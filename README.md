# Eroll Josephat appointment booking

## Run locally

Requires Node.js 22.13 or newer. From this directory:

```powershell
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). The server serves the frontend and the booking API from the same origin. Requests are stored in `data/bookings.sqlite`; set `DB_PATH` to a persistent writable location in deployment. Copy `.env.example` to `.env`; `npm start` and `npm run dev` load that file automatically. Set a strong `ADMIN_API_TOKEN` in `.env` to enable protected booking management.

The site has separate Home, About, Services, individual service-detail, Contact, and Booking pages. Service detail pages link directly to the booking form with the selected service prefilled. Public files are served through an explicit allowlist; project and database files are not exposed as static content.

### Deposits and payment methods

Bookings require a 50% deposit calculated from the server-owned service price. The manual M-Pesa option instructs clients to send the deposit to `0704437275`, M-Pesa name `EROLL JOSEPHAT`. Manual transfers stay pending until you verify them against your M-Pesa statement. Use the protected `PATCH /api/admin/payments/:reference` endpoint with `{"status":"completed"}` before confirming the appointment. Do not mark a payment complete based on a screenshot or browser redirect.

Pesapal API 3.0 hosted checkout is wired for card and M-Pesa methods enabled on your merchant account. Create and approve a Pesapal merchant account, set `PESAPAL_CONSUMER_KEY`, `PESAPAL_CONSUMER_SECRET`, and `PUBLIC_BASE_URL` (the deployed public HTTPS origin) in the server environment, and use `PESAPAL_ENVIRONMENT=sandbox` for testing. Then register this deployment's IPN by calling `POST /api/admin/pesapal/ipn` with the admin bearer token. Save the returned ID as `PESAPAL_IPN_ID` and restart the server. Only switch to production after successful sandbox tests and live merchant approval. The callback/IPN checks transaction status with Pesapal and match the provider tracking ID, unique merchant reference, amount, and currency before marking a deposit complete.

The booking form includes an M-Pesa STK Push radio option and Kenyan mobile-number input. When Daraja is configured, the server normalizes the number, calculates the deposit itself, and asks Safaricom to send the prompt; it verifies the callback against the stored phone and amount and confirms the result with the Daraja STK query endpoint before recording success. This integration uses the Paybill STK flow; a phone number by itself is not enough to initiate payment. Set `DARAJA_ENVIRONMENT=sandbox`, `DARAJA_CONSUMER_KEY`, `DARAJA_CONSUMER_SECRET`, an approved Safaricom Paybill shortcode in `DARAJA_SHORTCODE`, `DARAJA_PASSKEY`, and the deployed HTTPS callback URL (`DARAJA_CALLBACK_URL=https://your-domain/api/payments/daraja/callback`) in the server environment. The radio remains selectable so a user can enter their phone, but checkout is safely blocked with a setup notice until the required merchant configuration exists. Use Safaricom sandbox credentials for integration tests, then obtain production approval and credentials before switching `DARAJA_ENVIRONMENT=production`. Never expose provider credentials in frontend code or commit them.

### Email notifications

Booking notifications are addressed to `nyakwerieroll254@gmail.com`; the person booking also receives an acknowledgement. SMTP uses Gmail by default. Enable 2-Step Verification on that Google account, create an App Password in its Google Account security settings, and set the App Password as `SMTP_PASS` in `.env`. Never use your regular Gmail password, commit the App Password, or share it in chat. You can override the SMTP host, port, secure-connection setting, sender, and notification recipient using the `SMTP_*`, `EMAIL_FROM`, and `BOOKING_NOTIFICATION_EMAIL` settings in `.env.example`.

Restart the server after configuring SMTP. If email delivery fails, the booking remains saved, the server logs the delivery error, and the page tells the visitor that follow-up is needed. Without SMTP credentials, requests continue to be saved and the page clearly reports that email is not configured.

All four services are currently available on weekdays at 7:00 AM and 7:00 PM in the visitor's local timezone:

- Web Development: KSh 20,000 per project; a 60-minute consultation.
- Robotics lectures: KSh 2,000 per hour; clients can book 1–4 hours.
- Computing lectures: KSh 3,000 per hour; clients can book 1–4 hours.
- Media & Editing services: KSh 1,500 per hour; a 60-minute session.

Hourly lecture requests reserve the selected number of consecutive hours. The server is the source of truth for prices, durations, and appointment availability.

## API

- `GET /api/health` — process health.
- `GET /api/services` — server-owned service names, durations, and prices.
- `GET /api/availability?month=YYYY-MM&service=robotics-lectures&hours=2&timeZone=Africa%2FNairobi` — available weekday time slots for a service and requested duration.
- `POST /api/bookings` — validates a request and atomically saves it as `pending`. The JSON body contains `service`, `date` (`YYYY-MM-DD`), `time` (one of the returned slots), `timeZone` (IANA timezone), `name`, `email`, optional lecture `hours` (1–4), and an optional `note`.
- `GET /api/payment-options` — lists the deposit requirement, M-Pesa transfer instructions, and online checkout availability.
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
