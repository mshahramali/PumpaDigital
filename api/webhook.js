// PUMPA Digital — WhatsApp Webhook (Supabase + Coexistence)
// Handles: standard customer messages, plus Coexistence events —
//   history            (past chats synced after a client onboards their existing number)
//   smb_message_echoes (messages the client sends from their WhatsApp Business app)
//   smb_app_state_sync (the client's contacts)
const VERIFY_TOKEN = "pumpa_webhook_2026";
const SUPABASE_URL = "https://dpeszhbdgxevlkrfllrc.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

// ── AUTOMATIC ONBOARDING (webhook-driven) ─────────────────────────────
// When a client completes Embedded Signup, Meta fires account_update with
// event PARTNER_ADDED and their waba_id. This provisions them fully —
// subscribe, fetch number, create business, notify admin — with NO
// dependency on the client's browser. The browser path (/api/onboard)
// still runs when it can, and adds the login; both are idempotent on
// whatsapp_waba_id, so double-provisioning is harmless.
async function provisionPartner(wabaId, ownerName) {
  try {
    // 1. Subscribe our app to their WABA (the step done by hand for Arafat)
    const sub = await fetch(`https://graph.facebook.com/v18.0/${wabaId}/subscribed_apps`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
    });
    console.log('PROVISION: subscribed_apps →', sub.status);

    // 2. Read their phone number
    const pnRes = await fetch(`https://graph.facebook.com/v18.0/${wabaId}/phone_numbers`, {
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
    });
    const pn = await pnRes.json();
    const phone = pn.data && pn.data[0];
    if (!phone) { console.error('PROVISION: no phone numbers on WABA', wabaId, JSON.stringify(pn).slice(0, 300)); return; }

    // 3. Create/refresh the business row (idempotent — unique on whatsapp_waba_id)
    const up = await fetch(`${SUPABASE_URL}/rest/v1/businesses?on_conflict=whatsapp_waba_id`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify({
        name: ownerName || phone.verified_name || 'New PUMPA client',
        whatsapp_waba_id: wabaId,
        whatsapp_phone_number_id: phone.id,
        whatsapp_display_name: phone.display_phone_number
      })
    });
    console.log('PROVISION: business row →', up.status, (await up.text()).slice(0, 300));

    // 4. Try to create the client's login + email a magic link.
    //    This only completes if the browser already stored their email;
    //    if not, /api/pending-signup will trigger it when the email arrives.
    try {
      await fetch(`https://pumpa-whatsapp-crm.vercel.app/api/complete-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ waba_id: wabaId }),
      });
      console.log('PROVISION: complete-login triggered for', wabaId);
    } catch (e) { console.error('complete-login trigger failed:', e.message); }

    // 5. WhatsApp the admin (you): "new client!"
    if (process.env.ADMIN_WHATSAPP_NUMBER && process.env.PUMPA_PHONE_NUMBER_ID) {
      await fetch(`https://graph.facebook.com/v18.0/${process.env.PUMPA_PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: process.env.ADMIN_WHATSAPP_NUMBER,
          type: 'text',
          text: { body: `🎉 New client connected to PUMPA\n${ownerName || phone.verified_name || ''}\n${phone.display_phone_number}\nWABA: ${wabaId}` }
        })
      });
    }
  } catch (e) {
    console.error('PROVISION error:', e.message);
  }
}

