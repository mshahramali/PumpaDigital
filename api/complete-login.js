// POST /api/complete-login  { waba_id }
// Creates the client's Supabase login using the password THEY chose on
// onboard.html (self-service — no manual credential handoff needed).
// Runs only when BOTH exist: the provisioned business (from the webhook) AND
// the pending email (from the browser). Idempotent — safe to call many times.
//
// Flow:
//   - first call for this waba_id (once business + email exist): creates the
//     auth user with the client's chosen password (pre-confirmed email, so
//     they can log in immediately), links their profile to the business,
//     then WIPES the password from pending_signups.
//   - every later call: detects the profile is already linked to this
//     business and no-ops. No password is ever reset on repeat calls.
//   - fallback: if no password was captured (old row / edge case), generates
//     a readable one (Pumpa-XXXX-XXXX) and logs it as CREDENTIALS so the
//     admin can hand it over manually — the old manual flow still works.
//   - edge case: user exists in Supabase but was never linked to THIS
//     business — links the profile without touching their password.
//
// The client logs in at zyvonai.com/login.html with their email + password.
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

// Fallback only (used when the client somehow didn't set a password).
// Readable but strong: e.g. "Pumpa-7F2K-9QXM".
function makePassword() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I/l
  const grp = (n) =>
    Array.from({ length: n }, () => abc[crypto.randomInt(abc.length)]).join('');
  return `Pumpa-${grp(4)}-${grp(4)}`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const { waba_id, reset_password, admin_secret } = req.body || {};
    if (!waba_id) return res.status(400).json({ error: 'waba_id required' });

    // 1. Business must exist (webhook provisioned it).
    const bizRes = await sb(`/rest/v1/businesses?whatsapp_waba_id=eq.${waba_id}&select=id&limit=1`);
    const bizJson = await bizRes.json();
    if (!bizRes.ok) {
      console.error('COMPLETE-LOGIN: businesses query failed →', bizRes.status, JSON.stringify(bizJson).slice(0, 300));
      return res.status(200).json({ ok: false, reason: 'business lookup error', detail: bizJson });
    }
    const biz = bizJson[0];
    if (!biz) return res.status(200).json({ ok: false, reason: 'business not provisioned yet' });

    // 2. Email must exist (browser stored it). Password may exist too.
    const psRes = await sb(`/rest/v1/pending_signups?waba_id=eq.${waba_id}&select=email,password&limit=1`);
    const psJson = await psRes.json();
    if (!psRes.ok) {
      console.error('COMPLETE-LOGIN: pending_signups query failed →', psRes.status, JSON.stringify(psJson).slice(0, 300));
      return res.status(200).json({ ok: false, reason: 'pending signup lookup error', detail: psJson });
    }
    const ps = psJson[0];
    if (!ps || !ps.email) return res.status(200).json({ ok: false, reason: 'email not captured yet' });

    const email = ps.email;

    // 3. Does the user already exist?
    const usersRes = await sb(`/auth/v1/admin/users?email=${encodeURIComponent(email)}`);
    const usersJson = await usersRes.json();
    if (!usersRes.ok) {
      console.error('COMPLETE-LOGIN: users lookup failed →', usersRes.status, JSON.stringify(usersJson).slice(0, 300));
      return res.status(200).json({ ok: false, reason: 'user lookup error', detail: usersJson });
    }
    let userId = usersJson?.users?.[0]?.id || null;
    if ((usersJson?.users?.length || 0) > 1) {
      console.error('COMPLETE-LOGIN: WARNING multiple users matched email →', email, usersJson.users.map(u => u.id));
    }

    // 3b. Admin recovery path: if the account already exists (so normal
    //     creation would just no-op) but the client's original signup was
    //     lost to the popup-timing race, an admin can force-set a known
    //     password by passing reset_password + admin_secret. Gated behind
    //     ADMIN_ACTION_SECRET (a Vercel env var only the project owner
    //     knows) — NOT the Supabase service key, so nothing high-privilege
    //     ever needs to be pasted into a browser.
    if (userId && reset_password) {
      if (!process.env.ADMIN_ACTION_SECRET || admin_secret !== process.env.ADMIN_ACTION_SECRET) {
        return res.status(403).json({ ok: false, reason: 'invalid admin_secret' });
      }
      const resetRes = await sb(`/auth/v1/admin/users/${userId}`, {
        method: 'PUT',
        body: JSON.stringify({ password: reset_password, email_confirm: true }),
      });
      const resetJson = await resetRes.json();
      if (!resetRes.ok) {
        console.error('COMPLETE-LOGIN: password reset failed →', resetRes.status, JSON.stringify(resetJson).slice(0, 300));
        return res.status(200).json({ ok: false, reason: 'password reset failed', detail: resetJson });
      }
      console.log('COMPLETE-LOGIN: admin password reset →', email, 'targetUserId:', userId);
      return res.status(200).json({
        ok: true, reset: true, login_email: email, target_user_id: userId,
        returned_id: resetJson?.id, returned_email: resetJson?.email,
        email_confirmed_at: resetJson?.email_confirmed_at,
      });
    }

    // 4. Idempotency: if the user's profile is ALREADY linked to THIS
    //    business, this signup was fully completed — do nothing.
    if (userId) {
      const profRes = await sb(`/rest/v1/profiles?id=eq.${userId}&select=business_id&limit=1`);
      const prof = (await profRes.json())[0];
      if (prof && prof.business_id === biz.id) {
        console.log('COMPLETE-LOGIN: already provisioned, skipping →', email);
        return res.status(200).json({ ok: true, already: true, business_id: biz.id, login_email: email });
      }
    }

    let isNewUser = false;
    let usedFallback = false;
    let fallbackPassword = null;

    if (!userId) {
      // Genuinely new — create the auth user with the CLIENT'S chosen
      // password. Pre-confirm the email so they can log in immediately.
      isNewUser = true;
      let password = ps.password;
      if (!password) {
        // Edge case: no password captured — fall back to generated one so
        // the admin can hand it over manually (old flow).
        usedFallback = true;
        fallbackPassword = makePassword();
        password = fallbackPassword;
      }

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
    // else: user exists but wasn't linked to this business yet (partial
    // failure last time). Link below WITHOUT touching their password.

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

    // 6. Wipe the password from pending_signups — it has served its purpose
    //    and should not sit in the database.
    await sb(`/rest/v1/pending_signups?waba_id=eq.${waba_id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ password: null }),
    });

    if (isNewUser && usedFallback) {
      // Manual-handoff fallback: surface the generated credentials once.
      console.log('COMPLETE-LOGIN: CREDENTIALS →', email, '|', fallbackPassword);
      return res.status(200).json({
        ok: true,
        business_id: biz.id,
        login_email: email,
        login_password: fallbackPassword,
        login_url: 'https://zyvonai.com/login.html',
      });
    }

    if (isNewUser) {
      // Self-service success: client already knows their password.
      // Never log it.
      console.log('COMPLETE-LOGIN: account created (self-set password) →', email);
      return res.status(200).json({
        ok: true,
        business_id: biz.id,
        login_email: email,
        login_url: 'https://zyvonai.com/login.html',
      });
    }

    // Existing user, newly linked — no password change.
    console.log('COMPLETE-LOGIN: linked existing user to business, no password change →', email);
    return res.status(200).json({
      ok: true,
      linked_existing: true,
      business_id: biz.id,
      login_email: email,
    });
  } catch (err) {
    console.error('complete-login error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
