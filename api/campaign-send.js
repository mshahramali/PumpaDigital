// /api/campaign-send — the actual broadcast send engine.
//
// Body: { segment_key, template_name, template_language, variable_mapping,
//         campaign_name, test_only, test_phone }
//   OR, instead of segment_key:
//         { custom_recipients: [{ phone, name }, ...], ... }
// custom_recipients lets the composer send to an arbitrary hand-picked list
// (e.g. checkboxes selected in Recent Feedback, or a Visit Frequency quick-
// link) instead of a server-resolved segment. Takes priority over segment_key
// if both are somehow present.
//
// variable_mapping: { "1": "name" } — for each recipient, {{1}} is filled
// from that field on the resolved contact/customer row. Currently supports
// "name" only (safe, always present); extend later as needed.
//
// test_only + test_phone: sends ONE message to that number only, does not
// create/advance a campaign row. Used by the composer's "Test Campaign" step.
//
// Auth: same JWT-in-header pattern as send-message.js — business_id is
// resolved server-side from the caller's own profile, never trusted from
// the browser. WhatsApp token never reaches the browser.
//
// Pacing: sends are awaited sequentially with a small delay, since Vercel
// Hobby has a function timeout — for larger audiences this endpoint should
// be called in batches by the frontend (see app.html composer, which sends
// in chunks of 25 and calls this repeatedly with an offset).

const SUPABASE_URL = "https://dpeszhbdgxevlkrfllrc.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const GRAPH = 'https://graph.facebook.com/v21.0';
const PACE_MS = 120; // small delay between sends to avoid bursting Meta's API

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

