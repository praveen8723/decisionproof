document.documentElement.classList.add("motion-ready");

const form = document.querySelector("#loan-form");
const score = document.querySelector("#credit-score");
const scoreValue = document.querySelector("#credit-score-value");
const riskMeter = document.querySelector("#risk-meter");
const riskTier = document.querySelector("#risk-tier");
const emptyState = document.querySelector("#empty-state");
const receiptView = document.querySelector("#receipt-view");
const receiptState = document.querySelector("#receipt-state");
const receiptSurface = document.querySelector(".receipt-surface");
const proofFlow = document.querySelector("#proof-flow");
const verificationSection = document.querySelector("#verification-section");
const checksGrid = document.querySelector("#checks-grid");
const failureReasons = document.querySelector("#failure-reasons");
const toast = document.querySelector("#toast");
const auditResult = document.querySelector("#audit-result");
const auditSection = document.querySelector("#audit-section");

let activeRecordId = null;
let activeArtifact = null;
const sessionArtifacts = [];
let sessionReceiptCount = 0;
let toastTimer = null;

function updateRiskVisual() {
  const value = Number(score.value);
  const position = ((value - 300) / 600) * 100;
  const risk = value >= 720 ? "low" : value >= 650 ? "medium" : "high";
  scoreValue.value = String(value);
  riskMeter.style.setProperty("--score-position", `${position}%`);
  riskMeter.dataset.risk = risk;
  riskTier.textContent = `${risk.toUpperCase()} RISK BAND`;
  riskTier.style.color = risk === "low" ? "var(--green)" : risk === "medium" ? "var(--amber)" : "var(--red)";
}

score.addEventListener("input", updateRiskVisual);
updateRiskVisual();

const revealSections = document.querySelectorAll(".reveal-section");
if ("IntersectionObserver" in window) {
  const sectionObserver = new IntersectionObserver((entries, observer) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.12 });
  revealSections.forEach((section) => sectionObserver.observe(section));
} else {
  revealSections.forEach((section) => section.classList.add("is-visible"));
}

