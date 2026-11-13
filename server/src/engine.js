// De "motor" van de server: wachtrij per streamer, keuze van acties,
// doorsturen naar het hulpprogramma en afhandelen van resultaten (punten terugbetalen).
const crypto = require('crypto');
const db = require('./db');
const twitch = require('./twitch');
const { ACTIONS, BY_ID, mergeConfig } = require('./actions');
const versions = require('./versions');

const QUEUE_TIMEOUT_MS = 10 * 60_000; // channel points langer dan 10 min in de wachtrij → terugbetalen
const RESULT_TIMEOUT_MS = 2 * 60_000; // geen antwoord van de game na 2 min → mislukt
const RANDOM_EXCLUDE = new Set(['random', 'message', 'money_gift', 'repair', 'refuel']);

const channels = new Map();

function ch(userId) {
  if (!channels.has(userId)) {
    channels.set(userId, {
      queue: [], pending: new Map(), ws: null, gameActive: false, modVersion: null,
      lastDispatch: 0, log: [], sse: new Set(), dash: new Set(), pauseTimer: null, pausedState: null,
    });
  }
  return channels.get(userId);
}

const configOf = user => mergeConfig(user.config);

// ---------- Keuze van de actie bij bits ----------
function pickForBits(cfg, bits, message = '') {
  const enabled = ACTIONS.filter(a => cfg.actions[a.id]?.enabled && cfg.actions[a.id].useBits && cfg.actions[a.id].bits > 0);
  const price = a => cfg.actions[a.id].bits;

  const words = (message.match(/!([\p{L}\d_]+)/gu) || []).map(w => w.slice(1).toLowerCase());
  for (const w of words) {
    const a = enabled.find(x => x.keyword.toLowerCase() === w || x.id === w);
    if (a && bits >= price(a)) return a;
  }
  if (cfg.bitsMode === 'keyword_only') return null;

  const affordable = enabled.filter(a => price(a) <= bits);
  if (!affordable.length) return null;
  if (cfg.bitsMode === 'random') return affordable[Math.floor(Math.random() * affordable.length)];
  const max = Math.max(...affordable.map(price));
  const top = affordable.filter(a => price(a) === max);
  return top[Math.floor(Math.random() * top.length)];
}

function resolveRandom(cfg) {
  const pool = ACTIONS.filter(a => !RANDOM_EXCLUDE.has(a.id) && cfg.actions[a.id]?.enabled);
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
}

// ---------- Logboek + live updates ----------
function log(userId, entry) {
  const c = ch(userId);
  const item = { time: Date.now(), ...entry };
  c.log.unshift(item);
  if (c.log.length > 100) c.log.length = 100;
  const payload = `data: ${JSON.stringify(item)}\n\n`;
  for (const res of c.sse) res.write(payload);
  for (const res of c.dash) res.write(payload);
}

function publicStatus(userId) {
  const c = ch(userId);
  return {
    companionConnected: !!c.ws, gameActive: c.gameActive, modVersion: c.modVersion,
    companionVersion: c.companionVersion, linkKind: c.linkKind,
    queueLength: c.queue.length, pending: c.pending.size,
    latest: versions.latest(),
    modOutdated: versions.isOutdated(c.modVersion, versions.latest().mod),
    appOutdated: c.linkKind === 'app' && versions.isOutdated(c.companionVersion, versions.latest().app),
  };
}

// ---------- Wachtrij ----------
function enqueue(user, { actionId, viewer, source, amount = 0, rewardId, redemptionId, text }) {
  const cfg = configOf(user);
  let action = BY_ID[actionId];
  if (!action) return null;
  const label = action.label;
  if (action.id === 'random') {
    action = resolveRandom(cfg);
    if (!action) return null;
  }
  const fresh = db.getUser(user.id);
  const id = (fresh.nextCmdId || 1);
  db.upsertUser(user.id, { nextCmdId: id + 1 });

  const cmd = {
    id, action: action.id, label: action.id === actionId ? action.label : `${label}: ${action.label}`,
    param: cfg.actions[action.id]?.param ?? action.param ?? null,
    viewer: viewer || 'Anoniem', source, amount, text: (text || '').slice(0, 200),
    target: cfg.target || 'streamer', player: (cfg.playerName || '').trim(),
    rewardId, redemptionId, queuedAt: Date.now(),
  };
  ch(user.id).queue.push(cmd);
  log(user.id, { kind: 'queued', id, viewer: cmd.viewer, label: cmd.label, source, amount });
  pump(user.id);
  return cmd;
}

