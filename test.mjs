import assert from "node:assert/strict";

process.env.PORT = "4199";
const { server, cool } = await import("./server.mjs");

async function call(path, body) {
  const response = await fetch(`http://127.0.0.1:4199${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(response.ok, true, data.error);
  return data;
}

async function callError(path, body, expectedMessage) {
  const response = await fetch(`http://127.0.0.1:4199${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(response.ok, false);
  assert.equal(data.error, expectedMessage);
}

try {
  const created = await call("/api?action=decisions", {
    applicantName: "Test Applicant",
    email: "private@example.com",
    requestedAmount: 300000,
    monthlyIncome: 80000,
    existingEmi: 8000,
    creditScore: 760,
    consent: true,
  });
  assert.equal(created.decision.outcome, "APPROVED");
  assert.equal(created.receipt.verdict.ok, true);
  assert.equal(created.receipt.privacy.applicantNameAbsent, true);
  assert.equal(created.receipt.privacy.emailAbsent, true);
  assert.equal(created.receipt.mode, "simulated");
  assert.equal(typeof created.artifact.evidence, "object");

  const manualReview = await call("/api?action=decisions", {
    applicantName: "Review Applicant",
    email: "review@example.com",
    requestedAmount: 300000,
    monthlyIncome: 80000,
    existingEmi: 8000,
    creditScore: 640,
    consent: true,
  });
  assert.equal(manualReview.decision.outcome, "MANUAL_REVIEW");
  assert.equal(manualReview.receipt.verdict.ok, true);

  const declined = await call("/api?action=decisions", {
    applicantName: "Declined Applicant",
    email: "declined@example.com",
    requestedAmount: 300000,
    monthlyIncome: 80000,
    existingEmi: 8000,
    creditScore: 580,
    consent: true,
  });
  assert.equal(declined.decision.outcome, "DECLINED");
  assert.equal(declined.receipt.verdict.ok, true);

  await callError("/api?action=decisions", {
    applicantName: "No Consent",
    email: "no-consent@example.com",
    requestedAmount: 300000,
    monthlyIncome: 80000,
    existingEmi: 8000,
    creditScore: 760,
    consent: false,
  }, "Explicit consent is required");

  const verified = await call("/api?action=verify", { artifact: created.artifact });
  assert.equal(verified.verdict.ok, true);
  assert.equal(verified.verdict.checks.signature.status, "pass");

  const tampered = await call("/api?action=tamper", { artifact: created.artifact });
  assert.equal(tampered.verdict.ok, false);
  assert.equal(tampered.verdict.checks.binding.status, "fail");
  assert.equal(tampered.verdict.checks.signature.status, "fail");

  const disclosed = await call("/api?action=disclose", { artifact: created.artifact, field: "output" });
  assert.equal(disclosed.verdict.ok, true);
  assert.equal(disclosed.revealedValue.outcome, "APPROVED");

  const pack = await call("/api?action=audit-pack", { artifacts: [created.artifact] });
  assert.equal(pack.verdict.ok, true);
  assert.equal(pack.verdict.verified, 1);
  assert.equal(pack.verdict.obligationsCovered >= 1, true);

  const netlifyHandler = (await import("./netlify/functions/api.mjs")).default;
  const serverlessHealth = await netlifyHandler(
    new Request("https://decisionproof.test/.netlify/functions/api?action=health"),
  );
  assert.equal(serverlessHealth.status, 200);
  assert.equal((await serverlessHealth.json()).sdk, "cool-nwc 3.0.0");

  const serverlessVerification = await netlifyHandler(new Request(
    "https://decisionproof.test/.netlify/functions/api?action=verify",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ artifact: created.artifact }),
    },
  ));
  assert.equal(serverlessVerification.status, 200);
  assert.equal((await serverlessVerification.json()).verdict.ok, true);

  console.log("DecisionProof integration test passed");
} finally {
  server.close();
  await cool.close();
}
