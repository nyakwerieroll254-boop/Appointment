import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import Database from "better-sqlite3";
import { createApp, createBookingStore, createDarajaClient, createEmailTransport, createPesapalClient } from "./server.js";

const store = createBookingStore();
const deliveredEmails = [];
const app = createApp({
  store,
  adminToken: "test-admin-token",
  notificationEmail: "nyakwerieroll254@gmail.com",
  mailer: {
    sendMail: async (message) => {
      deliveredEmails.push(message);
      return { accepted: [message.to] };
    },
  },
});
let server;
let baseUrl;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  store.close();
});

test("serves the frontend and the canonical session catalog", async () => {
  const [home, services] = await Promise.all([
    fetch(`${baseUrl}/`),
    fetch(`${baseUrl}/api/services`),
  ]);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Ideas deserve/);
  assert.deepEqual(await services.json(), [
    {
      id: "web-development", name: "Web Development", durationMinutes: 60, price: 20000,
      currency: "KES", pricingUnit: "project", maximumHours: 1, priceLabel: "KSh 20,000 / project",
    },
    {
      id: "robotics-lectures", name: "Robotics lectures", durationMinutes: 60, price: 2000,
      currency: "KES", pricingUnit: "hour", maximumHours: 4, priceLabel: "KSh 2,000 / hour",
    },
    {
      id: "computing-lectures", name: "Computing lectures", durationMinutes: 60, price: 3000,
      currency: "KES", pricingUnit: "hour", maximumHours: 4, priceLabel: "KSh 3,000 / hour",
    },
    {
      id: "media-editing", name: "Media & Editing services", durationMinutes: 60, price: 1500,
      currency: "KES", pricingUnit: "hour", maximumHours: 1, priceLabel: "KSh 1,500 / hour",
    },
  ]);
});

test("serves every public page and asset without exposing project files", async () => {
  const pages = [
    ["/about.html", /ABOUT EROLL/],
    ["/services.html", /FOUR WAYS TO MOVE FORWARD/],
    ["/web-development.html", /Web Development/],
    ["/robotics-lectures.html", /Robotics Lectures/],
    ["/computing-lectures.html", /Computing Lectures/],
    ["/media-editing.html", /Media &amp; Editing/],
    ["/contact.html", /nyakwerieroll254@gmail\.com/],
    ["/booking.html", /Choose your service/],
    ["/payment-status.html", /Checking your payment/],
  ];
  const responses = await Promise.all(pages.map(([route]) => fetch(`${baseUrl}${route}`)));
  for (const [index, [route, content]] of pages.entries()) {
    assert.equal(responses[index].status, 200, `${route} should be served`);
    assert.match(await responses[index].text(), content);
  }
  for (const asset of ["/styles.css", "/site.js", "/script.js", "/payment-status.js", "/Eroll.png"]) {
    assert.equal((await fetch(`${baseUrl}${asset}`)).status, 200, `${asset} should be served`);
  }
  assert.equal((await fetch(`${baseUrl}/package.json`)).status, 404);
});

test("requires an SMTP password to enable email and rejects invalid SMTP ports", () => {
  assert.equal(createEmailTransport({}), null);
  assert.throws(
    () => createEmailTransport({ SMTP_PASS: "test-app-password", SMTP_PORT: "70000" }),
    /SMTP_PORT/,
  );
  const mailer = createEmailTransport({
    SMTP_HOST: "smtp.example.com",
    SMTP_PORT: "465",
    SMTP_USER: "sender@example.com",
    SMTP_PASS: "test-app-password",
  });
  assert.equal(typeof mailer.sendMail, "function");
});

