// /api/reservations — MERGED endpoint (public booking + authenticated CRM CRUD)
//
// Merged into a single serverless function to stay within Vercel Hobby's
// 12-function limit. Routing:
//
//   ?public=1  → public booking page (r.html). NO auth required.
//                GET  ?public=1&slug=xxx[&date=YYYY-MM-DD]  → settings + slot availability
//                POST ?public=1  {slug,name,phone,date,time,party_size,notes}
//
//   (default)  → authenticated CRM endpoints. Requires Supabase JWT in
//                Authorization: Bearer <access_token>
//                GET    ?from=&to=&status=   → list reservations
//                POST                        → manual add ({force:true} to overbook)
//                PATCH  ?id=xxx              → update status/fields
//                DELETE ?id=xxx              → cancel (soft — sets status='cancelled')
//
// No npm packages — raw fetch against Supabase REST + Meta Graph API.

const SUPABASE_URL = "https://dpeszhbdgxevlkrfllrc.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_ANON_KEY = "sb_publishable_gZj05PTTPix9SEKEwBXo5Q_W8YGBky2";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const GRAPH = 'https://graph.facebook.com/v21.0';
const DEFAULT_TEMPLATE = 'reservation_confirmed';

async function sb(path, opts = {}) {
  return fetch(`${SUPABASE_URL}${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
}

async function getUserId(accessToken) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u?.id || null;
}

// Per-business WhatsApp token lookup, same pattern as the rest of the codebase.
async function getToken(businessId) {
  try {
    const r = await sb(`/rest/v1/business_secrets?business_id=eq.${businessId}&select=*&limit=1`);
    const row = (await r.json())[0];
    if (row) {
      const t = row.access_token || row.whatsapp_access_token || row.token;
      if (t) return t;
    }
  } catch (e) { /* fall through */ }
  try {
    const r = await sb(`/rest/v1/businesses?id=eq.${businessId}&select=whatsapp_access_token&limit=1`);
    const row = (await r.json())[0];
    if (row?.whatsapp_access_token) return row.whatsapp_access_token;
  } catch (e) { /* fall through */ }
  return WHATSAPP_TOKEN || null;
}

async function getTemplateVarCount(wabaId, token, tplName) {
  try {
    const r = await fetch(
      `${GRAPH}/${wabaId}/message_templates?fields=name,language,components&limit=200`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const j = await r.json();
    if (!r.ok) return null;
    const match = (j.data || []).find(t => t.name === tplName);
    if (!match) return null;
    const body = (match.components || []).find(c => (c.type || '').toUpperCase() === 'BODY');
    if (!body?.text) return 0;
    return new Set((body.text.match(/\{\{\s*\d+\s*\}\}/g) || [])).size;
  } catch (e) { return null; }
}

// Every half-open [opening_time, closing_time) slot, stepped by slot_interval_minutes.
function buildSlots(openingTime, closingTime, intervalMin) {
  const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const toHHMM = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const start = toMin(openingTime), end = toMin(closingTime);
  const slots = [];
  for (let m = start; m < end; m += intervalMin) slots.push(toHHMM(m));
  return slots;
}

function fmtDateNice(dateStr) {
  try { return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); }
  catch (e) { return dateStr; }
}
function fmtTimeNice(timeStr) {
  const [h, m] = String(timeStr).slice(0, 5).split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

// Best-effort WhatsApp confirmation, shared by the manual-add path.
async function sendConfirmation(businessId, page, reservationId, name, phone, date, time, partySize) {
  try {
    const bizRes = await sb(`/rest/v1/businesses?id=eq.${businessId}&select=whatsapp_phone_number_id,whatsapp_waba_id&limit=1`);
    const biz = (await bizRes.json())[0];
    const token = await getToken(businessId);
    const tpl = page?.confirmation_template || DEFAULT_TEMPLATE;
    if (!biz?.whatsapp_phone_number_id || !token) return false;

    let varCount = biz.whatsapp_waba_id ? await getTemplateVarCount(biz.whatsapp_waba_id, token, tpl) : null;
    if (varCount == null) varCount = 4;

    const allValues = [name, fmtDateNice(date), fmtTimeNice(time), String(partySize), page?.restaurant_name || ''];
    const params = allValues.slice(0, varCount);

    const wr = await fetch(`${GRAPH}/${biz.whatsapp_phone_number_id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to: phone, type: 'template',
        template: { name: tpl, language: { code: 'en' }, components: [{ type: 'body', parameters: params.map(t => ({ type: 'text', text: String(t) })) }] },
      }),
    });
    const wj = await wr.json();
    const sent = wr.ok && !wj.error;
    if (sent) {
      await sb(`/rest/v1/reservations?id=eq.${reservationId}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ confirmation_sent: true }),
      });
    }
    return sent;
  } catch (e) {
    console.error('RESERVATIONS: confirmation send failed', e.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC handler — no auth. Used by r.html via ?public=1
// ═══════════════════════════════════════════════════════════════
async function handlePublic(req, res) {


  // ─────────────────────────── GET: settings (+ availability) ───────────────────────────
  if (req.method === 'GET') {
    const slug = (req.query?.slug || '').toString().trim();
    const date = (req.query?.date || '').toString().trim();
    if (!slug) return res.status(400).json({ ok: false, error: 'slug required' });

    const r = await sb(`/rest/v1/reservation_pages?slug=eq.${encodeURIComponent(slug)}&is_active=eq.true&select=id,restaurant_name,logo_url,accent_color,opening_time,closing_time,slot_interval_minutes,min_party_size,max_party_size,advance_booking_days,min_notice_hours,closed_weekdays,max_covers_per_slot&limit=1`);
    const page = (await r.json())[0];
    if (!page) return res.status(404).json({ ok: false, error: 'not found' });

    if (!date) return res.status(200).json({ ok: true, page });

    // Validate the requested date against this restaurant's booking window
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const reqDate = new Date(date + 'T00:00:00');
    const daysOut = Math.round((reqDate - today) / 86400000);
    const closedDays = Array.isArray(page.closed_weekdays) ? page.closed_weekdays : [];
    const isClosed = daysOut < 0 || daysOut > (page.advance_booking_days ?? 30) || closedDays.includes(reqDate.getDay());

    if (isClosed) return res.status(200).json({ ok: true, page, slots: [] });

    const allSlots = buildSlots(page.opening_time, page.closing_time, page.slot_interval_minutes || 30);

    // Sum booked covers per slot for that date (cancelled/no-show don't count against capacity)
    const rr = await sb(`/rest/v1/reservations?reservation_page_id=eq.${page.id}&reservation_date=eq.${date}&status=not.in.(cancelled,no_show)&select=reservation_time,party_size`);
    const booked = await rr.json();
    const usedBySlot = {};
    for (const row of booked) {
      const t = String(row.reservation_time).slice(0, 5);
      usedBySlot[t] = (usedBySlot[t] || 0) + (row.party_size || 0);
    }

    const now = new Date();
    const minNoticeMs = (page.min_notice_hours ?? 0) * 3600000;
    const slots = allSlots.map(t => {
      const used = usedBySlot[t] || 0;
      const remaining = Math.max(0, (page.max_covers_per_slot ?? 0) - used);
      const slotDt = new Date(date + 'T' + t + ':00');
      const pastNotice = (slotDt - now) < minNoticeMs;
      return { time: t, label: fmtTimeNice(t), remaining, available: remaining > 0 && !pastNotice };
    });

    return res.status(200).json({ ok: true, page, slots });
  }

  // ─────────────────────────── POST: create booking ───────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'GET or POST only' });

  try {
    const b = req.body || {};
    const slug = (b.slug || '').toString().trim();
    const name = (b.name || '').toString().trim();
    const phone = (b.phone || '').toString().replace(/[^0-9]/g, '');
    const date = (b.date || '').toString().trim();
    const time = (b.time || '').toString().trim();
    const partySize = parseInt(b.party_size, 10);
    const notes = (b.notes || '').toString().trim();

    if (!slug || !name || !/^92\d{10}$/.test(phone) || !date || !time || !Number.isFinite(partySize) || partySize < 1) {
      return res.status(400).json({ ok: false, error: 'slug, name, a valid phone, date, time and party size are required' });
    }

    const pr = await sb(`/rest/v1/reservation_pages?slug=eq.${encodeURIComponent(slug)}&is_active=eq.true&select=*&limit=1`);
    const page = (await pr.json())[0];
    if (!page) return res.status(404).json({ ok: false, error: 'This booking page is not available' });

    if (partySize < (page.min_party_size || 1) || partySize > (page.max_party_size || 20)) {
      return res.status(400).json({ ok: false, error: `Party size must be between ${page.min_party_size} and ${page.max_party_size}. For larger groups, please call us directly.` });
    }

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const reqDate = new Date(date + 'T00:00:00');
    const daysOut = Math.round((reqDate - today) / 86400000);
    const closedDays = Array.isArray(page.closed_weekdays) ? page.closed_weekdays : [];
    if (daysOut < 0 || daysOut > (page.advance_booking_days ?? 30)) {
      return res.status(400).json({ ok: false, error: 'That date is outside our booking window.' });
    }
    if (closedDays.includes(reqDate.getDay())) {
      return res.status(400).json({ ok: false, error: 'We are closed on that day.' });
    }
    const slotDt = new Date(date + 'T' + time + ':00');
    if ((slotDt - new Date()) < (page.min_notice_hours ?? 0) * 3600000) {
      return res.status(400).json({ ok: false, error: `Reservations need at least ${page.min_notice_hours} hours' notice — please pick a later time.` });
    }

    // Capacity re-check at write time — the authoritative check, since two people
    // could be booking the same slot at once and any GET snapshot may be stale.
    const rr = await sb(`/rest/v1/reservations?reservation_page_id=eq.${page.id}&reservation_date=eq.${date}&reservation_time=eq.${time}:00&status=not.in.(cancelled,no_show)&select=party_size`);
    const existingBookings = await rr.json();
    const used = existingBookings.reduce((sum, r) => sum + (r.party_size || 0), 0);
    if (used + partySize > (page.max_covers_per_slot ?? 0)) {
      return res.status(409).json({ ok: false, error: 'Sorry, that time just got fully booked — please pick another slot.' });
    }

    const ins = await sb(`/rest/v1/reservations`, {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        business_id: page.business_id, reservation_page_id: page.id,
        customer_name: name, customer_phone: phone, party_size: partySize,
        reservation_date: date, reservation_time: time, notes: notes || null,
        status: 'confirmed', source: 'public_form',
      }),
    });
    const row = (await ins.json())[0];
    if (!row) return res.status(500).json({ ok: false, error: 'Could not save the reservation — please try again.' });
    console.log('RESERVATION: created', page.restaurant_name, phone, date, time, partySize);

    // Also upsert into customers, mirroring the visit-tracking feedback-public.js does —
    // keeps the CRM's contact list aware of reservation-only customers too.
    try {
      const cr = await sb(`/rest/v1/customers?business_id=eq.${page.business_id}&phone=eq.${phone}&select=id&limit=1`);
      const existingCustomer = (await cr.json())[0];
      if (!existingCustomer) {
        await sb(`/rest/v1/customers`, {
          method: 'POST', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ business_id: page.business_id, phone, name, visit_count: 0 }),
        });
      }
    } catch (e) { /* non-critical, never block a confirmed booking on this */ }

    // WhatsApp confirmation (best-effort — reservation is already saved)
    let whatsappSent = false;
    try {
      const bizRes = await sb(`/rest/v1/businesses?id=eq.${page.business_id}&select=whatsapp_phone_number_id,whatsapp_waba_id&limit=1`);
      const biz = (await bizRes.json())[0];
      const token = await getToken(page.business_id);
      const tpl = page.confirmation_template || DEFAULT_TEMPLATE;

      if (biz?.whatsapp_phone_number_id && token) {
        let varCount = biz.whatsapp_waba_id ? await getTemplateVarCount(biz.whatsapp_waba_id, token, tpl) : null;
        if (varCount == null) varCount = 4; // reasonable guess if the live lookup fails

        const allValues = [name, fmtDateNice(date), fmtTimeNice(time), String(partySize), page.restaurant_name];
        const params = allValues.slice(0, varCount);

        const wr = await fetch(`${GRAPH}/${biz.whatsapp_phone_number_id}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp', to: phone, type: 'template',
            template: {
              name: tpl, language: { code: 'en' },
              components: [{ type: 'body', parameters: params.map(t => ({ type: 'text', text: String(t) })) }],
            },
          }),
        });
        const wj = await wr.json();
        whatsappSent = wr.ok && !wj.error;
        console.log('RESERVATION: whatsapp', tpl, wr.status, wj.error?.message || 'ok');
        if (whatsappSent) {
          await sb(`/rest/v1/reservations?id=eq.${row.id}`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ confirmation_sent: true }),
          });
        }
      }
    } catch (e) {
      console.error('RESERVATION: whatsapp send failed', e.message);
    }

    return res.status(200).json({ ok: true, reservation_id: row.id, whatsapp_sent: whatsappSent });
  } catch (err) {
    console.error('reservations-public error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
// AUTHENTICATED handler — CRM Reservations page
// ═══════════════════════════════════════════════════════════════
async function handleAuth(req, res) {

  try {
    const authHeader = req.headers.authorization || '';
    const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!accessToken) return res.status(401).json({ ok: false, error: 'Not logged in' });

    const userId = await getUserId(accessToken);
    if (!userId) return res.status(401).json({ ok: false, error: 'Invalid session' });

    const pr = await sb(`/rest/v1/profiles?id=eq.${userId}&select=business_id,role&limit=1`);
    const profile = (await pr.json())[0];
    if (!profile?.business_id) return res.status(400).json({ ok: false, error: 'No business linked to this account' });
    const businessId = profile.business_id;

    // ─────────────────────────── GET: list ───────────────────────────
    if (req.method === 'GET') {
      const from = (req.query?.from || '').toString().trim();
      const to = (req.query?.to || '').toString().trim();
      const status = (req.query?.status || '').toString().trim();
      let path = `/rest/v1/reservations?business_id=eq.${businessId}&select=*&order=reservation_date.asc,reservation_time.asc`;
      if (from) path += `&reservation_date=gte.${from}`;
      if (to) path += `&reservation_date=lte.${to}`;
      if (status) path += `&status=eq.${encodeURIComponent(status)}`;
      const r = await sb(path);
      const reservations = await r.json();
      return res.status(200).json({ ok: true, reservations });
    }

    // ─────────────────────────── POST: manual add ───────────────────────────
    if (req.method === 'POST') {
      const b = req.body || {};
      const customer_name = (b.customer_name || '').toString().trim();
      const customer_phone = (b.customer_phone || '').toString().replace(/[^0-9]/g, '');
      const party_size = parseInt(b.party_size, 10);
      const reservation_date = (b.reservation_date || '').toString().trim();
      const reservation_time = (b.reservation_time || '').toString().trim();
      const notes = (b.notes || '').toString().trim();
      const force = !!b.force;

      if (!customer_name || !customer_phone || !reservation_date || !reservation_time || !Number.isFinite(party_size) || party_size < 1) {
        return res.status(400).json({ ok: false, error: 'customer_name, customer_phone, reservation_date, reservation_time and party_size are required' });
      }

      // Optional — a manual entry can be tied to one of this business's booking
      // pages (for capacity tracking + which confirmation template to use), or
      // left unlinked for a walk-in/phone booking with no capacity check.
      let page = null;
      if (b.reservation_page_id) {
        const pr2 = await sb(`/rest/v1/reservation_pages?id=eq.${b.reservation_page_id}&business_id=eq.${businessId}&select=*&limit=1`);
        page = (await pr2.json())[0] || null;
      }

      if (page && !force) {
        const rr = await sb(`/rest/v1/reservations?reservation_page_id=eq.${page.id}&reservation_date=eq.${reservation_date}&reservation_time=eq.${reservation_time}:00&status=not.in.(cancelled,no_show)&select=party_size`);
        const existingBookings = await rr.json();
        const used = existingBookings.reduce((sum, r) => sum + (r.party_size || 0), 0);
        if (used + party_size > (page.max_covers_per_slot ?? 0)) {
          return res.status(409).json({
            ok: false, error: 'over_capacity',
            message: `That slot already has ${used}/${page.max_covers_per_slot} covers booked. Add anyway?`,
          });
        }
      }

      const ins = await sb(`/rest/v1/reservations`, {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          business_id: businessId, reservation_page_id: page?.id || null,
          customer_name, customer_phone, party_size,
          reservation_date, reservation_time, notes: notes || null,
          status: 'confirmed', source: 'manual',
        }),
      });
      const row = (await ins.json())[0];
      if (!row) return res.status(500).json({ ok: false, error: 'Could not save the reservation' });

      let whatsappSent = false;
      if (b.send_confirmation) {
        whatsappSent = await sendConfirmation(businessId, page, row.id, customer_name, customer_phone, reservation_date, reservation_time, party_size);
      }

      return res.status(200).json({ ok: true, reservation: row, whatsapp_sent: whatsappSent });
    }

    // ─────────────────────────── PATCH: update ───────────────────────────
    if (req.method === 'PATCH') {
      const id = (req.query?.id || '').toString().trim();
      if (!id) return res.status(400).json({ ok: false, error: 'id required' });
      const b = req.body || {};
      const patch = {};
      if (b.status) patch.status = b.status;
      if (b.notes !== undefined) patch.notes = b.notes;
      if (b.party_size !== undefined) patch.party_size = parseInt(b.party_size, 10);
      if (b.reservation_date !== undefined) patch.reservation_date = b.reservation_date;
      if (b.reservation_time !== undefined) patch.reservation_time = b.reservation_time;
      patch.updated_at = new Date().toISOString();

      const r = await sb(`/rest/v1/reservations?id=eq.${id}&business_id=eq.${businessId}`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
      });
      const row = (await r.json())[0];
      if (!row) return res.status(404).json({ ok: false, error: 'Reservation not found' });
      return res.status(200).json({ ok: true, reservation: row });
    }

    // ─────────────────────────── DELETE: cancel ───────────────────────────
    if (req.method === 'DELETE') {
      const id = (req.query?.id || '').toString().trim();
      if (!id) return res.status(400).json({ ok: false, error: 'id required' });
      const r = await sb(`/rest/v1/reservations?id=eq.${id}&business_id=eq.${businessId}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'cancelled', updated_at: new Date().toISOString() }),
      });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Could not cancel reservation' });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (err) {
    console.error('reservations error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
// Dispatcher
// ═══════════════════════════════════════════════════════════════
module.exports = async (req, res) => {
  const isPublic = String(req.query?.public || '') === '1'
    || String(req.query?.action || '') === 'public';
  if (isPublic) return handlePublic(req, res);
  return handleAuth(req, res);
};