async function getUserIdFromJwt(jwt) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${jwt}` },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u?.id || null;
}

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

// Resolve a segment_key into a list of { phone, name } recipients.
async function resolveAudience(businessId, segmentKey) {
  if (segmentKey.startsWith('tag:')) {
    const tag = segmentKey.slice(4);
    const r = await sb(`/rest/v1/contacts?business_id=eq.${businessId}&opted_out=eq.false&tags=cs.{${tag}}&select=name,whatsapp_number`);
    const rows = r.ok ? await r.json() : [];
    return rows.map(c => ({ phone: c.whatsapp_number, name: c.name }));
  }
  if (segmentKey === 'all') {
    const r = await sb(`/rest/v1/contacts?business_id=eq.${businessId}&opted_out=eq.false&select=name,whatsapp_number`);
    const rows = r.ok ? await r.json() : [];
    return rows.map(c => ({ phone: c.whatsapp_number, name: c.name }));
  }
  // customers_* auto segments
  const filters = {
    customers_1st: 'visit_count=eq.1',
    customers_returning: 'visit_count=gte.2',
    customers_regulars: 'visit_count=gte.5',
    customers_inactive_30: `last_visit_at=lt.${new Date(Date.now() - 30*864e5).toISOString()}`,
    customers_inactive_60: `last_visit_at=lt.${new Date(Date.now() - 60*864e5).toISOString()}`,
  };
  if (segmentKey === 'customers_birthday_month') {
    const r = await sb(`/rest/v1/customers?business_id=eq.${businessId}&opted_out=eq.false&birthday=not.is.null&select=name,phone,birthday`);
    const rows = r.ok ? await r.json() : [];
    const thisMonth = new Date().getMonth() + 1;
    return rows.filter(c => new Date(c.birthday).getMonth() + 1 === thisMonth)
               .map(c => ({ phone: c.phone, name: c.name }));
  }
  const filter = filters[segmentKey];
  if (!filter) return [];
  const r = await sb(`/rest/v1/customers?business_id=eq.${businessId}&opted_out=eq.false&${filter}&select=name,phone`);
  const rows = r.ok ? await r.json() : [];
  return rows.map(c => ({ phone: c.phone, name: c.name }));
}

function buildComponents(variableMapping, recipient) {
  const mapping = variableMapping || { "1": "name" };
  const keys = Object.keys(mapping).sort((a, b) => +a - +b);
  if (!keys.length) return [];
  const parameters = keys.map(k => {
    const field = mapping[k];
    const value = field === 'name' ? (recipient.name || 'there') : (recipient[field] || '');
    return { type: 'text', text: String(value) };
  });
  return [{ type: 'body', parameters }];
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  try {
    const auth = req.headers.authorization || '';
    const jwt = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!jwt) return res.status(401).json({ ok: false, error: 'Not logged in' });

    const userId = await getUserIdFromJwt(jwt);
    if (!userId) return res.status(401).json({ ok: false, error: 'Invalid session' });

    const pr = await sb(`/rest/v1/profiles?id=eq.${userId}&select=business_id,role&limit=1`);
    const profile = (await pr.json())[0];
    if (!profile?.business_id) return res.status(403).json({ ok: false, error: 'No business linked to your account' });
    const businessId = profile.business_id;

    const bizRes = await sb(`/rest/v1/businesses?id=eq.${businessId}&select=whatsapp_phone_number_id&limit=1`);
    const biz = (await bizRes.json())[0];
    if (!biz?.whatsapp_phone_number_id) return res.status(400).json({ ok: false, error: 'No WhatsApp number configured for your business' });
    const token = await getToken(businessId);
    if (!token) return res.status(400).json({ ok: false, error: 'No WhatsApp access token available' });

    const {
      segment_key, template_name, template_language, variable_mapping,
      campaign_name, test_only, test_phone, campaign_id: existingCampaignId,
      offset = 0, batch_size = 25, custom_recipients,
    } = req.body || {};

    if (!template_name) return res.status(400).json({ ok: false, error: 'template_name required' });

    // ── TEST SEND: one message, no campaign row, no counters touched ──
    if (test_only) {
      if (!test_phone) return res.status(400).json({ ok: false, error: 'test_phone required' });
      const components = buildComponents(variable_mapping, { name: 'Test' });
      const wr = await fetch(`${GRAPH}/${biz.whatsapp_phone_number_id}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp', to: test_phone, type: 'template',
          template: { name: template_name, language: { code: template_language || 'en' }, components },
        }),
      });
      const wj = await wr.json();
      return res.status(200).json({ ok: wr.ok && !wj.error, test: true, detail: wj });
    }

    // ── REAL SEND (first call creates the campaign; later calls with the
    //    same campaign_id + offset continue the batch) ──
    const hasCustomList = Array.isArray(custom_recipients) && custom_recipients.length > 0;
    if (!segment_key && !hasCustomList) {
      return res.status(400).json({ ok: false, error: 'segment_key or custom_recipients required' });
    }

    let campaignId = existingCampaignId;
    let audience;

    if (!campaignId) {
      audience = hasCustomList
        ? custom_recipients.filter(r => r && r.phone).map(r => ({ phone: String(r.phone), name: r.name || '' }))
        : await resolveAudience(businessId, segment_key);
      const insRes = await sb(`/rest/v1/campaigns`, {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          business_id: businessId,
          name: campaign_name || `Broadcast ${new Date().toISOString().slice(0,16)}`,
          type: 'broadcast',
          template_name,
          template_language: template_language || 'en',
          segment_type: hasCustomList ? 'custom' : (segment_key.startsWith('tag:') ? 'tag' : (segment_key === 'all' ? 'all' : 'auto')),
          segment_filter: hasCustomList ? { custom: true, count: audience.length } : { segment_key },
          variable_mapping: variable_mapping || { "1": "name" },
          status: 'sending',
          audience_count: audience.length,
          started_at: new Date().toISOString(),
        }),
      });
      const created = (await insRes.json())[0];
      campaignId = created?.id;
      if (!campaignId) return res.status(500).json({ ok: false, error: 'Could not create campaign' });
    } else {
      audience = hasCustomList
        ? custom_recipients.filter(r => r && r.phone).map(r => ({ phone: String(r.phone), name: r.name || '' }))
        : await resolveAudience(businessId, segment_key);
    }

    const batch = audience.slice(offset, offset + batch_size);
    let sent = 0, failed = 0;

    for (const recipient of batch) {
      if (!recipient.phone) { failed++; continue; }
      try {
        const components = buildComponents(variable_mapping, recipient);
        const wr = await fetch(`${GRAPH}/${biz.whatsapp_phone_number_id}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp', to: recipient.phone, type: 'template',
            template: { name: template_name, language: { code: template_language || 'en' }, components },
          }),
        });
        const wj = await wr.json();
        const ok = wr.ok && !wj.error;
        const waId = wj.messages?.[0]?.id || null;

        await sb(`/rest/v1/messages`, {
          method: 'POST', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            business_id: businessId, contact_id: null, direction: 'outbound',
            content: `[campaign] ${template_name}`, phone: String(recipient.phone),
            status: ok ? 'sent' : 'failed', wa_message_id: waId, campaign_id: campaignId,
          }),
        });
        if (ok) sent++; else failed++;
      } catch (e) {
        console.error('CAMPAIGN-SEND: recipient failed', recipient.phone, e.message);
        failed++;
      }
      await new Promise(r => setTimeout(r, PACE_MS));
    }

    const nextOffset = offset + batch.length;
    const isDone = nextOffset >= audience.length;

    if (isDone) {
      await sb(`/rest/v1/campaigns?id=eq.${campaignId}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'sent', completed_at: new Date().toISOString() }),
      });
    }

    console.log(`CAMPAIGN-SEND: campaign ${campaignId} batch [${offset}-${nextOffset}] sent=${sent} failed=${failed}`);
    return res.status(200).json({
      ok: true, campaign_id: campaignId, sent, failed,
      next_offset: isDone ? null : nextOffset,
      total: audience.length, done: isDone,
    });
  } catch (err) {
    console.error('campaign-send error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
