// PUMPA Digital — Send media (image/document) via WhatsApp, securely server-side.
// The browser never sees the WhatsApp token. It sends us the recipient + the image
// (either as a public URL, or as base64 to upload), and we handle Meta + saving.

const SUPABASE_URL = "https://dpeszhbdgxevlkrfllrc.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

// Upload a base64 image to the public whatsapp-media bucket, return its public URL.
async function uploadToBucket(base64Data, contentType) {
  const ext = (contentType.split('/')[1] || 'jpg').split(';')[0];
  const fileName = `outgoing/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const buffer = Buffer.from(base64Data, 'base64');

  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/whatsapp-media/${fileName}`,
    {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': contentType,
        'x-upsert': 'true'
      },
      body: buffer
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Bucket upload failed: ' + err);
  }
  return `${SUPABASE_URL}/storage/v1/object/public/whatsapp-media/${fileName}`;
}

// Look up a business's phone number id + token (token falls back to env).
async function getBusinessCreds(businessId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/businesses?id=eq.${businessId}&select=whatsapp_phone_number_id,whatsapp_access_token&limit=1`,
    {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
      }
    }
  );
  const rows = await res.json();
  const biz = rows && rows[0] ? rows[0] : {};
  return {
    phoneNumberId: biz.whatsapp_phone_number_id || null,
    token: biz.whatsapp_access_token || WHATSAPP_TOKEN
  };
}

async function saveOutgoing(businessId, phone, phoneNumberId, mediaUrl, mediaType, caption) {
  await fetch(`${SUPABASE_URL}/rest/v1/messages`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({
      business_id: businessId,
      contact_id: null,
      direction: 'outbound',
      content: caption || (mediaType === 'image' ? '[Image]' : '[Document]'),
      phone_number_id: phoneNumberId || null,
      phone: String(phone),
      status: 'sent',
      wa_message_id: null,
      media_url: mediaUrl,
      media_type: mediaType
    })
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    if (!SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ ok: false, error: 'Server not configured (SUPABASE_SERVICE_KEY missing)' });
    }

    const { phone, businessId, imageUrl, imageBase64, contentType, caption, mediaType } = req.body || {};

    if (!phone) return res.status(400).json({ ok: false, error: 'Missing recipient phone' });
    if (!businessId) return res.status(400).json({ ok: false, error: 'Missing businessId' });
    if (!imageUrl && !imageBase64) return res.status(400).json({ ok: false, error: 'Provide imageUrl or imageBase64' });

    const kind = mediaType || 'image';

    // 1) Resolve the sending number + token for this business
    const { phoneNumberId, token } = await getBusinessCreds(businessId);
    if (!phoneNumberId) return res.status(400).json({ ok: false, error: 'This business has no WhatsApp phone number id set' });
    if (!token) return res.status(400).json({ ok: false, error: 'No WhatsApp token available' });

    // 2) Get a public URL Meta can fetch (upload the base64 if that's what we got)
    let publicUrl = imageUrl;
    if (!publicUrl && imageBase64) {
      publicUrl = await uploadToBucket(imageBase64, contentType || 'image/jpeg');
    }

    // 3) Tell WhatsApp to deliver it
    const mediaObj = { link: publicUrl };
    if (caption && kind === 'image') mediaObj.caption = caption;

    const waRes = await fetch(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: String(phone),
        type: kind,          // "image" or "document"
        [kind]: mediaObj
      })
    });

    const waData = await waRes.json();

    if (!waData.messages || !waData.messages[0]) {
      // Surface Meta's exact error so failures are never a mystery
      const errMsg = waData.error?.message || JSON.stringify(waData);
      console.error('WhatsApp send error:', errMsg);
      return res.status(400).json({ ok: false, error: errMsg });
    }

    // 4) Save so it shows in the inbox like received media
    await saveOutgoing(businessId, phone, phoneNumberId, publicUrl, kind, caption);

    return res.status(200).json({ ok: true, media_url: publicUrl, wa_id: waData.messages[0].id });

  } catch (err) {
    console.error('send-media error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
