// Vercel Serverless Function: returns browser-safe Supabase settings only.
// Do not add service_role keys, database passwords, or MFU SSO client secrets here.
module.exports = function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !publishableKey) {
    return res.status(503).json({
      error: "Missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY."
    });
  }

  try {
    const parsed = new URL(supabaseUrl);
    if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".supabase.co")) {
      return res.status(500).json({ error: "SUPABASE_URL must be an HTTPS Supabase project URL." });
    }
  } catch {
    return res.status(500).json({ error: "SUPABASE_URL is invalid." });
  }

  return res.status(200).json({ supabaseUrl, publishableKey });
};
