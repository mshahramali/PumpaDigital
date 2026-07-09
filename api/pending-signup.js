// POST /api/pending-signup
// Stores {waba_id, email, business_name} from the onboarding page.
// The webhook (provisionPartner) reads this by waba_id to create the
// client's login and email them a magic link. No npm packages — raw fetch.

const SUPABASE_URL = "https://dpeszhbdgxevlkrfllrc.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const { waba_id, email, business_name } = req.body || {};
    if (!waba_id || !email) return res.status(400).json({ error: 'waba_id and email required' });

    // Upsert on waba_id — idempotent if the browser calls twice.
    const r = await fetch(`${SUPABASE_URL}/rest/v1/pending_signups?on_conflict=waba_id`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({ waba_id, email, business_name: business_name || null }),
    });

    if (!r.ok) {
      const txt = await r.text();
      console.error('pending-signup insert failed:', txt);
      return res.status(500).json({ error: 'store failed' });
    }

    // If the webhook ALREADY provisioned this business (race: webhook first),
    // trigger login creation now by calling our own provisioning completer.
    // Fire-and-forget; the webhook path also handles it.
    try {
      await fetch(`https://${req.headers.host}/api/complete-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ waba_id }),
      });
    } catch (e) { /* non-fatal */ }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('pending-signup error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
