const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const db = require('./db');
const twitch = require('./twitch');
const engine = require('./engine');
const { ACTIONS, mergeConfig } = require('./actions');
const { FtpLink, testConnection, installMod } = require('./ftplink');
const extension = require('./extension');
const legal = require('./legal');

// Alleen interne paden/poort (staan vast in de Docker-image). Alle echte instellingen gaan via /admin.
const PORT = Number(process.env.PORT || 3000);
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || path.join(__dirname, '..', 'downloads');

db.load();
const app = express();
app.set('trust proxy', true); // achter Nginx Proxy Manager: X-Forwarded-Proto/Host vertrouwen
app.disable('x-powered-by');

// Eenmalige installatiecode: alleen zichtbaar in de containerlogs (docker logs).
let setupCode = null;
function ensureSetupCode() {
  if (db.getSettings().adminHash) { setupCode = null; return; }
  if (!setupCode) setupCode = crypto.randomBytes(4).toString('hex').toUpperCase();
  console.log('\n==================================================');
  console.log(' Nog niet ingesteld. Open https://<jouw-domein>/admin');
  console.log(` Installatiecode: ${setupCode}`);
  console.log('==================================================\n');
}
ensureSetupCode();

// Publiek adres: optioneel vastgezet in /admin, anders afgeleid van het verzoek (domein uit NPM).
function detectedBase(req) {
  const host = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  return `${req.protocol}://${host}`;
}
function baseUrl(req) {
  const fixed = (db.getSettings().baseUrl || '').replace(/\/$/, '');
  return fixed || detectedBase(req);
}

// ---------- Cookies & sessies ----------
const sign = v => crypto.createHmac('sha256', db.getSettings().sessionSecret).update(v).digest('base64url');
function cookie(res, name, value, maxAge, req) {
  const secure = req.secure ? '; Secure' : '';
  res.append('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}
function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function currentUser(req) {
  const sid = getCookie(req, 'sid');
  if (!sid) return null;
  const [id, sig] = sid.split('.');
  if (!id || !sig || !safeEqual(sign(id), sig)) return null;
  return db.getUser(id);
}
function requireUser(req, res, next) {
  req.user = currentUser(req);
  if (!req.user) return res.status(401).json({ error: 'Niet ingelogd' });
  next();
}

// Beheerder-sessie: ongeldig zodra het wachtwoord verandert (hash zit in de handtekening).
function adminToken(exp) { return `${exp}.${sign(`admin:${exp}:${db.getSettings().adminHash}`)}`; }
function isAdmin(req) {
  const v = getCookie(req, 'adm');
  if (!v || !db.getSettings().adminHash) return false;
  const [exp] = v.split('.');
  return Number(exp) > Date.now() && safeEqual(adminToken(exp), v);
}
function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Niet ingelogd als beheerder' });
  next();
}
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  return safeEqual(crypto.scryptSync(String(pw), salt, 64).toString('hex'), hash);
}

// Simpele rem op raden van wachtwoord/installatiecode.
const attempts = new Map();
function tooMany(req) {
  const k = req.ip; const now = Date.now();
  const a = (attempts.get(k) || []).filter(t => now - t < 15 * 60_000);
  attempts.set(k, a);
  return a.length >= 10;
}
const failed = req => attempts.get(req.ip)?.push(Date.now()) ?? attempts.set(req.ip, [Date.now()]);

const newKey = () => crypto.randomBytes(18).toString('base64url');
// Koppelcode voor het hulpprogramma: bevat ook het serveradres, zodat de .exe niets ingebouwd hoeft te hebben.
const pairCode = (req, user) => 'FS25-' + Buffer.from(`${baseUrl(req)}|${user.pairKey}`).toString('base64url');

