const params = new URLSearchParams(window.location.search);
const reference = params.get("reference");
const heading = document.querySelector("#payment-heading");
const message = document.querySelector("#payment-message");
const details = document.querySelector("#payment-details");
const note = document.querySelector("#payment-status-note");
let statusPolls = 0;

function formatPrice(amount, currency) {
  return currency === "KES"
    ? `KSh ${new Intl.NumberFormat("en-KE", { maximumFractionDigits: 0 }).format(amount)}`
    : `${amount} ${currency}`;
}

async function loadPaymentStatus() {
  if (!reference) {
    heading.textContent = "Payment reference missing";
    message.textContent = "Open the payment status page from your booking confirmation or contact Eroll for help.";
    return;
  }

  try {
    const response = await fetch(`/api/payments/${encodeURIComponent(reference)}`, {
      headers: { accept: "application/json" },
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Payment status could not be loaded.");

    details.hidden = false;
    document.querySelector("#payment-status-amount").textContent = formatPrice(result.amount, result.currency);
    document.querySelector("#payment-status-method").textContent =
      result.provider === "manual_mpesa"
        ? "M-Pesa (manual verification)"
        : result.provider === "daraja_stk"
          ? "M-Pesa STK Push"
          : result.paymentMethod || "Pesapal checkout";
    document.querySelector("#payment-status-value").textContent = result.status;
    document.querySelector("#payment-status-reference").textContent = result.reference;
    if (result.provider === "manual_mpesa" && result.status === "pending") {
      document.querySelector("#payment-status-account-row").hidden = false;
    }
    if (result.confirmationCode) {
      document.querySelector("#payment-status-confirmation-row").hidden = false;
      document.querySelector("#payment-status-confirmation").textContent = result.confirmationCode;
    }

    const messages = {
      pending: ["Deposit awaiting verification", "Your 50% deposit is not confirmed yet. The appointment remains pending until the payment is verified."],
      completed: ["Deposit payment confirmed", "Your 50% deposit was verified. Eroll will follow up to confirm the appointment details."],
      failed: ["Payment was not completed", "No successful payment was recorded. You can return to booking or contact Eroll for help."],
      reversed: ["Payment was reversed", "The payment provider reports this transaction as reversed. Contact Eroll before making another payment."],
    };
    [heading.textContent, message.textContent] = messages[result.status] ?? messages.pending;
    if (result.provider === "manual_mpesa" && result.status === "pending") {
      note.textContent = `If you have already paid, allow time for verification. The M-Pesa deposit is ${formatPrice(result.amount, result.currency)} to 0704437275, account name EROLL JOSEPHAT.`;
    } else if (result.provider === "daraja_stk" && result.status === "pending") {
      note.textContent = `A Safaricom STK Push was sent to your phone. Enter your M-Pesa PIN to approve ${formatPrice(result.amount, result.currency)}. This page will check for the provider confirmation.`;
    }
    if (result.provider === "daraja_stk" && result.status === "pending" && statusPolls < 24) {
      statusPolls += 1;
      window.setTimeout(loadPaymentStatus, 5000);
    }
  } catch (error) {
    heading.textContent = "Unable to check payment";
    message.textContent = error instanceof Error ? error.message : "Payment status could not be loaded.";
  }
}

loadPaymentStatus();
