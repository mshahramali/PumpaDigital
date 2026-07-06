// PUMPA Digital — Public feedback endpoint.
// A customer submits the feedback form (no login). We:
//   1. Find which business is collecting feedback (by name).
//   2. Send that business's approved "thank you" WhatsApp template to the customer.
//   3. Save the feedback and the customer as a contact (best-effort, never blocks the message).
//
// NOTE: WhatsApp only lets a business OPEN a conversation with an approved template,
// so the first message here MUST be a template (e.g. usama_silk_thank_you).

const SUPABASE_URL = "https://dpeszhbdgxevlkrfllrc.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

// Look up a business by name → its id, phone number id, and token (token falls back to env).
async function getBusinessByName(name) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/businesses?name=eq.${encodeURIComponent(name)}&select=id,whatsapp_phone_number_id,whatsapp_access_token&limit=1`,
    {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
      }
    }
  );
  const rows = await res.json();
  const biz = rows && rows[0] ? rows[0] : null;
  if (!biz) return null;
  return {
    id: biz.id,
    phoneNumberId: biz.whatsapp_phone_number_id || null,
    token: biz.whatsapp_access_token || WHATSAPP_TOKEN
  };
}

// Best-effort insert — logs but never throws.
async function tryInsert(table, row) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(row)
    });
  } catch (e) {
    console.error(`Insert into ${table} failed:`, e.message);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    if (!SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ ok: false, error: 'Server not configured' });
    }

    let {
      name, phone, rating, feedback,
      businessName, templateName, templateLang
    } = req.body || {};

    name = (name || '').trim() || 'Customer';
    feedback = (feedback || '').trim();
    businessName = (businessName || 'PUMPA').trim();
    templateName = (templateName || 'usama_silk_thank_you').trim();
    templateLang = (templateLang || 'en').trim();

    // Normalise phone: keep digits only (WhatsApp wants full intl number, no +).
    const cleanPhone = String(phone || '').replace(/[^0-9]/g, '');
    if (cleanPhone.length < 8) {
      return res.status(400).json({ ok: false, error: 'Please enter a valid WhatsApp number with country code.' });
    }

    // 1) Which business is sending?
    const biz = await getBusinessByName(businessName);
    if (!biz) return res.status(400).json({ ok: false, error: `Business "${businessName}" not found.` });
    if (!biz.phoneNumberId) return res.status(400).json({ ok: false, error: `Business "${businessName}" has no WhatsApp number configured.` });
    if (!biz.token) return res.status(400).json({ ok: false, error: 'No WhatsApp token available.' });

    // 2) Send the approved template (this is what opens the conversation)
    const waRes = await fetch(`https://graph.facebook.com/v18.0/${biz.phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${biz.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: cleanPhone,
        type: 'template',
        template: {
          name: templateName,
          language: { code: templateLang },
          components: [{
            type: 'body',
            parameters: [{ type: 'text', text: name }]
          }]
        }
      })
    });

    const waData = await waRes.json();

    if (!waData.messages || !waData.messages[0]) {
      const errMsg = waData.error?.message || JSON.stringify(waData);
      console.error('Feedback template send error:', errMsg);
      // Still save the feedback even if the message failed, so nothing is lost.
      await tryInsert('feedback', {
        business_id: biz.id, name, phone: cleanPhone,
        rating: rating || null, feedback, message_sent: false
      });
      return res.status(400).json({ ok: false, error: errMsg });
    }

    // 3) Save the outgoing message (so it appears in the CRM inbox)
    await tryInsert('messages', {
      business_id: biz.id, contact_id: null, direction: 'outbound',
      content: `[Template] ${templateName}`, phone: cleanPhone,
      phone_number_id: biz.phoneNumberId, status: 'sent',
      wa_message_id: waData.messages[0].id
    });

    // 4) Save the feedback record
    await tryInsert('feedback', {
      business_id: biz.id, name, phone: cleanPhone,
      rating: rating || null, feedback, message_sent: true
    });

    // 5) Save the customer as a contact (harmless if duplicate)
    await tryInsert('contacts', {
      business_id: biz.id, name, whatsapp_number: cleanPhone, source: 'Feedback Form'
    });

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('feedback endpoint error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