test("creates Pesapal hosted orders and verifies their status through API 3.0", async () => {
  const requests = [];
  const client = createPesapalClient({
    env: {
      PESAPAL_ENVIRONMENT: "sandbox",
      PESAPAL_CONSUMER_KEY: "test-key",
      PESAPAL_CONSUMER_SECRET: "test-secret",
      PESAPAL_IPN_ID: "test-ipn-id",
      PUBLIC_BASE_URL: "https://appointments.example",
    },
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith("/api/Auth/RequestToken")) {
        return Response.json({ token: "temporary-token", expiryDate: new Date(Date.now() + 240_000).toISOString() });
      }
      if (String(url).endsWith("/api/Transactions/SubmitOrderRequest")) {
        return Response.json({ order_tracking_id: "provider-tracking-id", redirect_url: "https://cybqa.pesapal.com/checkout" });
      }
      return Response.json({
        merchant_reference: "deposit-reference",
        amount: 5000,
        currency: "KES",
        status_code: 1,
        payment_method: "Visa",
      });
    },
  });
  assert.equal(client.configured, true);
  const order = await client.createOrder({
    booking: { service_name: "Web Development", client_email: "client@example.com", client_name: "Client" },
    reference: "deposit-reference",
    amount: 5000,
  });
  assert.deepEqual(order, {
    trackingId: "provider-tracking-id",
    checkoutUrl: "https://cybqa.pesapal.com/checkout",
  });
  const submit = requests.find(({ url }) => url.endsWith("/api/Transactions/SubmitOrderRequest"));
  const requestBody = JSON.parse(submit.options.body);
  assert.equal(requestBody.amount, 5000);
  assert.equal(requestBody.currency, "KES");
  assert.equal(requestBody.callback_url, "https://appointments.example/api/payments/pesapal/callback");
  assert.equal(requestBody.notification_id, "test-ipn-id");
  const status = await client.getTransactionStatus(order.trackingId);
  assert.equal(status.status_code, 1);
  assert.equal(requests.filter(({ url }) => url.endsWith("/api/Auth/RequestToken")).length, 1);
});

test("creates Safaricom Daraja STK Push requests with normalized Kenyan numbers", async () => {
  const requests = [];
  const daraja = createDarajaClient({
    env: {
      DARAJA_ENVIRONMENT: "sandbox",
      DARAJA_CONSUMER_KEY: "test-key",
      DARAJA_CONSUMER_SECRET: "test-secret",
      DARAJA_SHORTCODE: "174379",
      DARAJA_PASSKEY: "test-passkey",
      DARAJA_CALLBACK_URL: "https://appointments.example/api/payments/daraja/callback",
    },
    now: () => new Date("2026-10-19T06:00:00.000Z"),
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url).includes("/oauth/v1/generate")) {
        return Response.json({ access_token: "daraja-test-token", expires_in: "3599" });
      }
      if (String(url).endsWith("/stkpush/v1/processrequest")) {
        return Response.json({
          ResponseCode: "0",
          CheckoutRequestID: "checkout-test-id",
          MerchantRequestID: "merchant-test-id",
          CustomerMessage: "Success. Request accepted for processing",
        });
      }
      return Response.json({ ResponseCode: "0", ResultCode: "0" });
    },
  });
  assert.equal(daraja.configured, true);
  const result = await daraja.requestStkPush({
    phoneNumber: "254712345678",
    amount: 5000,
    reference: "deposit-reference",
    description: "Deposit 12",
  });
  assert.deepEqual(result, {
    checkoutRequestId: "checkout-test-id",
    merchantRequestId: "merchant-test-id",
    customerMessage: "Success. Request accepted for processing",
  });
  const request = requests.find(({ url }) => url.endsWith("/stkpush/v1/processrequest"));
  const body = JSON.parse(request.options.body);
  assert.equal(body.BusinessShortCode, "174379");
  assert.equal(body.Amount, 5000);
  assert.equal(body.PhoneNumber, "254712345678");
  assert.equal(body.PartyA, "254712345678");
  assert.equal(body.AccountReference, "deposit-refe");
  assert.equal(body.Timestamp, "20261019090000");
  assert.equal(request.options.headers.authorization, "Bearer daraja-test-token");
  assert.equal(requests.filter(({ url }) => url.includes("/oauth/v1/generate")).length, 1);
});

