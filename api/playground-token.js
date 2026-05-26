const {
  setCors,
  readJsonBody,
  createApiClient,
  createApiKey,
  upsertActiveDemoSubscription,
  addDays,
} = require("./_shared");

const PLAYGROUND_TOKEN_ENABLED = process.env.PLAYGROUND_TOKEN_ENABLED || "true";

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed. Use POST." });
  if (PLAYGROUND_TOKEN_ENABLED === "false") return res.status(403).json({ error: "Playground token generation is disabled." });

  try {
    const body = await readJsonBody(req);
    const label = String(body.label || `playground-${Date.now()}`).slice(0, 80);
    const client = await createApiClient({ name: "Runtime Admissibility Playground", contact_email: null, organization: "browser-playground" });
    if (!client?.id) return res.status(500).json({ error: "Playground client creation failed." });

    await upsertActiveDemoSubscription(client.id);

    const expiresAt = addDays(new Date(), 1).toISOString();
    const { token, api_key } = await createApiKey({
      client_id: client.id,
      label,
      expires_at: expiresAt,
      created_by: "browser-playground",
    });

    return res.status(200).json({
      token,
      expires_at: expiresAt,
      client_id: client.id,
      api_key_id: api_key?.id || null,
      subscription: { plan_code: "playground", status: "active", monthly_quota: 1000 },
    });
  } catch (error) {
    return res.status(500).json({ error: "Playground token creation failed", detail: error instanceof Error ? error.message : String(error) });
  }
};
