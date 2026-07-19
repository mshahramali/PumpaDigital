// PUMPA Digital — Send text/template messages server-side.
// The browser NEVER sees the WhatsApp token. Security model:
//   1. Browser sends its Supabase login token (JWT) in the Authorization header.
//   2. We verify that JWT with Supabase and read the caller's OWN business_id
//      from their profile — the browser cannot claim someone else's business.
//   3. We send from that business's phone_number_id using the env token.
//   4. We return Meta's raw JSON unchanged, so the frontend logic keeps working.

const SUPABASE_URL = "https://dpeszhbdgxevlkrfllrc.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

// Verify the caller's JWT → return their user id, or null.
async function getUserIdFromJwt(jwt) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${jwt}`,
    },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user?.id || null;
}

// Read the caller's own profile → their business_id (server-side, unspoofable).
async function getCallerBusiness(userId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=business_id,role&limit=1`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    }
  );
  const rows = await res.json();
  return rows && rows[0] ? rows[0] : null;
}

async function getPhoneNumberId(businessId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/businesses?id=eq.${businessId}&select=whatsapp_phone_number_id&limit=1`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    }
  );
  const rows = await res.json();
  return rows && rows[0] ? rows[0].whatsapp_phone_number_id : null;
}

// ── Folded in from the old /api/test-connection endpoint ──────────────
// Merged here to stay within Vercel Hobby's 12-function limit.
// Reached via POST /api/send-message?action=test
async function handleTestConnection(req, res) {
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
}

module.exports = async (req, res) => {
  if (String(req.query?.action || '') === 'test') {
    return handleTestConnection(req, res);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'POST only' } });
  }

  try {
    // 1. Who is calling? Verify their login token.
    const auth = req.headers.authorization || '';
    const jwt = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!jwt) return res.status(401).json({ error: { message: 'Not logged in' } });

    const userId = await getUserIdFromJwt(jwt);
    if (!userId) return res.status(401).json({ error: { message: 'Invalid session' } });

    // 2. Which business do THEY belong to? (Server decides, not the browser.)
    const profile = await getCallerBusiness(userId);
    if (!profile || !profile.business_id) {
      return res.status(403).json({ error: { message: 'No business linked to your account' } });
    }

    const phoneNumberId = await getPhoneNumberId(profile.business_id);
    if (!phoneNumberId) {
      return res.status(400).json({ error: { message: 'Your business has no WhatsApp number configured' } });
    }

    // 3. The browser sends the same Meta payload it used to send directly.
    const payload = req.body && req.body.payload;
    if (!payload || payload.messaging_product !== 'whatsapp') {
      return res.status(400).json({ error: { message: 'Invalid payload' } });
    }

    // 4. Send from THEIR number with OUR server-side token.
    const waRes = await fetch(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }
    );

    // 5. Return Meta's response unchanged — frontend checks data.messages[0] as before.
    const data = await waRes.json();
    return res.status(waRes.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
};
