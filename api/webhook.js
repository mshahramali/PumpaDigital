// PUMPA Digital — WhatsApp Webhook (Supabase version)
const VERIFY_TOKEN = "pumpa_webhook_2026";
const SUPABASE_URL = "https://dpeszhbdgxevlkrfllrc.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN; // Your permanent system user token

// Download media URL from Meta and upload to Supabase Storage
async function getMediaUrl(mediaId) {
  try {
    // Step 1 — Get the download URL from Meta
    const metaRes = await fetch(
      `https://graph.facebook.com/v18.0/${mediaId}`,
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`
        }
      }
    );
    const metaData = await metaRes.json();
    if (!metaData.url) {
      console.error('No URL from Meta for media:', mediaId);
      return null;
    }

    // Step 2 — Download the actual file from Meta
    const fileRes = await fetch(metaData.url, {
      headers: {
        'Authorization': `Bearer ${WHATSAPP_TOKEN}`
      }
    });
    if (!fileRes.ok) {
      console.error('Failed to download media file');
      return null;
    }

    const fileBuffer = await fileRes.arrayBuffer();
    const contentType = fileRes.headers.get('content-type') || 'image/jpeg';
    const extension = contentType.split('/')[1]?.split(';')[0] || 'jpg';
    const fileName = `media/${mediaId}.${extension}`;

    // Step 3 — Upload to Supabase Storage
    const uploadRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/whatsapp-media/${fileName}`,
      {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': contentType,
          'x-upsert': 'true'
        },
        body: fileBuffer
      }
    );

    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      console.error('Supabase storage upload error:', err);
      return null;
    }

    // Step 4 — Return the public URL
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/whatsapp-media/${fileName}`;
    console.log('Media uploaded to Supabase:', publicUrl);
    return publicUrl;

  } catch (err) {
    console.error('getMediaUrl error:', err.message);
    return null;
  }
}

async function saveToSupabase(phone, message, direction = "inbound", phoneNumberId = null, mediaUrl = null, mediaType = null) {
  try {
    if (!SUPABASE_SERVICE_KEY) {
      console.error("SUPABASE_SERVICE_KEY not set");
      return;
    }

    // Find which business owns this phone_number_id
    let businessId = null;
    if (phoneNumberId) {
      const lookupRes = await fetch(
        `${SUPABASE_URL}/rest/v1/businesses?whatsapp_phone_number_id=eq.${phoneNumberId}&select=id&limit=1`,
        {
          headers: {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          }
        }
      );
      const businesses = await lookupRes.json();
      if (businesses && businesses[0]) businessId = businesses[0].id;
    }

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/messages`, {
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
        direction: direction,
        content: String(message).replace(/\n/g, ' ').replace(/\r/g, '').trim(),
        phone_number_id: phoneNumberId || null,
        phone: String(phone),
        status: 'received',
        wa_message_id: null,
        media_url: mediaUrl || null,
        media_type: mediaType || null
      })
    });

    if (!insertRes.ok) {
      const err = await insertRes.text();
      console.error('Supabase insert error:', err);
    } else {
      console.log(`Message saved: ${direction} from ${phone}${mediaUrl ? ' [with media]' : ''}`);
    }
  } catch (err) {
    console.error("Failed to save to Supabase:", err.message);
  }
}

export default async function handler(req, res) {
  // ── GET: Webhook Verification
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("Webhook verified!");
      return res.status(200).send(challenge);
    }
    return res.status(403).json({ error: "Verification failed" });
  }

  // ── POST: Receive Messages
  if (req.method === "POST") {
    const body = req.body;
    if (body.object === "whatsapp_business_account") {
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          const value = change.value;
          const phoneNumberId = value.metadata?.phone_number_id || null;

          if (value.messages) {
            for (const message of value.messages) {
              const from = message.from;
              const msgType = message.type;
              let text = "";
              let mediaUrl = null;
              let mediaType = null;

              if (msgType === "text") {
                text = message.text?.body || "";

              } else if (msgType === "image") {
                const mediaId = message.image?.id;
                text = "[Image]";
                mediaType = "image";
                if (mediaId && WHATSAPP_TOKEN) {
                  mediaUrl = await getMediaUrl(mediaId);
                  if (!mediaUrl) text = "[Image - download failed]";
                }

              } else if (msgType === "audio") {
                const mediaId = message.audio?.id;
                text = "[Audio]";
                mediaType = "audio";
                if (mediaId && WHATSAPP_TOKEN) {
                  mediaUrl = await getMediaUrl(mediaId);
                }

              } else if (msgType === "document") {
                const mediaId = message.document?.id;
                const fileName = message.document?.filename || "document";
                text = `[Document: ${fileName}]`;
                mediaType = "document";
                if (mediaId && WHATSAPP_TOKEN) {
                  mediaUrl = await getMediaUrl(mediaId);
                }

              } else if (msgType === "video") {
                const mediaId = message.video?.id;
                text = "[Video]";
                mediaType = "video";
                if (mediaId && WHATSAPP_TOKEN) {
                  mediaUrl = await getMediaUrl(mediaId);
                }

              } else if (msgType === "sticker") {
                text = "[Sticker]";
                mediaType = "sticker";

              } else if (msgType === "location") {
                const lat = message.location?.latitude;
                const lng = message.location?.longitude;
                text = `[Location: ${lat}, ${lng}]`;

              } else {
                text = `[${msgType}]`;
              }

              console.log(`New message from ${from}: ${text}`);
              await saveToSupabase(from, text, "inbound", phoneNumberId, mediaUrl, mediaType);
            }
          }

          if (value.statuses) {
            for (const status of value.statuses) {
              console.log(`Message ${status.id} status: ${status.status}`);
            }
          }
        }
      }
      return res.status(200).json({ status: "ok" });
    }
    return res.status(404).json({ error: "Not a WhatsApp event" });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