// Mark a customer opted out of marketing WhatsApp messages (e.g. they tapped
// the "Stop promotions" quick-reply button on a template). Best-effort —
// never throws into the webhook's main flow.
async function optOutCustomer(businessId, phone) {
  if (!businessId || !phone) return;
  const patch = { opted_out: true, opted_out_at: new Date().toISOString() };
  // Mark opted_out on BOTH tables — `customers` (restaurant/feedback vertical)
  // AND `contacts` (general broadcast audience). A STOP from either surface
  // must silence both, or broadcasts could still reach someone who opted out
  // via a feedback-thanks message, and vice versa.
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/customers?business_id=eq.${businessId}&phone=eq.${phone}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json', 'Prefer': 'return=minimal'
        },
        body: JSON.stringify(patch)
      }
    );
    if (!res.ok) console.error('optOutCustomer (customers) error:', await res.text());
    else console.log('OPT-OUT: customers row for', phone, 'marked opted_out, business', businessId);
  } catch (e) { console.error('optOutCustomer (customers) failed:', e.message); }

  try {
    const res2 = await fetch(
      `${SUPABASE_URL}/rest/v1/contacts?business_id=eq.${businessId}&whatsapp_number=eq.${phone}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json', 'Prefer': 'return=minimal'
        },
        body: JSON.stringify(patch)
      }
    );
    if (!res2.ok) console.error('optOutCustomer (contacts) error:', await res2.text());
    else console.log('OPT-OUT: contacts row for', phone, 'marked opted_out, business', businessId);
  } catch (e) { console.error('optOutCustomer (contacts) failed:', e.message); }
}

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

// Update a message's delivery status by its wa_message_id. Statuses can
// arrive out of order (Meta doesn't guarantee sequencing), so we only ever
// move FORWARD through sent -> delivered -> read, never backward, and never
// overwrite a terminal 'failed'.
const STATUS_RANK = { sent: 1, delivered: 2, read: 3, failed: 99 };
async function updateMessageStatus(waMessageId, newStatus) {
  if (!waMessageId || !newStatus || !SUPABASE_SERVICE_KEY) return;
  try {
    const curRes = await fetch(
      `${SUPABASE_URL}/rest/v1/messages?wa_message_id=eq.${waMessageId}&select=id,status&limit=1`,
      { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    const rows = await curRes.json();
    const row = rows && rows[0];
    if (!row) return; // status for a message we didn't log (e.g. sent before this feature existed)

    const curRank = STATUS_RANK[row.status] || 0;
    const newRank = STATUS_RANK[newStatus] || 0;
    if (newRank <= curRank) return; // don't regress or repeat

    const res = await fetch(`${SUPABASE_URL}/rest/v1/messages?id=eq.${row.id}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ status: newStatus }),
    });
    if (!res.ok) console.error('updateMessageStatus error:', await res.text());
  } catch (e) { console.error('updateMessageStatus failed:', e.message); }
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

          // ── New client connected via Embedded Signup → provision automatically
          if (field === 'account_update' &&
              (value.event === 'PARTNER_ADDED' || value.event === 'PARTNER_APP_INSTALLED')) {
            const newWabaId = value.waba_info?.waba_id;
            const ownerName = value.waba_info?.owner_business_name || null;
            console.log('PARTNER event:', value.event, 'waba:', newWabaId);
            if (newWabaId) await provisionPartner(newWabaId, ownerName);
          }

          // Standard incoming customer messages
          if (field === 'messages' || value.messages || value.statuses) {
            if (value.messages) {
              for (const message of value.messages) {
                console.log(`New message from ${message.from}`);
                const businessId = await getBusinessId(phoneNumberId);
                await insertMessage({
                  businessId,
                  phone: message.from, content: messageToText(message),
                  direction: 'inbound', phoneNumberId, waId: message.id
                });

                // Quick-reply button tap — check for the "Stop promotions" opt-out.
                // Cloud API sends these as type 'button', with the button's text
                // (and, since we didn't set a custom payload, its payload too)
                // equal to the label we set when creating the template.
                if (message.type === 'button') {
                  const label = (message.button?.text || message.button?.payload || '').toLowerCase();
                  if (label.includes('stop promo')) {
                    await optOutCustomer(businessId, message.from);
                  }
                }
              }
            }
            if (value.statuses) {
              for (const s of value.statuses) {
                console.log(`Status ${s.id}: ${s.status}`);
                await updateMessageStatus(s.id, s.status);
              }
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