test("rejects invalid Daraja STK inputs before contacting Safaricom", async () => {
  let requestCount = 0;
  const daraja = createDarajaClient({
    env: {
      DARAJA_ENVIRONMENT: "sandbox",
      DARAJA_CONSUMER_KEY: "test-key",
      DARAJA_CONSUMER_SECRET: "test-secret",
      DARAJA_SHORTCODE: "174379",
      DARAJA_PASSKEY: "test-passkey",
      DARAJA_CALLBACK_URL: "https://appointments.example/api/payments/daraja/callback",
    },
    fetchImpl: async () => {
      requestCount += 1;
      return Response.json({ access_token: "daraja-test-token", expires_in: "3599" });
    },
  });
  const validRequest = {
    phoneNumber: "254712345678",
    amount: 5000,
    reference: "deposit-reference",
    description: "Deposit 12",
  };

  await assert.rejects(
    daraja.requestStkPush({ ...validRequest, phoneNumber: "2547XXXXXXXX" }),
    /valid Kenyan mobile number/,
  );
  await assert.rejects(
    daraja.requestStkPush({ ...validRequest, amount: 0 }),
    /positive whole number/,
  );
  await assert.rejects(
    daraja.requestStkPush({ ...validRequest, amount: 1.5 }),
    /positive whole number/,
  );
  await assert.rejects(
    daraja.requestStkPush({ ...validRequest, reference: " " }),
    /reference and description are required/,
  );
  assert.equal(requestCount, 0);
});

test("verifies STK callbacks against the pending phone, amount, and Daraja query result", async () => {
  const paymentStore = createBookingStore();
  const paymentApp = createApp({
    store: paymentStore,
    mailer: null,
    daraja: {
      configured: true,
      requestStkPush: async () => ({
        checkoutRequestId: "checkout-test-id",
        merchantRequestId: "merchant-test-id",
        customerMessage: "Check your phone.",
      }),
      queryStkPush: async (checkoutRequestId) => {
        assert.equal(checkoutRequestId, "checkout-test-id");
        return { ResultCode: "0" };
      },
    },
  });
  const paymentServer = paymentApp.listen(0);

  try {
    await new Promise((resolve) => paymentServer.once("listening", resolve));
    const paymentUrl = `http://127.0.0.1:${paymentServer.address().port}`;
    const month = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC", year: "numeric", month: "2-digit",
    }).format(new Date()).slice(0, 7);
    const availabilityResponse = await fetch(
      `${paymentUrl}/api/availability?month=${month}&service=web-development&timeZone=UTC`,
    );
    const { days } = await availabilityResponse.json();
    const bookingResponse = await fetch(`${paymentUrl}/api/bookings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        service: "web-development",
        date: days[0].date,
        time: days[0].times[0],
        timeZone: "UTC",
        name: "STK client",
        email: "stk@example.com",
      }),
    });
    const { booking } = await bookingResponse.json();
    const paymentResponse = await fetch(`${paymentUrl}/api/payments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookingId: booking.id, method: "daraja_stk", phoneNumber: "0712345678" }),
    });
    assert.equal(paymentResponse.status, 201);
    const payment = await paymentResponse.json();
    assert.equal(payment.status, "pending");
    assert.equal(payment.phoneNumber, "+254712345678");

    const callbackBody = {
      Body: {
        stkCallback: {
          CheckoutRequestID: "checkout-test-id",
          ResultCode: 0,
          CallbackMetadata: {
            Item: [
              { Name: "Amount", Value: 10000 },
              { Name: "MpesaReceiptNumber", Value: "RCP12345" },
              { Name: "PhoneNumber", Value: 254712345678 },
            ],
          },
        },
      },
    };
    const mismatchedCallback = await fetch(`${paymentUrl}/api/payments/daraja/callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...callbackBody,
        Body: {
          stkCallback: {
            ...callbackBody.Body.stkCallback,
            CallbackMetadata: {
              Item: [
                { Name: "Amount", Value: 1 },
                { Name: "MpesaReceiptNumber", Value: "RCP12345" },
                { Name: "PhoneNumber", Value: 254712345678 },
              ],
            },
          },
        },
      }),
    });
    assert.equal(mismatchedCallback.status, 400);
    assert.equal(paymentStore.getPayment(payment.reference).status, "pending");

    const verifiedCallback = await fetch(`${paymentUrl}/api/payments/daraja/callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(callbackBody),
    });
    assert.equal(verifiedCallback.status, 200);
    const statusResponse = await fetch(`${paymentUrl}/api/payments/${encodeURIComponent(payment.reference)}`);
    const status = await statusResponse.json();
    assert.equal(status.status, "completed");
    assert.equal(status.confirmationCode, "RCP12345");
    assert.equal("payerPhone" in status, false);
  } finally {
    await new Promise((resolve, reject) => paymentServer.close((error) => error ? reject(error) : resolve()));
    paymentStore.close();
  }
});

