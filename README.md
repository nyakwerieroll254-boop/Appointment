# Eroll Josephat appointment booking

## Run locally

Requires Node.js 22.13 or newer. From this directory:

```powershell
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). The server serves the frontend and the booking API from the same origin. Requests are stored in `data/bookings.sqlite`; set `DB_PATH` to a persistent writable location in deployment. Copy `.env.example` to `.env`; `npm start` and `npm run dev` load that file automatically. Set a strong `ADMIN_API_TOKEN` in `.env` to enable protected booking management.

The site has separate Home, About, Services, individual service-detail, Contact, and Booking pages. Service detail pages link directly to the booking form with the selected service prefilled. Public files are served through an explicit allowlist; project and database files are not exposed as static content.

## Deploy on Render

This repository includes a Render Blueprint in `render.yaml`. Push the project to a GitHub repository, then in the Render Dashboard choose **New → Blueprint**, connect that repository, and deploy the Blueprint. It creates a Node web service with `/api/health` as its health check, a generated `ADMIN_API_TOKEN`, and a 1 GB persistent disk mounted at `/var/data` for the SQLite database. The service uses Render's paid Starter plan because SQLite data on a service without a persistent disk would be lost on restart or redeploy. The attached disk supports only one service instance; do not scale this SQLite deployment horizontally.

Render provides `RENDER_EXTERNAL_URL` at runtime. Pesapal and Daraja use it to build their HTTPS callback URLs automatically; set `PUBLIC_BASE_URL` or `DARAJA_CALLBACK_URL` in the service environment only if you need to override the Render URL. Payment integrations and Africa's Talking are set to sandbox in the Blueprint. Before accepting real payments or sending live SMS messages, add provider credentials in the Render service's environment, test in sandbox, and switch to production only after provider approval. Add SMTP and Africa's Talking credentials in the Render Dashboard to enable email and SMS notifications. Never put secrets in `render.yaml` or source control.

After the first deployment, use the Render service URL to check `/api/health`. Keep the generated admin token private. Back up the SQLite database and disk before making changes that could affect stored bookings.

### Deposits and payment methods

Deposits are optional. The default **Book now — no deposit** option confirms and reserves the appointment immediately without creating a payment attempt. Choosing a payment method instead saves the booking as pending while payment is verified. The manual M-Pesa option instructs clients to send the optional deposit to `0704437275`, M-Pesa name `EROLL JOSEPHAT`. Manual transfers stay pending until you verify them against your M-Pesa statement. Use the protected `PATCH /api/admin/payments/:reference` endpoint with `{"status":"completed"}` before confirming a deposit-based appointment. Do not mark a payment complete based on a screenshot or browser redirect.

Pesapal API 3.0 hosted checkout is wired for card and M-Pesa methods enabled on your merchant account. Create and approve a Pesapal merchant account, set `PESAPAL_CONSUMER_KEY`, `PESAPAL_CONSUMER_SECRET`, and `PUBLIC_BASE_URL` (the deployed public HTTPS origin) in the server environment, and use `PESAPAL_ENVIRONMENT=sandbox` for testing. Then register this deployment's IPN by calling `POST /api/admin/pesapal/ipn` with the admin bearer token. Save the returned ID as `PESAPAL_IPN_ID` and restart the server. Only switch to production after successful sandbox tests and live merchant approval. The callback/IPN checks transaction status with Pesapal and match the provider tracking ID, unique merchant reference, amount, and currency before marking a deposit complete.

The booking form includes an M-Pesa STK Push option and a Kenyan mobile-number field used for both booking SMS and an optional STK prompt. When Daraja is configured, the server normalizes the number, calculates the deposit itself, and asks Safaricom to send the prompt; it verifies the callback against the stored phone and amount and confirms the result with the Daraja STK query endpoint before recording success. This integration uses the Paybill STK flow; a phone number by itself is not enough to initiate payment. Set `DARAJA_ENVIRONMENT=sandbox`, `DARAJA_CONSUMER_KEY`, `DARAJA_CONSUMER_SECRET`, an approved Safaricom Paybill shortcode in `DARAJA_SHORTCODE`, `DARAJA_PASSKEY`, and the deployed HTTPS callback URL (`DARAJA_CALLBACK_URL=https://your-domain/api/payments/daraja/callback`) in the server environment. STK checkout is safely blocked with a setup notice until the required merchant configuration exists. Use Safaricom sandbox credentials for integration tests, then obtain production approval and credentials before switching `DARAJA_ENVIRONMENT=production`. Never expose provider credentials in frontend code or commit them.

### Email and SMS notifications

Each booking requires an email address and Kenyan mobile number. The backend saves the phone, appointment status, and email/SMS notification status in SQLite and returns these fields to the protected admin booking endpoint. The client and `nyakwerieroll254@gmail.com` receive booking emails; the client receives an SMS through Africa's Talking. Confirmed bookings receive a confirmation message; bookings choosing a deposit are told they are pending and the deposit is optional.

