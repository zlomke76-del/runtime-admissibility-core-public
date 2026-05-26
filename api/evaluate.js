const {
  json,
  sha256,
  encodeFilterValue,
  readJsonBody,
  supabaseFetch,
  authenticate,
  getActiveSubscription,
  getOrCreateUsage,
} = require("./_shared");

const BILLING_ENFORCEMENT_MODE = process.env.BILLING_ENFORCEMENT_MODE || "off";

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function toText(values) {
  return normalizeArray(values).map((value) => String(value || "")).join(" ").toLowerCase();
}

function readRuntimeState(packet) {
  return packet?.runtime_state || packet?.state_context || {};
}

function readAuthority(packet) {
  return packet?.authority_context || packet?.authority || {};
}

function readConstraints(packet) {
  return packet?.constraint_context || packet?.constraints || {};
}

function readConsequenceBoundary(packet) {
  return packet?.consequence_boundary || packet?.consequence_context || {};
}

function collectRuntimeSignals(packet) {
  return normalizeArray(packet?.runtime_signals || packet?.signals);
}

function timestampIsExpired(value) {
  if (!value) return false;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) && ms <= Date.now();
}

function isStateStale(packet) {
  const state = readRuntimeState(packet);
  const lastValidatedAt = state.last_validated_at || state.last_verified_at;
  const staleAfterMinutes = Number(packet?.freshness_policy?.state_stale_after_minutes || packet?.drift_checks?.stale_after_minutes);
  if (!lastValidatedAt || !Number.isFinite(staleAfterMinutes)) return false;
  const validatedAtMs = new Date(lastValidatedAt).getTime();
  if (!Number.isFinite(validatedAtMs)) return false;
  return (Date.now() - validatedAtMs) / 60000 > staleAfterMinutes;
}

function hasRuntimeContradiction(packet) {
  const state = readRuntimeState(packet);
  const assertedState = toText([...(state.assumptions || []), ...(state.current_state_claims || []), ...(state.validated_conditions || [])]);
  const signals = collectRuntimeSignals(packet).map((signal) => String(signal?.statement || signal?.signal || signal?.finding || "")).join(" ").toLowerCase();
  if (!assertedState || !signals) return false;

  const stableTerms = ["stable", "normal", "clear", "ready", "safe", "approved", "valid", "authorized", "complete"];
  const degradingTerms = ["unstable", "abnormal", "decline", "deterioration", "failure", "conflict", "contradiction", "revoked", "expired", "missing", "denied"];

  return stableTerms.some((term) => assertedState.includes(term)) && degradingTerms.some((term) => signals.includes(term));
}

function evaluateRuntimeAdmissibility(packet) {
  const signals = [];
  const runtimeState = readRuntimeState(packet);
  const authority = readAuthority(packet);
  const constraints = readConstraints(packet);
  const consequenceBoundary = readConsequenceBoundary(packet);
  const runtimeSignals = collectRuntimeSignals(packet);

  if (!packet?.packet_id) signals.push({ code: "missing_packet_id", severity: "warn", message: "Packet does not include a packet_id." });

  const authorityPresent = authority.present !== false && Boolean(authority.issuer || authority.scope || authority.delegation_chain || authority.authority_id || authority.status === "valid");
  const authorityExpired = timestampIsExpired(authority.expires_at || authority.valid_until);
  const authorityRevoked = ["revoked", "expired", "denied", "suspended"].includes(String(authority.status || "").toLowerCase());

  if (!authorityPresent) signals.push({ code: "authority_not_established", severity: "block", message: "Authority context is missing or insufficient for execution." });
  if (authorityExpired || authorityRevoked) signals.push({ code: "authority_not_current", severity: "block", message: "Authority is expired, revoked, or no longer current." });

  const stateValidated = runtimeState.state_valid === true || Boolean(runtimeState.last_validated_at || runtimeState.last_verified_at || normalizeArray(runtimeState.validated_conditions).length);
  if (!stateValidated) signals.push({ code: "state_not_validated", severity: "block", message: "Runtime state has not been validated for the requested execution." });
  if (isStateStale(packet)) signals.push({ code: "state_freshness_expired", severity: "warn", message: "Runtime state is older than the configured freshness window." });

  if (runtimeSignals.length === 0) signals.push({ code: "missing_runtime_signals", severity: "warn", message: "No runtime signals were supplied for current execution context." });
  if (hasRuntimeContradiction(packet)) signals.push({ code: "runtime_state_contradiction", severity: "block", message: "Runtime signals contradict the asserted execution state." });

  const constraintsPresent = constraints.action_constrained === true || normalizeArray(constraints.allowed_actions).length > 0 || normalizeArray(constraints.prohibited_actions).length > 0;
  if (!constraintsPresent) signals.push({ code: "constraints_not_established", severity: "block", message: "Action constraints are missing for the requested execution." });

  const consequenceDeclared = Boolean(consequenceBoundary.level || consequenceBoundary.scope || consequenceBoundary.irreversibility || consequenceBoundary.downstream_effects);
  if (!consequenceDeclared) signals.push({ code: "consequence_boundary_missing", severity: "warn", message: "Consequence boundary was not declared." });

  const hasBlock = signals.some((signal) => signal.severity === "block");
  const outcome = hasBlock ? "inadmissible" : signals.length ? "conditional" : "admissible";
  const result = {
    service: "runtime-admissibility-core",
    version: "2.0",
    packet_id: packet?.packet_id || null,
    outcome,
    admissible: outcome === "admissible",
    evaluated_at: new Date().toISOString(),
    admissibility_signals: signals,
    runtime_legitimacy: {
      state_valid: stateValidated && !isStateStale(packet),
      authority_valid: authorityPresent && !authorityExpired && !authorityRevoked,
      action_constrained: constraintsPresent,
      consequence_boundary_declared: consequenceDeclared,
    },
    boundary: {
      evaluates: "whether execution remains admissible under current runtime state, authority, constraints, and consequence boundary",
      does_not_evaluate: "ultimate truth, domain judgment, legal advice, or business permission outside the supplied packet",
    },
  };

  return { ...result, artifact_hash: sha256(JSON.stringify(result)) };
}

