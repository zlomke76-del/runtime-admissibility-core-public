const crypto = require("crypto");
const {
  getPlanDefaults,
  encodeFilterValue,
  readRawBody,
  supabaseFetch,
  createApiKey,
} = require("./_shared");

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ACCESS_INQUIRY_FROM = process.env.ACCESS_INQUIRY_FROM || "Runtime Admissibility <noreply@runtime-admissibility.com>";
const WEBHOOK_TOLERANCE_SECONDS = 300;

function verifyStripeSignature(rawBody, signatureHeader) {
  if (!STRIPE_WEBHOOK_SECRET) return true;
  if (!signatureHeader) return false;

  const parts = signatureHeader.split(",").reduce((acc, part) => {
    const [key, value] = part.split("=");
    if (!key || !value) return acc;
    if (!acc[key]) acc[key] = [];
    acc[key].push(value);
    return acc;
  }, {});

  const timestamp = Number(parts.t?.[0]);
  const signatures = parts.v1 || [];
  if (!Number.isFinite(timestamp) || !signatures.length) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > WEBHOOK_TOLERANCE_SECONDS) return false;

  const expected = crypto.createHmac("sha256", STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
  return signatures.some((signature) => {
    try {
      return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
    } catch {
      return false;
    }
  });
}

async function stripeFetch(path) {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, { headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || "Stripe request failed.");
  return payload;
}

async function logBillingEvent(event, handled, errorMessage = null) {
  await supabaseFetch("billing_events", {
    method: "POST",
    headers: { Prefer: "return=minimal,resolution=merge-duplicates" },
    body: JSON.stringify({ stripe_event_id: event.id, event_type: event.type, payload: event, handled, error_message: errorMessage }),
  });
}

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY || !to) return { skipped: true };
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: ACCESS_INQUIRY_FROM, to: [to], subject, html }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("[resend] email failed", payload);
    return { skipped: true, error: payload?.message || payload?.error || "Resend failed" };
  }
  return payload;
}

async function sendWelcomeEmail({ to, token, planCode }) {
  if (!to || !token) return;
  await sendEmail({
    to,
    subject: "Runtime Admissibility API access is ready",
    html: `
      <h2>Your Runtime Admissibility API access is ready</h2>
      <p>Your <strong>${planCode}</strong> subscription is active.</p>
      <p>Store this token securely. It will not be shown again.</p>
      <pre style="padding:16px;background:#0b1220;color:#eaf2ff;border-radius:12px;white-space:pre-wrap">${token}</pre>
      <p>Use it as:</p>
      <pre style="padding:16px;background:#0b1220;color:#eaf2ff;border-radius:12px;white-space:pre-wrap">Authorization: Bearer ${token}</pre>
    `,
  });
}

async function sendPaymentFailedEmail({ to }) {
  if (!to) return;
  await sendEmail({
    to,
    subject: "Runtime Admissibility payment action required",
    html: "<h2>Payment action required</h2><p>Your Runtime Admissibility subscription payment failed. Please update billing to keep API access active.</p>",
  });
}

async function getClient(clientId) {
  const rows = await supabaseFetch(`api_clients?id=eq.${encodeFilterValue(clientId)}&select=id,name,contact_email,stripe_customer_id&limit=1`);
  return rows?.[0] || null;
}

async function getClientByStripeCustomer(stripeCustomerId) {
  if (!stripeCustomerId) return null;
  const rows = await supabaseFetch(`api_clients?stripe_customer_id=eq.${encodeFilterValue(stripeCustomerId)}&select=id,name,contact_email,stripe_customer_id&limit=1`);
  return rows?.[0] || null;
}

