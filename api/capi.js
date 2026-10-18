'use strict';

/* =====================================
   META CONVERSIONS API — serverdan Meta’ga hodisa yuborish

   Sayt (index.html) har bir hodisani ikki yo‘l bilan yuboradi:
     1) brauzerdan — Meta Pixel (fbq)
     2) serverdan  — shu fayl orqali (Conversions API)
   Ikkalasida event_id bir xil — Meta ularni BITTA hodisa deb sanaydi.
   Reklama bloklovchi yoki iOS cheklovi Pixel’ni to‘xtatsa ham,
   server yo‘li ishlayveradi.

   SOZLASH (bir marta) — Vercel → loyiha → Settings → Environment Variables:
     META_CAPI_TOKEN  — Conversions API tokeni (MAJBURIY)
     META_PIXEL_ID    — ixtiyoriy (bo‘lmasa pastdagi ID ishlatiladi)
   Keyin Deployments → oxirgi deploy → Redeploy.

   DIQQAT: tokenni hech qachon kodga yozmang — GitHub ochiq (public).
===================================== */

const PIXEL_ID = process.env.META_PIXEL_ID || '1669087454197560';
const API_VERSION = process.env.META_API_VERSION || 'v26.0';

/* Faqat shu hodisalar qabul qilinadi */
const EVENTS = new Set([
  'PageView', 'ViewContent', 'Lead', 'Contact',
  'AudioReview', 'PatientPhone', 'WheelPrize'
]);

const HASH = /^[a-f0-9]{64}$/;

function first(v){
  return String(v || '').split(',')[0].trim();
}

function hostOf(url){
  try{ return new URL(url).host.toLowerCase(); }catch(e){ return ''; }
}

function cleanCustom(c){
  const out = {};
  if(!c || typeof c !== 'object' || Array.isArray(c)) return out;
  Object.keys(c).slice(0, 10).forEach(function(k){
    if(!/^[a-z_]{1,40}$/.test(k)) return;
    const v = c[k];
    if(typeof v === 'number' && isFinite(v)) out[k] = v;
    else if(typeof v === 'string' && v) out[k] = v.slice(0, 100);
  });
  return out;
}

function readBody(req){
  let b = req.body;
  if(typeof b === 'string'){
    try{ b = JSON.parse(b); }catch(e){ b = null; }
  }else if(Buffer.isBuffer(b)){
    try{ b = JSON.parse(b.toString('utf8')); }catch(e){ b = null; }
  }
  return b && typeof b === 'object' ? b : null;
}

module.exports = async function handler(req, res){
  res.setHeader('Cache-Control', 'no-store');

  if(req.method !== 'POST'){
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok:false });
  }

  const token = process.env.META_CAPI_TOKEN;
  if(!token){
    return res.status(503).json({ ok:false, error:'META_CAPI_TOKEN sozlanmagan' });
  }

  /* Faqat o‘z saytimizdan kelgan so‘rov */
  const host = first(req.headers['x-forwarded-host'] || req.headers.host).toLowerCase();
  const from = hostOf(req.headers.origin || req.headers.referer || '');
  if(!host || from !== host){
    return res.status(403).json({ ok:false });
  }

  const b = readBody(req);
  if(!b) return res.status(400).json({ ok:false });

  const name = String(b.event_name || '');
  const id = String(b.event_id || '');
  if(!EVENTS.has(name) || !/^[A-Za-z0-9_.-]{8,80}$/.test(id)){
    return res.status(400).json({ ok:false });
  }

  /* Foydalanuvchi ma’lumoti: telefon, ism va h.k. brauzerda SHA-256 bilan
     shifrlanib keladi — bu yerda faqat to‘g‘ri ko‘rinishdagilar qoladi */
  const ud = {};
  const ip = first(req.headers['x-forwarded-for']) || first(req.headers['x-real-ip']) ||
    (req.socket && req.socket.remoteAddress) || '';
  if(ip) ud.client_ip_address = ip;
  const ua = String(req.headers['user-agent'] || '').slice(0, 500);
  if(ua) ud.client_user_agent = ua;

  const u = b.user && typeof b.user === 'object' ? b.user : {};
  ['ph', 'fn', 'country', 'external_id'].forEach(function(k){
    if(typeof u[k] === 'string' && HASH.test(u[k])) ud[k] = [u[k]];
  });
  if(typeof b.fbp === 'string' && /^fb\.\d\.\d{10,16}\.\d{1,25}$/.test(b.fbp)) ud.fbp = b.fbp;
  if(typeof b.fbc === 'string' && /^fb\.\d\.\d{10,16}\.[A-Za-z0-9_-]{10,500}$/.test(b.fbc)) ud.fbc = b.fbc;

  const event = {
    event_name:name,
    event_time:Math.floor(Date.now() / 1000),
    event_id:id,
    action_source:'website',
    user_data:ud
  };

  const url = String(b.event_source_url || '').slice(0, 1000);
  if(url && hostOf(url) === host) event.event_source_url = url;

  const cd = cleanCustom(b.custom_data);
  if(Object.keys(cd).length) event.custom_data = cd;

  const payload = { data:[event], access_token:token };
  if(typeof b.test_event_code === 'string' && /^[A-Za-z0-9_-]{3,40}$/.test(b.test_event_code)){
    payload.test_event_code = b.test_event_code;
  }

  try{
    const r = await fetch('https://graph.facebook.com/' + API_VERSION + '/' + encodeURIComponent(PIXEL_ID) + '/events', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify(payload)
    });
    const j = await r.json().catch(function(){ return {}; });
    if(!r.ok){
      console.error('CAPI xato:', r.status, j && j.error && j.error.message);
      return res.status(502).json({ ok:false });
    }
    return res.status(200).json({ ok:true, received:j.events_received || 0 });
  }catch(e){
    console.error('CAPI ulanmadi:', e && e.message);
    return res.status(502).json({ ok:false });
  }
};
