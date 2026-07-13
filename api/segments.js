// /api/segments — returns targetable audiences for the broadcast composer.
//
// Two kinds, merged:
//   - AUTO segments (RFM): computed live from `customers` (visit-tracking
//     data from the feedback system) via get_segment_counts(). Present only
//     if the business has customer/visit data — a pure-retail client with
//     no feedback kiosk simply won't see these, and that's correct.
//   - TAG segments: distinct tags currently used on `contacts`, each with
//     a live count. Works for every business type.
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

    // 1. Auto (RFM) segments — via the SQL function.
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

    // 2. Tag segments — distinct tags on contacts, with live counts.
    const contactsRes = await sb(`/rest/v1/contacts?business_id=eq.${businessId}&opted_out=eq.false&select=tags`);
    const contacts = contactsRes.ok ? await contactsRes.json() : [];
    const tagCounts = {};
    contacts.forEach(c => (c.tags || []).forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));
    const tagSegments = Object.entries(tagCounts).map(([tag, count]) => ({
      key: `tag:${tag}`, label: `Tag: ${tag}`, count, type: 'tag',
    }));

    return res.status(200).json({ ok: true, segments: [...auto, ...tagSegments] });
  } catch (err) {
    console.error('segments error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
