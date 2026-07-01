// PUMPA Digital — WhatsApp Webhook (Supabase version)
const VERIFY_TOKEN = "pumpa_webhook_2026";
const SUPABASE_URL = "https://dpeszhbdgxevlkrfllrc.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function saveToSupabase(phone, message, direction = "inbound", phoneNumberId = null) {
  try {
    if (!SUPABASE_SERVICE_KEY) {
      console.error("SUPABASE_SERVICE_KEY not set");
      return;
    }

    // Find which business owns this phone_number_id
    let businessId = null;
    if (phoneNumberId) {
      const lookupRes = await fetch(
        `${SUPABASE_URL}/rest/v1/businesses?phone_number_id=eq.${phoneNumberId}&select=id&limit=1`,
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
        wa_message_id: null
      })
    });

    if (!insertRes.ok) {
      const err = await insertRes.text();
      console.error('Supabase insert error:', err);
    } else {
      console.log(`Message saved: ${direction} from ${phone}`);
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
              if (msgType === "text") text = message.text?.body || "";
              else if (msgType === "image") text = "[Image]";
              else if (msgType === "audio") text = "[Audio]";
              else if (msgType === "document") text = "[Document]";
              else text = `[${msgType}]`;
              console.log(`New message from ${from}: ${text}`);
              await saveToSupabase(from, text, "inbound", phoneNumberId);
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