For email, enable 2-Step Verification on the Gmail account, create an App Password in its Google Account security settings, and set it as `SMTP_PASS` in `.env`. Never use the regular Gmail password, commit the App Password, or share it in chat. Override SMTP host, port, secure-connection setting, sender, and notification recipient using the `SMTP_*`, `EMAIL_FROM`, and `BOOKING_NOTIFICATION_EMAIL` settings.

For SMS, set `AFRICASTALKING_ENVIRONMENT=sandbox`, `AFRICASTALKING_USERNAME`, and `AFRICASTALKING_API_KEY`; set `AFRICASTALKING_SENDER_ID` only if Africa's Talking has approved one for your account. Sandbox messages go through Africa's Talking's sandbox and are not live delivery. After approval, configure production credentials and `AFRICASTALKING_ENVIRONMENT=production` in the server environment. Keep all provider keys out of browser code and source control.

For Render, enter the Gmail App Password for `SMTP_PASS`, and your Africa's Talking sandbox username and API key for `AFRICASTALKING_USERNAME` and `AFRICASTALKING_API_KEY` when creating or updating the Blueprint. Keep `AFRICASTALKING_ENVIRONMENT=sandbox` until live credentials and account approval are ready. Restart/redeploy after setting values. The application code and Blueprint fields are prepared, but email and SMS cannot be delivered until these provider credentials are supplied. Failed or unconfigured delivery does not undo a booking: notification state is saved in the backend, server logs delivery failures, and the booking response clearly reports channel status so follow-up can happen.

All four services are available on weekdays with hourly start times beginning at 7:00 AM. Appointments must finish by 7:00 PM in the visitor's local timezone. One-hour appointments can start from 7:00 AM through 6:00 PM; multi-hour lecture start times are narrowed so the selected consecutive hours finish by 7:00 PM.

- Web Development: KSh 20,000 per project; a 60-minute consultation.
- Robotics lectures: KSh 2,000 per hour; clients can book 1–4 hours.
- Computing lectures: KSh 3,000 per hour; clients can book 1–4 hours.
- Media & Editing services: KSh 1,500 per hour; a 60-minute session.

Hourly lecture requests reserve the selected number of consecutive hours. The server is the source of truth for prices, durations, and appointment availability.

## API

- `GET /api/health` — process health.
- `GET /api/services` — server-owned service names, durations, and prices.
- `GET /api/availability?month=YYYY-MM&service=robotics-lectures&hours=2&timeZone=Africa%2FNairobi` — hourly weekday start times for the service and duration, filtered so the appointment ends by 7:00 PM.
- `POST /api/bookings` — validates and atomically saves a booking. The body contains `service`, `date` (`YYYY-MM-DD`), `time`, `timeZone` (IANA timezone), `name`, `email`, Kenyan `phoneNumber`, optional lecture `hours` (1–4), optional `note`, and `depositMethod` (`none`, `manual_mpesa`, `pesapal`, or `daraja_stk`). `none` is the default and confirms the booking immediately without payment; selecting a deposit method creates a pending booking.
- `GET /api/payment-options` — lists deposit optionality, M-Pesa transfer instructions, and online checkout availability.
- `POST /api/payments` — creates a manual M-Pesa deposit, Pesapal hosted checkout, or Safaricom STK Push. Body: `{"bookingId":1,"method":"manual_mpesa"}`, `{"bookingId":1,"method":"pesapal"}`, or `{"bookingId":1,"method":"daraja_stk","phoneNumber":"0712345678"}`.
- `GET /api/payments/:reference` — checks deposit status using its unguessable payment reference.
- `GET /api/payments/pesapal/callback` and `/api/payments/pesapal/ipn` — hosted-checkout return and server-to-server notification endpoints.
- `POST /api/payments/daraja/callback` — Safaricom STK result callback; payment status is verified with Daraja before recording success.
- `GET /api/admin/bookings` — list requests; requires `Authorization: Bearer <ADMIN_API_TOKEN>`.
- `GET /api/admin/payments` — list payment attempts with booking details; requires the admin token.
- `PATCH /api/admin/bookings/:id` — change a request to `confirmed` or `cancelled`; requires the same admin token.
- `PATCH /api/admin/payments/:reference` — manually mark an M-Pesa payment `completed` or `failed`; requires the admin token.
- `POST /api/admin/pesapal/ipn` — register this deployment's IPN URL with Pesapal; requires the admin token.

Set a long, randomly generated `ADMIN_API_TOKEN` before exposing the admin API. Keep it private; do not put it in frontend code or commit it. The API never exposes admin endpoints without a configured token.

The public booking endpoint is rate limited, validates all prices and appointment times on the server, rejects conflicting or overlapping active bookings, and uses SQLite transactions for concurrent requests. Configure backups and persistent storage appropriate to your hosting provider before production use.

Run the backend tests with `npm test`.
