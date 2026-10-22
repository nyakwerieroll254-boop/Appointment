import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import express from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import nodemailer from "nodemailer";
import { z } from "zod";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BOOKING_START_HOUR = 7;
const BOOKING_END_HOUR = 19;
const SERVICES = Object.freeze({
  "web-development": { name: "Web Development", duration: 60, price: 20_000, pricingUnit: "project", maximumHours: 1 },
  "robotics-lectures": { name: "Robotics lectures", duration: 60, price: 2_000, pricingUnit: "hour", maximumHours: 4 },
  "computing-lectures": { name: "Computing lectures", duration: 60, price: 3_000, pricingUnit: "hour", maximumHours: 4 },
  "media-editing": { name: "Media & Editing services", duration: 60, price: 1_500, pricingUnit: "hour", maximumHours: 1 },
});
const serviceSchema = z.enum(Object.keys(SERVICES));
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timezoneSchema = z.string().min(1).max(100);
const bookingSchema = z.object({
  service: serviceSchema,
  date: dateSchema,
  time: z.string().min(1).max(20),
  timeZone: timezoneSchema,
  hours: z.number().int().min(1).max(4).optional().default(1),
  name: z.string().trim().min(1).max(100),
  email: z.email().max(254),
  phoneNumber: z.string().trim().min(1).max(20),
  depositMethod: z.enum(["none", "manual_mpesa", "pesapal", "daraja_stk"]).optional().default("none"),
  note: z.string().max(1000).optional().default(""),
}).strict();
const bookingStatusSchema = z.object({
  status: z.enum(["confirmed", "cancelled"]),
}).strict();
const paymentRequestSchema = z.object({
  bookingId: z.number().int().positive(),
  method: z.enum(["manual_mpesa", "pesapal", "daraja_stk"]),
  phoneNumber: z.string().max(20).optional(),
}).strict();
const paymentStatusSchema = z.object({
  status: z.enum(["completed", "failed"]),
}).strict();
const DEFAULT_NOTIFICATION_EMAIL = "nyakwerieroll254@gmail.com";
const MPESA_ACCOUNT_NUMBER = "0704437275";
const MPESA_ACCOUNT_NAME = "EROLL JOSEPHAT";

function getAvailableStartTimes(serviceId, hours = 1) {
  const service = SERVICES[serviceId];
  const durationMinutes = service.duration * (service.pricingUnit === "hour" ? hours : 1);
  const latestStartMinutes = BOOKING_END_HOUR * 60 - durationMinutes;
  const times = [];
  for (let hour = BOOKING_START_HOUR; hour * 60 <= latestStartMinutes; hour += 1) {
    const twelveHour = hour % 12 || 12;
    const meridiem = hour < 12 ? "AM" : "PM";
    times.push(`${twelveHour}:00 ${meridiem}`);
  }
  return times;
}

function normalizeKenyanPhoneNumber(value) {
  const digits = value.replace(/[\s()+-]/g, "");
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  return null;
}

function darajaTimestamp(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}${values.month}${values.day}${values.hour}${values.minute}${values.second}`;
}

export function createDarajaClient({ env = process.env, fetchImpl = fetch, now = () => new Date() } = {}) {
  const production = env.DARAJA_ENVIRONMENT === "production";
  const apiBase = production ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";
  const consumerKey = env.DARAJA_CONSUMER_KEY?.trim() ?? "";
  const consumerSecret = env.DARAJA_CONSUMER_SECRET?.trim() ?? "";
  const shortcode = env.DARAJA_SHORTCODE?.trim() ?? "";
  const passkey = env.DARAJA_PASSKEY?.trim() ?? "";
  const renderExternalUrl = env.RENDER_EXTERNAL_URL?.trim().replace(/\/+$/, "") ?? "";
  const callbackUrl = env.DARAJA_CALLBACK_URL?.trim() ||
    (renderExternalUrl ? `${renderExternalUrl}/api/payments/daraja/callback` : "");
  let validCallbackUrl = false;
  try {
    validCallbackUrl = new URL(callbackUrl).protocol === "https:";
  } catch {
    validCallbackUrl = false;
  }
  const configured = Boolean(consumerKey && consumerSecret && shortcode && passkey && validCallbackUrl);
  let cachedToken;
  let tokenExpiresAt = 0;

  async function requestJson(url, options) {
    const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(15_000) });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error("Safaricom returned an invalid response.");
    }
    if (!response.ok) {
      throw new Error(typeof result.errorMessage === "string" ? result.errorMessage : `Safaricom request failed with HTTP ${response.status}.`);
    }
    return result;
  }

  async function getToken() {
    if (!configured) throw new Error("Safaricom Daraja STK Push is not configured.");
    if (cachedToken && tokenExpiresAt > Date.now() + 30_000) return cachedToken;
    const credentials = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
    const result = await requestJson(`${apiBase}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { authorization: `Basic ${credentials}`, accept: "application/json" },
    });
    if (typeof result.access_token !== "string" || !result.access_token) {
      throw new Error("Safaricom did not return an access token.");
    }
    cachedToken = result.access_token;
    tokenExpiresAt = Date.now() + Math.max(30, Number(result.expires_in) || 3590) * 1000;
    return cachedToken;
  }

  function stkPassword(timestamp) {
    return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");
  }

  return {
    configured,
    async requestStkPush({ phoneNumber, amount, reference, description }) {
      const normalizedPhoneNumber = normalizeKenyanPhoneNumber(phoneNumber);
      if (!normalizedPhoneNumber) {
        throw new Error("A valid Kenyan mobile number is required for STK Push.");
      }
      if (!Number.isSafeInteger(amount) || amount < 1) {
        throw new Error("The STK Push amount must be a positive whole number of Kenyan shillings.");
      }
      if (typeof reference !== "string" || !reference.trim() ||
        typeof description !== "string" || !description.trim()) {
        throw new Error("An STK Push reference and description are required.");
      }

      const token = await getToken();
      const timestamp = darajaTimestamp(now());
      const result = await requestJson(`${apiBase}/mpesa/stkpush/v1/processrequest`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          BusinessShortCode: shortcode,
          Password: stkPassword(timestamp),
          Timestamp: timestamp,
          TransactionType: "CustomerPayBillOnline",
          Amount: amount,
          PartyA: normalizedPhoneNumber,
          PartyB: shortcode,
          PhoneNumber: normalizedPhoneNumber,
          CallBackURL: callbackUrl,
          AccountReference: reference.slice(0, 12),
          TransactionDesc: description.slice(0, 20),
        }),
      });
      if (result.ResponseCode !== "0" || !result.CheckoutRequestID || !result.MerchantRequestID) {
        throw new Error(typeof result.ResponseDescription === "string"
          ? result.ResponseDescription
          : "Safaricom did not accept the STK Push request.");
      }
      return {
        checkoutRequestId: result.CheckoutRequestID,
        merchantRequestId: result.MerchantRequestID,
        customerMessage: typeof result.CustomerMessage === "string" ? result.CustomerMessage : "Check your phone and enter your M-Pesa PIN to complete the deposit.",
      };
    },
    async queryStkPush(checkoutRequestId) {
      const token = await getToken();
      const timestamp = darajaTimestamp(now());
      return requestJson(`${apiBase}/mpesa/stkpushquery/v1/query`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          BusinessShortCode: shortcode,
          Password: stkPassword(timestamp),
          Timestamp: timestamp,
          CheckoutRequestID: checkoutRequestId,
        }),
      });
    },
  };
}