test("returns only future weekday availability in the requested timezone", async () => {
  const month = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit",
  }).format(new Date()).slice(0, 7);
  for (const service of ["web-development", "robotics-lectures", "computing-lectures", "media-editing"]) {
    const response = await fetch(
      `${baseUrl}/api/availability?month=${month}&service=${service}&timeZone=America%2FLos_Angeles`,
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.timeZone, "America/Los_Angeles");
    assert.equal(result.service, service);
    assert.ok(result.days.length > 0);
    for (const day of result.days) {
      assert.match(day.date, /^\d{4}-\d{2}-\d{2}$/);
      const weekday = new Date(`${day.date}T00:00:00Z`).getUTCDay();
      assert.notEqual(weekday, 0);
      assert.notEqual(weekday, 6);
      assert.deepEqual(day.times, ["7:00 AM", "7:00 PM"]);
    }
  }

  for (const hours of [1, 2, 3, 4]) {
    const response = await fetch(
      `${baseUrl}/api/availability?month=${month}&service=robotics-lectures&hours=${hours}&timeZone=America%2FLos_Angeles`,
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).hours, hours);
  }
  const invalidDuration = await fetch(
    `${baseUrl}/api/availability?month=${month}&service=media-editing&hours=2&timeZone=America%2FLos_Angeles`,
  );
  assert.equal(invalidDuration.status, 400);
});

test("rejects malformed, past, and unsupported booking requests", async () => {
  const response = await fetch(`${baseUrl}/api/bookings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      service: "web-development",
      date: "2020-02-30",
      time: "7:00 AM",
      timeZone: "UTC",
      name: "Test client",
      email: "test@example.com",
    }),
  });
  assert.equal(response.status, 400);
  assert.equal(store.listBookings().length, 0);
});

test("rejects session times removed from the weekday schedule", async () => {
  const month = new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC", year: "numeric", month: "2-digit",
  }).format(new Date()).slice(0, 7);
  const availability = await fetch(
    `${baseUrl}/api/availability?month=${month}&service=web-development&timeZone=UTC`,
  );
  const { days } = await availability.json();
  const response = await fetch(`${baseUrl}/api/bookings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      service: "web-development",
      date: days[0].date,
      time: "9:00 AM",
      timeZone: "UTC",
      name: "Old schedule",
      email: "old-schedule@example.com",
    }),
  });
  assert.equal(response.status, 400);
  assert.equal(store.listBookings().length, 0);
});

