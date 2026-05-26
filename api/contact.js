const { APP_BASE_URL, json, readJsonBody, supabaseFetch } = require("./_shared");

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ACCESS_INQUIRY_TO = process.env.ACCESS_INQUIRY_TO || "access@runtime-admissibility.com";
const ACCESS_INQUIRY_FROM = process.env.ACCESS_INQUIRY_FROM || "Runtime Admissibility <noreply@runtime-admissibility.com>";

function sanitize(value, max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function sendResendEmail({ subject, html, replyTo }) {
  if (!RESEND_API_KEY) return { skipped: true, reason: "Missing RESEND_API_KEY" };
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: ACCESS_INQUIRY_FROM, to: [ACCESS_INQUIRY_TO], reply_to: replyTo || undefined, subject, html }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.message || payload?.error || "Resend request failed.");
  return payload;
}

async function recordInquiry({ name, email, organization, message, source }) {
  const rows = await supabaseFetch("access_inquiries", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ name, email, organization: organization || null, message, source: source || "access-page", status: "new" }),
  });
  return rows?.[0] || null;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", APP_BASE_URL);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed. Use POST." });

  try {
    const body = await readJsonBody(req);
    const name = sanitize(body.name, 160);
    const email = sanitize(body.email, 240);
    const organization = sanitize(body.organization, 240);
    const message = sanitize(body.message, 6000);
    const source = sanitize(body.source, 120);

    if (!name || !email || !message) return json(res, 400, { error: "Name, email, and message are required." });

    const inquiry = await recordInquiry({ name, email, organization, message, source });
    const html = `
      <h2>Runtime Admissibility access inquiry</h2>
      <p><strong>Inquiry ID:</strong> ${escapeHtml(inquiry?.id || "not recorded")}</p>
      <p><strong>Name:</strong> ${escapeHtml(name)}</p>
      <p><strong>Email:</strong> ${escapeHtml(email)}</p>
      <p><strong>Organization:</strong> ${escapeHtml(organization || "Not provided")}</p>
      <p><strong>Source:</strong> ${escapeHtml(source || "access-page")}</p>
      <hr />
      <p style="white-space:pre-wrap">${escapeHtml(message)}</p>
    `;

    const sent = await sendResendEmail({ subject: `Runtime Admissibility inquiry — ${organization || name}`, html, replyTo: email });
    return json(res, 200, { ok: true, inquiry_id: inquiry?.id || null, email_id: sent?.id || null, email_skipped: Boolean(sent?.skipped) });
  } catch (error) {
    return json(res, 500, { error: "Inquiry failed", detail: error instanceof Error ? error.message : String(error) });
  }
};
