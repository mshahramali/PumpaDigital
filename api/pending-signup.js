// POST /api/pending-signup  { waba_id, email, business_name, password }
// Called by onboard.html the moment the Embedded Signup popup returns a
// waba_id. Stores what the browser knows (email + the client's CHOSEN
// password) so the webhook side — which never receives these from Meta —
// can create the login. Upserts on waba_id, so repeat calls are safe.
//
// The password is held here only until complete-login creates the auth
// user, then complete-login wipes it from the row.
//
// After storing, this endpoint also triggers complete-login itself, so the
// login gets created no matter which side (browser or webhook) finishes last.
//
// No npm packages — raw fetch against Supabase REST.

const SUPABASE_URL = "https://dpeszhbdgxevlkrfllrc.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const { waba_id, email, business_name, password } = req.body || {};
    if (!waba_id || !email) {
      return res.status(400).json({ error: 'waba_id and email required' });
    }

    // Upsert the pending signup keyed on waba_id.
    const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/pending_signups?on_conflict=waba_id`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        waba_id,
        email,
        business_name: business_name || null,
        password: password || null,
      }),
    });

    if (!upsertRes.ok) {
      const t = await upsertRes.text();
      console.error('PENDING-SIGNUP: upsert failed', upsertRes.status, t);
      return res.status(500).json({ error: 'store failed' });
    }

    console.log('PENDING-SIGNUP: stored for waba', waba_id);

    // Trigger complete-login from this side too — the business may already
    // exist (webhook finished first), in which case this call completes the
    // loop. If not, complete-login safely no-ops and the webhook side will
    // trigger it again after provisioning.
    try {
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const proto = req.headers['x-forwarded-proto'] || 'https';
      await fetch(`${proto}://${host}/api/complete-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ waba_id }),
      });
    } catch (e) {
      // Non-fatal: the webhook side will trigger complete-login anyway.
      console.error('PENDING-SIGNUP: complete-login trigger failed', e.message);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('pending-signup error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
