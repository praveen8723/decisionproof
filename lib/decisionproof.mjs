import { randomUUID } from "node:crypto";

import { CooL, verifyEvidence } from "cool-nwc";
import {
  buildAuditPack,
  disclose,
  verifyAuditPack,
  verifyDisclosure,
} from "cool-nwc/phala";

const cool = new CooL({ applicationId: "decisionproof-demo" });
const records = new Map();
const recordOrder = [];

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") return JSON.parse(req.body || "{}");
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString("utf8") || "{}");
    if (typeof req.body === "object") return req.body;
  }

  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 1_000_000) throw new Error("Request is too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function cleanText(value, maxLength = 120) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function numberInRange(value, min, max, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be between ${min} and ${max}`);
  }
  return parsed;
}

function assessLoan(application) {
  const emiRatio = application.existingEmi / application.monthlyIncome;
  const requestedToIncome = application.requestedAmount / application.monthlyIncome;
  const reasons = [];
  let outcome = "APPROVED";

  if (application.creditScore < 650) reasons.push("CREDIT_SCORE_BELOW_POLICY");
  if (emiRatio > 0.5) reasons.push("EXISTING_EMI_ABOVE_POLICY");
  if (requestedToIncome > 12) reasons.push("REQUESTED_AMOUNT_ABOVE_POLICY");

  if (application.creditScore < 600 || emiRatio > 0.65) {
    outcome = "DECLINED";
  } else if (reasons.length > 0) {
    outcome = "MANUAL_REVIEW";
  }

  const rate = outcome === "APPROVED"
    ? Math.max(10.5, 17.5 - (application.creditScore - 650) * 0.025)
    : null;

  return {
    outcome,
    reasonCodes: reasons.length > 0 ? reasons : ["POLICY_CHECKS_PASSED"],
    offeredRate: rate === null ? null : Number(rate.toFixed(2)),
    emiRatio: Number(emiRatio.toFixed(3)),
    policy: "DP-PERSONAL-LOAN-2026-09",
    model: "decisionproof-scorecard",
    modelVersion: "0.1.0-demo",
  };
}

function verdictChecks(verdict) {
  return Object.fromEntries(
    Object.entries(verdict.checks).map(([name, check]) => [name, {
      status: check.status,
      detail: check.detail,
    }]),
  );
}

function receiptSummary(evidence, verdict, stored) {
  const serialized = JSON.stringify(evidence);
  return {
    recordId: evidence.record.record_id,
    executionId: evidence.record.event.execution_id,
    issuedAt: evidence.record.time.issued_at,
    eventType: evidence.record.event.type,
    software: evidence.record.event.software,
    mode: evidence.record.runtime.mode,
    bindingHash: evidence.binding_hash,
    metadataCommitment: evidence.record.event.metadata_hash,
    inclusion: evidence.inclusion,
    verdict: { ok: verdict.ok, checks: verdictChecks(verdict), reasons: verdict.reasons },
    privacy: {
      applicantNameAbsent: !serialized.includes(stored.application.applicantName),
      emailAbsent: !serialized.includes(stored.application.email),
      rawPayloadsAbsent: !serialized.includes(stored.inputPayload) && !serialized.includes(stored.outputPayload),
    },
  };
}

// A Vercel instance can disappear between clicks, so the browser carries the receipt forward.
function artifactFrom(stored) {
  return {
    evidence: stored.evidence,
    disclosureValues: { output: stored.outputPayload },
  };
}

function getStored(recordId) {
  const stored = records.get(cleanText(recordId, 80));
  if (!stored) throw new Error("Receipt was not found in this demo session");
  return stored;
}

function getArtifact(body) {
  if (body?.artifact?.evidence && typeof body.artifact.evidence === "object") {
    return body.artifact;
  }
  return artifactFrom(getStored(body?.recordId));
}

