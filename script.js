const serviceSelect = document.querySelector("#service");
const calendarDays = document.querySelector("#calendar-days");
const monthLabel = document.querySelector("#month-label");
const selectedDateLabel = document.querySelector("#selected-date-label");
const timeList = document.querySelector("#time-list");
const timeHint = document.querySelector("#time-hint");
const timezoneName = document.querySelector("#timezone-name");
const bookingForm = document.querySelector("#booking-form");
const submitButton = document.querySelector("#submit-button");
const hoursField = document.querySelector("#hours-field");
const hoursSelect = document.querySelector("#hours");
const confirmation = document.querySelector("#confirmation");
const previousMonthButton = document.querySelector("#previous-month");
const nextMonthButton = document.querySelector("#next-month");
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const today = new Date();
today.setHours(0, 0, 0, 0);
const firstBookableMonth = new Date(today.getFullYear(), today.getMonth(), 1);
const lastBookableMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
const lastBookableDate = new Date(today.getFullYear(), today.getMonth() + 2, 0);
let visibleMonth = new Date(firstBookableMonth);
let selectedDate = "";
let selectedTime = "";
let availability = new Map();
let availabilityRequest = 0;
let availabilityLoading = false;
let darajaStkAvailable = false;
let savedFocusTarget = submitButton;

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseDate(key) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function formatDate(date, options) {
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

function announceAvailability(message) {
  timeHint.textContent = message;
}

function renderCalendar() {
  const year = visibleMonth.getFullYear();
  const month = visibleMonth.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];

  monthLabel.textContent = formatDate(visibleMonth, { month: "long", year: "numeric" });
  previousMonthButton.disabled = visibleMonth <= firstBookableMonth;
  nextMonthButton.disabled = visibleMonth >= lastBookableMonth;

  for (let index = 0; index < firstDay; index += 1) {
    cells.push('<span class="day-button outside" aria-hidden="true"></span>');
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month, day);
    const key = dateKey(date);
    const hasAvailableTimes = availability.has(key);
    const isBookableDate = date >= today && date <= lastBookableDate && date.getDay() !== 0 && date.getDay() !== 6;
    const isSelected = key === selectedDate;
    const classes = [
      "day-button",
      isBookableDate ? "bookable" : "",
      isSelected ? "selected" : "",
    ].filter(Boolean).join(" ");
    const label = formatDate(date, { weekday: "long", month: "long", day: "numeric" });
    const availabilityLabel = isBookableDate
      ? hasAvailableTimes ? ", available appointment times" : ", select date"
      : "";
    cells.push(
      `<button class="${classes}" type="button" data-date="${key}" aria-label="${label}${availabilityLabel}"${isSelected ? ' aria-pressed="true"' : ""}${isBookableDate ? "" : " disabled"}>${day}</button>`,
    );
  }

  calendarDays.innerHTML = cells.join("");
  calendarDays.querySelectorAll("button.bookable").forEach((button) => {
    button.addEventListener("click", () => {
      selectedDate = button.dataset.date;
      selectedTime = "";
      renderCalendar();
      renderTimes();
    });
  });
}

function renderTimes() {
  const availableTimes = availability.get(selectedDate) ?? [];
  const service = serviceSelect.selectedOptions[0];
  const sessionDuration = Number(service.dataset.duration) *
    (service.dataset.pricingUnit === "hour" ? Number(hoursSelect.value) : 1);

  selectedDateLabel.textContent = selectedDate
    ? formatDate(parseDate(selectedDate), { weekday: "short", month: "short", day: "numeric" })
    : "";
  if (!availableTimes.includes(selectedTime)) selectedTime = "";

  timeList.innerHTML = availableTimes.map((time) =>
    `<button class="time-button${time === selectedTime ? " selected" : ""}" type="button" data-time="${time}"${time === selectedTime ? ' aria-pressed="true"' : ""}>${time}</button>`,
  ).join("");

  timeList.querySelectorAll(".time-button").forEach((button) => {
    button.addEventListener("click", () => {
      selectedTime = button.dataset.time;
      renderTimes();
    });
  });

  if (availabilityLoading) return;
  announceAvailability(
    availableTimes.length
      ? `All times are shown in your local timezone · ${sessionDuration} min`
      : selectedDate
        ? "No appointment times are available on this date. Choose another weekday."
        : availability.size
          ? "Choose a weekday to see available appointment times."
          : "No appointment times are available this month. Choose another month.",
  );
}

