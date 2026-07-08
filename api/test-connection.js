// PUMPA Digital — Test WhatsApp connection server-side.
// Same security model as send-message.js: verify the caller's login,
// resolve THEIR business, test THEIR number with the server-side token.

const SUPABASE_URL = "https://dpeszhbdgxevlkrfllrc.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

async function getUserIdFromJwt(jwt) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user?.id || null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'POST only' } });
  }
  try {
    const auth = req.headers.authorization || '';
    const jwt = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!jwt) return res.status(401).json({ error: { message: 'Not logged in' } });

    const userId = await getUserIdFromJwt(jwt);
    if (!userId) return res.status(401).json({ error: { message: 'Invalid session' } });

    const pRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=business_id&limit=1`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    const pRows = await pRes.json();
    const businessId = pRows && pRows[0] ? pRows[0].business_id : null;
    if (!businessId) return res.status(403).json({ error: { message: 'No business linked' } });

    const bRes = await fetch(
      `${SUPABASE_URL}/rest/v1/businesses?id=eq.${businessId}&select=whatsapp_phone_number_id&limit=1`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    const bRows = await bRes.json();
    const phoneNumberId = bRows && bRows[0] ? bRows[0].whatsapp_phone_number_id : null;
    if (!phoneNumberId) return res.status(400).json({ error: { message: 'No WhatsApp number configured' } });

    const waRes = await fetch(
      `https://graph.facebook.com/v18.0/${phoneNumberId}`,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    const data = await waRes.json();
    return res.status(waRes.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
};
