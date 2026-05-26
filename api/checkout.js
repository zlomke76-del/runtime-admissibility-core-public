const {
  APP_BASE_URL,
  json,
  readJsonBody,
  createApiClient,
} = require("./_shared");

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

const PLAN_PRICE_ENV = {
  developer: "STRIPE_DEVELOPER_PRICE_ID",
  infrastructure: "STRIPE_INFRASTRUCTURE_PRICE_ID",
  clinical_runtime: "STRIPE_CLINICAL_RUNTIME_PRICE_ID",
  financial_consequence: "STRIPE_FINANCIAL_CONSEQUENCE_PRICE_ID",
  sovereign_infrastructure: "STRIPE_SOVEREIGN_INFRASTRUCTURE_PRICE_ID",
};

function formEncode(payload) {
  const params = new URLSearchParams();
  function append(prefix, value) {
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value)) return value.forEach((item, index) => append(`${prefix}[${index}]`, item));
    if (typeof value === "object") return Object.entries(value).forEach(([key, item]) => append(`${prefix}[${key}]`, item));
    params.append(prefix, String(value));
  }
  Object.entries(payload).forEach(([key, value]) => append(key, value));
  return params;
}

function getStripeMode() {
  if (!STRIPE_SECRET_KEY) return "missing";
  if (STRIPE_SECRET_KEY.startsWith("sk_live_")) return "live";
  if (STRIPE_SECRET_KEY.startsWith("sk_test_")) return "test";
  return "unknown";
}

function getPlanConfig(planCode) {
  const priceEnv = PLAN_PRICE_ENV[planCode];
  const priceId = priceEnv ? process.env[priceEnv] : "";
  if (!priceEnv || !priceId) return null;
  return { planCode, priceEnv, priceId };
}

async function createStripeCheckoutSession({ priceId, client, planCode, customerEmail }) {
  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formEncode({
      mode: "subscription",
      success_url: `${APP_BASE_URL}/access.html?checkout=success&plan=${encodeURIComponent(planCode)}`,
      cancel_url: `${APP_BASE_URL}/access.html?checkout=cancelled&plan=${encodeURIComponent(planCode)}`,
      customer_email: customerEmail || client.contact_email || undefined,
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      metadata: { client_id: client.id, plan_code: planCode, product: "runtime_admissibility_core" },
      subscription_data: { metadata: { client_id: client.id, plan_code: planCode, product: "runtime_admissibility_core" } },
    }).toString(),
  });

  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || "Stripe Checkout session creation failed.");
  return payload;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", APP_BASE_URL);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed.", allowed_methods: ["POST"] });

  try {
    const body = await readJsonBody(req);
    const planCode = String(body.plan_code || "developer").trim().toLowerCase();
    const planConfig = getPlanConfig(planCode);
    if (!planConfig) return json(res, 400, { error: "Plan is not available for checkout.", detail: `Missing ${PLAN_PRICE_ENV[planCode] || "price environment variable"}.`, plan_code: planCode });

    const mode = getStripeMode();
    if (mode === "missing") return json(res, 500, { error: "Stripe is not configured.", detail: "Missing STRIPE_SECRET_KEY." });
    if (mode === "unknown") return json(res, 500, { error: "Stripe secret key is invalid.", detail: "STRIPE_SECRET_KEY must start with sk_live_ or sk_test_." });

    const client = body.client_id
      ? { id: body.client_id, contact_email: body.customer_email || null }
      : await createApiClient({ name: body.name || body.customer_email || "Runtime Admissibility Client", contact_email: body.customer_email || null, organization: body.organization || null });

    if (!client?.id) return json(res, 500, { error: "Unable to create checkout client." });

    const session = await createStripeCheckoutSession({ priceId: planConfig.priceId, planCode, client, customerEmail: body.customer_email });

    return json(res, 200, { url: session.url, id: session.id, mode, plan_code: planCode, client_id: client.id });
  } catch (error) {
    return json(res, 500, { error: "Checkout failed", detail: error instanceof Error ? error.message : String(error) });
  }
};