async function api(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

function showToast(message, type = "ok") {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `toast visible ${type === "error" ? "error" : ""}`;
  toastTimer = setTimeout(() => { toast.className = "toast"; }, 3500);
}

function setBusy(button, busy, label) {
  if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
  if (busy) button.textContent = label;
  else button.innerHTML = button.dataset.originalHtml;
}

function short(value, start = 16, end = 10) {
  if (!value || value.length <= start + end + 1) return value;
  return `${value.slice(0, start)}…${value.slice(-end)}`;
}

function renderReceipt(result) {
  activeRecordId = result.receipt.recordId;
  activeArtifact = result.artifact;
  sessionArtifacts.unshift(result.artifact);
  sessionReceiptCount += 1;
  document.querySelector("#session-count").textContent = String(sessionReceiptCount);
  receiptSurface.classList.add("has-receipt");
  emptyState.classList.add("hidden");
  receiptView.classList.remove("hidden");
  const receiptLabel = result.receipt.verdict.ok ? "Verified" : "Failed";
  receiptState.replaceChildren(document.createElement("i"), document.createTextNode(` ${receiptLabel}`));
  receiptState.className = `receipt-state ${result.receipt.verdict.ok ? "verified" : "failed"}`;

  const banner = document.querySelector("#decision-banner");
  banner.className = "decision-banner";
  if (result.decision.outcome === "MANUAL_REVIEW") banner.classList.add("review");
  if (result.decision.outcome === "DECLINED") banner.classList.add("declined");
  document.querySelector("#decision-value").textContent = result.decision.outcome.replace("_", " ");
  document.querySelector("#decision-detail").textContent = result.decision.offeredRate
    ? `${result.decision.offeredRate}% indicative rate · ${result.applicationRef}`
    : `${result.decision.reasonCodes.join(" · ")} · ${result.applicationRef}`;

  document.querySelector("#record-id").textContent = short(result.receipt.recordId, 12, 6);
  document.querySelector("#record-id").title = result.receipt.recordId;
  document.querySelector("#model-version").textContent = result.decision.modelVersion;
  document.querySelector("#policy-version").textContent = result.decision.policy;
  document.querySelector("#runtime-mode").textContent = `${result.receipt.mode} attestation`;

  const privacyOk = Object.values(result.receipt.privacy).every(Boolean);
  document.querySelector("#privacy-status").textContent = privacyOk ? "Checked" : "Review";
  renderVerification(result.receipt.verdict, "Receipt verified", "The receipt passed independent checks immediately after it was created.");
  auditResult.textContent = "Ready to package this receipt for an auditor.";
}

function renderVerification(verdict, title, copy) {
  verificationSection.classList.remove("hidden", "failed");
  if (!verdict.ok) verificationSection.classList.add("failed");
  verificationSection.dataset.status = verdict.ok ? "pass" : "fail";
  document.querySelector("#verification-title").textContent = title;
  document.querySelector("#verification-copy").textContent = copy;
  checksGrid.replaceChildren();

  Object.entries(verdict.checks).forEach(([name, check], index) => {
    const card = document.createElement("article");
    card.className = "check-card";
    card.style.setProperty("--i", String(index));
    const top = document.createElement("div");
    top.className = "check-top";
    const checkName = document.createElement("span");
    checkName.className = "check-name";
    checkName.textContent = name;
    const status = document.createElement("span");
    status.className = `check-status ${check.status}`;
    status.textContent = check.status;
    const detail = document.createElement("p");
    detail.textContent = check.detail;
    top.append(checkName, status);
    card.append(top, detail);
    checksGrid.append(card);
  });

  if (verdict.reasons?.length) {
    failureReasons.classList.remove("hidden");
    const heading = document.createElement("strong");
    heading.textContent = "Why verification failed";
    const list = document.createElement("ul");
    for (const reason of verdict.reasons) {
      const item = document.createElement("li");
      item.textContent = reason;
      list.append(item);
    }
    failureReasons.replaceChildren(heading, list);
  } else {
    failureReasons.classList.add("hidden");
    failureReasons.replaceChildren();
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector("button[type=submit]");
  const data = Object.fromEntries(new FormData(form));
  data.consent = form.elements.consent.checked;
  setBusy(button, true, "Signing the decision…");
  proofFlow.classList.remove("is-complete");
  proofFlow.classList.add("is-running");
  receiptSurface.classList.add("is-sealing");
  try {
    const result = await api("/api?action=decisions", data);
    renderReceipt(result);
    proofFlow.classList.remove("is-running");
    proofFlow.classList.add("is-complete");
    receiptSurface.classList.remove("is-sealing");
    showToast("Decision recorded and verified with CooL.");
  } catch (error) {
    proofFlow.classList.remove("is-running");
    receiptSurface.classList.remove("is-sealing");
    showToast(error.message, "error");
  } finally {
    setBusy(button, false);
  }
});

document.querySelector("#verify-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  setBusy(button, true, "Verifying…");
  try {
    const result = await api("/api?action=verify", { recordId: activeRecordId, artifact: activeArtifact });
    renderVerification(result.verdict, "Receipt verified again", "This check used the self-contained receipt, with no lender database lookup.");
    verificationSection.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setBusy(button, false);
  }
});

document.querySelector("#tamper-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  setBusy(button, true, "Changing one byte…");
  try {
    const result = await api("/api?action=tamper", { recordId: activeRecordId, artifact: activeArtifact });
    renderVerification(
      result.verdict,
      "Tampering detected",
      `A copy changed ${result.changedField}. The original receipt remains untouched.`,
    );
    verificationSection.scrollIntoView({ behavior: "smooth", block: "start" });
    showToast("The verifier rejected the altered copy.");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setBusy(button, false);
  }
});

document.querySelector("#disclose-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  setBusy(button, true, "Opening outcome…");
  try {
    const result = await api("/api?action=disclose", { recordId: activeRecordId, artifact: activeArtifact, field: "output" });
    const outcome = result.revealedValue.outcome.replace("_", " ");
    showToast(`Selective disclosure verified: outcome was ${outcome}.`);
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setBusy(button, false);
  }
});

document.querySelector("#audit-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  setBusy(button, true, "Building pack…");
  auditSection.classList.remove("is-complete");
  auditSection.classList.add("is-building");
  try {
    const result = await api("/api?action=audit-pack", { artifacts: sessionArtifacts });
    auditResult.textContent = `${result.verdict.verified}/${result.verdict.total} receipts verified · ${result.verdict.obligationsCovered}/${result.verdict.obligationsTotal} mapped controls covered.`;
    auditSection.classList.add("is-complete");
    showToast("Audit pack built and independently verified.");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    auditSection.classList.remove("is-building");
    setBusy(button, false);
  }
});