async function loadAvailability({ chooseFirstDate = false } = {}) {
  const requestId = ++availabilityRequest;
  const month = `${visibleMonth.getFullYear()}-${String(visibleMonth.getMonth() + 1).padStart(2, "0")}`;
  const query = new URLSearchParams({
    month,
    service: serviceSelect.value,
    timeZone,
    hours: hoursSelect.value,
  });

  availability = new Map();
  availabilityLoading = true;
  selectedTime = "";
  announceAvailability("Checking available times…");
  renderCalendar();
  renderTimes();

  try {
    const response = await fetch(`/api/availability?${query}`, { headers: { accept: "application/json" } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not load available times.");
    if (requestId !== availabilityRequest) return;

    availabilityLoading = false;
    availability = new Map(result.days.map((day) => [day.date, day.times]));
    if (chooseFirstDate || !availability.has(selectedDate)) {
      selectedDate = availability.keys().next().value ?? "";
    }
    renderCalendar();
    renderTimes();
  } catch (error) {
    if (requestId !== availabilityRequest) return;
    availabilityLoading = false;
    selectedDate = "";
    renderCalendar();
    renderTimes();
    announceAvailability(error instanceof Error ? error.message : "Could not load available times. Please try again.");
  }
}

function serviceDetails() {
  const option = serviceSelect.selectedOptions[0];
  return {
    name: option.dataset.name,
    price: Number(option.dataset.price),
    currency: option.dataset.currency,
    pricingUnit: option.dataset.pricingUnit,
    durationMinutes: Number(option.dataset.duration),
    hours: Number(hoursSelect.value),
    maximumHours: Number(option.dataset.maximumHours),
  };
}

function formatPrice(amount, currency = "KES") {
  if (currency === "KES") return `KSh ${new Intl.NumberFormat("en-KE", { maximumFractionDigits: 0 }).format(amount)}`;
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
}

function updateServiceSummary({ reloadAvailability = true } = {}) {
  const maximumHours = Number(serviceSelect.selectedOptions[0].dataset.maximumHours);
  const isMultiHourService = maximumHours > 1;
  hoursField.hidden = !isMultiHourService;
  if (!isMultiHourService && hoursSelect.value !== "1") hoursSelect.value = "1";

  const service = serviceDetails();
  const billableHours = service.pricingUnit === "hour" ? service.hours : 1;
  const totalPrice = service.price * billableHours;
  document.querySelector("#summary-service").textContent = service.name;
  document.querySelector("#summary-price").textContent = formatPrice(totalPrice, service.currency);
  document.querySelector("#summary-deposit").textContent = formatPrice(totalPrice * 0.5, service.currency);
  document.querySelector("#summary-pricing").textContent = service.pricingUnit === "project"
    ? `${formatPrice(service.price, service.currency)} per project · 60-minute consultation`
    : service.maximumHours > 1
      ? `${billableHours} ${billableHours === 1 ? "hour" : "hours"} × ${formatPrice(service.price, service.currency)}/hour`
      : `${formatPrice(service.price, service.currency)}/hour · 60-minute session`;
  if (reloadAvailability) loadAvailability({ chooseFirstDate: true });
}

async function loadServices() {
  const response = await fetch("/api/services", { headers: { accept: "application/json" } });
  const services = await response.json();
  if (!response.ok || !Array.isArray(services) || services.length === 0) {
    throw new Error("Appointment sessions are temporarily unavailable. Please try again later.");
  }

  serviceSelect.replaceChildren(...services.map((service) => {
    const option = document.createElement("option");
    option.value = service.id;
    option.dataset.name = service.name;
    option.dataset.price = String(service.price);
    option.dataset.duration = String(service.durationMinutes);
    option.dataset.currency = service.currency;
    option.dataset.pricingUnit = service.pricingUnit;
    option.dataset.maximumHours = String(service.maximumHours);
    option.textContent = `${service.name} · ${service.priceLabel}`;
    return option;
  }));

  const requestedService = new URLSearchParams(window.location.search).get("service");
  if (requestedService && services.some((service) => service.id === requestedService)) {
    serviceSelect.value = requestedService;
  }
  updateServiceSummary();
}

function updatePaymentActionLabel() {
  const method = bookingForm.querySelector('input[name="paymentMethod"]:checked')?.value;
  const label = method === "none"
    ? "Confirm booking"
    : method === "pesapal"
      ? "Request & continue to secure checkout"
      : method === "daraja_stk"
        ? "Request & send STK Push"
        : "Request & view M-Pesa details";
  submitButton.firstChild.textContent = `${label} `;
}

async function loadPaymentOptions() {
  const response = await fetch("/api/payment-options", { headers: { accept: "application/json" } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Payment options are unavailable.");

  const onlineOption = document.querySelector("#online-payment-option");
  const onlineInput = onlineOption.querySelector("input");
  const onlineHelp = document.querySelector("#online-payment-help");
  onlineInput.disabled = !result.onlineCheckout.available;
  onlineOption.classList.toggle("payment-method-disabled", !result.onlineCheckout.available);
  if (result.onlineCheckout.available) {
    onlineHelp.textContent = "Pay securely by card or M-Pesa with Pesapal.";
  }
  darajaStkAvailable = result.darajaStkPush.available;
  document.querySelector("#daraja-payment-help").textContent = darajaStkAvailable
    ? "Safaricom will send a secure payment prompt to the mobile number above."
    : "STK Push cannot start until Safaricom merchant credentials and a public HTTPS callback are configured.";
  updatePaymentActionLabel();
}

previousMonthButton.addEventListener("click", () => {
  if (previousMonthButton.disabled) return;
  visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() - 1, 1);
  selectedDate = "";
  renderCalendar();
  renderTimes();
  loadAvailability({ chooseFirstDate: true });
});

nextMonthButton.addEventListener("click", () => {
  if (nextMonthButton.disabled) return;
  visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1);
  selectedDate = "";
  renderCalendar();
  renderTimes();
  loadAvailability({ chooseFirstDate: true });
});

serviceSelect.addEventListener("change", updateServiceSummary);
hoursSelect.addEventListener("change", () => updateServiceSummary());
bookingForm.querySelectorAll('input[name="paymentMethod"]').forEach((input) => {
  input.addEventListener("change", () => {
    updatePaymentActionLabel();
  });
});
updatePaymentActionLabel();
bookingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedDate || !selectedTime) {
    announceAvailability("Please choose an available date and time before continuing.");
    if (!selectedDate) calendarDays.querySelector("button.bookable")?.focus();
    else timeList.querySelector(".time-button")?.focus();
    return;
  }

  const formData = new FormData(bookingForm);
  const service = serviceDetails();
  const selectedPaymentMethod = String(formData.get("paymentMethod"));
  const phoneNumber = String(formData.get("phoneNumber")).trim();
  if (!/^(?:0[17]\d{8}|(?:\+?254)[17]\d{8})$/.test(phoneNumber.replace(/[\s()-]/g, ""))) {
    document.querySelector("#payment-help").textContent =
      "Enter a valid Kenyan mobile number, such as 0712345678 or +254712345678.";
    document.querySelector("#phone-number").focus();
    return;
  }
  if (selectedPaymentMethod === "daraja_stk" && !darajaStkAvailable) {
    document.querySelector("#payment-help").textContent =
      "STK Push is not active on this server yet. Configure the Daraja shortcode, consumer key/secret, passkey, and public HTTPS callback URL before submitting your booking.";
    return;
  }
  savedFocusTarget = document.activeElement instanceof HTMLElement ? document.activeElement : submitButton;
  let submitted = false;
  submitButton.disabled = true;
  submitButton.setAttribute("aria-busy", "true");
  submitButton.firstChild.textContent = selectedPaymentMethod === "none" ? "Confirming booking… " : "Saving request & deposit… ";

  try {
    const response = await fetch("/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        service: serviceSelect.value,
        date: selectedDate,
        time: selectedTime,
        timeZone,
        hours: service.hours,
        name: String(formData.get("name")).trim(),
        email: String(formData.get("email")).trim(),
        phoneNumber,
        depositMethod: selectedPaymentMethod,
        note: String(formData.get("note") ?? "").trim(),
      }),
    });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 409) {
        await loadAvailability();
        announceAvailability(result.error || "That time is no longer available. Please choose another.");
      }
      throw new Error(result.error || "We could not save your request. Please try again.");
    }

    const savedBooking = result.booking;
    submitted = true;
    let paymentResponse = { ok: false };
    let payment = {};
    if (selectedPaymentMethod !== "none") {
      try {
        paymentResponse = await fetch("/api/payments", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            bookingId: savedBooking.id,
            method: selectedPaymentMethod,
            phoneNumber: selectedPaymentMethod === "daraja_stk" ? savedBooking.phoneNumber : undefined,
          }),
        });
        payment = await paymentResponse.json();
      } catch {
        paymentResponse = { ok: false };
        payment = { error: "The booking was saved, but payment could not be reached. Contact Eroll before trying to pay." };
      }
    }
    if (paymentResponse.ok && payment.checkoutUrl) {
      if (!payment.checkoutUrl.startsWith("https://")) throw new Error("The payment provider returned an invalid checkout link.");
      window.location.href = payment.checkoutUrl;
      return;
    }
    document.querySelector("#confirmation-name").textContent = savedBooking.name;
    document.querySelector("#confirmation-summary").textContent =
      `${savedBooking.serviceName} · ${formatDate(parseDate(savedBooking.date), { weekday: "long", month: "long", day: "numeric" })} at ${savedBooking.time} (${savedBooking.timeZone}) · ${savedBooking.durationLabel} · ${formatPrice(savedBooking.price, savedBooking.currency)}${savedBooking.pricingUnit === "hour" ? ` (${savedBooking.billableHours} ${savedBooking.billableHours === 1 ? "hour" : "hours"} at ${formatPrice(savedBooking.price / savedBooking.billableHours, savedBooking.currency)}/hour)` : " per project"}. ${result.message}`;
    document.querySelector("#confirmation-title").firstChild.textContent =
      savedBooking.status === "confirmed" ? "Booking confirmed, " : "Request received, ";
    document.querySelector(".demo-notice").textContent = result.message;
    const instructions = document.querySelector("#payment-instructions");
    if (selectedPaymentMethod === "none") {
      instructions.hidden = true;
    } else if (paymentResponse.ok && payment.reference) {
      document.querySelector("#payment-reference").textContent = payment.reference;
      document.querySelector("#payment-status-link").href = `/payment-status.html?reference=${encodeURIComponent(payment.reference)}`;
      if (selectedPaymentMethod === "daraja_stk") {
        document.querySelector("#payment-instructions-title").textContent = "STK Push sent to your phone";
        document.querySelector("#manual-payment-details").hidden = true;
        document.querySelector(".demo-notice").textContent =
          `Request #${savedBooking.id} is saved. ${payment.message || "Check your phone and enter your M-Pesa PIN to complete the deposit."} The appointment remains pending until Safaricom confirms payment.`;
      } else {
        document.querySelector("#payment-instructions-title").textContent = "M-Pesa deposit instructions";
        document.querySelector("#manual-payment-details").hidden = false;
        document.querySelector("#payment-amount").textContent = formatPrice(payment.amount);
        document.querySelector("#payment-account-name").textContent = payment.accountName;
        document.querySelector("#payment-account-number").textContent = payment.accountNumber;
      }
      instructions.hidden = false;
    } else if (payment.reference) {
      document.querySelector(".demo-notice").textContent =
        `Request #${savedBooking.id} is saved. Payment is still pending and needs assistance before retrying. ${payment.error || ""}`.trim();
      document.querySelector("#payment-reference").textContent = payment.reference;
      document.querySelector("#payment-status-link").href = `/payment-status.html?reference=${encodeURIComponent(payment.reference)}`;
      const isManualPayment = Boolean(payment.accountNumber && payment.accountName);
      document.querySelector("#payment-instructions-title").textContent =
        isManualPayment ? "M-Pesa deposit instructions" : "Payment attempt status";
      document.querySelector("#manual-payment-details").hidden = !isManualPayment;
      if (isManualPayment) {
        document.querySelector("#payment-amount").textContent = formatPrice(payment.amount);
        document.querySelector("#payment-account-name").textContent = payment.accountName;
        document.querySelector("#payment-account-number").textContent = payment.accountNumber;
      }
      instructions.hidden = false;
    } else {
      document.querySelector(".demo-notice").textContent =
        `Request #${savedBooking.id} is saved, but payment could not be started. Contact Eroll at nyakwerieroll254@gmail.com before paying. ${payment.error || ""}`.trim();
      instructions.hidden = true;
    }
    confirmation.hidden = false;
    document.querySelector("#close-confirmation").focus();
    bookingForm.reset();
    hoursSelect.value = "1";
    updateServiceSummary({ reloadAvailability: false });
    await loadAvailability({ chooseFirstDate: true });
  } catch (error) {
    announceAvailability(error instanceof Error ? error.message : "We could not save your request. Please try again.");
  } finally {
    submitButton.disabled = false;
    submitButton.removeAttribute("aria-busy");
    updatePaymentActionLabel();
    if (submitted) {
      bookingForm.reset();
    }
  }
});

