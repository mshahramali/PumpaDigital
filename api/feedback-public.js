// /api/feedback-public — powers the public comment card (f.html)
//
// GET  ?slug=xxx  → returns the restaurant's branding/settings (public, safe fields only)
// POST {…}        → records feedback:
//                   1. upsert customer on (business_id, phone) — increments visit_count,
//                      updates last_visit_at (this IS the visit-tracking / ICP data)
//                   2. inserts the feedback row
//                   3. sends WhatsApp thank-you template (with Google review link if set)
//                   Feedback is saved even if the WhatsApp send fails.
//
// Templates expected on each restaurant's WABA (approved in Meta, language code 'en'):
//   feedback_thanks_google_review — body vars {{1}}=customer name, {{2}}=restaurant name, {{3}}=review URL
//     (used when the restaurant has a google_review_url set)
//   feedback_thanks — body vars {{1}}=customer name, {{2}}=restaurant name
//     (used when no google_review_url is set)
//
// No npm packages — raw fetch against Supabase REST + Meta Graph API.

const SUPABASE_URL = "https://dpeszhbdgxevlkrfllrc.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GRAPH = 'https://graph.facebook.com/v21.0';

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

// Look up the WhatsApp access token for a business. Tries business_secrets
// first (the admin-only table), then a token column on businesses as fallback.
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
  return null;
}

module.exports = async (req, res) => {

  // ─────────────────────────── GET: public branding ───────────────────────────
  if (req.method === 'GET') {
    const slug = (req.query?.slug || '').toString().trim();
    if (!slug) return res.status(400).json({ ok: false, error: 'slug required' });
    const r = await sb(`/rest/v1/feedback_forms?slug=eq.${encodeURIComponent(slug)}&is_active=eq.true&select=restaurant_name,logo_url,accent_color,lucky_draw_enabled&limit=1`);
    const form = (await r.json())[0];
    if (!form) return res.status(404).json({ ok: false, error: 'not found' });
    return res.status(200).json({ ok: true, form });
  }

  // ─────────────────────────── POST: submission ───────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'GET or POST only' });

  try {
    const b = req.body || {};
    const slug = (b.slug || '').toString().trim();
    const name = (b.name || '').toString().trim();
    const phone = (b.phone || '').toString().replace(/[^0-9]/g, '');
    if (!slug || !name || !/^92\d{10}$/.test(phone)) {
      return res.status(400).json({ ok: false, error: 'slug, name and a valid phone are required' });
    }

    // 1. Resolve form + business
    const fr = await sb(`/rest/v1/feedback_forms?slug=eq.${encodeURIComponent(slug)}&is_active=eq.true&select=business_id,restaurant_name,google_review_url&limit=1`);
    const form = (await fr.json())[0];
    if (!form) return res.status(404).json({ ok: false, error: 'form not found' });
    const bizId = form.business_id;

    // 2. Upsert customer — increments visit_count on repeat visits
    let customerId = null;
    const cr = await sb(`/rest/v1/customers?business_id=eq.${bizId}&phone=eq.${phone}&select=id,visit_count,name,birthday,city&limit=1`);
    const existing = (await cr.json())[0];

    if (existing) {
      customerId = existing.id;
      const patch = {
        visit_count: (existing.visit_count || 0) + 1,
        last_visit_at: new Date().toISOString(),
      };
      if (!existing.name && name) patch.name = name;
      if (!existing.birthday && b.birthday) patch.birthday = b.birthday;
      if (!existing.city && b.city) patch.city = b.city;
      await sb(`/rest/v1/customers?id=eq.${customerId}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch),
      });
    } else {
      const ins = await sb(`/rest/v1/customers`, {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          business_id: bizId, phone, name,
          birthday: b.birthday || null, city: b.city || null,
          visit_count: 1,
        }),
      });
      const row = (await ins.json())[0];
      customerId = row?.id || null;
    }

    // 3. Insert feedback row
    const clamp = v => (v >= 1 && v <= 4 ? v : null);
    await sb(`/rest/v1/feedback`, {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        business_id: bizId, customer_id: customerId,
        server_name: b.server_name || null, table_no: b.table_no || null,
        food: clamp(+b.food), service: clamp(+b.service), cleanliness: clamp(+b.cleanliness),
        ambiance: clamp(+b.ambiance), value_money: clamp(+b.value_money),
        source: b.source || null, visit_claim: b.visit_claim || null,
        comments: b.comments || null,
      }),
    });
    console.log('FEEDBACK: recorded for', form.restaurant_name, phone);

    // 4. WhatsApp thank-you (best-effort — never fails the submission)
    let whatsappSent = false;
    try {
      const bizRes = await sb(`/rest/v1/businesses?id=eq.${bizId}&select=whatsapp_phone_number_id&limit=1`);
      const biz = (await bizRes.json())[0];
      const token = await getToken(bizId);

      if (biz?.whatsapp_phone_number_id && token) {
        const hasReview = !!form.google_review_url;
        const params = hasReview
          ? [name, form.restaurant_name, form.google_review_url]
          : [name, form.restaurant_name];
        const tpl = hasReview ? 'feedback_thanks_google_review' : 'feedback_thanks';

        const wr = await fetch(`${GRAPH}/${biz.whatsapp_phone_number_id}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: phone,
            type: 'template',
            template: {
              name: tpl,
              language: { code: 'en' },
              components: [{
                type: 'body',
                parameters: params.map(t => ({ type: 'text', text: String(t) })),
              }],
            },
          }),
        });
        const wj = await wr.json();
        whatsappSent = wr.ok && !wj.error;
        console.log('FEEDBACK: whatsapp', tpl, wr.status, wj.error?.message || 'ok');
        if (whatsappSent) {
          await sb(`/rest/v1/feedback?customer_id=eq.${customerId}&order=created_at.desc&limit=1`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ whatsapp_sent: true }),
          });
        }
      } else {
        console.log('FEEDBACK: no phone_number_id or token for business', bizId);
      }
    } catch (e) {
      console.error('FEEDBACK: whatsapp send failed', e.message);
    }

    return res.status(200).json({ ok: true, whatsapp_sent: whatsappSent });
  } catch (err) {
    console.error('feedback-public error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
