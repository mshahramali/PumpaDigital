// POST /api/onboard
//
// Everything you did by hand for Arafat, in one call.
// Fed by the Embedded Signup FINISH callback (onboard.html).
//
// Body: { code, waba_id, phone_number_id, email, business_name }
//
// Vercel env required:
//   FB_APP_ID, FB_APP_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY
//   ADMIN_WHATSAPP_NUMBER   (where "new client!" pings go)
//   WHATSAPP_TOKEN          (your system user token — used only to notify you)

import { createClient } from '@supabase/supabase-js';

const GRAPH = 'https://graph.facebook.com/v25.0';

const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { code, waba_id, phone_number_id, email, business_name } = req.body ?? {};
  if (!code || !waba_id) {
    return res.status(400).json({ error: 'code and waba_id required' });
  }

  const log = (step, detail) =>
    console.log(JSON.stringify({ step, waba_id, email, ...detail }));

  try {
    // ── 1. Exchange the code for a BUSINESS TOKEN scoped to this client's WABA.
    //       This is the Tech Provider pattern. No shared master key.
    log('exchange_code', {});
    const token = await exchangeCodeForToken(code);

    // ── 2. Tell Meta to send us this WABA's webhooks.
    //       You did this by hand in Graph API Explorer. Now it's automatic.
    log('subscribe_apps', {});
    await graph(`${waba_id}/subscribed_apps`, token, { method: 'POST' });

    // ── 3. Read their phone number. Trust Meta over the callback payload.
    log('fetch_phone_numbers', {});
    const numbers = await graph(`${waba_id}/phone_numbers`, token);
    const phone =
      numbers.data?.find((n) => n.id === phone_number_id) ?? numbers.data?.[0];
    if (!phone) throw new Error('WABA has no phone numbers');

    // ── 4. Business row. Idempotent: re-onboarding is a no-op update.
    log('upsert_business', { pni: phone.id });
    const { data: business, error: bizErr } = await db
      .from('businesses')
      .upsert(
        {
          name: business_name || phone.verified_name || 'Unnamed business',
          whatsapp_waba_id: waba_id,
          whatsapp_phone_number_id: phone.id,
          whatsapp_display_name: phone.display_phone_number,
        },
        { onConflict: 'whatsapp_waba_id' }
      )
      .select()
      .single();
    if (bizErr) throw bizErr;

    // ── 5. Token into the vault. Never touches `businesses`, never a browser.
    const { error: secErr } = await db.from('business_secrets').upsert({
      business_id: business.id,
      whatsapp_access_token: token,
      token_type: 'business',
      updated_at: new Date().toISOString(),
    });
    if (secErr) throw secErr;

    // ── 6. Login. business_id in metadata so the trigger links instead of creating.
    let user_id = null;
    let login_link = null;
    if (email) {
      log('create_user', {});
      const { data: created, error: userErr } =
        await db.auth.admin.createUser({
          email,
          email_confirm: true,
          user_metadata: { business_id: business.id },
        });

      if (userErr) {
        // BUG FIX 1: if the user already exists, createUser errors and returns
        // no id. We must look the existing user up by email, otherwise the
        // profile below never gets linked and the client can't see their inbox.
        if (/already|registered|exists/i.test(userErr.message)) {
          const { data: list } = await db.auth.admin.listUsers();
          const existing = list?.users?.find(
            (u) => u.email?.toLowerCase() === email.toLowerCase()
          );
          user_id = existing?.id ?? null;
        } else {
          throw userErr;
        }
      } else {
        user_id = created?.user?.id ?? null;
      }

      if (user_id) {
        await db.from('profiles').upsert({
          id: user_id,
          business_id: business.id,
          role: 'client',
        });
      } else {
        log('user_unresolved', { note: 'could not create or find user for email' });
      }

      // BUG FIX 2: generateLink returns a link but does NOT email it. Capture
      // it and return it to the caller so the onboarding page (or you) can
      // deliver it. Supabase can email it directly only if SMTP is configured
      // in your project; until then, surfacing the link is what makes login work.
      const { data: linkData } = await db.auth.admin.generateLink({
        type: 'magiclink',
        email,
      });
      login_link = linkData?.properties?.action_link ?? null;
    }

    // ── 7. Tell you it happened. This is the answer to "how will I know?"
    notifyAdmin(business).catch((e) => log('notify_failed', { e: e.message }));

    log('done', { business_id: business.id });
    return res.status(200).json({
      ok: true,
      business_id: business.id,
      phone_number_id: phone.id,
      display_number: phone.display_phone_number,
      user_id,
      login_link,
    });
  } catch (err) {
    log('failed', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
}

// ── helpers ──────────────────────────────────────────────────

async function exchangeCodeForToken(code) {
  const url =
    `${GRAPH}/oauth/access_token` +
    `?client_id=${process.env.FB_APP_ID}` +
    `&client_secret=${process.env.FB_APP_SECRET}` +
    `&code=${encodeURIComponent(code)}`;

  const r = await fetch(url);
  const j = await r.json();
  if (!r.ok || !j.access_token) {
    throw new Error(`code exchange failed: ${JSON.stringify(j)}`);
  }
  return j.access_token;
}

async function graph(path, token, opts = {}) {
  const r = await fetch(`${GRAPH}/${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers ?? {}) },
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`graph ${path}: ${JSON.stringify(j.error ?? j)}`);
  return j;
}

async function notifyAdmin(business) {
  const to = process.env.ADMIN_WHATSAPP_NUMBER;
  const from = process.env.PUMPA_PHONE_NUMBER_ID;
  if (!to || !from) return;

  await fetch(`${GRAPH}/${from}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: {
        body: `New PUMPA client onboarded\n${business.name}\n${business.whatsapp_display_name}`,
      },
    }),
  });
}
