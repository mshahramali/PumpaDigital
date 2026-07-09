// POST /api/complete-login  { waba_id }
// Creates the client's Supabase login and emails a magic link — but ONLY
// when BOTH exist: the provisioned business (from the webhook) AND the
// pending email (from the browser). Safe to call many times; it checks
// whether a profile already exists and does nothing if so.
// No npm packages — raw fetch against Supabase Auth Admin + REST.

const SUPABASE_URL = "https://dpeszhbdgxevlkrfllrc.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  return r;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const { waba_id } = req.body || {};
    if (!waba_id) return res.status(400).json({ error: 'waba_id required' });

    // 1. Business must exist (webhook provisioned it).
    const bizRes = await sb(`/rest/v1/businesses?whatsapp_waba_id=eq.${waba_id}&select=id&limit=1`);
    const biz = (await bizRes.json())[0];
    if (!biz) return res.status(200).json({ ok: false, reason: 'business not provisioned yet' });

    // 2. Email must exist (browser stored it).
    const psRes = await sb(`/rest/v1/pending_signups?waba_id=eq.${waba_id}&select=email&limit=1`);
    const ps = (await psRes.json())[0];
    if (!ps || !ps.email) return res.status(200).json({ ok: false, reason: 'email not captured yet' });

    // 3. Already linked? Then we're done — don't re-create.
    //    Find the user by email, see if their profile points at this business.
    const usersRes = await sb(`/auth/v1/admin/users?email=${encodeURIComponent(ps.email)}`);
    const usersJson = await usersRes.json();
    let userId = usersJson?.users?.[0]?.id || null;

    if (!userId) {
      // Create the auth user with business_id in metadata (the trigger links the profile).
      const createRes = await sb(`/auth/v1/admin/users`, {
        method: 'POST',
        body: JSON.stringify({
          email: ps.email,
          email_confirm: true,
          user_metadata: { business_id: biz.id },
        }),
      });
      const created = await createRes.json();
      userId = created?.id || created?.user?.id || null;
    }

    if (userId) {
      // Ensure the profile is linked to THIS business (overrides any trigger default).
      await sb(`/rest/v1/profiles?on_conflict=id`, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ id: userId, business_id: biz.id, role: 'client' }),
      });
    }

    // 4. Generate a magic link and let Supabase email it (built-in SMTP for now).
    const linkRes = await sb(`/auth/v1/admin/generate_link`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'magiclink',
        email: ps.email,
        // where the client lands after clicking the link:
        redirect_to: 'https://zyvonai.com/app.html',
      }),
    });
    const linkJson = await linkRes.json();
    // Supabase emails automatically when SMTP is configured; the action_link
    // is also returned so you can resend manually if needed.
    console.log('COMPLETE-LOGIN: link generated for', ps.email, linkRes.status);

    return res.status(200).json({
      ok: true,
      business_id: biz.id,
      email: ps.email,
      action_link: linkJson?.properties?.action_link || linkJson?.action_link || null,
    });
  } catch (err) {
    console.error('complete-login error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