async function patchClient(clientId, payload) {
  await supabaseFetch(`api_clients?id=eq.${encodeFilterValue(clientId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ ...payload, updated_at: new Date().toISOString() }),
  });
}

async function createClientFromCheckout(session) {
  const clientName = session.customer_details?.name || session.customer_email || "Runtime Admissibility Client";
  const contactEmail = session.customer_details?.email || session.customer_email || null;
  const inserted = await supabaseFetch("api_clients?select=id,name,contact_email,stripe_customer_id", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ name: clientName, contact_email: contactEmail, stripe_customer_id: session.customer || null, status: "active", updated_at: new Date().toISOString() }),
  });
  return inserted?.[0] || null;
}

async function resolveClientForSubscription(subscription, fallbackMetadata = {}) {
  const metadata = { ...(fallbackMetadata || {}), ...(subscription.metadata || {}) };
  if (metadata.client_id) {
    const client = await getClient(metadata.client_id);
    if (client) {
      if (subscription.customer && client.stripe_customer_id !== subscription.customer) {
        await patchClient(client.id, { stripe_customer_id: subscription.customer });
      }
      return { clientId: client.id, client };
    }
  }

  const byCustomer = await getClientByStripeCustomer(subscription.customer);
  if (byCustomer) return { clientId: byCustomer.id, client: byCustomer };

  throw new Error("Unable to resolve client for Stripe subscription.");
}

async function ensureInitialApiKey(clientId, email, planCode) {
  const existing = await supabaseFetch(`api_keys?client_id=eq.${encodeFilterValue(clientId)}&status=eq.active&select=id&limit=1`);
  if (existing?.[0]) return null;
  const { token } = await createApiKey({ client_id: clientId, label: "default-live-key", created_by: "stripe-webhook" });
  await sendWelcomeEmail({ to: email, token, planCode });
  return token;
}

async function upsertSubscriptionRecord(payload) {
  const existing = await supabaseFetch(`client_subscriptions?stripe_subscription_id=eq.${encodeFilterValue(payload.stripe_subscription_id)}&select=id&limit=1`);
  if (existing?.[0]?.id) {
    await supabaseFetch(`client_subscriptions?id=eq.${encodeFilterValue(existing[0].id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(payload),
    });
    return existing[0].id;
  }
  const inserted = await supabaseFetch("client_subscriptions", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(payload),
  });
  return inserted?.[0]?.id || null;
}

async function upsertSubscriptionFromStripe(subscriptionOrId, fallbackMetadata = {}) {
  const subscription = typeof subscriptionOrId === "string" ? await stripeFetch(`subscriptions/${subscriptionOrId}`) : subscriptionOrId;
  const metadata = { ...(fallbackMetadata || {}), ...(subscription.metadata || {}) };
  const planCode = metadata.plan_code || "developer";
  const defaults = getPlanDefaults(planCode);
  const item = subscription.items?.data?.[0];
  const { clientId, client } = await resolveClientForSubscription(subscription, metadata);

  const payload = {
    client_id: clientId,
    stripe_customer_id: subscription.customer || null,
    stripe_subscription_id: subscription.id,
    stripe_price_id: item?.price?.id || null,
    plan_code: planCode,
    status: subscription.status || "incomplete",
    monthly_quota: defaults.monthly_quota,
    current_period_start: subscription.current_period_start ? new Date(subscription.current_period_start * 1000).toISOString() : null,
    current_period_end: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null,
    audit_retention_days: defaults.audit_retention_days,
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    max_keys: defaults.max_keys,
    updated_at: new Date().toISOString(),
  };

  await upsertSubscriptionRecord(payload);
  if (["active", "trialing"].includes(payload.status)) {
    await ensureInitialApiKey(clientId, client?.contact_email, planCode);
  }
}

async function handleCheckoutCompleted(session) {
  const metadata = session.metadata || {};
  let clientId = metadata.client_id || "";
  let client = clientId ? await getClient(clientId) : null;

  if (!client) {
    client = await getClientByStripeCustomer(session.customer) || await createClientFromCheckout(session);
    clientId = client?.id || "";
  }

  if (!clientId) throw new Error("Unable to resolve client for checkout session.");

  await patchClient(clientId, {
    stripe_customer_id: session.customer || client?.stripe_customer_id || null,
    contact_email: client?.contact_email || session.customer_details?.email || session.customer_email || null,
    name: client?.name || session.customer_details?.name || session.customer_email || "Runtime Admissibility Client",
  });

  if (session.subscription) {
    await upsertSubscriptionFromStripe(session.subscription, { ...metadata, client_id: clientId });
  }
}

async function handleInvoicePaymentFailed(invoice) {
  const client = await getClientByStripeCustomer(invoice.customer);
  await sendPaymentFailedEmail({ to: client?.contact_email });
}

async function handleEvent(event) {
  if (event.type === "checkout.session.completed") return handleCheckoutCompleted(event.data.object);
  if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) {
    return upsertSubscriptionFromStripe(event.data.object, event.data.object.metadata || {});
  }
  if (event.type === "invoice.payment_failed") return handleInvoicePaymentFailed(event.data.object);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed. Use POST." });
  if (!STRIPE_SECRET_KEY) return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY." });

  try {
    const rawBody = await readRawBody(req);
    const signature = req.headers["stripe-signature"];
    if (!verifyStripeSignature(rawBody, signature)) return res.status(400).json({ error: "Invalid Stripe webhook signature." });

    const event = JSON.parse(rawBody);
    try {
      await handleEvent(event);
      await logBillingEvent(event, true, null);
    } catch (error) {
      await logBillingEvent(event, false, error instanceof Error ? error.message : String(error));
      throw error;
    }
    return res.status(200).json({ received: true });
  } catch (error) {
    return res.status(500).json({ error: "Webhook handling failed", detail: error instanceof Error ? error.message : String(error) });
  }
};