export function createPesapalClient({ env = process.env, fetchImpl = fetch } = {}) {
  const sandbox = env.PESAPAL_ENVIRONMENT !== "production";
  const baseUrl = sandbox
    ? "https://cybqa.pesapal.com/pesapalv3"
    : "https://pay.pesapal.com/v3";
  const consumerKey = env.PESAPAL_CONSUMER_KEY?.trim() ?? "";
  const consumerSecret = env.PESAPAL_CONSUMER_SECRET?.trim() ?? "";
  const ipnId = env.PESAPAL_IPN_ID?.trim() ?? "";
  const publicBaseUrl = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") ||
    env.RENDER_EXTERNAL_URL?.trim().replace(/\/+$/, "") || "";
  let publicCallbackConfigured = false;
  try {
    publicCallbackConfigured = new URL(publicBaseUrl).protocol === "https:";
  } catch {
    publicCallbackConfigured = false;
  }
  const canRegisterIpn = Boolean(consumerKey && consumerSecret && publicCallbackConfigured);
  const configured = Boolean(canRegisterIpn && ipnId);
  let cachedToken;
  let tokenExpiresAt = 0;

  async function requestJson(url, options) {
    const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(15_000) });
    const result = await response.json();
    if (!response.ok) throw new Error(`Pesapal request failed with HTTP ${response.status}.`);
    if (result.error) throw new Error(result.error.message || "Pesapal rejected the request.");
    return result;
  }

  async function getToken() {
    if (cachedToken && tokenExpiresAt > Date.now() + 30_000) return cachedToken;
    const result = await requestJson(`${baseUrl}/api/Auth/RequestToken`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ consumer_key: consumerKey, consumer_secret: consumerSecret }),
    });
    if (typeof result.token !== "string" || !result.token) {
      throw new Error("Pesapal did not return an access token.");
    }
    cachedToken = result.token;
    const expiry = Date.parse(result.expiryDate);
    tokenExpiresAt = Number.isFinite(expiry) ? expiry : Date.now() + 4 * 60_000;
    return cachedToken;
  }

  return {
    configured,
    canRegisterIpn,
    async registerIpn() {
      if (!canRegisterIpn) throw new Error("Pesapal credentials and a public HTTPS callback URL are required.");
      const token = await getToken();
      return requestJson(`${baseUrl}/api/URLSetup/RegisterIPN`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          url: `${publicBaseUrl}/api/payments/pesapal/ipn`,
          ipn_notification_type: "GET",
        }),
      });
    },
    async createOrder({ booking, reference, amount }) {
      if (!configured) throw new Error("Pesapal checkout is not configured.");
      const token = await getToken();
      const callbackUrl = `${publicBaseUrl}/api/payments/pesapal/callback`;
      const result = await requestJson(`${baseUrl}/api/Transactions/SubmitOrderRequest`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          id: reference,
          currency: "KES",
          amount,
          description: `50% deposit for ${booking.service_name}`,
          callback_url: callbackUrl,
          cancellation_url: `${publicBaseUrl}/payment-status.html?reference=${encodeURIComponent(reference)}`,
          redirect_mode: "TOP_WINDOW",
          notification_id: ipnId,
          billing_address: {
            email_address: booking.client_email,
            phone_number: "",
            country_code: "KE",
            first_name: booking.client_name.slice(0, 50),
          },
        }),
      });
      if (typeof result.redirect_url !== "string" || !result.redirect_url.startsWith("https://")) {
        throw new Error("Pesapal did not return a secure checkout URL.");
      }
      return { trackingId: result.order_tracking_id, checkoutUrl: result.redirect_url };
    },
    async getTransactionStatus(trackingId) {
      if (!configured) throw new Error("Pesapal checkout is not configured.");
      const token = await getToken();
      const url = new URL(`${baseUrl}/api/Transactions/GetTransactionStatus`);
      url.searchParams.set("orderTrackingId", trackingId);
      return requestJson(url, {
        headers: { accept: "application/json", authorization: `Bearer ${token}` },
      });
    },
  };
}

export function createEmailTransport(env = process.env) {
  const password = env.SMTP_PASS?.trim();
  if (!password) return null;

  const host = env.SMTP_HOST?.trim() || "smtp.gmail.com";
  const user = env.SMTP_USER?.trim() || DEFAULT_NOTIFICATION_EMAIL;
  const port = Number(env.SMTP_PORT || 465);
  const secure = env.SMTP_SECURE === undefined ? port === 465 : env.SMTP_SECURE.toLowerCase() === "true";
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SMTP_PORT must be an integer between 1 and 65535.");
  }
  if (!host || !user) throw new Error("SMTP_HOST and SMTP_USER are required when SMTP_PASS is configured.");

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    auth: { user, pass: password },
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  const from = env.EMAIL_FROM?.trim() || user;
  return { sendMail: (message) => transporter.sendMail({ from, ...message }) };
}