async function enforceBilling(authContext) {
  const subscription = await getActiveSubscription(authContext.client_id);
  if (BILLING_ENFORCEMENT_MODE === "off") return { allowed: true, subscription: subscription || null, usage: null };
  if (!subscription) return { allowed: false, status: 402, error: "Active subscription required" };

  const usage = await getOrCreateUsage(authContext.client_id, subscription);
  const monthlyQuota = Number(subscription.monthly_quota || 0);
  const used = Number(usage?.evaluations_used || 0);
  if (monthlyQuota > 0 && used >= monthlyQuota) return { allowed: false, status: 429, error: "Monthly evaluation quota exceeded" };
  return { allowed: true, subscription, usage };
}

async function incrementUsage(authContext, billing) {
  const subscription = billing.subscription || (await getActiveSubscription(authContext.client_id));
  const usage = billing.usage || (await getOrCreateUsage(authContext.client_id, subscription));
  if (!usage?.id) return null;
  const nextCount = Number(usage.evaluations_used || 0) + 1;
  await supabaseFetch(`client_usage?id=eq.${encodeFilterValue(usage.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ evaluations_used: nextCount, updated_at: new Date().toISOString() }),
  });
  return { ...usage, evaluations_used: nextCount, subscription };
}

async function recordEvaluation(authContext, packet, result, usageContext) {
  await supabaseFetch("evaluation_events", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      client_id: authContext.client_id,
      api_key_id: authContext.api_key_id,
      packet_id: packet?.packet_id || null,
      outcome: result.outcome,
      artifact_hash: result.artifact_hash,
      request_domain: packet?.system_context?.domain || null,
      request_workflow: packet?.system_context?.workflow || null,
      consequence_level: packet?.system_context?.consequence_level || packet?.consequence_boundary?.level || null,
      billing_plan_code: usageContext?.subscription?.plan_code || null,
      billing_period_start: usageContext?.period_start || null,
      billing_period_end: usageContext?.period_end || null,
      evaluations_used_after: usageContext?.evaluations_used || null,
    }),
  });
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed", allowed_methods: ["POST"] });

    const authContext = await authenticate(req);
    if (!authContext) return json(res, 401, { error: "Unauthorized" });

    const billing = await enforceBilling(authContext);
    if (!billing.allowed) return json(res, billing.status || 402, { error: billing.error || "Billing enforcement failed" });

    const packet = await readJsonBody(req);
    const result = evaluateRuntimeAdmissibility(packet);
    const usageContext = await incrementUsage(authContext, billing);
    await recordEvaluation(authContext, packet, result, usageContext);

    return json(res, 200, {
      ...result,
      client: { id: authContext.client_id, name: authContext.client_name, key_label: authContext.key_label },
      usage: usageContext
        ? {
            plan_code: usageContext.subscription?.plan_code || null,
            period_start: usageContext.period_start,
            period_end: usageContext.period_end,
            evaluations_used: usageContext.evaluations_used,
            monthly_quota: usageContext.subscription?.monthly_quota || null,
          }
        : null,
    });
  } catch (error) {
    return json(res, 500, { error: "Evaluation failed", detail: error instanceof Error ? error.message : String(error) });
  }
};

module.exports.evaluateRuntimeAdmissibility = evaluateRuntimeAdmissibility;