test("charges lecture rates by selected hours and rejects invalid durations", async () => {
  const month = new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC", year: "numeric", month: "2-digit",
  }).format(new Date()).slice(0, 7);
  const availability = await fetch(
    `${baseUrl}/api/availability?month=${month}&service=robotics-lectures&hours=3&timeZone=UTC`,
  );
  const { days } = await availability.json();
  const booking = {
    service: "robotics-lectures",
    date: days[0].date,
    time: days[0].times[0],
    timeZone: "UTC",
    hours: 3,
    name: "Robotics student",
    email: "student@example.com",
  };
  const response = await fetch(`${baseUrl}/api/bookings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(booking),
  });
  assert.equal(response.status, 201);
  const { booking: saved } = await response.json();
  assert.equal(saved.serviceName, "Robotics lectures");
  assert.equal(saved.durationMinutes, 180);
  assert.equal(saved.price, 6000);
  assert.equal(saved.currency, "KES");
  assert.equal(saved.pricingUnit, "hour");
  assert.equal(saved.billableHours, 3);

  const mediaAvailability = await fetch(
    `${baseUrl}/api/availability?month=${month}&service=media-editing&timeZone=UTC`,
  );
  const mediaDays = (await mediaAvailability.json()).days;
  const mediaDay = mediaDays.find((day) => day.date !== days[0].date) ?? mediaDays[0];
  const mediaTime = mediaDay.times[0];
  const mediaResponse = await fetch(`${baseUrl}/api/bookings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      service: "media-editing",
      date: mediaDay.date,
      time: mediaTime,
      timeZone: "UTC",
      name: "Media client",
      email: "media@example.com",
    }),
  });
  assert.equal(mediaResponse.status, 201);
  const { booking: mediaBooking } = await mediaResponse.json();
  assert.equal(mediaBooking.price, 1500);
  assert.equal(mediaBooking.durationMinutes, 60);
  assert.equal(mediaBooking.pricingUnit, "hour");
  assert.equal(mediaBooking.billableHours, 1);

  const invalid = await fetch(`${baseUrl}/api/bookings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...booking, hours: 5 }),
  });
  assert.equal(invalid.status, 400);
});

test("persists a web development project request and rejects overlapping bookings", async () => {
  const month = new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC", year: "numeric", month: "2-digit",
  }).format(new Date()).slice(0, 7);
  const availability = await fetch(
    `${baseUrl}/api/availability?month=${month}&service=web-development&timeZone=UTC`,
  );
  const { days } = await availability.json();
  assert.ok(days.length > 0);
  const booking = {
    service: "web-development",
    date: days[0].date,
    time: days[0].times[0],
    timeZone: "UTC",
    name: "Test client",
    email: "test@example.com",
    note: "A <script>alert('x')</script> project brief",
  };
  const bookingsBefore = store.listBookings().length;
  const emailsBefore = deliveredEmails.length;

  const createRequest = () => fetch(`${baseUrl}/api/bookings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(booking),
  });
  const concurrentRequests = await Promise.all([createRequest(), createRequest()]);
  assert.deepEqual(concurrentRequests.map((response) => response.status).sort(), [201, 409]);
  const created = concurrentRequests.find((response) => response.status === 201);
  const createResponse = await created.json();
  const { booking: saved } = createResponse;
  assert.equal(saved.name, booking.name);
  assert.equal(saved.status, "pending");
  assert.equal(saved.timeZone, booking.timeZone);
  assert.equal(saved.price, 20000);
  assert.equal(saved.currency, "KES");
  assert.equal(saved.pricingUnit, "project");
  assert.equal(saved.durationMinutes, 60);
  assert.equal(createResponse.notificationStatus, "sent");
  assert.equal(deliveredEmails.length - emailsBefore, 2);
  const [ownerEmail, clientEmail] = deliveredEmails.slice(emailsBefore);
  assert.equal(ownerEmail.to, "nyakwerieroll254@gmail.com");
  assert.equal(ownerEmail.replyTo, booking.email);
  assert.equal(clientEmail.to, booking.email);
  assert.ok(ownerEmail.html.includes("&lt;script&gt;"));
  assert.ok(!ownerEmail.html.includes("<script>"));
  assert.equal(store.listBookings().length, bookingsBefore + 1);

  const overlap = await fetch(`${baseUrl}/api/bookings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...booking, service: "media-editing" }),
  });
  assert.equal(overlap.status, 409);

  const refreshedAvailability = await fetch(
    `${baseUrl}/api/availability?month=${month}&service=web-development&timeZone=UTC`,
  );
  const refreshedDays = (await refreshedAvailability.json()).days;
  assert.equal(refreshedDays.find((day) => day.date === booking.date)?.times.includes(booking.time) ?? false, false);
});

test("protects booking management and supports confirmation and cancellation", async () => {
  const denied = await fetch(`${baseUrl}/api/admin/bookings`);
  assert.equal(denied.status, 401);
  const authorized = await fetch(`${baseUrl}/api/admin/bookings`, {
    headers: { authorization: "Bearer test-admin-token" },
  });
  assert.equal(authorized.status, 200);
  const { bookings } = await authorized.json();
  assert.equal(bookings.length, 3);

  const paymentResponse = await fetch(`${baseUrl}/api/payments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bookingId: bookings[0].id, method: "manual_mpesa" }),
  });
  assert.equal(paymentResponse.status, 201);
  const manualPayment = await paymentResponse.json();
  assert.equal(manualPayment.amount, bookings[0].price * 0.5);
  assert.equal(manualPayment.accountNumber, "0704437275");
  assert.equal(manualPayment.accountName, "EROLL JOSEPHAT");

  const unverifiedConfirmation = await fetch(`${baseUrl}/api/admin/bookings/${bookings[0].id}`, {
    method: "PATCH",
    headers: { authorization: "Bearer test-admin-token", "content-type": "application/json" },
    body: JSON.stringify({ status: "confirmed" }),
  });
  assert.equal(unverifiedConfirmation.status, 409);
  const verifiedPayment = await fetch(`${baseUrl}/api/admin/payments/${manualPayment.reference}`, {
    method: "PATCH",
    headers: { authorization: "Bearer test-admin-token", "content-type": "application/json" },
    body: JSON.stringify({ status: "completed" }),
  });
  assert.equal(verifiedPayment.status, 200);
  const paymentStatus = await fetch(`${baseUrl}/api/payments/${manualPayment.reference}`);
  assert.equal((await paymentStatus.json()).status, "completed");

  const confirmed = await fetch(`${baseUrl}/api/admin/bookings/${bookings[0].id}`, {
    method: "PATCH",
    headers: { authorization: "Bearer test-admin-token", "content-type": "application/json" },
    body: JSON.stringify({ status: "confirmed" }),
  });
  assert.equal((await confirmed.json()).booking.status, "confirmed");

  const cancelled = await fetch(`${baseUrl}/api/admin/bookings/${bookings[0].id}`, {
    method: "PATCH",
    headers: { authorization: "Bearer test-admin-token", "content-type": "application/json" },
    body: JSON.stringify({ status: "cancelled" }),
  });
  assert.equal((await cancelled.json()).booking.status, "cancelled");
});