// ---------- EventSub webhook (heeft de ruwe body nodig voor de handtekening) ----------
app.post('/eventsub', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  const id = req.get('Twitch-Eventsub-Message-Id');
  const ts = req.get('Twitch-Eventsub-Message-Timestamp');
  const sig = req.get('Twitch-Eventsub-Message-Signature') || '';
  const type = req.get('Twitch-Eventsub-Message-Type');
  const body = req.body instanceof Buffer ? req.body : Buffer.from('');
  if (!id || !ts) return res.sendStatus(403);

  const expected = 'sha256=' + crypto.createHmac('sha256', db.getSettings().eventsubSecret).update(id + ts).update(body).digest('hex');
  if (!safeEqual(sig, expected)) return res.sendStatus(403);
  if (Math.abs(Date.now() - Date.parse(ts)) > 10 * 60_000) return res.sendStatus(403);

  const msg = JSON.parse(body.toString('utf8'));
  if (type === 'webhook_callback_verification') return res.type('text/plain').send(msg.challenge);
  res.sendStatus(204);
  if (db.seenEvent(id)) return;

  const subType = msg.subscription?.type;
  if (subType === 'extension.bits_transaction.create') {
    if (type === 'notification' && msg.subscription?.condition?.extension_client_id === db.getSettings().extClientId) extension.onEventSubTransaction(msg.event);
    return;
  }
  const user = db.getUser(msg.subscription?.condition?.broadcaster_user_id);
  if (!user) return;

  if (type === 'revocation') {
    engine.log(user.id, { kind: 'system', msg: `Twitch-koppeling ingetrokken (${subType}). Log opnieuw in.` });
    return;
  }
  if (type === 'notification') {
    if (subType === 'channel.cheer') engine.onCheer(user, msg.event);
    if (subType === 'channel.channel_points_custom_reward_redemption.add') engine.onRedemption(user, msg.event);
  }
});

app.use(express.json({ limit: '200kb' }));
extension.mount(app, express);

// Openbare status: alleen of de site klaar is, nooit instellingen.
app.get('/api/status', (req, res) => res.json({ configured: db.isConfigured() }));

// ---------- Beheer (/admin) ----------
app.get('/api/admin/state', (req, res) => {
  const s = db.getSettings();
  const base = baseUrl(req);
  const out = { setupDone: !!s.adminHash, loggedIn: isAdmin(req), detectedBaseUrl: detectedBase(req), redirectUrl: twitch.redirectUri(base) };
  if (out.loggedIn) {
    Object.assign(out, {
      clientId: s.clientId || '',
      clientSecretSet: !!s.clientSecret,          // het secret zelf gaat nooit naar de browser
      baseUrl: s.baseUrl || '',
      contactEmail: s.contactEmail || '',
      extClientId: s.extClientId || '',
      extSecretSet: !!s.extSecret,
      extApiSecretSet: !!s.extApiSecret,
      extInDevelopment: s.extInDevelopment !== false,
      ebsDomain: new URL(base).host,
      streamers: db.allUsers().map(u => ({ login: u.login, displayName: u.displayName, connected: !!engine.ch(u.id).ws, gameActive: engine.ch(u.id).gameActive })),
    });
  }
  res.json(out);
});

app.post('/api/admin/setup', (req, res) => {
  if (db.getSettings().adminHash) return res.status(409).json({ error: 'Al ingesteld' });
  if (tooMany(req)) return res.status(429).json({ error: 'Te veel pogingen, wacht 15 minuten' });
  const { code, password } = req.body || {};
  if (!setupCode || !safeEqual(String(code || '').trim().toUpperCase(), setupCode)) {
    failed(req);
    return res.status(403).json({ error: 'Onjuiste installatiecode (zie: docker logs fs25-sabotage)' });
  }
  if (String(password || '').length < 10) return res.status(400).json({ error: 'Wachtwoord moet minstens 10 tekens zijn' });
  db.updateSettings({ adminHash: hashPassword(password) });
  setupCode = null;
  const exp = Date.now() + 12 * 3600_000;
  cookie(res, 'adm', adminToken(exp), 12 * 3600, req);
  res.json({ ok: true });
});

