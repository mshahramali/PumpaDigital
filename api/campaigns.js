// /api/campaigns — merged endpoint (was segments.js + campaign-stats.js).
// Merged solely to stay under Vercel Hobby's 12-Serverless-Function cap;
// logic is unchanged from the two original files, just routed by ?action=.
//
// GET /api/campaigns?action=segments
//   → targetable audiences for the broadcast composer (auto RFM + tag segments)
//
// GET /api/campaigns                         (no action, no campaign_id)
//   → list of this business's campaigns, most recent first
//
// GET /api/campaigns?campaign_id=xxx
//   → funnel counts + per-recipient status list for one campaign
//
// Auth: same Supabase-JWT-in-header pattern as templates.js / send-message.js.
// GET only. No npm packages.

const SUPABASE_URL = "https://dpeszhbdgxevlkrfllrc.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_ANON_KEY = "sb_publishable_gZj05PTTPix9SEKEwBXo5Q_W8YGBky2";

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

async function getUserId(accessToken) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u?.id || null;
}

// ---- segments.js logic, unchanged ----
async function handleSegments(businessId, res) {
  const autoRes = await sb(`/rest/v1/rpc/get_segment_counts`, {
    method: 'POST',
    body: JSON.stringify({ p_business_id: businessId }),
  });
  let auto = [];
  if (autoRes.ok) {
    const rows = await autoRes.json();
    auto = rows.map(r => ({
      key: r.segment_key,
      label: r.segment_label,
      count: r.contact_count,
      type: r.segment_key === 'all' ? 'all' : 'auto',
    }));
  } else {
    console.error('SEGMENTS: get_segment_counts failed', await autoRes.text());
  }

  const contactsRes = await sb(`/rest/v1/contacts?business_id=eq.${businessId}&opted_out=eq.false&select=tags`);
  const contacts = contactsRes.ok ? await contactsRes.json() : [];
  const tagCounts = {};
  contacts.forEach(c => (c.tags || []).forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));
  const tagSegments = Object.entries(tagCounts).map(([tag, count]) => ({
    key: `tag:${tag}`, label: `Tag: ${tag}`, count, type: 'tag',
  }));

  return res.status(200).json({ ok: true, segments: [...auto, ...tagSegments] });
}

// ---- campaign-stats.js logic, unchanged ----
async function handleStats(businessId, campaignId, res) {
  if (!campaignId) {
    const cr = await sb(`/rest/v1/campaigns?business_id=eq.${businessId}&order=created_at.desc&limit=50`);
    const campaigns = cr.ok ? await cr.json() : [];
    return res.status(200).json({ ok: true, campaigns });
  }

  const cr = await sb(`/rest/v1/campaigns?id=eq.${campaignId}&business_id=eq.${businessId}&select=*&limit=1`);
  const campaign = (await cr.json())[0];
  if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' });

  const statsRes = await sb(`/rest/v1/rpc/get_campaign_stats`, {
    method: 'POST', body: JSON.stringify({ p_campaign_id: campaignId }),
  });
  const stats = statsRes.ok ? (await statsRes.json())[0] : null;

  const recRes = await sb(`/rest/v1/messages?campaign_id=eq.${campaignId}&select=phone,status,clicked_at,created_at&order=created_at.desc&limit=500`);
  const recipients = recRes.ok ? await recRes.json() : [];

  return res.status(200).json({ ok: true, campaign, stats, recipients });
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });
  try {
    const authHeader = req.headers.authorization || '';
    const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!accessToken) return res.status(401).json({ ok: false, error: 'Not logged in' });

    const userId = await getUserId(accessToken);
    if (!userId) return res.status(401).json({ ok: false, error: 'Invalid session' });

    const pr = await sb(`/rest/v1/profiles?id=eq.${userId}&select=business_id,role&limit=1`);
    const profile = (await pr.json())[0];
    if (!profile?.business_id) return res.status(400).json({ ok: false, error: 'No business linked to this account' });
    const businessId = profile.business_id;

    if (req.query?.action === 'segments') {
      return await handleSegments(businessId, res);
    }

    return await handleStats(businessId, req.query?.campaign_id, res);
  } catch (err) {
    console.error('campaigns error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