export function createAfricasTalkingClient({ env = process.env, fetchImpl = fetch } = {}) {
  const username = env.AFRICASTALKING_USERNAME?.trim() ?? "";
  const apiKey = env.AFRICASTALKING_API_KEY?.trim() ?? "";
  const senderId = env.AFRICASTALKING_SENDER_ID?.trim() ?? "";
  const environment = env.AFRICASTALKING_ENVIRONMENT?.trim() || "sandbox";
  if (!["sandbox", "production"].includes(environment)) {
    throw new Error("AFRICASTALKING_ENVIRONMENT must be sandbox or production.");
  }
  const configured = Boolean(username && apiKey);
  const baseUrl = environment === "production"
    ? "https://api.africastalking.com"
    : "https://api.sandbox.africastalking.com";

  return {
    configured,
    async sendMessage({ phoneNumber, message }) {
      if (!configured) throw new Error("Africa's Talking SMS is not configured.");
      const normalizedPhoneNumber = normalizeKenyanPhoneNumber(phoneNumber);
      if (!normalizedPhoneNumber) {
        throw new Error("A valid Kenyan mobile number is required for SMS notifications.");
      }
      if (typeof message !== "string" || !message.trim()) {
        throw new Error("An SMS notification message is required.");
      }

      const body = new URLSearchParams({
        username,
        to: `+${normalizedPhoneNumber}`,
        message,
      });
      if (senderId) body.set("from", senderId);

      const response = await fetchImpl(`${baseUrl}/version1/messaging`, {
        method: "POST",
        headers: {
          apiKey,
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      let result;
      try {
        result = await response.json();
      } catch {
        throw new Error("Africa's Talking returned an invalid SMS response.");
      }
      const recipients = result.SMSMessageData?.Recipients;
      if (!response.ok || !Array.isArray(recipients) || recipients.length !== 1) {
        throw new Error("Africa's Talking could not accept the SMS notification.");
      }
      const statusCode = Number(recipients[0].statusCode);
      if (![100, 101, 102].includes(statusCode)) {
        throw new Error("Africa's Talking rejected the SMS notification.");
      }
      return { status: statusCode === 101 ? "sent" : "queued" };
    },
  };
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function createBookingEmails(booking, notificationEmail) {
  const safeName = escapeHtml(booking.client_name);
  const safeEmail = escapeHtml(booking.client_email);
  const safeService = escapeHtml(booking.service_name);
  const safeDate = escapeHtml(booking.local_date);
  const safeTime = escapeHtml(booking.local_time);
  const safeTimeZone = escapeHtml(booking.time_zone);
  const safeNote = escapeHtml(booking.client_note ?? "").replace(/\r?\n/g, "<br>");
  const price = formatPrice(booking.price_cents / 100, booking.currency);
  const duration = formatDuration(booking.duration_minutes);
  const details = [
    `Service: ${booking.service_name}`,
    `Date: ${booking.local_date}`,
    `Time: ${booking.local_time} (${booking.time_zone})`,
    `Duration: ${duration}`,
    booking.pricing_unit === "hour" ? `Billable hours: ${booking.billable_hours}` : null,
    `Price: ${price}`,
    booking.status === "confirmed"
      ? "Deposit: not required"
      : `Optional 50% deposit: ${formatPrice(Math.round(booking.price_cents / 2) / 100, booking.currency)}`,
    `Name: ${booking.client_name}`,
    `Email: ${booking.client_email}`,
    `Mobile: +${booking.client_phone}`,
  ].filter(Boolean);
  if (booking.client_note) details.push(`Note: ${booking.client_note}`);
  const text = details.join("\n");
  const confirmedWithoutDeposit = booking.status === "confirmed";
  const billing = booking.pricing_unit === "hour"
    ? `<p>${booking.billable_hours} hour${booking.billable_hours === 1 ? "" : "s"} at ${formatPrice(booking.price_cents / 100 / booking.billable_hours, booking.currency)} per hour</p>`
    : "<p>Project fee</p>";
  const html = `
    <h2>${confirmedWithoutDeposit ? "Confirmed appointment" : "Appointment request"} #${booking.id}</h2>
    <p><strong>${safeService}</strong></p>
    <p>${safeDate} at ${safeTime} (${safeTimeZone}) · ${duration} · ${price}</p>
    ${billing}
    <p><strong>${safeName}</strong><br><a href="mailto:${safeEmail}">${safeEmail}</a><br>+${booking.client_phone}</p>
    ${safeNote ? `<p><strong>Note:</strong><br>${safeNote}</p>` : ""}
    ${confirmedWithoutDeposit
    ? "<p>No deposit was collected. The appointment is confirmed.</p>"
    : `<p>Optional 50% deposit: <strong>${formatPrice(Math.round(booking.price_cents / 2) / 100, booking.currency)}</strong></p><p>Status: awaiting deposit verification; appointment is not yet confirmed.</p>`}`;

  return [
    {
      to: notificationEmail,
      replyTo: booking.client_email,
      subject: `${confirmedWithoutDeposit ? "New confirmed appointment" : "New appointment request"} #${booking.id}`,
      text,
      html,
    },
    {
      to: booking.client_email,
      subject: `${confirmedWithoutDeposit ? "Appointment confirmed" : "Appointment request received"} #${booking.id}`,
      text: confirmedWithoutDeposit
        ? `Hi ${booking.client_name},\n\nYour appointment is confirmed. No deposit was charged.\n\n${text}`
        : `Hi ${booking.client_name},\n\nYour appointment request is saved and awaiting confirmation. The 50% deposit is optional; if you choose to pay, Eroll Josephat will verify it before confirming the appointment.\n\n${text}`,
      html: confirmedWithoutDeposit
        ? `<p>Hi ${safeName},</p><p>Your appointment is confirmed. No deposit was charged.</p>${html}`
        : `<p>Hi ${safeName},</p><p>Your appointment request is saved and awaiting confirmation. The 50% deposit is optional; if you choose to pay, Eroll Josephat will verify it before confirming the appointment.</p>${html}`,
    },
  ];
}

function createBookingSms(booking) {
  const name = booking.client_name.replace(/\s+/g, " ").slice(0, 30);
  const status = booking.status === "confirmed"
    ? "CONFIRMED; no deposit."
    : "PENDING; deposit optional.";
  return `Hi ${name}, booking #${booking.id}: ${booking.service_name} on ${booking.local_date} at ${booking.local_time}. ${status}`;
}

async function sendBookingNotifications({ mailer, sms }, booking, notificationEmail) {
  const emailStatusPromise = !mailer
    ? Promise.resolve("not_configured")
    : Promise.allSettled(
      createBookingEmails(booking, notificationEmail).map((message) => Promise.resolve().then(() => mailer.sendMail(message))),
    ).then((results) => {
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length) {
        console.error("Appointment email delivery failed:", failures.map(({ reason }) =>
          reason instanceof Error ? reason.message : "Unknown email delivery error",
        ));
      }
      if (!failures.length) return "sent";
      return failures.length === results.length ? "failed" : "partial";
    });
  const smsStatusPromise = sms?.configured === false || typeof sms?.sendMessage !== "function"
    ? Promise.resolve("not_configured")
    : Promise.resolve()
      .then(() => sms.sendMessage({ phoneNumber: booking.client_phone, message: createBookingSms(booking) }))
      .then((result) => result?.status === "queued" ? "queued" : "sent")
      .catch((error) => {
        console.error("Appointment SMS delivery failed:", error instanceof Error ? error.message : "Unknown SMS delivery error");
        return "failed";
      });
  const [email, smsStatus] = await Promise.all([emailStatusPromise, smsStatusPromise]);
  const channelStatuses = [email, smsStatus];
  const allNotificationsAccepted = channelStatuses.every((status) => status === "sent" || status === "queued");
  let notificationStatus;
  if (allNotificationsAccepted) {
    notificationStatus = channelStatuses.includes("queued") ? "queued" : "sent";
  } else if (channelStatuses.every((status) => status === "not_configured")) {
    notificationStatus = "not_configured";
  } else if (channelStatuses.some((status) => status === "sent" || status === "queued" || status === "partial")) {
    notificationStatus = "partial";
  } else {
    notificationStatus = "failed";
  }
  const message = {
    sent: "Email and SMS notifications were sent.",
    queued: "Email was sent and Africa's Talking accepted the SMS notification for delivery.",
    partial: "The booking was saved, but one or more email or SMS notifications could not be sent.",
    failed: "The booking was saved, but the email and SMS notifications could not be sent.",
    not_configured: "The booking was saved, but email and SMS delivery are not configured yet.",
  }[notificationStatus];
  return { email, sms: smsStatus, notificationStatus, message };
}

export function createBookingStore(dbPath = ":memory:") {
  if (dbPath !== ":memory:") mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service TEXT NOT NULL,
      service_name TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL,
      price_cents INTEGER NOT NULL,
      client_name TEXT NOT NULL,
      client_email TEXT NOT NULL,
      client_phone TEXT NOT NULL,
      client_note TEXT NOT NULL DEFAULT '',
      local_date TEXT NOT NULL,
      local_time TEXT NOT NULL,
      time_zone TEXT NOT NULL,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      pricing_unit TEXT NOT NULL DEFAULT 'legacy',
      billable_hours INTEGER NOT NULL DEFAULT 1,
      notification_email_status TEXT NOT NULL DEFAULT 'pending',
      notification_sms_status TEXT NOT NULL DEFAULT 'pending',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS bookings_start_status_idx ON bookings(status, start_at, end_at);
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER NOT NULL REFERENCES bookings(id),
      merchant_reference TEXT NOT NULL UNIQUE,
      tracking_id TEXT UNIQUE,
      provider TEXT NOT NULL CHECK (provider IN ('manual_mpesa', 'pesapal', 'daraja_stk')),
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'KES',
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'reversed')),
      checkout_url TEXT,
      provider_request_id TEXT UNIQUE,
      payer_phone TEXT,
      payment_method TEXT,
      confirmation_code TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS payments_booking_idx ON payments(booking_id, created_at);
  `);
  const paymentColumns = new Set(db.pragma("table_info(payments)").map((column) => column.name));
  if (!paymentColumns.has("provider_request_id")) {
    db.exec("ALTER TABLE payments ADD COLUMN provider_request_id TEXT");
  }
  if (!paymentColumns.has("payer_phone")) {
    db.exec("ALTER TABLE payments ADD COLUMN payer_phone TEXT");
  }
  const paymentTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'payments'").get()?.sql ?? "";
  if (!paymentTableSql.includes("'daraja_stk'")) {
    db.exec(`
      BEGIN;
      CREATE TABLE payments_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_id INTEGER NOT NULL REFERENCES bookings(id),
        merchant_reference TEXT NOT NULL UNIQUE,
        tracking_id TEXT UNIQUE,
        provider TEXT NOT NULL CHECK (provider IN ('manual_mpesa', 'pesapal', 'daraja_stk')),
        amount_cents INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'KES',
        status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'reversed')),
        checkout_url TEXT,
        provider_request_id TEXT UNIQUE,
        payer_phone TEXT,
        payment_method TEXT,
        confirmation_code TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      INSERT INTO payments_v2 (
        id, booking_id, merchant_reference, tracking_id, provider, amount_cents, currency,
        status, checkout_url, provider_request_id, payer_phone, payment_method,
        confirmation_code, created_at, updated_at
      )
      SELECT id, booking_id, merchant_reference, tracking_id, provider, amount_cents, currency,
        status, checkout_url, provider_request_id, payer_phone, payment_method,
        confirmation_code, created_at, updated_at
      FROM payments;
      DROP TABLE payments;
      ALTER TABLE payments_v2 RENAME TO payments;
      CREATE INDEX IF NOT EXISTS payments_booking_idx ON payments(booking_id, created_at);
      COMMIT;
    `);
  }

  const bookingColumns = new Set(db.pragma("table_info(bookings)").map((column) => column.name));
  if (!bookingColumns.has("currency")) {
    db.exec("ALTER TABLE bookings ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD'");
  }
  if (!bookingColumns.has("pricing_unit")) {
    db.exec("ALTER TABLE bookings ADD COLUMN pricing_unit TEXT NOT NULL DEFAULT 'legacy'");
  }
  if (!bookingColumns.has("billable_hours")) {
    db.exec("ALTER TABLE bookings ADD COLUMN billable_hours INTEGER NOT NULL DEFAULT 1");
  }
  if (!bookingColumns.has("client_phone")) {
    db.exec("ALTER TABLE bookings ADD COLUMN client_phone TEXT NOT NULL DEFAULT ''");
  }
  if (!bookingColumns.has("notification_email_status")) {
    db.exec("ALTER TABLE bookings ADD COLUMN notification_email_status TEXT NOT NULL DEFAULT 'not_configured'");
  }
  if (!bookingColumns.has("notification_sms_status")) {
    db.exec("ALTER TABLE bookings ADD COLUMN notification_sms_status TEXT NOT NULL DEFAULT 'not_configured'");
  }

  const store = {
    hasConflict(startAt, endAt) {
      return Boolean(db.prepare(`
        SELECT 1 FROM bookings
        WHERE status != 'cancelled' AND start_at < ? AND end_at > ?
        LIMIT 1
      `).get(endAt, startAt));
    },
    createBooking(booking) {
      const service = SERVICES[booking.service];
      const billableHours = service.pricingUnit === "hour" ? booking.hours : 1;
      const durationMinutes = service.duration * billableHours;
      const price = service.pricingUnit === "project" ? service.price : service.price * billableHours;
      const startAt = new Date(booking.startMs).toISOString();
      const endAt = new Date(booking.startMs + durationMinutes * 60_000).toISOString();
      const insert = db.prepare(`
        INSERT INTO bookings (
          service, service_name, duration_minutes, price_cents, currency, pricing_unit, billable_hours,
          client_name, client_email, client_phone, client_note, local_date, local_time, time_zone, start_at, end_at,
          status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const create = db.transaction(() => {
        if (store.hasConflict(startAt, endAt)) return null;
        const result = insert.run(
          booking.service, service.name, durationMinutes, price * 100, "KES", service.pricingUnit, billableHours,
          booking.name, booking.email, booking.phoneNumber, booking.note, booking.date, booking.time,
          booking.timeZone, startAt, endAt, booking.status ?? "pending",
        );
        return Number(result.lastInsertRowid);
      });
      return create.immediate();
    },
    getBooking(id) {
      return db.prepare("SELECT * FROM bookings WHERE id = ?").get(id);
    },
    beginPayment({ bookingId, reference, provider, amountCents, payerPhone = null }) {
      const begin = db.transaction(() => {
        const activePayment = db.prepare(`
          SELECT * FROM payments
          WHERE booking_id = ? AND status = 'pending'
          ORDER BY id DESC LIMIT 1
        `).get(bookingId);
        if (activePayment) return { created: false, payment: activePayment };
        if (store.completedPaymentTotal(bookingId) >= amountCents) return { created: false, payment: null };
        db.prepare(`
          INSERT INTO payments (booking_id, merchant_reference, provider, amount_cents, payer_phone, status)
          VALUES (?, ?, ?, ?, ?, 'pending')
        `).run(bookingId, reference, provider, amountCents, payerPhone);
        return { created: true, payment: store.getPayment(reference) };
      });
      return begin.immediate();
    },
    getPayment(reference) {
      return db.prepare("SELECT * FROM payments WHERE merchant_reference = ?").get(reference);
    },
    getPaymentByProviderRequestId(provider, requestId) {
      return db.prepare("SELECT * FROM payments WHERE provider = ? AND provider_request_id = ?").get(provider, requestId);
    },
    completedPaymentTotal(bookingId) {
      return db.prepare(`
        SELECT COALESCE(SUM(amount_cents), 0) AS total
        FROM payments WHERE booking_id = ? AND status = 'completed'
      `).get(bookingId).total;
    },
    updatePayment(reference, payment) {
      const result = db.prepare(`
        UPDATE payments SET tracking_id = COALESCE(?, tracking_id), status = ?,
          provider_request_id = COALESCE(?, provider_request_id),
          checkout_url = COALESCE(?, checkout_url), payment_method = COALESCE(?, payment_method),
          confirmation_code = COALESCE(?, confirmation_code),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE merchant_reference = ?
          AND (
            status = 'pending'
            OR (status = 'failed' AND ? = 'completed')
            OR (status = 'completed' AND ? IN ('completed', 'reversed'))
          )
      `).run(
        payment.trackingId ?? null, payment.status,
        payment.providerRequestId ?? null,
        payment.checkoutUrl ?? null, payment.paymentMethod ?? null,
        payment.confirmationCode ?? null, reference, payment.status, payment.status,
      );
      return result.changes > 0;
    },
    listBookings() {
      return db.prepare("SELECT * FROM bookings ORDER BY start_at ASC").all();
    },
    updateBookingNotificationStatus(id, { email, sms }) {
      db.prepare(`
        UPDATE bookings SET notification_email_status = ?, notification_sms_status = ?
        WHERE id = ?
      `).run(email, sms, id);
    },
    listPayments() {
      return db.prepare(`
        SELECT p.*, b.service_name, b.client_name, b.client_email, b.local_date, b.local_time
        FROM payments p JOIN bookings b ON b.id = p.booking_id
        ORDER BY p.created_at DESC
      `).all();
    },
    updateBookingStatus(id, status) {
      const result = db.prepare("UPDATE bookings SET status = ? WHERE id = ? AND status != 'cancelled'").run(status, id);
      return result.changes > 0;
    },
    close() {
      db.close();
    },
  };

  return store;
}

