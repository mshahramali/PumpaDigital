// PUMPA Digital — WhatsApp Webhook
const VERIFY_TOKEN = "pumpa_webhook_2026";
const GOOGLE_SHEET_URL = "https://script.google.com/macros/s/AKfycbyMtzAnXg62RPMa9jcc5vaNiyanQCOgZ88Ob06InGY_Pz_O6XSKuZLc6Zv_COYoc6aKSg/exec";
const SHEET_SECRET = "pumpa_secret_2026";

async function saveToSheet(phone, message, type = "incoming") {
  try {
    const cleanMessage = String(message).replace(/\n/g, ' ').replace(/\r/g, '').trim();
    const response = await fetch(GOOGLE_SHEET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: SHEET_SECRET, phone, message: cleanMessage, type }),
    });
    const result = await response.text();
    console.log(`Sheet save result: ${result}`);
  } catch (err) {
    console.error("Failed to save to Google Sheet:", err.message);
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

          // Incoming messages
          if (value.messages) {
            for (const message of value.messages) {
              const from = message.from;
              const msgType = message.type;
              let text = "";
              if (msgType === "text") {
                text = message.text?.body || "";
              } else if (msgType === "image") {
                text = "[Image]";
              } else if (msgType === "audio") {
                text = "[Audio]";
              } else if (msgType === "document") {
                text = "[Document]";
              } else {
                text = `[${msgType}]`;
              }
              console.log(`New message from ${from}: ${text}`);
              await saveToSheet(from, text, "incoming");
            }
          }

          // Status updates
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
