// POST /api/complete-login  { waba_id }
// Creates the client's Supabase login with a PASSWORD (manual-onboarding mode).
// Runs only when BOTH exist: the provisioned business (from the webhook) AND
// the pending email (from the browser). Idempotent — safe to call many times.
//
// IDEMPOTENCY FIX: multiple webhook events can trigger this for the same
// signup (PARTNER_ADDED can fire more than once). Earlier version reset the
// password on every call, so the LAST log line had the only valid password —
// easy to copy the wrong one. Now: a password is generated exactly ONCE, the
// first time a user+business link is created. Every call after that is a
// silent no-op that changes nothing and logs nothing new.
//
// What it does:
//   - first call for this waba_id: creates the auth user with a generated
//     password, links their profile to the business, logs + returns the
//     credentials (the ONLY time they're ever shown).
//   - every later call for the same waba_id: detects the profile is already
//     linked to this business, does nothing, returns { ok: true, already: true }.
//   - edge case — user exists in Supabase but was never linked to THIS
//     business (e.g. partial failure last time): links the profile, but does
//     NOT touch their password, since we don't know if it was already handed
//     to a client.
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

    // 3. Does the user already exist?
    const usersRes = await sb(`/auth/v1/admin/users?email=${encodeURIComponent(email)}`);
    const usersJson = await usersRes.json();
    let userId = usersJson?.users?.[0]?.id || null;

    // 4. If the user exists, check whether their profile is ALREADY linked
    //    to THIS business. If so, this signup was already fully completed —
    //    do nothing. This is the fix: no password reset on repeat calls.
    if (userId) {
      const profRes = await sb(`/rest/v1/profiles?id=eq.${userId}&select=business_id&limit=1`);
      const prof = (await profRes.json())[0];
      if (prof && prof.business_id === biz.id) {
        console.log('COMPLETE-LOGIN: already provisioned, skipping →', email);
        return res.status(200).json({ ok: true, already: true, business_id: biz.id, login_email: email });
      }
    }

    let password = null;
    let isNewUser = false;

    if (!userId) {
      // Genuinely new — create the auth user WITH a password and
      // pre-confirmed email so they can log in immediately.
      password = makePassword();
      isNewUser = true;
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
    }
    // else: user exists but wasn't linked to this business yet (edge case —
    // e.g. a prior call created the user but crashed before linking the
    // profile). We link below WITHOUT touching their password, since it may
    // already have been sent to a client.

    if (!userId) {
      console.log('COMPLETE-LOGIN: could not resolve user id for', email);
      return res.status(200).json({ ok: false, reason: 'user not created' });
    }

    // 5. Link the profile to THIS business (role: client).
    await sb(`/rest/v1/profiles?on_conflict=id`, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ id: userId, business_id: biz.id, role: 'client' }),
    });

    if (isNewUser) {
      // 6. Surface the credentials — this is the ONLY time they're ever
      //    shown. Copy from this log line and send to the client on WhatsApp.
      console.log('COMPLETE-LOGIN: CREDENTIALS →', email, '|', password);
      return res.status(200).json({
        ok: true,
        business_id: biz.id,
        login_email: email,
        login_password: password,
        login_url: 'https://zyvonai.com/login.html',
      });
    } else {
      // Existing user, just newly linked — no new password to show.
      console.log('COMPLETE-LOGIN: linked existing user to business, no password change →', email);
      return res.status(200).json({
        ok: true,
        linked_existing: true,
        business_id: biz.id,
        login_email: email,
      });
    }
  } catch (err) {
    console.error('complete-login error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