function pump(userId) {
  const c = ch(userId);
  const user = db.getUser(userId);
  if (!user || !c.ws || !c.gameActive || !c.queue.length) return;
  const gap = (configOf(user).gapSeconds || 0) * 1000;
  const wait = c.lastDispatch + gap - Date.now();
  if (wait > 0) {
    clearTimeout(c.pumpTimer);
    c.pumpTimer = setTimeout(() => pump(userId), wait + 10);
    return;
  }
  const cmd = c.queue.shift();
  cmd.sentAt = Date.now();
  c.pending.set(cmd.id, cmd);
  c.lastDispatch = Date.now();
  sendCommand(c, user, cmd);
  if (c.queue.length) pump(userId);
}

function sendCommand(c, user, cmd) {
  c.ws.send(JSON.stringify({
    type: 'command',
    epoch: user.cmdEpoch,
    cmd: { id: cmd.id, action: cmd.action, param: cmd.param, viewer: cmd.viewer, source: cmd.source, amount: cmd.amount, text: cmd.text, label: cmd.label, target: cmd.target, player: cmd.player },
  }));
}

async function finish(userId, cmd, ok, msg) {
  const user = db.getUser(userId);
  log(userId, { kind: ok ? 'done' : 'failed', id: cmd.id, viewer: cmd.viewer, label: cmd.label, source: cmd.source, amount: cmd.amount, msg });
  if (cmd.source === 'points' && cmd.redemptionId && user) {
    try {
      await twitch.setRedemptionStatus(user, cmd.rewardId, cmd.redemptionId, ok ? 'FULFILLED' : 'CANCELED');
    } catch (e) {
      console.error('[engine] redemption status:', e.message);
    }
  }
}

function onResult(userId, { id, status, msg }) {
  const c = ch(userId);
  const cmd = c.pending.get(Number(id));
  if (!cmd) return;
  c.pending.delete(cmd.id);
  finish(userId, cmd, status === 'ok', msg);
}

// ---------- Hulpprogramma (WebSocket) ----------
function attachCompanion(user, ws, label = 'Hulpprogramma') {
  const c = ch(user.id);
  if (c.ws && c.ws !== ws) { try { c.ws.close(4000, 'Nieuwe verbinding'); } catch {} }
  c.ws = ws;
  if (!user.cmdEpoch) db.upsertUser(user.id, { cmdEpoch: crypto.randomBytes(4).toString('hex') });
  c.linkKind = label === 'Hulpprogramma' ? 'app' : 'ftp';
  c.companionVersion = null;
  const latest = versions.latest();
  ws.send(JSON.stringify({ type: 'hello', user: user.displayName, epoch: db.getUser(user.id).cmdEpoch, latestApp: latest.app, latestMod: latest.mod }));
  // Opdrachten die al verstuurd waren maar nog geen resultaat hebben opnieuw sturen (mod negeert dubbele).
  for (const cmd of c.pending.values()) sendCommand(c, db.getUser(user.id), cmd);
  log(user.id, { kind: 'system', msg: `${label} verbonden` });

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'status') {
      if (m.companionVersion && m.companionVersion !== 'ftp') c.companionVersion = String(m.companionVersion).slice(0, 20);
      setGameActive(user.id, !!m.gameActive, m.modVersion);
    }
    if (m.type === 'result') onResult(user.id, m);
  });
  ws.on('close', () => {
    if (c.ws !== ws) return;
    c.ws = null;
    setGameActive(user.id, false);
    log(user.id, { kind: 'system', msg: `${label} verbroken` });
  });
}

function setGameActive(userId, active, modVersion) {
  const c = ch(userId);
  if (modVersion) c.modVersion = modVersion;
  if (c.gameActive === active) return;
  c.gameActive = active;
  log(userId, { kind: 'system', msg: active ? 'Game actief: sabotage staat AAN' : 'Game niet actief: sabotage gepauzeerd' });
  if (active) pump(userId);
  schedulePause(userId);
}