test("reports manual M-Pesa availability and keeps automated payment disabled without credentials", async () => {
  const response = await fetch(`${baseUrl}/api/payment-options`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    depositPercent: 50,
    manualMpesa: { available: true, accountNumber: "0704437275", accountName: "EROLL JOSEPHAT" },
    onlineCheckout: { available: false, provider: "Pesapal", methods: ["M-Pesa", "Card"] },
    darajaStkPush: {
      available: false,
      reason: "A Safaricom Paybill shortcode, Daraja credentials and passkey, and a public HTTPS callback URL are required.",
    },
  });
});

test("persists a Pesapal deposit and verifies callbacks against the provider status", async () => {
  const paymentStore = createBookingStore();
  let submittedReference = "";
  let submittedAmount = 0;
  const paymentApp = createApp({
    store: paymentStore,
    adminToken: "payment-admin-token",
    mailer: null,
    pesapal: {
      configured: true,
      canRegisterIpn: false,
      createOrder: async ({ reference, amount }) => {
        submittedReference = reference;
        submittedAmount = amount;
        return { trackingId: "trusted-tracking-id", checkoutUrl: "https://checkout.example/pay" };
      },
      getTransactionStatus: async () => ({
        merchant_reference: submittedReference,
        amount: submittedAmount,
        currency: "KES",
        status_code: 1,
        payment_method: "Visa",
        confirmation_code: "PAYMENT-CODE",
      }),
    },
  });

  test("prevents duplicate attempts after ambiguous Pesapal initialization failures", async () => {
    const paymentStore = createBookingStore();
    const paymentApp = createApp({
      store: paymentStore,
      mailer: null,
      pesapal: {
        configured: true,
        canRegisterIpn: false,
        createOrder: async () => { throw new Error("Provider request timed out after submission."); },
        getTransactionStatus: async () => { throw new Error("not expected"); },
      },
    });
    const paymentServer = paymentApp.listen(0);

    try {
      await new Promise((resolve) => paymentServer.once("listening", resolve));
      const paymentUrl = `http://127.0.0.1:${paymentServer.address().port}`;
      const month = new Intl.DateTimeFormat("en-CA", {
        timeZone: "UTC", year: "numeric", month: "2-digit",
      }).format(new Date()).slice(0, 7);
      const availabilityResponse = await fetch(
        `${paymentUrl}/api/availability?month=${month}&service=web-development&timeZone=UTC`,
      );
      const { days } = await availabilityResponse.json();
      const bookingResponse = await fetch(`${paymentUrl}/api/bookings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          service: "web-development",
          date: days[0].date,
          time: days[0].times[0],
          timeZone: "UTC",
          name: "Retry safety",
          email: "retry-safety@example.com",
        }),
      });
      const { booking } = await bookingResponse.json();
      const requestPayment = () => fetch(`${paymentUrl}/api/payments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bookingId: booking.id, method: "pesapal" }),
      });
      const firstAttempt = await requestPayment();
      assert.equal(firstAttempt.status, 502);
      const firstResult = await firstAttempt.json();
      assert.ok(firstResult.reference);
      assert.equal(firstResult.status, "pending");
      const secondAttempt = await requestPayment();
      assert.equal(secondAttempt.status, 409);
      assert.equal(paymentStore.listPayments().length, 1);
    } finally {
      await new Promise((resolve, reject) => paymentServer.close((error) => error ? reject(error) : resolve()));
      paymentStore.close();
    }
  });
  const paymentServer = paymentApp.listen(0);

  try {
    await new Promise((resolve) => paymentServer.once("listening", resolve));
    const paymentUrl = `http://127.0.0.1:${paymentServer.address().port}`;
    const month = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC", year: "numeric", month: "2-digit",
    }).format(new Date()).slice(0, 7);
    const availabilityResponse = await fetch(
      `${paymentUrl}/api/availability?month=${month}&service=web-development&timeZone=UTC`,
    );
    const { days } = await availabilityResponse.json();
    const bookingResponse = await fetch(`${paymentUrl}/api/bookings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        service: "web-development",
        date: days[0].date,
        time: days[0].times[0],
        timeZone: "UTC",
        name: "Deposit client",
        email: "deposit@example.com",
      }),
    });
    const { booking } = await bookingResponse.json();
    const checkoutResponse = await fetch(`${paymentUrl}/api/payments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookingId: booking.id, method: "pesapal" }),
    });
    assert.equal(checkoutResponse.status, 201);
    const checkout = await checkoutResponse.json();
    assert.equal(checkout.amount, 10000);
    assert.equal(checkout.checkoutUrl, "https://checkout.example/pay");

    const competingMethod = await fetch(`${paymentUrl}/api/payments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookingId: booking.id, method: "manual_mpesa" }),
    });
    assert.equal(competingMethod.status, 409);
    assert.equal(paymentStore.listPayments().length, 1);

    const callbackResponse = await fetch(
      `${paymentUrl}/api/payments/pesapal/callback?OrderTrackingId=trusted-tracking-id&OrderMerchantReference=${encodeURIComponent(checkout.reference)}`,
      { redirect: "manual" },
    );
    assert.equal(callbackResponse.status, 303);
    const statusResponse = await fetch(`${paymentUrl}/api/payments/${encodeURIComponent(checkout.reference)}`);
    const status = await statusResponse.json();
    assert.equal(status.status, "completed");
    assert.equal(status.paymentMethod, "Visa");
    assert.equal(status.confirmationCode, "PAYMENT-CODE");

    const adminPayments = await fetch(`${paymentUrl}/api/admin/payments`, {
      headers: { authorization: "Bearer payment-admin-token" },
    });
    assert.equal(adminPayments.status, 200);
    const paymentList = await adminPayments.json();
    assert.equal(paymentList.payments[0].reference, checkout.reference);
    assert.equal(paymentList.payments[0].clientEmail, "deposit@example.com");

    const confirmResponse = await fetch(`${paymentUrl}/api/admin/bookings/${booking.id}`, {
      method: "PATCH",
      headers: { authorization: "Bearer payment-admin-token", "content-type": "application/json" },
      body: JSON.stringify({ status: "confirmed" }),
    });
    assert.equal(confirmResponse.status, 200);
    const duplicateDeposit = await fetch(`${paymentUrl}/api/payments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookingId: booking.id, method: "pesapal" }),
    });
    assert.equal(duplicateDeposit.status, 409);
  } finally {
    await new Promise((resolve, reject) => paymentServer.close((error) => error ? reject(error) : resolve()));
    paymentStore.close();
  }
});