function closeConfirmation() {
  confirmation.hidden = true;
  if (savedFocusTarget.isConnected && !savedFocusTarget.matches(":disabled") &&
    savedFocusTarget.getClientRects().length > 0) {
    savedFocusTarget.focus();
  } else {
    serviceSelect.focus();
  }
}

confirmation.addEventListener("keydown", (event) => {
  if (event.key !== "Tab") return;

  const focusableElements = [...confirmation.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((element) => element.getClientRects().length > 0);
  if (!focusableElements.length) {
    event.preventDefault();
    return;
  }

  const firstElement = focusableElements[0];
  const lastElement = focusableElements[focusableElements.length - 1];
  if (event.shiftKey &&
    (document.activeElement === firstElement || !confirmation.contains(document.activeElement))) {
    event.preventDefault();
    lastElement.focus();
  } else if (!event.shiftKey &&
    (document.activeElement === lastElement || !confirmation.contains(document.activeElement))) {
    event.preventDefault();
    firstElement.focus();
  }
});

document.querySelector("#close-confirmation").addEventListener("click", closeConfirmation);
document.querySelector("#confirmation-done").addEventListener("click", closeConfirmation);
confirmation.addEventListener("click", (event) => {
  if (event.target === confirmation) closeConfirmation();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !confirmation.hidden) closeConfirmation();
});

timezoneName.textContent = `(${timeZone})`;
document.querySelector("#timezone-name-booking").textContent = `(${timeZone})`;
renderCalendar();
loadPaymentOptions().catch((error) => {
  document.querySelector("#payment-help").textContent =
    error instanceof Error ? error.message : "Payment options could not be loaded.";
});
loadServices().catch((error) => {
  announceAvailability(error instanceof Error ? error.message : "Appointment sessions are temporarily unavailable.");
  submitButton.disabled = true;
});