// Beloningen pauzeren als de game niet draait (met vertraging om flapperen te voorkomen).
function schedulePause(userId) {
  const c = ch(userId);
  clearTimeout(c.pauseTimer);
  c.pauseTimer = setTimeout(async () => {
    const user = db.getUser(userId);
    if (!user) return;
    const paused = configOf(user).pauseWhenOffline ? !c.gameActive : false;
    if (c.pausedState === paused) return;
    c.pausedState = paused;
    for (const rewardId of Object.values(user.rewards || {})) {
      await twitch.updateReward(user, rewardId, { is_paused: paused }).catch(e => console.error('[pause]', e.message));
    }
  }, 15_000);
}

// ---------- Timeouts ----------
setInterval(() => {
  const now = Date.now();
  for (const [userId, c] of channels) {
    for (const cmd of [...c.queue]) {
      if (cmd.source === 'points' && now - cmd.queuedAt > QUEUE_TIMEOUT_MS) {
        c.queue.splice(c.queue.indexOf(cmd), 1);
        finish(userId, cmd, false, 'Te lang in de wachtrij: punten terug');
      }
    }
    for (const cmd of [...c.pending.values()]) {
      if (now - cmd.sentAt > RESULT_TIMEOUT_MS) {
        c.pending.delete(cmd.id);
        finish(userId, cmd, false, 'Geen antwoord van de game');
      }
    }
  }
}, 15_000).unref();

// ---------- Channel points beloningen synchroniseren ----------
function rewardBody(action, c) {
  return {
    title: `FS25: ${action.label}`.slice(0, 45),
    cost: Math.max(1, Math.floor(c.points)),
    prompt: action.desc.slice(0, 200),
    is_enabled: true,
    background_color: '#2E7D32',
    is_user_input_required: !!action.userInput,
    is_global_cooldown_enabled: c.cooldown > 0,
    global_cooldown_seconds: Math.max(1, Math.floor(c.cooldown || 1)),
    should_redemptions_skip_request_queue: false,
  };
}

async function syncRewards(user) {
  const cfg = configOf(user);
  const rewards = { ...(user.rewards || {}) };
  const errors = [];
  for (const a of ACTIONS) {
    const c = cfg.actions[a.id];
    const want = c.enabled && c.usePoints && c.points > 0;
    try {
      if (want) {
        const body = rewardBody(a, c);
        if (rewards[a.id]) {
          try { await twitch.updateReward(user, rewards[a.id], body); }
          catch (e) {
            if (e.status !== 404) throw e;
            rewards[a.id] = (await twitch.createReward(user, body)).id;
          }
        } else {
          rewards[a.id] = (await twitch.createReward(user, body)).id;
        }
      } else if (rewards[a.id]) {
        await twitch.deleteReward(user, rewards[a.id]).catch(e => { if (e.status !== 404) throw e; });
        delete rewards[a.id];
      }
    } catch (e) {
      errors.push(`${a.label}: ${e.message}`);
    }
  }
  db.upsertUser(user.id, { rewards });
  ch(user.id).pausedState = null;
  schedulePause(user.id);
  return errors;
}

// ---------- Twitch events ----------
function onCheer(user, ev) {
  const cfg = configOf(user);
  const action = pickForBits(cfg, ev.bits, ev.message || '');
  const viewer = ev.is_anonymous ? 'Anoniem' : ev.user_name;
  if (!action) {
    log(user.id, { kind: 'ignored', viewer, source: 'bits', amount: ev.bits, msg: 'Geen actie voor dit aantal bits' });
    return;
  }
  enqueue(user, { actionId: action.id, viewer, source: 'bits', amount: ev.bits, text: ev.message });
}

function onRedemption(user, ev) {
  const actionId = Object.entries(user.rewards || {}).find(([, rid]) => rid === ev.reward.id)?.[0];
  if (!actionId) return; // niet onze beloning
  const cmd = enqueue(user, {
    actionId, viewer: ev.user_name, source: 'points', amount: ev.reward.cost,
    rewardId: ev.reward.id, redemptionId: ev.id, text: ev.user_input,
  });
  if (!cmd) twitch.setRedemptionStatus(user, ev.reward.id, ev.id, 'CANCELED').catch(() => {});
}

module.exports = {
  ch, pickForBits, enqueue, pump, onResult, attachCompanion, publicStatus, syncRewards,
  onCheer, onRedemption, configOf, log, schedulePause,
};
