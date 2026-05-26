const crypto = require("crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_BASE_URL = process.env.APP_BASE_URL || "https://www.runtime-admissibility.com";

const PLAN_LIMITS = {
  playground: { monthly_quota: 1000, audit_retention_days: 7, max_keys: 1 },
  developer: { monthly_quota: 10000, audit_retention_days: 30, max_keys: 1 },
  infrastructure: { monthly_quota: 250000, audit_retention_days: 365, max_keys: 5 },
  clinical_runtime: { monthly_quota: 500000, audit_retention_days: 2555, max_keys: 10 },
  financial_consequence: { monthly_quota: 500000, audit_retention_days: 2555, max_keys: 10 },
  sovereign_infrastructure: { monthly_quota: 1000000, audit_retention_days: 3650, max_keys: 25 },
};

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload, null, 2));
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function createClientToken() {
  return `ra_live_${crypto.randomBytes(32).toString("hex")}`;
}

function encodeFilterValue(value) {
  return encodeURIComponent(String(value));
}

function getPlanDefaults(planCode) {
  return PLAN_LIMITS[planCode] || PLAN_LIMITS.developer;
}

function currentUsagePeriod(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return {
    period_start: start.toISOString().slice(0, 10),
    period_end: end.toISOString().slice(0, 10),
  };
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", APP_BASE_URL);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function supabaseFetch(path, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase environment variables are missing.");
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Accept-Profile": "runtime_admissibility",
      "Content-Profile": "runtime_admissibility",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase request failed: ${response.status} ${text || response.statusText}`);
  }
  if (!text || response.status === 204) return null;
  return JSON.parse(text);
}

async function createApiClient({ name, contact_email, stripe_customer_id = null, organization = null }) {
  const rows = await supabaseFetch("api_clients", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      name: name || contact_email || organization || "Runtime Admissibility Client",
      contact_email: contact_email || null,
      organization: organization || null,
      stripe_customer_id,
      status: "active",
      updated_at: new Date().toISOString(),
    }),
  });
  return rows?.[0] || null;
}

async function createApiKey({ client_id, label = "default", expires_at = null, created_by = "system" }) {
  const token = createClientToken();
  const rows = await supabaseFetch("api_keys", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      client_id,
      label,
      token_hash: sha256(token),
      status: "active",
      expires_at,
      created_by,
    }),
  });
  return { token, api_key: rows?.[0] || null };
}

function getBearerToken(req) {
  const authorization = req.headers.authorization || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) return "";
  return authorization.slice(7).trim();
}

async function authenticate(req, { touch = true } = {}) {
  const token = getBearerToken(req);
  if (!token) return null;
  const tokenHash = sha256(token.trim());

  const rows = await supabaseFetch(
    `api_keys?token_hash=eq.${encodeFilterValue(tokenHash)}&status=eq.active&select=id,client_id,label,status,expires_at,last_used_at,created_at,created_by&limit=1`
  );
  const key = rows?.[0];
  if (!key) return null;
  if (key.expires_at && new Date(key.expires_at).getTime() <= Date.now()) return null;

  const clients = await supabaseFetch(
    `api_clients?id=eq.${encodeFilterValue(key.client_id)}&status=eq.active&select=id,name,status,contact_email,organization,stripe_customer_id,created_at,updated_at&limit=1`
  );
  const client = clients?.[0];
  if (!client) return null;

  if (touch) {
    await supabaseFetch(`api_keys?id=eq.${encodeFilterValue(key.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ last_used_at: new Date().toISOString() }),
    });
  }

  return {
    token,
    api_key_id: key.id,
    client_id: key.client_id,
    client_name: client.name,
    key_label: key.label,
    key,
    client,
  };
}

async function getActiveSubscription(clientId) {
  const rows = await supabaseFetch(
    `client_subscriptions?client_id=eq.${encodeFilterValue(clientId)}&status=in.(active,trialing)&select=id,status,plan_code,monthly_quota,current_period_start,current_period_end,audit_retention_days,max_keys,cancel_at_period_end,stripe_customer_id,stripe_subscription_id,stripe_price_id,updated_at&order=updated_at.desc&limit=1`
  );
  return rows?.[0] || null;
}

async function getOrCreateUsage(clientId, subscription) {
  const period = subscription?.current_period_start && subscription?.current_period_end
    ? { period_start: subscription.current_period_start.slice(0, 10), period_end: subscription.current_period_end.slice(0, 10) }
    : currentUsagePeriod();

  const existing = await supabaseFetch(
    `client_usage?client_id=eq.${encodeFilterValue(clientId)}&period_start=eq.${period.period_start}&period_end=eq.${period.period_end}&select=id,evaluations_used,period_start,period_end&limit=1`
  );
  if (existing?.[0]) return existing[0];

  const inserted = await supabaseFetch("client_usage", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ client_id: clientId, period_start: period.period_start, period_end: period.period_end, evaluations_used: 0 }),
  });
  return inserted?.[0] || null;
}

async function upsertActiveDemoSubscription(clientId) {
  const defaults = getPlanDefaults("playground");
  const now = new Date();
  const end = addDays(now, 30);
  const existing = await supabaseFetch(
    `client_subscriptions?client_id=eq.${encodeFilterValue(clientId)}&plan_code=eq.playground&status=eq.active&select=id&limit=1`
  );
  const payload = {
    client_id: clientId,
    plan_code: "playground",
    status: "active",
    monthly_quota: defaults.monthly_quota,
    audit_retention_days: defaults.audit_retention_days,
    max_keys: defaults.max_keys,
    current_period_start: now.toISOString(),
    current_period_end: end.toISOString(),
    updated_at: now.toISOString(),
  };
  if (existing?.[0]?.id) {
    await supabaseFetch(`client_subscriptions?id=eq.${encodeFilterValue(existing[0].id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(payload),
    });
    return existing[0];
  }
  const inserted = await supabaseFetch("client_subscriptions", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(payload),
  });
  return inserted?.[0] || null;
}

module.exports = {
  APP_BASE_URL,
  PLAN_LIMITS,
  json,
  sha256,
  createClientToken,
  encodeFilterValue,
  getPlanDefaults,
  currentUsagePeriod,
  addDays,
  setCors,
  readJsonBody,
  readRawBody,
  supabaseFetch,
  createApiClient,
  createApiKey,
  getBearerToken,
  authenticate,
  getActiveSubscription,
  getOrCreateUsage,
  upsertActiveDemoSubscription,
};