function formatPrice(amount, currency = "KES") {
  if (currency === "KES") return `KSh ${new Intl.NumberFormat("en-KE", { maximumFractionDigits: 0 }).format(amount)}`;
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

function formatDuration(minutes) {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${minutes} minutes`;
}

function getLocalDate(timeZone, instant = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function getDateRange(timeZone, now = new Date()) {
  const today = getLocalDate(timeZone, now);
  const [year, month] = today.split("-").map(Number);
  const finalDate = new Date(Date.UTC(year, month + 2, 0));
  const lastBookableDate = [
    finalDate.getUTCFullYear(),
    String(finalDate.getUTCMonth() + 1).padStart(2, "0"),
    String(finalDate.getUTCDate()).padStart(2, "0"),
  ].join("-");
  return { today, lastBookableDate };
}

function wallTimeToEpoch(date, time, timeZone) {
  const [year, month, day] = date.split("-").map(Number);
  const [clock, meridiem] = time.split(" ");
  let [hour, minute] = clock.split(":").map(Number);
  if (meridiem === "PM" && hour !== 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;

  const expected = [year, month, day, hour, minute];
  const expectedUtcMs = Date.UTC(year, month - 1, day, hour, minute);
  let candidateMs = expectedUtcMs;
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const values = Object.fromEntries(formatter.formatToParts(new Date(candidateMs)).map(({ type, value }) => [type, Number(value)]));
    const formatted = [values.year, values.month, values.day, values.hour, values.minute];
    const difference = expectedUtcMs - Date.UTC(formatted[0], formatted[1] - 1, formatted[2], formatted[3], formatted[4]);
    if (difference === 0) return candidateMs;
    candidateMs += difference;
  }

  const result = formatter.formatToParts(new Date(candidateMs));
  const values = Object.fromEntries(result.map(({ type, value }) => [type, Number(value)]));
  const actual = [values.year, values.month, values.day, values.hour, values.minute];
  return expected.every((part, index) => part === actual[index]) ? candidateMs : null;
}

function isValidCalendarDate(date) {
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function isValidMonth(month) {
  return typeof month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
}

function isWeekday(date) {
  const [year, month, day] = date.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

function isAdminAuthorized(req, token) {
  const provided = req.get("authorization")?.replace(/^Bearer /i, "");
  if (!token || !provided) return false;
  const expectedBuffer = Buffer.from(token);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
}

function serializeBooking(booking) {
  return {
    id: booking.id,
    service: booking.service,
    serviceName: booking.service_name,
    durationMinutes: booking.duration_minutes,
    durationLabel: formatDuration(booking.duration_minutes),
    price: booking.price_cents / 100,
    currency: booking.currency ?? "USD",
    pricingUnit: booking.pricing_unit ?? "legacy",
    billableHours: booking.billable_hours ?? 1,
    name: booking.client_name,
    email: booking.client_email,
    phoneNumber: booking.client_phone,
    note: booking.client_note,
    date: booking.local_date,
    time: booking.local_time,
    timeZone: booking.time_zone,
    startAt: booking.start_at,
    status: booking.status,
    notifications: {
      email: booking.notification_email_status ?? "not_configured",
      sms: booking.notification_sms_status ?? "not_configured",
    },
    createdAt: booking.created_at,
  };
}

export function createApp({
  store = createBookingStore(),
  adminToken = process.env.ADMIN_API_TOKEN ?? "",
  mailer = createEmailTransport(),
  sms = createAfricasTalkingClient(),
  pesapal = createPesapalClient(),
  daraja = createDarajaClient(),
  notificationEmail = process.env.BOOKING_NOTIFICATION_EMAIL ?? DEFAULT_NOTIFICATION_EMAIL,
} = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https://images.unsplash.com"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  }));
  app.use(express.json({ limit: "8kb", strict: true }));

  const availabilityLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false });
  const bookingLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false });
  const paymentLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false });

  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/api/payment-options", (_req, res) => res.json({
    depositPercent: 50,
    depositRequired: false,
    manualMpesa: {
      available: true,
      accountNumber: MPESA_ACCOUNT_NUMBER,
      accountName: MPESA_ACCOUNT_NAME,
    },
    onlineCheckout: {
      available: pesapal.configured,
      provider: "Pesapal",
      methods: ["M-Pesa", "Card"],
    },
    darajaStkPush: {
      available: daraja.configured,
      reason: daraja.configured ? null : "A Safaricom Paybill shortcode, Daraja credentials and passkey, and a public HTTPS callback URL are required.",
    },
  }));
  app.get("/api/services", (_req, res) => {
    res.json(Object.entries(SERVICES).map(([id, service]) => ({
      id,
      name: service.name,
      durationMinutes: service.duration,
      price: service.price,
      currency: "KES",
      pricingUnit: service.pricingUnit,
      maximumHours: service.maximumHours,
      priceLabel: service.pricingUnit === "project"
        ? `${formatPrice(service.price)} / project`
        : `${formatPrice(service.price)} / hour`,
    })));
  });

  app.get("/api/availability", availabilityLimiter, (req, res) => {
    const parsedService = serviceSchema.safeParse(req.query.service);
    const parsedTimeZone = timezoneSchema.safeParse(req.query.timeZone);
    const requestedHours = req.query.hours === undefined ? 1 : Number(req.query.hours);
    if (!isValidMonth(req.query.month) || !parsedService.success || !parsedTimeZone.success ||
      !Number.isInteger(requestedHours) || requestedHours < 1 ||
      requestedHours > (parsedService.success ? SERVICES[parsedService.data].maximumHours : 1)) {
      return res.status(400).json({ error: "A valid month, service, session duration, and IANA timezone are required." });
    }

    let today;
    try {
      today = getLocalDate(parsedTimeZone.data);
      new Intl.DateTimeFormat("en-US", { timeZone: parsedTimeZone.data });
    } catch {
      return res.status(400).json({ error: "The timezone is not a valid IANA timezone." });
    }
    const { lastBookableDate } = getDateRange(parsedTimeZone.data);
    const [year, month] = req.query.month.split("-").map(Number);
    const monthEndDate = new Date(Date.UTC(year, month, 0));
    const times = getAvailableStartTimes(parsedService.data, requestedHours);
    const days = [];

    for (let day = 1; day <= monthEndDate.getUTCDate(); day += 1) {
      const date = `${req.query.month}-${String(day).padStart(2, "0")}`;
      if (date < today || date > lastBookableDate || !isWeekday(date)) continue;

      const availableTimes = times.filter((time) => {
        const startMs = wallTimeToEpoch(date, time, parsedTimeZone.data);
        if (startMs === null || startMs <= Date.now()) return false;
        const startAt = new Date(startMs).toISOString();
        const endAt = new Date(startMs + SERVICES[parsedService.data].duration * requestedHours * 60_000).toISOString();
        return !store.hasConflict(startAt, endAt);
      });

      if (availableTimes.length) days.push({ date, times: availableTimes });
    }

    return res.json({
      month: req.query.month,
      service: parsedService.data,
      hours: requestedHours,
      timeZone: parsedTimeZone.data,
      today,
      days,
    });
  });

  app.post("/api/bookings", bookingLimiter, async (req, res) => {
    const parsed = bookingSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Please check the booking details and try again." });
    }

    const booking = parsed.data;
    const phoneNumber = normalizeKenyanPhoneNumber(booking.phoneNumber);
    if (!phoneNumber) {
      return res.status(400).json({ error: "Enter a valid Kenyan mobile number, for example 0712345678 or +254712345678." });
    }
    const service = SERVICES[booking.service];
    if (booking.hours > service.maximumHours) {
      return res.status(400).json({ error: "Choose a duration supported by this service." });
    }
    if (!isValidCalendarDate(booking.date) || !isWeekday(booking.date)) {
      return res.status(400).json({ error: "Choose an available weekday." });
    }
    if (!getAvailableStartTimes(booking.service, booking.hours).includes(booking.time)) {
      return res.status(400).json({ error: "Choose an available time for this session." });
    }

    let startMs;
    try {
      startMs = wallTimeToEpoch(booking.date, booking.time, booking.timeZone);
    } catch {
      return res.status(400).json({ error: "The timezone is not a valid IANA timezone." });
    }
    if (startMs === null) return res.status(400).json({ error: "This local time is not valid in the selected timezone." });
    const { today, lastBookableDate } = getDateRange(booking.timeZone);
    if (booking.date < today || booking.date > lastBookableDate || startMs <= Date.now()) {
      return res.status(400).json({ error: "Choose a future appointment date within the booking window." });
    }

    try {
      const bookingStatus = booking.depositMethod === "none" ? "confirmed" : "pending";
      const id = store.createBooking({
        ...booking,
        phoneNumber,
        status: bookingStatus,
        startMs,
      });
      if (id === null) {
        return res.status(409).json({ error: "That time was just booked. Please choose another available time." });
      }
      const notificationResult = await sendBookingNotifications({ mailer, sms }, store.getBooking(id), notificationEmail);
      store.updateBookingNotificationStatus(id, notificationResult);
      const savedBooking = store.getBooking(id);
      return res.status(201).json({
        booking: serializeBooking(savedBooking),
        notificationStatus: notificationResult.notificationStatus,
        notifications: {
          email: notificationResult.email,
          sms: notificationResult.sms,
        },
        message: `${bookingStatus === "confirmed" ? "Your booking is confirmed with no deposit required." : "Your appointment request is saved and awaiting confirmation."} ${notificationResult.message}`,
      });
    } catch (error) {
      console.error("Unable to save appointment request:", error);
      return res.status(500).json({ error: "We could not save your request. Please try again shortly." });
    }
  });

  app.post("/api/payments", paymentLimiter, async (req, res) => {
    const parsed = paymentRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Choose a valid appointment and payment method." });

    const booking = store.getBooking(parsed.data.bookingId);
    if (!booking || booking.status === "cancelled") {
      return res.status(404).json({ error: "The appointment request was not found." });
    }

    const amountCents = Math.round(booking.price_cents * 0.5);
    if (amountCents < 1) return res.status(400).json({ error: "The deposit amount is invalid." });
    if (store.completedPaymentTotal(booking.id) >= amountCents) {
      return res.status(409).json({ error: "The required deposit has already been verified." });
    }
    if (parsed.data.method === "pesapal" && !pesapal.configured) {
      return res.status(503).json({ error: "Secure card and M-Pesa checkout is not configured yet. Use the manual M-Pesa option." });
    }
    const phoneNumber = parsed.data.method === "daraja_stk"
      ? normalizeKenyanPhoneNumber(parsed.data.phoneNumber ?? "")
      : null;
    if (parsed.data.method === "daraja_stk" && !phoneNumber) {
      return res.status(400).json({ error: "Enter a valid Kenyan mobile number, for example 0712345678 or +254712345678." });
    }
    if (parsed.data.method === "daraja_stk" && !daraja.configured) {
      return res.status(503).json({ error: "Daraja STK Push is not active yet. Configure the Safaricom shortcode, API credentials, passkey, and HTTPS callback URL first." });
    }

    let createdReference = "";
    try {
      const attempt = store.beginPayment({
        bookingId: booking.id,
        reference: randomUUID(),
        provider: parsed.data.method,
        amountCents,
        payerPhone: phoneNumber,
      });
      if (!attempt.created && !attempt.payment) {
        return res.status(409).json({ error: "The required deposit has already been verified." });
      }
      const existing = attempt.payment;
      createdReference = existing.merchant_reference;
      if (!attempt.created && existing.provider !== parsed.data.method) {
        return res.status(409).json({
          error: "Another deposit method is already pending for this appointment. Complete it or contact Eroll before choosing another method.",
          reference: existing.merchant_reference,
          status: existing.status,
        });
      }
      if (!attempt.created && parsed.data.method === "daraja_stk" && existing.payer_phone !== phoneNumber) {
        return res.status(409).json({
          error: "An STK Push is already pending for a different phone number. Check that phone or contact Eroll before trying another number.",
          reference: existing.merchant_reference,
          status: existing.status,
        });
      }
      if (!attempt.created && existing.checkout_url) {
        return res.json({ reference: existing.merchant_reference, amount: existing.amount_cents / 100, checkoutUrl: existing.checkout_url });
      }
      if (!attempt.created && existing.provider === "manual_mpesa") {
        return res.json({
          reference: existing.merchant_reference,
          amount: existing.amount_cents / 100,
          accountNumber: MPESA_ACCOUNT_NUMBER,
          accountName: MPESA_ACCOUNT_NAME,
          status: "pending",
        });
      }
      if (!attempt.created && existing.provider === "daraja_stk") {
        return res.json({
          reference: existing.merchant_reference,
          amount: existing.amount_cents / 100,
          status: "pending",
          message: "An STK Push may already have reached your phone. Check the prompt and do not request another push.",
        });
      }
      if (!attempt.created) {
        return res.status(409).json({
          error: "Your secure checkout is still being initialized. Do not submit another payment. Contact Eroll if this message persists.",
          reference: existing.merchant_reference,
          status: existing.status,
        });
      }
      const reference = existing.merchant_reference;
      if (parsed.data.method === "manual_mpesa") {
        return res.status(201).json({
          reference,
          amount: amountCents / 100,
          accountNumber: MPESA_ACCOUNT_NUMBER,
          accountName: MPESA_ACCOUNT_NAME,
          status: "pending",
          message: "Send the deposit using M-Pesa. The payment will be marked received after it is verified.",
        });
      }

      if (parsed.data.method === "daraja_stk") {
        const stk = await daraja.requestStkPush({
          phoneNumber,
          amount: amountCents / 100,
          reference,
          description: `Deposit ${booking.id}`,
        });
        if (!stk.checkoutRequestId || !stk.merchantRequestId) {
          throw new Error("Safaricom returned incomplete STK Push details.");
        }
        store.updatePayment(reference, {
          status: "pending",
          trackingId: stk.checkoutRequestId,
          providerRequestId: stk.checkoutRequestId,
          paymentMethod: "M-Pesa STK Push",
        });
        return res.status(201).json({
          reference,
          amount: amountCents / 100,
          status: "pending",
          phoneNumber: `+${phoneNumber}`,
          message: stk.customerMessage,
        });
      }

      const checkout = await pesapal.createOrder({
        booking,
        reference,
        amount: amountCents / 100,
      });
      if (!checkout.trackingId || !checkout.checkoutUrl) {
        throw new Error("Pesapal returned incomplete checkout details.");
      }
      store.updatePayment(reference, {
        status: "pending",
        trackingId: checkout.trackingId,
        checkoutUrl: checkout.checkoutUrl,
      });
      return res.status(201).json({ reference, amount: amountCents / 100, checkoutUrl: checkout.checkoutUrl });
    } catch (error) {
      console.error("Unable to initialize payment:", error instanceof Error ? error.message : "Unknown payment error");
      return res.status(502).json({
        error: "We could not confirm the payment setup. Your appointment request is saved, but its payment attempt may still be processing. Do not start another payment; contact Eroll.",
        reference: createdReference || undefined,
        status: createdReference ? "pending" : undefined,
      });
    }
  });

  async function updatePesapalPayment(trackingId, reference) {
    if (!trackingId || !reference) return null;
    const payment = store.getPayment(reference);
    if (!payment || payment.provider !== "pesapal" || payment.tracking_id !== trackingId) return null;

    const transaction = await pesapal.getTransactionStatus(trackingId);
    if (transaction.merchant_reference !== reference ||
      transaction.currency !== payment.currency ||
      Math.round(Number(transaction.amount) * 100) !== payment.amount_cents) {
      throw new Error("Pesapal transaction details do not match the payment record.");
    }
    const statuses = new Map([[1, "completed"], [2, "failed"], [3, "reversed"]]);
    const status = statuses.get(Number(transaction.status_code)) ?? "pending";
    store.updatePayment(reference, {
      status,
      paymentMethod: typeof transaction.payment_method === "string" ? transaction.payment_method : null,
      confirmationCode: typeof transaction.confirmation_code === "string" ? transaction.confirmation_code : null,
    });
    return store.getPayment(reference);
  }

  app.get("/api/payments/pesapal/callback", async (req, res) => {
    const trackingId = typeof req.query.OrderTrackingId === "string" ? req.query.OrderTrackingId : "";
    const reference = typeof req.query.OrderMerchantReference === "string" ? req.query.OrderMerchantReference : "";
    try {
      await updatePesapalPayment(trackingId, reference);
    } catch (error) {
      console.error("Unable to verify Pesapal callback:", error instanceof Error ? error.message : "Unknown payment error");
    }
    return res.redirect(303, `/payment-status.html?reference=${encodeURIComponent(reference)}`);
  });

  app.all("/api/payments/pesapal/ipn", async (req, res) => {
    const payload = req.method === "GET" ? req.query : req.body;
    const trackingId = payload.orderTrackingId ?? payload.OrderTrackingId;
    const reference = payload.orderMerchantReference ?? payload.OrderMerchantReference;
    try {
      const payment = await updatePesapalPayment(trackingId, reference);
      if (!payment) return res.status(500).json({ orderNotificationType: "IPNCHANGE", orderTrackingId: trackingId ?? "", orderMerchantReference: reference ?? "", status: 500 });
      return res.json({ orderNotificationType: "IPNCHANGE", orderTrackingId: trackingId, orderMerchantReference: reference, status: 200 });
    } catch (error) {
      console.error("Unable to process Pesapal IPN:", error instanceof Error ? error.message : "Unknown payment error");
      return res.status(500).json({ orderNotificationType: "IPNCHANGE", orderTrackingId: trackingId ?? "", orderMerchantReference: reference ?? "", status: 500 });
    }
  });

  app.post("/api/payments/daraja/callback", async (req, res) => {
    const callback = req.body?.Body?.stkCallback;
    const checkoutRequestId = callback?.CheckoutRequestID;
    if (typeof checkoutRequestId !== "string" || !checkoutRequestId) {
      return res.status(400).json({ ResultCode: 1, ResultDesc: "Invalid STK callback." });
    }

    const payment = store.getPaymentByProviderRequestId("daraja_stk", checkoutRequestId);
    if (!payment || payment.status !== "pending") {
      return res.status(404).json({ ResultCode: 1, ResultDesc: "Payment request not found or already finalized." });
    }

    if (Number(callback.ResultCode) !== 0) {
      store.updatePayment(payment.merchant_reference, {
        status: "failed",
        paymentMethod: "M-Pesa STK Push",
      });
      return res.json({ ResultCode: 0, ResultDesc: "Callback accepted." });
    }

    const metadata = callback.CallbackMetadata?.Item;
    if (!Array.isArray(metadata)) {
      return res.status(400).json({ ResultCode: 1, ResultDesc: "Successful callback is missing payment metadata." });
    }
    const values = new Map(metadata.filter((item) => item && typeof item.Name === "string").map((item) => [item.Name, item.Value]));
    const callbackAmount = Number(values.get("Amount"));
    const callbackPhone = normalizeKenyanPhoneNumber(String(values.get("PhoneNumber") ?? ""));
    const receipt = values.get("MpesaReceiptNumber");
    if (Math.round(callbackAmount * 100) !== payment.amount_cents ||
      callbackPhone !== payment.payer_phone ||
      typeof receipt !== "string" || !receipt) {
      console.error("Safaricom STK callback did not match the pending payment:", payment.merchant_reference);
      return res.status(400).json({ ResultCode: 1, ResultDesc: "Callback details did not match the payment request." });
    }

    try {
      const query = await daraja.queryStkPush(checkoutRequestId);
      if (String(query.ResultCode) !== "0") {
        return res.status(202).json({ ResultCode: 0, ResultDesc: "Payment is still being verified." });
      }
      const updated = store.updatePayment(payment.merchant_reference, {
        status: "completed",
        paymentMethod: "M-Pesa STK Push",
        confirmationCode: receipt,
      });
      if (!updated) return res.status(409).json({ ResultCode: 1, ResultDesc: "Payment was already finalized." });
      return res.json({ ResultCode: 0, ResultDesc: "Payment verified." });
    } catch (error) {
      console.error("Unable to verify Safaricom STK callback:", error instanceof Error ? error.message : "Unknown payment error");
      return res.status(503).json({ ResultCode: 1, ResultDesc: "Payment verification is temporarily unavailable." });
    }
  });

  app.get("/api/payments/:reference", (req, res) => {
    const payment = store.getPayment(req.params.reference);
    if (!payment) return res.status(404).json({ error: "Payment not found." });
    return res.json({
      reference: payment.merchant_reference,
      amount: payment.amount_cents / 100,
      currency: payment.currency,
      provider: payment.provider,
      status: payment.status,
      paymentMethod: payment.payment_method,
      confirmationCode: payment.confirmation_code,
      accountNumber: payment.provider === "manual_mpesa" ? MPESA_ACCOUNT_NUMBER : null,
      accountName: payment.provider === "manual_mpesa" ? MPESA_ACCOUNT_NAME : null,
    });
  });

  app.get("/api/admin/bookings", (req, res) => {
    if (!isAdminAuthorized(req, adminToken)) {
      return res.status(adminToken ? 401 : 503).json({
        error: adminToken ? "A valid admin bearer token is required." : "Booking management is not enabled until ADMIN_API_TOKEN is configured.",
      });
    }
    return res.json({ bookings: store.listBookings().map(serializeBooking) });
  });

  app.get("/api/admin/payments", (req, res) => {
    if (!isAdminAuthorized(req, adminToken)) {
      return res.status(adminToken ? 401 : 503).json({
        error: adminToken ? "A valid admin bearer token is required." : "Booking management is not enabled until ADMIN_API_TOKEN is configured.",
      });
    }
    return res.json({
      payments: store.listPayments().map((payment) => ({
        reference: payment.merchant_reference,
        bookingId: payment.booking_id,
        serviceName: payment.service_name,
        clientName: payment.client_name,
        clientEmail: payment.client_email,
        date: payment.local_date,
        time: payment.local_time,
        provider: payment.provider,
        amount: payment.amount_cents / 100,
        currency: payment.currency,
        status: payment.status,
        checkoutInitialized: Boolean(payment.checkout_url || payment.provider === "manual_mpesa"),
        payerPhone: payment.payer_phone,
        paymentMethod: payment.payment_method,
        confirmationCode: payment.confirmation_code,
        createdAt: payment.created_at,
        updatedAt: payment.updated_at,
      })),
    });
  });

  app.patch("/api/admin/bookings/:id", express.json(), (req, res) => {
    if (!isAdminAuthorized(req, adminToken)) {
      return res.status(adminToken ? 401 : 503).json({
        error: adminToken ? "A valid admin bearer token is required." : "Booking management is not enabled until ADMIN_API_TOKEN is configured.",
      });
    }
    const id = Number(req.params.id);
    const parsed = bookingStatusSchema.safeParse(req.body);
    if (!Number.isSafeInteger(id) || id < 1 || !parsed.success) {
      return res.status(400).json({ error: "Provide a valid booking ID and status." });
    }
    const booking = store.getBooking(id);
    if (!booking) return res.status(404).json({ error: "Active booking not found." });
    const requiredDeposit = Math.round(booking.price_cents * 0.5);
    if (parsed.data.status === "confirmed" && booking.status !== "confirmed" &&
      store.completedPaymentTotal(id) < requiredDeposit) {
      return res.status(409).json({ error: "Verify the 50% deposit before confirming this appointment." });
    }
    if (!store.updateBookingStatus(id, parsed.data.status)) {
      return res.status(404).json({ error: "Active booking not found." });
    }
    return res.json({ booking: serializeBooking(store.getBooking(id)) });
  });

  app.post("/api/admin/pesapal/ipn", (req, res) => {
    if (!isAdminAuthorized(req, adminToken)) {
      return res.status(adminToken ? 401 : 503).json({
        error: adminToken ? "A valid admin bearer token is required." : "Booking management is not enabled until ADMIN_API_TOKEN is configured.",
      });
    }
    if (!pesapal.canRegisterIpn) return res.status(503).json({ error: "Configure Pesapal credentials and PUBLIC_BASE_URL before registering the payment callback." });
    pesapal.registerIpn().then((result) => {
      if (typeof result.ipn_id !== "string" || !result.ipn_id) {
        throw new Error("Pesapal did not return an IPN registration ID.");
      }
      return res.json({ ipnId: result.ipn_id, instruction: "Set PESAPAL_IPN_ID to this value in the server environment, then restart the server." });
    }).catch((error) => {
      console.error("Unable to register Pesapal IPN:", error instanceof Error ? error.message : "Unknown payment error");
      if (!res.headersSent) res.status(502).json({ error: "Pesapal could not register the payment notification URL." });
    });
  });

  app.patch("/api/admin/payments/:reference", (req, res) => {
    if (!isAdminAuthorized(req, adminToken)) {
      return res.status(adminToken ? 401 : 503).json({
        error: adminToken ? "A valid admin bearer token is required." : "Booking management is not enabled until ADMIN_API_TOKEN is configured.",
      });
    }
    const parsed = paymentStatusSchema.safeParse(req.body);
    const payment = store.getPayment(req.params.reference);
    if (!payment || !parsed.success || (parsed.data.status === "completed" && payment.provider !== "manual_mpesa")) {
      return res.status(400).json({ error: "Provide a valid manual M-Pesa payment reference and status. Pesapal transactions must be verified by the provider." });
    }
    if (!store.updatePayment(payment.merchant_reference, { status: parsed.data.status })) {
      return res.status(409).json({ error: "This payment has already been finalized and cannot be changed." });
    }
    return res.json({ reference: payment.merchant_reference, status: parsed.data.status });
  });

  const publicFiles = new Map([
    ["/", "index.html"],
    ["/index.html", "index.html"],
    ["/about.html", "about.html"],
    ["/services.html", "services.html"],
    ["/web-development.html", "web-development.html"],
    ["/robotics-lectures.html", "robotics-lectures.html"],
    ["/computing-lectures.html", "computing-lectures.html"],
    ["/media-editing.html", "media-editing.html"],
    ["/contact.html", "contact.html"],
    ["/booking.html", "booking.html"],
    ["/payment-status.html", "payment-status.html"],
    ["/payment-status.js", "payment-status.js"],
    ["/styles.css", "styles.css"],
    ["/script.js", "script.js"],
    ["/site.js", "site.js"],
    ["/Eroll.png", "Eroll.png"],
  ]);
  for (const [route, filename] of publicFiles) {
    app.get(route, (_req, res) => res.sendFile(path.join(ROOT, filename)));
  }
  app.use("/api", (_req, res) => res.status(404).json({ error: "API endpoint not found." }));
  app.use((_req, res) => res.status(404).type("text").send("Not found."));
  app.use((error, _req, res, _next) => {
    if (error instanceof SyntaxError && "body" in error) {
      return res.status(400).json({ error: "Request body must be valid JSON." });
    }
    console.error("Unhandled request error:", error);
    return res.status(500).json({ error: "An unexpected server error occurred." });
  });

  return app;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const dbPath = path.resolve(ROOT, process.env.DB_PATH ?? "./data/bookings.sqlite");
  const store = createBookingStore(dbPath);
  const app = createApp({ store });
  const port = Number(process.env.PORT ?? 3000);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }

  const server = app.listen(port, () => {
    console.log(`Appointment site listening at http://localhost:${port}`);
  });
  const shutdown = () => server.close(() => {
    store.close();
    process.exit(0);
  });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