app.post('/api/admin/login', (req, res) => {
  if (tooMany(req)) return res.status(429).json({ error: 'Te veel pogingen, wacht 15 minuten' });
  if (!checkPassword(req.body?.password, db.getSettings().adminHash)) {
    failed(req);
    return res.status(403).json({ error: 'Onjuist wachtwoord' });
  }
  const exp = Date.now() + 12 * 3600_000;
  cookie(res, 'adm', adminToken(exp), 12 * 3600, req);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => { cookie(res, 'adm', '', 0, req); res.json({ ok: true }); });

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const b = req.body || {};
  const fields = {};
  if (typeof b.clientId === 'string') fields.clientId = b.clientId.trim();
  if (typeof b.clientSecret === 'string' && b.clientSecret.trim()) fields.clientSecret = b.clientSecret.trim(); // leeg = ongewijzigd
  if (typeof b.baseUrl === 'string') {
    const u = b.baseUrl.trim().replace(/\/$/, '');
    if (u && !/^https?:\/\/[^\s/]+$/.test(u)) return res.status(400).json({ error: 'Basisadres moet zoiets zijn als https://sabotage.mijndomein.nl' });
    fields.baseUrl = u;
  }
  if (typeof b.contactEmail === 'string') {
    const v = b.contactEmail.trim();
    if (v && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(v)) return res.status(400).json({ error: 'Dat is geen geldig e-mailadres.' });
    fields.contactEmail = v;
  }
  if (typeof b.extClientId === 'string') fields.extClientId = b.extClientId.trim();
  if (typeof b.extSecret === 'string' && b.extSecret.trim()) {
    const v = b.extSecret.trim();
    if (!/^[A-Za-z0-9+/]+=*$/.test(v)) return res.status(400).json({ error: 'De Extension Secret moet de base64-code uit de Twitch-console zijn.' });
    fields.extSecret = v;
  }
  if (typeof b.extApiSecret === 'string' && b.extApiSecret.trim()) fields.extApiSecret = b.extApiSecret.trim();
  if (typeof b.extInDevelopment === 'boolean') fields.extInDevelopment = b.extInDevelopment;
  if (typeof b.newPassword === 'string' && b.newPassword) {
    if (b.newPassword.length < 10) return res.status(400).json({ error: 'Wachtwoord moet minstens 10 tekens zijn' });
    fields.adminHash = hashPassword(b.newPassword);
  }
  db.updateSettings(fields);
  twitch.resetAppToken();
  extension.resetExtToken();
  if (fields.adminHash) cookie(res, 'adm', adminToken(Date.now() + 12 * 3600_000), 12 * 3600, req);
  res.json({ ok: true });
});

// ---------- Twitch-extensie ----------
app.get('/api/admin/extension.zip', requireAdmin, (req, res) => {
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', 'attachment; filename="fs25-sabotage-extensie.zip"');
  res.send(extension.buildZip(baseUrl(req)));
});

app.post('/api/admin/extension/connect', requireAdmin, async (req, res) => {
  if (!extension.extConfigured() || !db.getSettings().extApiSecret) return res.status(400).json({ error: 'Vul eerst Client ID, Extension Secret en API Client Secret van de extensie in.' });
  const sub = await extension.subscribeTransactions(baseUrl(req));
  const products = [];
  for (const u of db.allUsers()) products.push({ login: u.login, errors: await extension.syncProducts(u) });
  res.json({ subscription: sub, products });
});

// Na wijzigen van domein of Twitch-app: alle EventSub-koppelingen opnieuw aanmaken.
app.post('/api/admin/resubscribe-all', requireAdmin, async (req, res) => {
  const base = baseUrl(req);
  const results = [];
  for (const u of db.allUsers()) {
    try {
      await twitch.unsubscribeAll(u.id);
      const r = await twitch.subscribeEvents(u.id, base);
      results.push({ login: u.login, ok: r.every(x => x.ok), errors: r.filter(x => !x.ok).map(x => x.error) });
    } catch (e) { results.push({ login: u.login, ok: false, errors: [e.message] }); }
  }
  res.json({ results });
});

// ---------- Inloggen met Twitch (streamers) ----------
app.get('/auth/login', (req, res) => {
  if (!db.isConfigured()) return res.redirect('/');
  const state = newKey();
  cookie(res, 'oauth_state', state, 600, req);
  res.redirect(twitch.authorizeUrl(state, baseUrl(req)));
});

