// Twitch-extensie (paneel + overlay) met Bits in Extensions.
//  - Het paneel haalt het menu op bij GET /ext/menu (met de JWT van Twitch).
//  - Na betaling stuurt het paneel de betaalbevestiging naar POST /ext/transaction.
//  - Twitch stuurt daarnaast een EventSub-melding (extension.bits_transaction.create) naar /eventsub.
//  Beide wegen gebruiken hetzelfde transactienummer, dus een betaling wordt maar één keer uitgevoerd.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const engine = require('./engine');
const { ACTIONS, BY_ID } = require('./actions');

const S = () => db.getSettings();
const extConfigured = () => !!(S().extClientId && S().extSecret);

// ---------- JWT (HS256) van Twitch controleren ----------
function verifyJwt(token, base64Secret) {
  if (!token || !base64Secret) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  let header;
  try { header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return null; }
  if (header.alg !== 'HS256') return null;
  const expected = crypto.createHmac('sha256', Buffer.from(base64Secret, 'base64')).update(`${parts[0]}.${parts[1]}`).digest();
  const given = Buffer.from(parts[2], 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
  if (payload.exp && payload.exp * 1000 < Date.now()) return null;
  return payload;
}

// JWT ondertekenen (alleen gebruikt in tests om Twitch na te bootsen).
function signJwt(payload, base64Secret) {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', Buffer.from(base64Secret, 'base64')).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

// Acties die via de extensie gekocht kunnen worden: aan + bits aangevinkt.
function extActions(user) {
  const cfg = engine.configOf(user);
  return ACTIONS.filter(a => a.id !== 'message' && cfg.actions[a.id]?.enabled && cfg.actions[a.id].useBits && cfg.actions[a.id].bits > 0)
    .map(a => ({ sku: a.id, label: a.label, desc: a.desc, bits: cfg.actions[a.id].bits }));
}

// Betaling verwerken (vanuit het paneel of vanuit EventSub).
function handlePurchase({ channelId, transactionId, sku, bits, viewer, via }) {
  if (!transactionId || db.seenEvent(`tx:${transactionId}`)) return { ok: true, duplicate: true };
  const user = db.getUser(String(channelId));
  if (!user) return { ok: false, error: 'Kanaal onbekend' };
  const action = BY_ID[sku];
  const cfg = engine.configOf(user);
  if (!action || !cfg.actions[sku]?.enabled) {
    engine.log(user.id, { kind: 'ignored', viewer, source: 'bits', amount: bits, msg: `Extensie: actie "${sku}" staat uit` });
    return { ok: false, error: 'Actie staat uit' };
  }
  engine.enqueue(user, { actionId: sku, viewer: viewer || 'Kijker', source: 'bits', amount: bits, text: `via extensie (${via})` });
  return { ok: true };
}

// ---------- Twitch-API met de sleutels van de extensie ----------
let appToken = null;
async function extAppToken() {
  if (appToken && appToken.clientId === S().extClientId && appToken.expiresAt > Date.now() + 60_000) return appToken.token;
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: S().extClientId, client_secret: S().extApiSecret || '', grant_type: 'client_credentials' }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Extensie-token: ${data.message || res.status}`);
  appToken = { token: data.access_token, clientId: S().extClientId, expiresAt: Date.now() + data.expires_in * 1000 };
  return appToken.token;
}
const resetExtToken = () => { appToken = null; };

async function extHelix(method, url, body) {
  const res = await fetch(`https://api.twitch.tv/helix${url}`, {
    method,
    headers: { 'Client-Id': S().extClientId, Authorization: `Bearer ${await extAppToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) { const e = new Error(`${method} ${url} → ${res.status}: ${data?.message || text}`); e.status = res.status; throw e; }
  return data;
}

// Bits-producten van de extensie gelijkzetten met de prijzen op het dashboard.
async function syncProducts(user) {
  const errors = [];
  const inDevelopment = S().extInDevelopment !== false;
  for (const a of extActions(user)) {
    try {
      await extHelix('PUT', '/bits/extensions', {
        sku: a.sku, cost: { amount: a.bits, type: 'bits' }, display_name: a.label.slice(0, 255),
        in_development: inDevelopment, is_broadcast: false,
      });
    } catch (e) { errors.push(`${a.label}: ${e.message}`); }
  }
  return errors;
}

async function subscribeTransactions(base) {
  try {
    await extHelix('POST', '/eventsub/subscriptions', {
      type: 'extension.bits_transaction.create', version: '1',
      condition: { extension_client_id: S().extClientId },
      transport: { method: 'webhook', callback: `${base}/eventsub`, secret: S().eventsubSecret },
    });
    return { ok: true };
  } catch (e) {
    return e.status === 409 ? { ok: true, existed: true } : { ok: false, error: e.message };
  }
}

// ---------- Zip met de extensie-bestanden (zonder externe libraries) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function makeZip(files) { // files: [{ name, data: Buffer }]
  const locals = []; const centrals = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'); const crc = crc32(f.data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8); local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18); local.writeUInt32LE(f.data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, name, f.data);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10); central.writeUInt32LE(0, 12); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(f.data.length, 20); central.writeUInt32LE(f.data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + f.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const EXT_DIR = path.join(__dirname, '..', 'extension');
function buildZip(base) {
  const files = fs.readdirSync(EXT_DIR).filter(f => !f.startsWith('.')).sort().map(name => {
    let data = fs.readFileSync(path.join(EXT_DIR, name));
    if (/\.(html|js)$/.test(name)) data = Buffer.from(data.toString('utf8').replaceAll('__EBS_URL__', base), 'utf8');
    return { name, data };
  });
  return makeZip(files);
}

// ---------- Routes ----------
function cors(req, res, next) {
  const origin = req.get('origin') || '';
  if (/^https:\/\/[a-z0-9]+\.ext-twitch\.tv$/.test(origin) || origin === 'https://localhost.rig.twitch.tv:8080') {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

function requireExtAuth(req, res, next) {
  if (!extConfigured()) return res.status(503).json({ error: 'Extensie is nog niet ingesteld' });
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const claims = verifyJwt(token, S().extSecret);
  if (!claims || !claims.channel_id) return res.status(401).json({ error: 'Ongeldige Twitch-token' });
  req.ext = claims;
  next();
}

function mount(app, express) {
  app.use('/ext', cors);

  app.get('/ext/menu', requireExtAuth, (req, res) => {
    const user = db.getUser(String(req.ext.channel_id));
    if (!user) return res.json({ linked: false, actions: [] });
    const st = engine.publicStatus(user.id);
    res.json({ linked: true, gameActive: st.gameActive && st.companionConnected, actions: extActions(user) });
  });

  app.post('/ext/transaction', requireExtAuth, express.json({ limit: '20kb' }), (req, res) => {
    const receipt = verifyJwt(req.body?.receipt, S().extSecret);
    if (!receipt || receipt.topic !== 'bits_transaction_receipt' || !receipt.data?.transactionId) {
      return res.status(400).json({ error: 'Ongeldige betaalbevestiging' });
    }
    const d = receipt.data;
    const viewer = String(req.body?.displayName || 'Kijker').slice(0, 40);
    const r = handlePurchase({
      channelId: req.ext.channel_id, transactionId: d.transactionId, sku: d.product?.sku,
      bits: Number(d.product?.cost?.amount ?? d.product?.Cost?.amount) || 0, viewer, via: 'paneel',
    });
    res.status(r.ok ? 200 : 400).json(r);
  });
}

// Vanuit de EventSub-webhook.
function onEventSubTransaction(ev) {
  return handlePurchase({
    channelId: ev.broadcaster_user_id, transactionId: ev.id, sku: ev.product?.sku,
    bits: Number(ev.product?.bits) || 0, viewer: ev.user_name, via: 'Twitch',
  });
}

module.exports = { mount, verifyJwt, signJwt, extActions, syncProducts, subscribeTransactions, buildZip, makeZip, onEventSubTransaction, extConfigured, resetExtToken };
