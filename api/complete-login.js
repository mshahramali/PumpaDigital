// POST /api/complete-login  { waba_id }
// Creates the client's Supabase login with a PASSWORD (manual-onboarding mode).
// Runs only when BOTH exist: the provisioned business (from the webhook) AND
// the pending email (from the browser). Idempotent — safe to call many times.
//
// What it does now (password mode, no email dependency):
//   - creates the auth user with a generated password, OR
//   - if the user already exists, resets their password to a fresh one
//   - links their profile to the business (role: client)
//   - LOGS the email + password to the Vercel function log, and RETURNS them
//     in the JSON response, so you can copy the credentials and send them to
//     the client yourself (e.g. over WhatsApp). No magic-link email needed.
//
// The client logs in at your login page with email + password.
// No npm packages — raw fetch against Supabase Auth Admin + REST.

const crypto = require('crypto');

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

// Readable but strong: 3 short groups, e.g. "Pumpa-7F2K-9QXM". Easy to relay
// over WhatsApp, hard to guess. ~10^12 space in the random part.
function makePassword() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I/l
  const grp = (n) =>
    Array.from({ length: n }, () => abc[crypto.randomInt(abc.length)]).join('');
  return `Pumpa-${grp(4)}-${grp(4)}`;
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

    const email = ps.email;
    const password = makePassword();

    // 3. Does the user already exist?
    const usersRes = await sb(`/auth/v1/admin/users?email=${encodeURIComponent(email)}`);
    const usersJson = await usersRes.json();
    let userId = usersJson?.users?.[0]?.id || null;

    if (!userId) {
      // Create the auth user WITH a password and pre-confirmed email so they
      // can log in immediately (no email verification step).
      const createRes = await sb(`/auth/v1/admin/users`, {
        method: 'POST',
        body: JSON.stringify({
          email,
          password,
          email_confirm: true,
          user_metadata: { business_id: biz.id },
        }),
      });
      const created = await createRes.json();
      userId = created?.id || created?.user?.id || null;
      console.log('COMPLETE-LOGIN: created user', email, createRes.status);
    } else {
      // User already exists → reset their password to this fresh one so the
      // credentials you hand out always work (safe to re-run).
      const updRes = await sb(`/auth/v1/admin/users/${userId}`, {
        method: 'PUT',
        body: JSON.stringify({ password, email_confirm: true }),
      });
      console.log('COMPLETE-LOGIN: reset password for', email, updRes.status);
    }

    if (userId) {
      // Ensure the profile is linked to THIS business (role: client).
      await sb(`/rest/v1/profiles?on_conflict=id`, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ id: userId, business_id: biz.id, role: 'client' }),
      });
    } else {
      console.log('COMPLETE-LOGIN: could not resolve user id for', email);
      return res.status(200).json({ ok: false, reason: 'user not created' });
    }

    // 4. Surface the credentials. THIS is what you copy from the Vercel log
    //    (or read from the response) and send to the client over WhatsApp.
    console.log('COMPLETE-LOGIN: CREDENTIALS →', email, '|', password);

    return res.status(200).json({
      ok: true,
      business_id: biz.id,
      login_email: email,
      login_password: password,
      login_url: 'https://zyvonai.com/login.html',
    });
  } catch (err) {
    console.error('complete-login error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