app.get('/auth/callback', async (req, res) => {
  try {
    if (!req.query.code || req.query.state !== getCookie(req, 'oauth_state')) return res.status(400).send('Ongeldige login, probeer opnieuw.');
    const base = baseUrl(req);
    const tok = await twitch.exchangeCode(req.query.code, base);
    const info = await twitch.getUserInfo(tok.access_token);
    const existing = db.getUser(info.id);
    const user = db.upsertUser(info.id, {
      login: info.login,
      displayName: info.display_name,
      avatar: info.profile_image_url,
      broadcasterType: info.broadcaster_type, // '', 'affiliate', 'partner'
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      tokenExpiresAt: Date.now() + tok.expires_in * 1000,
      pairKey: existing?.pairKey || newKey(),
      overlayKey: existing?.overlayKey || newKey(),
      cmdEpoch: existing?.cmdEpoch || crypto.randomBytes(4).toString('hex'),
      config: mergeConfig(existing?.config),
      createdAt: existing?.createdAt || Date.now(),
    });
    const subs = await twitch.subscribeEvents(user.id, base);
    const failedSubs = subs.filter(s => !s.ok);
    if (failedSubs.length) engine.log(user.id, { kind: 'system', msg: 'EventSub-fout: ' + failedSubs.map(f => f.error).join('; ') });
    if (!existing && user.broadcasterType) {
      const errors = await engine.syncRewards(user);
      if (errors.length) engine.log(user.id, { kind: 'system', msg: 'Beloningen: ' + errors.join('; ') });
    }
    cookie(res, 'sid', `${user.id}.${sign(user.id)}`, 60 * 60 * 24 * 30, req);
    res.redirect('/');
  } catch (e) {
    console.error('[auth]', e);
    res.status(500).send('Inloggen mislukt. Probeer het later opnieuw.');
  }
});

app.post('/auth/logout', (req, res) => { cookie(res, 'sid', '', 0, req); res.json({ ok: true }); });

// Account verwijderen: Twitch-koppelingen en beloningen opruimen, gegevens wissen.
app.post('/api/account/delete', requireUser, async (req, res) => {
  const user = req.user;
  const problems = [];
  try { await twitch.unsubscribeAll(user.id); } catch (e) { problems.push(e.message); }
  for (const rewardId of Object.values(user.rewards || {})) {
    await twitch.deleteReward(user, rewardId).catch(e => { if (e.status !== 404) problems.push(e.message); });
  }
  const link = links.get(user.id);
  if (link) { links.delete(user.id); link.close(); }
  const c = engine.ch(user.id);
  if (c.ws) { try { c.ws.close(4001, 'Account verwijderd'); } catch {} }
  c.queue.length = 0;
  db.deleteUser(user.id);
  cookie(res, 'sid', '', 0, req);
  if (problems.length) console.warn('[account] opruimen bij Twitch deels mislukt:', problems.join('; '));
  res.json({ ok: true });
});

// ---------- Dashboard API (streamers) ----------
app.get('/api/actions', (req, res) => res.json(ACTIONS));

app.get('/api/me', requireUser, (req, res) => {
  const u = req.user;
  res.json({
    id: u.id, login: u.login, displayName: u.displayName, avatar: u.avatar,
    broadcasterType: u.broadcasterType,
    pairCode: pairCode(req, u),
    overlayUrl: `${baseUrl(req)}/overlay.html?key=${u.overlayKey}`,
    config: engine.configOf(u),
    rewards: u.rewards || {},
    status: engine.publicStatus(u.id),
    log: engine.ch(u.id).log.slice(0, 50),
    link: publicLink(u),
  });
});

// ---------- Verbinding met de game: Windows-programma of FTP (gehuurde server) ----------
const links = new Map(); // userId -> FtpLink

function publicLink(u) {
  const f = u.link?.ftp || {};
  // Het FTP-wachtwoord gaat nooit naar de browser.
  return { mode: u.link?.mode || 'app', ftp: { host: f.host || '', port: f.port || 21, user: f.user || '', path: f.path || '', passwordSet: !!f.password } };
}
const ftpComplete = f => !!(f && f.host && f.user && f.password);

function startLink(userId) {
  const old = links.get(userId);
  if (old) { links.delete(userId); old.close(); }
  const user = db.getUser(userId);
  if (!user || user.link?.mode !== 'ftp' || !ftpComplete(user.link.ftp)) return;
  const link = new FtpLink(user.link.ftp, msg => engine.log(userId, { kind: 'system', msg }));
  link.on('close', () => { if (links.get(userId) === link) links.delete(userId); });
  links.set(userId, link);
  engine.attachCompanion(user, link, 'Gameserver (FTP)');
}