async function createDecision(body) {
  if (body.consent !== true) throw new Error("Explicit consent is required");

  const application = {
    applicantName: cleanText(body.applicantName, 80),
    email: cleanText(body.email, 120),
    requestedAmount: numberInRange(body.requestedAmount, 10_000, 5_000_000, "Requested amount"),
    monthlyIncome: numberInRange(body.monthlyIncome, 10_000, 2_000_000, "Monthly income"),
    existingEmi: numberInRange(body.existingEmi, 0, 1_500_000, "Existing EMI"),
    creditScore: numberInRange(body.creditScore, 300, 900, "Credit score"),
    consentRef: `CONSENT-${randomUUID().slice(0, 8).toUpperCase()}`,
  };
  if (!application.applicantName || !application.email) {
    throw new Error("Applicant name and email are required");
  }

  const decision = assessLoan(application);
  const inputPayload = JSON.stringify(application);
  const outputPayload = JSON.stringify(decision);
  const executionId = randomUUID();

  const { evidence } = await cool.record({
    type: "loan.decision",
    executionId,
    metadata: {
      consentRef: application.consentRef,
      policy: decision.policy,
      model: decision.model,
      modelVersion: decision.modelVersion,
      outcome: decision.outcome,
    },
    payloads: { input: inputPayload, output: outputPayload },
    software: {
      name: "decisionproof-underwriter",
      version: "0.1.0-demo",
      digest: null,
    },
  });

  const verdict = await verifyEvidence(evidence);
  const stored = { application, decision, evidence, inputPayload, outputPayload };
  records.set(evidence.record.record_id, stored);
  recordOrder.unshift(evidence.record.record_id);

  return {
    applicationRef: `APL-${evidence.record.record_id.slice(-6)}`,
    consentRef: application.consentRef,
    decision,
    receipt: receiptSummary(evidence, verdict, stored),
    artifact: artifactFrom(stored),
  };
}

async function routeApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/health") {
    return json(res, 200, { ok: true, sdk: "cool-nwc 3.0.0", runtime: "serverless-ready" });
  }

  if (req.method === "POST" && pathname === "/api/decisions") {
    return json(res, 201, await createDecision(await readJson(req)));
  }

  if (req.method === "POST" && pathname === "/api/verify") {
    const body = await readJson(req);
    const artifact = getArtifact(body);
    const verdict = await verifyEvidence(artifact.evidence);
    return json(res, 200, {
      recordId: artifact.evidence.record.record_id,
      verdict: { ok: verdict.ok, checks: verdictChecks(verdict), reasons: verdict.reasons },
    });
  }

  if (req.method === "POST" && pathname === "/api/tamper") {
    const body = await readJson(req);
    const artifact = getArtifact(body);
    // We alter a copy for the demo. The receipt the user created is never changed.
    const tampered = structuredClone(artifact.evidence);
    const hash = tampered.record.event.metadata_hash;
    tampered.record.event.metadata_hash = hash.replace(/.$/, (last) => last === "0" ? "1" : "0");
    const verdict = await verifyEvidence(tampered);
    return json(res, 200, {
      recordId: artifact.evidence.record.record_id,
      changedField: "record.event.metadata_hash",
      originalEnding: hash.slice(-12),
      tamperedEnding: tampered.record.event.metadata_hash.slice(-12),
      verdict: { ok: verdict.ok, checks: verdictChecks(verdict), reasons: verdict.reasons },
    });
  }

  if (req.method === "POST" && pathname === "/api/disclose") {
    const body = await readJson(req);
    const artifact = getArtifact(body);
    const field = body.field ?? "output";
    if (field !== "output") throw new Error("This demo discloses only the decision output");
    const value = artifact.disclosureValues?.output;
    if (typeof value !== "string") throw new Error("The disclosure value is missing");
    const disclosure = disclose(artifact.evidence, field, value);
    const verdict = verifyDisclosure(artifact.evidence, disclosure);
    return json(res, 200, { disclosure, verdict, revealedValue: JSON.parse(value) });
  }

  if (req.method === "POST" && pathname === "/api/audit-pack") {
    const body = await readJson(req);
    const supplied = Array.isArray(body.artifacts) ? body.artifacts : [];
    // The browser sends its session receipts, which keeps this working after a cold start.
    const receipts = supplied.length > 0
      ? supplied.slice(0, 100).map((artifact) => getArtifact({ artifact }).evidence)
      : recordOrder.map((id) => records.get(id).evidence);
    if (receipts.length === 0) throw new Error("Create at least one decision first");
    const pack = buildAuditPack(receipts, { subject: "DecisionProof demo session" });
    const verdict = await verifyAuditPack(pack);
    return json(res, 200, {
      pack,
      verdict: {
        ok: verdict.ok,
        total: verdict.total,
        verified: verdict.verified,
        failed: verdict.failed,
        obligationsCovered: verdict.obligationsCovered,
        obligationsTotal: verdict.obligationsTotal,
      },
    });
  }

  return false;
}

async function handleApiRequest(req, res, requestUrl) {
  const url = requestUrl instanceof URL
    ? requestUrl
    : new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const action = cleanText(url.searchParams.get("action"), 40);
  const pathname = url.pathname === "/api" && action ? `/api/${action}` : url.pathname;

  try {
    const handled = await routeApi(req, res, pathname);
    if (handled === false) json(res, 404, { error: "API route not found" });
  } catch (error) {
    json(res, 400, { error: error instanceof Error ? error.message : "Request failed" });
  }
}

export { cool, handleApiRequest };
