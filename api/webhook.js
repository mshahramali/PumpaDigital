// PUMPA Digital — WhatsApp Webhook (Supabase + Coexistence)
// Handles: standard customer messages, plus Coexistence events —
//   history            (past chats synced after a client onboards their existing number)
//   smb_message_echoes (messages the client sends from their WhatsApp Business app)
//   smb_app_state_sync (the client's contacts)
const VERIFY_TOKEN = "pumpa_webhook_2026";
const SUPABASE_URL = "https://dpeszhbdgxevlkrfllrc.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Resolve which business owns a given phone_number_id
async function getBusinessId(phoneNumberId) {
  if (!phoneNumberId || !SUPABASE_SERVICE_KEY) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/businesses?whatsapp_phone_number_id=eq.${phoneNumberId}&select=id&limit=1`,
      { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    const rows = await res.json();
    return rows && rows[0] ? rows[0].id : null;
  } catch (e) { console.error('getBusinessId error:', e.message); return null; }
}

// Insert a message row
async function insertMessage({ businessId, phone, content, direction, phoneNumberId, waId }) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/messages`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        business_id: businessId, contact_id: null, direction,
        content: String(content || '').replace(/\n/g, ' ').replace(/\r/g, '').trim(),
        phone_number_id: phoneNumberId || null, phone: String(phone),
        status: direction === 'inbound' ? 'received' : 'sent',
        wa_message_id: waId || null
      })
    });
    if (!res.ok) console.error('insertMessage error:', await res.text());
  } catch (e) { console.error('insertMessage failed:', e.message); }
}

// Save/refresh a contact (best-effort; harmless on duplicate)
async function insertContact({ businessId, phone, name }) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/contacts`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        business_id: businessId, name: name || ('+' + phone),
        whatsapp_number: String(phone), source: 'Coexistence Sync'
      })
    });
  } catch (e) { console.error('insertContact failed:', e.message); }
}

// Turn a WhatsApp message object into readable text
function messageToText(m) {
  const t = m.type;
  if (t === 'text') return m.text?.body || '';
  if (t === 'image') return '[Image]';
  if (t === 'audio') return '[Audio]';
  if (t === 'video') return '[Video]';
  if (t === 'document') return '[Document]';
  if (t === 'sticker') return '[Sticker]';
  if (t === 'location') return `[Location: ${m.location?.latitude}, ${m.location?.longitude}]`;
  return `[${t}]`;
}

// ---- Coexistence handlers ----

// history: past chat threads synced right after onboarding
async function handleHistory(value, phoneNumberId) {
  const businessId = await getBusinessId(phoneNumberId);
  const businessPhone = value.metadata?.display_phone_number || null;
  const historyBlocks = value.history || [];
  for (const block of historyBlocks) {
    if (block.errors) { console.log('History not shared / error:', JSON.stringify(block.errors)); continue; }
    for (const thread of block.threads || []) {
      const userPhone = thread.id; // the customer's number for this thread
      for (const m of thread.messages || []) {
        // direction: if the message is FROM the business number, it's outbound
        const fromBusiness = m.from && businessPhone && String(m.from).includes(String(businessPhone).replace(/\D/g,''));
        await insertMessage({
          businessId, phone: userPhone, content: messageToText(m),
          direction: fromBusiness ? 'outbound' : 'inbound',
          phoneNumberId, waId: m.id
        });
      }
    }
  }
  console.log('History processed for phoneNumberId', phoneNumberId);
}

// smb_message_echoes: messages the business owner sends from their phone app
async function handleEcho(value, phoneNumberId) {
  const businessId = await getBusinessId(phoneNumberId);
  const echoes = value.message_echoes || value.messages || [];
  for (const m of echoes) {
    const userPhone = m.to || m.from; // echo of an outbound message → 'to' is the customer
    await insertMessage({
      businessId, phone: userPhone, content: messageToText(m),
      direction: 'outbound', phoneNumberId, waId: m.id
    });
  }
  console.log('Echo processed for phoneNumberId', phoneNumberId);
}

// smb_app_state_sync: the business's contacts
async function handleContacts(value, phoneNumberId) {
  const businessId = await getBusinessId(phoneNumberId);
  const contacts = value.contacts || value.state_sync || [];
  for (const c of contacts) {
    const phone = c.wa_id || c.phone || c.id;
    const name = c.profile?.name || c.name || null;
    if (phone) await insertContact({ businessId, phone, name });
  }
  console.log('Contacts processed for phoneNumberId', phoneNumberId);
}

export default async function handler(req, res) {
  // ── GET: Verification
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

  // ── POST: Events
  if (req.method === "POST") {
    const body = req.body;

    // Log the raw payload of anything that isn't a plain 'messages' event,
    // so new/Coexistence formats can be verified against reality.
    try {
      const fields = (body.entry || []).flatMap(e => (e.changes || []).map(c => c.field));
      if (fields.some(f => f && f !== 'messages')) {
        console.log('COEXISTENCE/RAW PAYLOAD:', JSON.stringify(body).slice(0, 4000));
      }
    } catch (e) {}

    if (body.object === "whatsapp_business_account") {
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          const field = change.field;
          const value = change.value || {};
          const phoneNumberId = value.metadata?.phone_number_id || null;

          // Standard incoming customer messages
          if (field === 'messages' || value.messages || value.statuses) {
            if (value.messages) {
              for (const message of value.messages) {
                console.log(`New message from ${message.from}`);
                await insertMessage({
                  businessId: await getBusinessId(phoneNumberId),
                  phone: message.from, content: messageToText(message),
                  direction: 'inbound', phoneNumberId, waId: message.id
                });
              }
            }
            if (value.statuses) {
              for (const s of value.statuses) console.log(`Status ${s.id}: ${s.status}`);
            }
          }

          // Coexistence events
          if (field === 'history') await handleHistory(value, phoneNumberId);
          if (field === 'smb_message_echoes') await handleEcho(value, phoneNumberId);
          if (field === 'smb_app_state_sync') await handleContacts(value, phoneNumberId);
        }
      }
      return res.status(200).json({ status: "ok" });
    }

    // Fallback: some Coexistence payloads may arrive with a top-level 'event' key
    if (body.event) {
      console.log('TOP-LEVEL EVENT PAYLOAD:', JSON.stringify(body).slice(0, 4000));
      const value = body.data || {};
      const phoneNumberId = value.metadata?.phone_number_id || null;
      if (body.event === 'history') await handleHistory(value, phoneNumberId);
      if (body.event === 'smb_message_echoes') await handleEcho(value, phoneNumberId);
      if (body.event === 'smb_app_state_sync') await handleContacts(value, phoneNumberId);
      return res.status(200).json({ status: "ok" });
    }

    return res.status(200).json({ status: "ignored" });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
