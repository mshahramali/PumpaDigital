// /api/birthday-cron — runs once a day (see vercel.json: 0 4 * * * UTC = 9am PKT)
//
// 1. Calls the get_todays_birthdays() Postgres function — timezone-aware,
//    already filters out opted-out customers and anyone already sent this
//    year's message (see add-birthday-tracking-column.sql).
// 2. For each match: looks up their business's WhatsApp credentials + the
//    restaurant name (from feedback_forms), sends the `birthday_wish`
//    template, then marks last_birthday_sent_year so it never repeats.
// 3. Best-effort per customer — one failure doesn't stop the rest of the run.
//
// This endpoint is meant to be hit only by Vercel Cron. It checks a shared
// secret (CRON_SECRET env var) so it can't be triggered by randoms hitting
// the URL — set CRON_SECRET in Vercel's env vars and Vercel Cron will send
// it automatically as an Authorization: Bearer header if configured, or
// call this once manually with the header for testing.

const SUPABASE_URL = "https://dpeszhbdgxevlkrfllrc.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;
const GRAPH = 'https://graph.facebook.com/v21.0';

// Static header image shown at the top of the birthday template.
// Must be a public, directly-fetchable URL (Meta fetches it server-side).
// Upload once to Supabase Storage (e.g. the existing public "logos" bucket,
// path "system/birthday.jpg") and paste its public URL here, or set the
// BIRTHDAY_IMAGE_URL env var to override without a code change.
const BIRTHDAY_IMAGE_URL = process.env.BIRTHDAY_IMAGE_URL || "";

async function sb(path, opts = {}) {
  return fetch(`${SUPABASE_URL}${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
}

// Same per-business token lookup used in feedback-public.js / templates.js
async function getToken(businessId) {
  try {
    const r = await sb(`/rest/v1/business_secrets?business_id=eq.${businessId}&select=*&limit=1`);
    const row = (await r.json())[0];
    if (row) {
      const t = row.access_token || row.whatsapp_access_token || row.token;
      if (t) return t;
    }
  } catch (e) { /* fall through */ }
  try {
    const r = await sb(`/rest/v1/businesses?id=eq.${businessId}&select=whatsapp_access_token&limit=1`);
    const row = (await r.json())[0];
    if (row?.whatsapp_access_token) return row.whatsapp_access_token;
  } catch (e) { /* fall through */ }
  return WHATSAPP_TOKEN || null;
}

module.exports = async (req, res) => {
  // Guard: only Vercel Cron (or someone with the secret) can trigger this.
  if (CRON_SECRET) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
  }

  const results = { sent: 0, skipped: 0, failed: 0, details: [] };

  try {
    const bd = await sb(`/rest/v1/rpc/get_todays_birthdays`, { method: 'POST', body: JSON.stringify({}) });
    if (!bd.ok) {
      const errText = await bd.text();
      console.error('BIRTHDAY-CRON: get_todays_birthdays failed', bd.status, errText);
      return res.status(500).json({ ok: false, error: 'Could not query birthdays', detail: errText });
    }
    const customers = await bd.json();
    console.log(`BIRTHDAY-CRON: ${customers.length} birthday(s) today`);

    for (const c of customers) {
      try {
        // Restaurant name + business WhatsApp phone_number_id
        const [formRes, bizRes] = await Promise.all([
          sb(`/rest/v1/feedback_forms?business_id=eq.${c.business_id}&select=restaurant_name&limit=1`),
          sb(`/rest/v1/businesses?id=eq.${c.business_id}&select=whatsapp_phone_number_id&limit=1`),
        ]);
        const form = (await formRes.json())[0];
        const biz = (await bizRes.json())[0];
        const restaurantName = form?.restaurant_name || 'us';
        const token = await getToken(c.business_id);

        if (!biz?.whatsapp_phone_number_id || !token) {
          console.log('BIRTHDAY-CRON: skipped, no phone_number_id/token for business', c.business_id);
          results.skipped++;
          results.details.push({ phone: c.phone, status: 'skipped-no-credentials' });
          continue;
        }

        const components = [{
          type: 'body',
          parameters: [
            { type: 'text', text: c.name || 'there' },
            { type: 'text', text: restaurantName },
          ],
        }];
        if (BIRTHDAY_IMAGE_URL) {
          components.unshift({
            type: 'header',
            parameters: [{ type: 'image', image: { link: BIRTHDAY_IMAGE_URL } }],
          });
        }

        const wr = await fetch(`${GRAPH}/${biz.whatsapp_phone_number_id}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: c.phone,
            type: 'template',
            template: { name: 'birthday_wish', language: { code: 'en' }, components },
          }),
        });
        const wj = await wr.json();

        if (wr.ok && !wj.error) {
          await sb(`/rest/v1/customers?id=eq.${c.id}`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ last_birthday_sent_year: new Date().getUTCFullYear() }),
          });
          console.log('BIRTHDAY-CRON: sent to', c.phone, 'for', restaurantName);
          results.sent++;
          results.details.push({ phone: c.phone, status: 'sent' });
        } else {
          console.error('BIRTHDAY-CRON: send failed for', c.phone, wj.error?.message);
          results.failed++;
          results.details.push({ phone: c.phone, status: 'failed', error: wj.error?.message });
        }
      } catch (e) {
        console.error('BIRTHDAY-CRON: error for customer', c.id, e.message);
        results.failed++;
        results.details.push({ phone: c.phone, status: 'error', error: e.message });
      }
    }

    return res.status(200).json({ ok: true, ...results });
  } catch (err) {
    console.error('BIRTHDAY-CRON: fatal error', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