app.post('/api/link', requireUser, (req, res) => {
  const b = req.body || {};
  const cur = req.user.link || {};
  const ftp = { ...(cur.ftp || {}) };
  if (typeof b.host === 'string') ftp.host = b.host.trim().replace(/^s?ftps?:\/\//i, '').replace(/\/.*$/, '');
  if (b.port !== undefined) ftp.port = clampInt(b.port, 1, 65535);
  if (typeof b.user === 'string') ftp.user = b.user.trim();
  if (typeof b.password === 'string' && b.password) ftp.password = b.password; // leeg = ongewijzigd
  if (typeof b.path === 'string') ftp.path = b.path.trim();
  const mode = b.mode === 'ftp' ? 'ftp' : 'app';
  const user = db.upsertUser(req.user.id, { link: { mode, ftp } });
  startLink(user.id);
  res.json({ ok: true, link: publicLink(user) });
});

app.post('/api/link/test', requireUser, async (req, res) => {
  const f = req.user.link?.ftp;
  if (!ftpComplete(f)) return res.status(400).json({ error: 'Vul eerst server, gebruikersnaam en wachtwoord in.' });
  try { res.json(await testConnection(f)); }
  catch (e) { res.status(400).json({ error: `Verbinding mislukt: ${e.message}` }); }
});

// Singleplayer: het Windows-programma downloadt de mod en zet hem in de mods-map.
app.post('/api/app/install-mod', requireUser, async (req, res) => {
  const r = await engine.requestModInstall(req.user.id);
  res.status(r.ok ? 200 : 400).json(r.ok ? r : { error: r.message, needsAppUpdate: !!r.needsAppUpdate });
});

app.post('/api/link/install-mod', requireUser, async (req, res) => {
  const f = req.user.link?.ftp;
  if (!ftpComplete(f)) return res.status(400).json({ error: 'Vul eerst de FTP-gegevens in.' });
  const zip = path.join(DOWNLOADS_DIR, 'FS25_TwitchSabotage.zip');
  if (!require('fs').existsSync(zip)) return res.status(500).json({ error: 'Mod-zip ontbreekt op de website.' });
  try { res.json(await installMod(f, zip)); }
  catch (e) { res.status(400).json({ error: `Uploaden mislukt: ${e.message}` }); }
});

app.post('/api/config', requireUser, async (req, res) => {
  const incoming = req.body || {};
  const cfg = engine.configOf(req.user);
  for (const a of ACTIONS) {
    const v = incoming.actions?.[a.id];
    if (!v) continue;
    cfg.actions[a.id] = {
      enabled: !!v.enabled,
      useBits: v.useBits === undefined ? cfg.actions[a.id].useBits : !!v.useBits,
      usePoints: v.usePoints === undefined ? cfg.actions[a.id].usePoints : !!v.usePoints,
      bits: clampInt(v.bits, 1, 1_000_000),
      points: clampInt(v.points, 1, 10_000_000),
      cooldown: clampInt(v.cooldown, 0, 604_800),
      param: v.param === null || v.param === undefined || v.param === '' ? (a.param ?? null) : Number(v.param),
    };
  }
  if (['highest', 'random', 'keyword_only'].includes(incoming.bitsMode)) cfg.bitsMode = incoming.bitsMode;
  if (incoming.gapSeconds !== undefined) cfg.gapSeconds = clampInt(incoming.gapSeconds, 0, 600);
  if (incoming.pauseWhenOffline !== undefined) cfg.pauseWhenOffline = !!incoming.pauseWhenOffline;
  if (['streamer', 'random', 'all'].includes(incoming.target)) cfg.target = incoming.target;
  if (typeof incoming.playerName === 'string') cfg.playerName = incoming.playerName.trim().slice(0, 64);
  if (incoming.extDelaySeconds !== undefined) cfg.extDelaySeconds = clampInt(incoming.extDelaySeconds, 0, 30);
  const user = db.upsertUser(req.user.id, { config: cfg });

  let errors = [];
  if (user.broadcasterType) errors = await engine.syncRewards(user);
  else errors = ['Channel points zijn alleen beschikbaar voor Twitch Affiliates/Partners. Bits werken wel.'];
  if (extension.extConfigured() && db.getSettings().extApiSecret) {
    errors.push(...(await extension.syncProducts(user)).map(e => `Extensie: ${e}`));
  }
  res.json({ ok: true, errors, rewards: db.getUser(user.id).rewards || {} });
});

app.post('/api/pairkey', requireUser, (req, res) => {
  const user = db.upsertUser(req.user.id, { pairKey: newKey() });
  const c = engine.ch(user.id);
  if (c.ws) c.ws.close(4001, 'Koppelcode vernieuwd');
  res.json({ pairCode: pairCode(req, user) });
});

app.post('/api/test/:action', requireUser, (req, res) => {
  const cmd = engine.enqueue(req.user, { actionId: req.params.action, viewer: `${req.user.displayName} (test)`, source: 'test', text: 'Testbericht vanaf het dashboard' });
  if (!cmd) return res.status(400).json({ error: 'Onbekende of uitgeschakelde actie' });
  res.json({ ok: true, id: cmd.id, action: cmd.action, param: cmd.param, status: engine.publicStatus(req.user.id) });
});

app.post('/api/resubscribe', requireUser, async (req, res) => {
  res.json({ results: await twitch.subscribeEvents(req.user.id, baseUrl(req)) });
});

app.post('/api/clear-queue', requireUser, (req, res) => {
  const c = engine.ch(req.user.id);
  const dropped = c.queue.splice(0);
  for (const cmd of dropped) {
    if (cmd.source === 'points') twitch.setRedemptionStatus(req.user, cmd.rewardId, cmd.redemptionId, 'CANCELED').catch(() => {});
  }
  engine.log(req.user.id, { kind: 'system', msg: `Wachtrij geleegd (${dropped.length})` });
  res.json({ ok: true });
});

// Live logboek voor het dashboard
app.get('/api/stream', requireUser, (req, res) => {
  sseHeaders(res);
  const c = engine.ch(req.user.id);
  c.dash.add(res);
  const t = setInterval(() => res.write(`event: status\ndata: ${JSON.stringify(engine.publicStatus(req.user.id))}\n\n`), 3000);
  req.on('close', () => { clearInterval(t); c.dash.delete(res); });
});

// OBS-overlay (geen login: beveiligd met een geheime sleutel in de URL)
app.get('/overlay/stream', (req, res) => {
  const user = db.findUserBy('overlayKey', String(req.query.key || ''));
  if (!user) return res.sendStatus(404);
  sseHeaders(res);
  const c = engine.ch(user.id);
  c.sse.add(res);
  const t = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => { clearInterval(t); c.sse.delete(res); });
});

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/privacy', (req, res) => res.type('html').send(legal.privacy()));
app.get('/terms', (req, res) => res.type('html').send(legal.terms()));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));
app.use('/downloads', express.static(DOWNLOADS_DIR));
app.use(express.static(path.join(__dirname, '..', 'public')));

function sseHeaders(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(': ok\n\n');
}
function clampInt(v, min, max) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

// ---------- WebSocket voor het hulpprogramma ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const key = new URL(req.url, 'http://x').searchParams.get('key');
  const user = key && db.findUserBy('pairKey', key);
  if (!user) {
    ws.send(JSON.stringify({ type: 'error', message: 'Ongeldige koppelcode. Kopieer de code opnieuw van de website.' }));
    return ws.close(4003, 'Ongeldige koppelcode');
  }
  if (user.link?.mode === 'ftp') {
    ws.send(JSON.stringify({ type: 'error', message: 'Dit kanaal gebruikt een gameserver via FTP. Zet op de website de verbinding op "Windows-programma" om dit programma te gebruiken.' }));
    return ws.close(4002, 'Kanaal gebruikt FTP');
  }
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  engine.attachCompanion(user, ws);
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000).unref();

server.listen(PORT, () => {
  console.log(`FS25 Twitch Sabotage server draait op poort ${PORT}`);
  for (const u of db.allUsers()) startLink(u.id);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { db.flush(); process.exit(0); });