test("keeps a saved booking and reports notification failures", async () => {
  const notificationStore = createBookingStore();
  const notificationApp = createApp({
    store: notificationStore,
    notificationEmail: "nyakwerieroll254@gmail.com",
    mailer: { sendMail: async () => { throw new Error("SMTP unavailable"); } },
  });
  const notificationServer = notificationApp.listen(0);

  try {
    await new Promise((resolve) => notificationServer.once("listening", resolve));
    const notificationUrl = `http://127.0.0.1:${notificationServer.address().port}`;
    const month = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC", year: "numeric", month: "2-digit",
    }).format(new Date()).slice(0, 7);
    const availabilityResponse = await fetch(
      `${notificationUrl}/api/availability?month=${month}&service=web-development&timeZone=UTC`,
    );
    const { days } = await availabilityResponse.json();
    const response = await fetch(`${notificationUrl}/api/bookings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        service: "web-development",
        date: days[0].date,
        time: days[0].times[0],
        timeZone: "UTC",
        name: "Mail test",
        email: "mail-test@example.com",
      }),
    });
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.notificationStatus, "failed");
    assert.match(result.message, /request is saved/);
    assert.equal(notificationStore.listBookings().length, 1);
  } finally {
    await new Promise((resolve, reject) => notificationServer.close((error) => error ? reject(error) : resolve()));
    notificationStore.close();
  }
});

test("persists bookings when the SQLite store is reopened", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "appointment-store-"));
  const dbPath = path.join(directory, "bookings.sqlite");
  let persistentStore = createBookingStore(dbPath);

  try {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + 7);
    while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() + 1);
    const localDate = date.toISOString().slice(0, 10);
    const startMs = Date.parse(`${localDate}T07:00:00.000Z`);
    const id = persistentStore.createBooking({
      service: "robotics-lectures",
      date: localDate,
      time: "7:00 AM",
      timeZone: "UTC",
      name: "Persistent client",
      email: "persistent@example.com",
      note: "",
      hours: 1,
      startMs,
    });

    persistentStore.close();
    persistentStore = createBookingStore(dbPath);
    assert.equal(persistentStore.getBooking(id).client_name, "Persistent client");
  } finally {
    persistentStore.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("migrates existing payment rows to allow Daraja STK Push", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "appointment-payment-migration-"));
  const dbPath = path.join(directory, "bookings.sqlite");
  const legacyDb = new Database(dbPath);

  try {
    legacyDb.exec(`
      CREATE TABLE bookings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service TEXT NOT NULL,
        service_name TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL,
        price_cents INTEGER NOT NULL,
        client_name TEXT NOT NULL,
        client_email TEXT NOT NULL,
        client_note TEXT NOT NULL DEFAULT '',
        local_date TEXT NOT NULL,
        local_time TEXT NOT NULL,
        time_zone TEXT NOT NULL,
        start_at TEXT NOT NULL,
        end_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_id INTEGER NOT NULL REFERENCES bookings(id),
        merchant_reference TEXT NOT NULL UNIQUE,
        tracking_id TEXT UNIQUE,
        provider TEXT NOT NULL CHECK (provider IN ('manual_mpesa', 'pesapal')),
        amount_cents INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'KES',
        status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'reversed')),
        checkout_url TEXT,
        payment_method TEXT,
        confirmation_code TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      INSERT INTO bookings (
        id, service, service_name, duration_minutes, price_cents, client_name,
        client_email, local_date, local_time, time_zone, start_at, end_at
      ) VALUES (
        1, 'web-development', 'Web Development', 60, 2000000, 'Legacy client',
        'legacy@example.com', '2026-10-26', '7:00 AM', 'UTC',
        '2026-10-26T07:00:00.000Z', '2026-10-26T08:00:00.000Z'
      );
      INSERT INTO payments (booking_id, merchant_reference, provider, amount_cents, status)
      VALUES (1, 'legacy-reference', 'manual_mpesa', 1000000, 'pending');
      CREATE INDEX bookings_start_status_idx ON bookings(status, start_at, end_at);
      CREATE INDEX payments_booking_idx ON payments(booking_id, created_at);
    `);
  } finally {
    legacyDb.close();
  }

  let store;
  try {
    store = createBookingStore(dbPath);
    assert.equal(store.getPayment("legacy-reference").provider, "manual_mpesa");
    assert.equal(store.getPayment("legacy-reference").amount_cents, 1000000);
    const nextDate = new Date();
    nextDate.setUTCDate(nextDate.getUTCDate() + 14);
    while (nextDate.getUTCDay() === 0 || nextDate.getUTCDay() === 6) nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    const localDate = nextDate.toISOString().slice(0, 10);
    const bookingId = store.createBooking({
      service: "web-development",
      date: localDate,
      time: "7:00 AM",
      timeZone: "UTC",
      name: "New STK client",
      email: "new-stk@example.com",
      note: "",
      hours: 1,
      startMs: Date.parse(`${localDate}T07:00:00.000Z`),
    });
    const payment = store.beginPayment({
      bookingId,
      reference: "new-daraja-reference",
      provider: "daraja_stk",
      amountCents: 1000000,
      payerPhone: "254712345678",
    });
    assert.equal(payment.created, true);
    assert.equal(store.getPayment("new-daraja-reference").payer_phone, "254712345678");
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
