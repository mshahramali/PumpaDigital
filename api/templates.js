// /api/templates — returns the logged-in business's live Meta message templates
//
// GET only. Auth: same pattern as waApi() in app.html — Supabase session
// access_token in the Authorization header. Server verifies it against
// Supabase, resolves business_id → whatsapp_waba_id, then calls Meta's
// Graph API for that WABA's templates. Falls back to the global
// WHATSAPP_TOKEN env var if the business has no per-business token stored
// (mirrors the token lookup already used in feedback-public.js).

const SUPABASE_URL = "https://dpeszhbdgxevlkrfllrc.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_ANON_KEY = "sb_publishable_gZj05PTTPix9SEKEwBXo5Q_W8YGBky2";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
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

// Verify the browser's Supabase session token, return the user id
async function getUserId(accessToken) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u?.id || null;
}

// Same per-business token lookup used in feedback-public.js, with a
// final fallback to the shared WHATSAPP_TOKEN env var.
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
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });

  try {
    const authHeader = req.headers.authorization || '';
    const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!accessToken) return res.status(401).json({ ok: false, error: 'Not logged in' });

    const userId = await getUserId(accessToken);
    if (!userId) return res.status(401).json({ ok: false, error: 'Invalid session' });

    // Resolve business_id (+ role) from profiles
    const pr = await sb(`/rest/v1/profiles?id=eq.${userId}&select=business_id,role&limit=1`);
    const profile = (await pr.json())[0];
    if (!profile) return res.status(404).json({ ok: false, error: 'Profile not found' });

    // Admins with no business_id could optionally pass ?business_id=xxx to inspect
    // a specific client — supported for future dashboard use, ignored otherwise.
    const businessId = (req.query?.business_id && profile.role === 'admin')
      ? req.query.business_id
      : profile.business_id;
    if (!businessId) return res.status(400).json({ ok: false, error: 'No business linked to this account' });

    const br = await sb(`/rest/v1/businesses?id=eq.${businessId}&select=whatsapp_waba_id&limit=1`);
    const biz = (await br.json())[0];
    if (!biz?.whatsapp_waba_id) return res.status(404).json({ ok: false, error: 'No WABA connected for this business' });

    const token = await getToken(businessId);
    if (!token) return res.status(404).json({ ok: false, error: 'No WhatsApp access token available' });

    const mr = await fetch(
      `${GRAPH}/${biz.whatsapp_waba_id}/message_templates?fields=name,status,category,language,components&limit=100`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const mj = await mr.json();
    if (!mr.ok) {
      console.error('TEMPLATES: Meta error', mr.status, JSON.stringify(mj).slice(0, 400));
      return res.status(mr.status).json({ ok: false, error: mj.error?.message || 'Meta API error' });
    }

    return res.status(200).json({ ok: true, templates: mj.data || [] });
  } catch (err) {
    console.error('templates error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
