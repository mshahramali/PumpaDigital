// PUMPA Digital — WhatsApp Webhook
// Deploy to: /api/webhook.js in your GitHub repo

const VERIFY_TOKEN = "pumpa_webhook_2026";
const GOOGLE_SHEET_URL = "https://script.google.com/macros/s/AKfycbyMtzAnXg62RPMa9jcc5vaNiyanQCOgZ88Ob06InGY_Pz_O6XSKuZLc6Zv_COYoc6aKSg/exec";
const SHEET_SECRET = "pumpa_secret_2026";

async function saveToSheet(phone, message, type = "incoming") {
  try {
    await fetch(GOOGLE_SHEET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: SHEET_SECRET, phone, message, type }),
    });
  } catch (err) {
    console.error("Failed to save to Google Sheet:", err);
  }
}

export default async function handler(req, res) {
  
  // ── GET: Webhook Verification (Meta calls this once to verify)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("Webhook verified successfully!");
      return res.status(200).send(challenge);
    } else {
      return res.status(403).json({ error: "Verification failed" });
    }
  }

  // ── POST: Receive WhatsApp Messages
  if (req.method === "POST") {
    const body = req.body;

    if (body.object === "whatsapp_business_account") {
      body.entry?.forEach((entry) => {
        entry.changes?.forEach((change) => {
          const value = change.value;

          // Incoming messages
          if (value.messages) {
            value.messages.forEach(async (message) => {
              const from = message.from;
              const msgType = message.type;
              
              let text = "";
              if (msgType === "text") {
                text = message.text?.body || "";
              }

              console.log(`New message from ${from}: ${text}`);

              // ── SAVE TO GOOGLE SHEET ──
              await saveToSheet(from, text, "incoming");
            });
          }

          // Message status updates (delivered, read, etc.)
          if (value.statuses) {
            value.statuses.forEach((status) => {
              console.log(`Message ${status.id} status: ${status.status}`);
            });
          }
        });
      });

      return res.status(200).json({ status: "ok" });
    }

    return res.status(404).json({ error: "Not a WhatsApp event" });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
