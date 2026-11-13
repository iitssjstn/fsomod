const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const db = require('./db');
const twitch = require('./twitch');
const engine = require('./engine');
const { ACTIONS, mergeConfig } = require('./actions');

const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET;
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || path.join(__dirname, '..', 'downloads');

for (const k of ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'BASE_URL', 'SESSION_SECRET', 'EVENTSUB_SECRET']) {
  if (!process.env[k]) console.warn(`[waarschuwing] ${k} is niet ingesteld (zie .env.example)`);
}

db.load();
const app = express();
app.set('trust proxy', 1);

// ---------- Sessies (ondertekende cookie) ----------
const sign = v => crypto.createHmac('sha256', SESSION_SECRET || 'dev').update(v).digest('base64url');
function setSession(res, userId) {
  const v = `${userId}.${sign(userId)}`;
  res.setHeader('Set-Cookie', `sid=${v}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${twitch.BASE_URL.startsWith('https') ? '; Secure' : ''}`);
}
function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
function currentUser(req) {
  const sid = getCookie(req, 'sid');
  if (!sid) return null;
  const [id, sig] = sid.split('.');
  if (!id || !sig || sign(id) !== sig) return null;
  return db.getUser(id);
}
function requireUser(req, res, next) {
  req.user = currentUser(req);
  if (!req.user) return res.status(401).json({ error: 'Niet ingelogd' });
  next();
}

const newKey = () => crypto.randomBytes(18).toString('base64url');

// ---------- EventSub webhook (heeft de ruwe body nodig voor de handtekening) ----------
app.post('/eventsub', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  const id = req.get('Twitch-Eventsub-Message-Id');
  const ts = req.get('Twitch-Eventsub-Message-Timestamp');
  const sig = req.get('Twitch-Eventsub-Message-Signature') || '';
  const type = req.get('Twitch-Eventsub-Message-Type');
  const body = req.body instanceof Buffer ? req.body : Buffer.from('');

  const expected = 'sha256=' + crypto.createHmac('sha256', twitch.EVENTSUB_SECRET || '').update(id + ts).update(body).digest('hex');
  const valid = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!valid) return res.sendStatus(403);
  if (Math.abs(Date.now() - Date.parse(ts)) > 10 * 60_000) return res.sendStatus(403);

  const msg = JSON.parse(body.toString('utf8'));
  if (type === 'webhook_callback_verification') return res.type('text/plain').send(msg.challenge);
  res.sendStatus(204);
  if (db.seenEvent(id)) return;

  const subType = msg.subscription?.type;
  const broadcasterId = msg.subscription?.condition?.broadcaster_user_id;
  const user = db.getUser(broadcasterId);
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

// ---------- Inloggen met Twitch ----------
app.get('/auth/login', (req, res) => {
  const state = newKey();
  res.setHeader('Set-Cookie', `oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`);
  res.redirect(twitch.authorizeUrl(state));
});

app.get('/auth/callback', async (req, res) => {
  try {
    if (!req.query.code || req.query.state !== getCookie(req, 'oauth_state')) return res.status(400).send('Ongeldige login, probeer opnieuw.');
    const tok = await twitch.exchangeCode(req.query.code);
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
    const subs = await twitch.subscribeEvents(user.id);
    const failed = subs.filter(s => !s.ok);
    if (failed.length) engine.log(user.id, { kind: 'system', msg: 'EventSub-fout: ' + failed.map(f => f.error).join('; ') });
    if (!existing && user.broadcasterType) {
      const errors = await engine.syncRewards(user);
      if (errors.length) engine.log(user.id, { kind: 'system', msg: 'Beloningen: ' + errors.join('; ') });
    }
    setSession(res, user.id);
    res.redirect('/');
  } catch (e) {
    console.error('[auth]', e);
    res.status(500).send('Inloggen mislukt: ' + e.message);
  }
});

app.post('/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// ---------- Dashboard API ----------
app.get('/api/actions', (req, res) => res.json(ACTIONS));

app.get('/api/me', requireUser, (req, res) => {
  const u = req.user;
  res.json({
    id: u.id, login: u.login, displayName: u.displayName, avatar: u.avatar,
    broadcasterType: u.broadcasterType, pairKey: u.pairKey,
    serverUrl: twitch.BASE_URL,
    overlayUrl: `${twitch.BASE_URL}/overlay.html?key=${u.overlayKey}`,
    config: engine.configOf(u),
    rewards: u.rewards || {},
    status: engine.publicStatus(u.id),
    log: engine.ch(u.id).log.slice(0, 50),
  });
});

app.post('/api/config', requireUser, async (req, res) => {
  const incoming = req.body || {};
  const cfg = engine.configOf(req.user);
  for (const a of ACTIONS) {
    const v = incoming.actions?.[a.id];
    if (!v) continue;
    cfg.actions[a.id] = {
      enabled: !!v.enabled,
      bits: clampInt(v.bits, 0, 1_000_000),
      points: clampInt(v.points, 0, 10_000_000),
      cooldown: clampInt(v.cooldown, 0, 604_800),
      param: v.param === null || v.param === undefined || v.param === '' ? (a.param ?? null) : Number(v.param),
    };
  }
  if (['highest', 'random', 'keyword_only'].includes(incoming.bitsMode)) cfg.bitsMode = incoming.bitsMode;
  if (incoming.gapSeconds !== undefined) cfg.gapSeconds = clampInt(incoming.gapSeconds, 0, 600);
  if (incoming.pauseWhenOffline !== undefined) cfg.pauseWhenOffline = !!incoming.pauseWhenOffline;
  const user = db.upsertUser(req.user.id, { config: cfg });

  let errors = [];
  if (user.broadcasterType) errors = await engine.syncRewards(user);
  else errors = ['Channel points zijn alleen beschikbaar voor Twitch Affiliates/Partners. Bits werken wel.'];
  res.json({ ok: true, errors, rewards: db.getUser(user.id).rewards || {} });
});

app.post('/api/pairkey', requireUser, (req, res) => {
  const user = db.upsertUser(req.user.id, { pairKey: newKey() });
  const c = engine.ch(user.id);
  if (c.ws) c.ws.close(4001, 'Koppelcode vernieuwd');
  res.json({ pairKey: user.pairKey });
});

app.post('/api/test/:action', requireUser, (req, res) => {
  const cmd = engine.enqueue(req.user, { actionId: req.params.action, viewer: `${req.user.displayName} (test)`, source: 'test', text: 'Testbericht vanaf het dashboard' });
  if (!cmd) return res.status(400).json({ error: 'Onbekende of uitgeschakelde actie' });
  res.json({ ok: true, status: engine.publicStatus(req.user.id) });
});

app.post('/api/resubscribe', requireUser, async (req, res) => {
  res.json({ results: await twitch.subscribeEvents(req.user.id) });
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

server.listen(PORT, () => console.log(`FS25 Twitch Sabotage server draait op poort ${PORT} (${twitch.BASE_URL})`));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { db.flush(); process.exit(0); });
