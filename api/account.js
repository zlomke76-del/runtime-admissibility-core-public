const {
  json,
  setCors,
  readJsonBody,
  encodeFilterValue,
  authenticate,
  supabaseFetch,
  createApiKey,
  getActiveSubscription,
  getOrCreateUsage,
  addDays,
} = require("./_shared");

function publicKey(row) {
  return {
    id: row.id,
    label: row.label,
    status: row.status,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
    expires_at: row.expires_at,
    created_by: row.created_by,
  };
}

async function listKeys(clientId) {
  const rows = await supabaseFetch(
    `api_keys?client_id=eq.${encodeFilterValue(clientId)}&select=id,label,status,created_at,last_used_at,revoked_at,expires_at,created_by&order=created_at.desc`
  );
  return (rows || []).map(publicKey);
}

async function listRecentEvaluations(clientId) {
  return (await supabaseFetch(
    `evaluation_events?client_id=eq.${encodeFilterValue(clientId)}&select=id,packet_id,outcome,artifact_hash,request_domain,request_workflow,consequence_level,created_at,billing_plan_code,billing_period_start,billing_period_end,evaluations_used_after&order=created_at.desc&limit=25`
  )) || [];
}

async function buildAccount(authContext) {
  const subscription = await getActiveSubscription(authContext.client_id);
  const usage = subscription ? await getOrCreateUsage(authContext.client_id, subscription) : null;
  const keys = await listKeys(authContext.client_id);
  const evaluations = await listRecentEvaluations(authContext.client_id);
  return {
    client: authContext.client,
    current_key: publicKey(authContext.key),
    subscription,
    usage: usage && subscription ? {
      ...usage,
      monthly_quota: subscription.monthly_quota,
      remaining: Math.max(0, Number(subscription.monthly_quota || 0) - Number(usage.evaluations_used || 0)),
    } : usage,
    keys,
    recent_evaluations: evaluations,
  };
}

async function createKey(authContext, body) {
  const subscription = await getActiveSubscription(authContext.client_id);
  const maxKeys = Number(subscription?.max_keys || 1);
  const activeKeys = await supabaseFetch(
    `api_keys?client_id=eq.${encodeFilterValue(authContext.client_id)}&status=eq.active&select=id`
  );
  if ((activeKeys || []).length >= maxKeys) {
    return { status: 403, payload: { error: "API key limit reached", max_keys: maxKeys } };
  }
  const label = String(body.label || `customer-key-${Date.now()}`).trim().slice(0, 80);
  const expiryDays = Number(body.expires_in_days || 365);
  const expiresAt = Number.isFinite(expiryDays) && expiryDays > 0 ? addDays(new Date(), Math.min(expiryDays, 3650)).toISOString() : null;
  const created = await createApiKey({ client_id: authContext.client_id, label, expires_at: expiresAt, created_by: "customer-console" });
  return {
    status: 200,
    payload: {
      token: created.token,
      api_key: publicKey(created.api_key),
      warning: "Store this token now. It will not be shown again.",
    },
  };
}

async function revokeKey(authContext, body) {
  const keyId = String(body.api_key_id || "").trim();
  if (!keyId) return { status: 400, payload: { error: "api_key_id is required" } };
  if (keyId === authContext.api_key_id) return { status: 400, payload: { error: "Use another active key to revoke the current key." } };

  await supabaseFetch(`api_keys?id=eq.${encodeFilterValue(keyId)}&client_id=eq.${encodeFilterValue(authContext.client_id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status: "revoked", revoked_at: new Date().toISOString() }),
  });
  return { status: 200, payload: { ok: true } };
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!["GET", "POST"].includes(req.method)) return json(res, 405, { error: "Method not allowed", allowed_methods: ["GET", "POST"] });

  try {
    const authContext = await authenticate(req, { touch: true });
    if (!authContext) return json(res, 401, { error: "Unauthorized" });

    if (req.method === "GET") return json(res, 200, await buildAccount(authContext));

    const body = await readJsonBody(req);
    const action = String(body.action || "").trim();
    if (action === "create_key") {
      const result = await createKey(authContext, body);
      return json(res, result.status, result.payload);
    }
    if (action === "revoke_key") {
      const result = await revokeKey(authContext, body);
      return json(res, result.status, result.payload);
    }
    return json(res, 400, { error: "Unknown action", allowed_actions: ["create_key", "revoke_key"] });
  } catch (error) {
    return json(res, 500, { error: "Account request failed", detail: error instanceof Error ? error.message : String(error) });
  }
};
