// End-to-end test: nep-Twitch-webhook → server → hulpprogramma → (nagebootste) mod → resultaat terug.
// Uitvoeren: cd server && npm test
const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'testsecret-1234567890';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs25ts-'));
const dataDir = path.join(tmp, 'data');
const gameDir = path.join(tmp, 'game');
const modDir = path.join(gameDir, 'modSettings', 'FS25_TwitchSabotage');
const procs = [];

fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
  users: { '123': { id: '123', login: 'tester', displayName: 'Tester', pairKey: 'PAIR', overlayKey: 'OVL', cmdEpoch: 'ep1', broadcasterType: '', config: { gapSeconds: 0 } } },
  eventIds: [],
}));

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); }
  throw new Error('timeout');
}

function start(cmd, args, env) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.output = '';
  p.stdout.on('data', d => { p.output += d; });
  p.stderr.on('data', d => { p.output += d; });
  procs.push(p);
  return p;
}

// Nagebootste mod: leest inbox.xml, "voert uit", schrijft outbox.xml + hartslag.
let modLastId = 0; let modEpoch = ''; const modResults = []; const executed = [];
const modTimer = setInterval(() => {
  fs.mkdirSync(modDir, { recursive: true });
  const inbox = path.join(modDir, 'inbox.xml');
  if (fs.existsSync(inbox)) {
    const xml = fs.readFileSync(inbox, 'utf8');
    const epoch = (xml.match(/<inbox epoch="([^"]*)"/) || [])[1] || '';
    if (epoch !== modEpoch) { modEpoch = epoch; modLastId = 0; }
    for (const m of xml.matchAll(/<cmd id="(\d+)" action="([^"]+)"/g)) {
      const id = Number(m[1]);
      if (id > modLastId) {
        modLastId = id; executed.push(m[2]);
        modResults.push(`<result id="${id}" action="${m[2]}" status="${m[2] === 'kick_out' ? 'failed' : 'ok'}" msg=""/>`);
      }
    }
  }
  fs.writeFileSync(path.join(modDir, 'outbox.xml'), `<outbox version="test" epoch="${modEpoch}" lastId="${modLastId}">${modResults.join('')}</outbox>`);
}, 200);

function signed(body, id = crypto.randomUUID(), type = 'notification') {
  const ts = new Date().toISOString();
  const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(id + ts + body).digest('hex');
  return { 'Twitch-Eventsub-Message-Id': id, 'Twitch-Eventsub-Message-Timestamp': ts, 'Twitch-Eventsub-Message-Signature': sig, 'Twitch-Eventsub-Message-Type': type, 'Content-Type': 'application/json' };
}
function cheer(bits, message) {
  return JSON.stringify({
    subscription: { type: 'channel.cheer', condition: { broadcaster_user_id: '123' } },
    event: { is_anonymous: false, user_name: 'Kijker1', bits, message, broadcaster_user_id: '123' },
  });
}
function sessionCookie() {
  const sig = crypto.createHmac('sha256', 'sess').update('123').digest('base64url');
  return `sid=123.${sig}`;
}

const env = { PORT: String(PORT), DATA_DIR: dataDir, BASE_URL: BASE, EVENTSUB_SECRET: SECRET, SESSION_SECRET: 'sess', TWITCH_CLIENT_ID: 'x', TWITCH_CLIENT_SECRET: 'y' };

test('server start', async () => {
  start(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], env);
  await waitFor(async () => (await fetch(`${BASE}/healthz`).catch(() => null))?.ok);
});

test('webhook verificatie: challenge en ongeldige handtekening', async () => {
  const body = JSON.stringify({ challenge: 'abc123', subscription: { type: 'channel.cheer' } });
  const r = await fetch(`${BASE}/eventsub`, { method: 'POST', headers: signed(body, 'v1', 'webhook_callback_verification'), body });
  assert.equal(await r.text(), 'abc123');
  const bad = await fetch(`${BASE}/eventsub`, { method: 'POST', headers: { ...signed(body), 'Twitch-Eventsub-Message-Signature': 'sha256=00' }, body });
  assert.equal(bad.status, 403);
});

test('hulpprogramma verbindt en game wordt actief', async () => {
  start(process.execPath, [path.join(__dirname, '..', '..', 'companion', 'companion.js'), '--key', 'PAIR', '--server', BASE, '--game-dir', gameDir, '--no-autostart'],
    { HOME: tmp, APPDATA: tmp });
  await waitFor(async () => {
    const me = await (await fetch(`${BASE}/api/me`, { headers: { cookie: sessionCookie() } })).json();
    return me.status.companionConnected && me.status.gameActive;
  });
});

test('cheer met !woord → juiste actie wordt uitgevoerd en afgerond', async () => {
  const body = cheer(500, 'Cheer500 haha !motor');
  const r = await fetch(`${BASE}/eventsub`, { method: 'POST', headers: signed(body), body });
  assert.equal(r.status, 204);
  await waitFor(() => executed.includes('engine_off'));
  const me = await waitFor(async () => {
    const m = await (await fetch(`${BASE}/api/me`, { headers: { cookie: sessionCookie() } })).json();
    return m.log.find(l => l.kind === 'done' && l.label === 'Motor uit') ? m : null;
  });
  assert.ok(me);
});

test('cheer zonder woord → duurste actie die past (100 bits)', async () => {
  const body = cheer(100, 'Cheer100');
  await fetch(`${BASE}/eventsub`, { method: 'POST', headers: signed(body), body });
  await waitFor(() => executed.length >= 2);
  const last = executed[executed.length - 1];
  assert.ok(['engine_off', 'cruise_slow', 'implement_off', 'implement_lift'].includes(last), last);
});

test('dubbel event (zelfde message-id) wordt maar één keer uitgevoerd', async () => {
  const body = cheer(50, 'Cheer50 !modder');
  const h = signed(body, 'dup-1');
  await fetch(`${BASE}/eventsub`, { method: 'POST', headers: h, body });
  await fetch(`${BASE}/eventsub`, { method: 'POST', headers: h, body });
  await waitFor(() => executed.includes('dirt'));
  await sleep(1000);
  assert.equal(executed.filter(a => a === 'dirt').length, 1);
});

test('mislukte actie komt als failed in het logboek', async () => {
  const r = await fetch(`${BASE}/api/test/kick_out`, { method: 'POST', headers: { cookie: sessionCookie() } });
  assert.equal(r.status, 200);
  await waitFor(async () => {
    const m = await (await fetch(`${BASE}/api/me`, { headers: { cookie: sessionCookie() } })).json();
    return m.log.find(l => l.kind === 'failed' && l.label === 'Eruit gegooid');
  });
});

test('config opslaan en valideren', async () => {
  const r = await fetch(`${BASE}/api/config`, {
    method: 'POST', headers: { cookie: sessionCookie(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ gapSeconds: 3, bitsMode: 'random', actions: { engine_off: { enabled: false, bits: -5, points: 10, cooldown: 1 } } }),
  });
  const j = await r.json();
  assert.equal(j.ok, true);
  const me = await (await fetch(`${BASE}/api/me`, { headers: { cookie: sessionCookie() } })).json();
  assert.equal(me.config.gapSeconds, 3);
  assert.equal(me.config.bitsMode, 'random');
  assert.equal(me.config.actions.engine_off.enabled, false);
  assert.equal(me.config.actions.engine_off.bits, 0);
});

test('ongeldige koppelcode wordt geweigerd', async () => {
  const WebSocket = require('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?key=FOUT`);
  const code = await new Promise(r => ws.on('close', c => r(c)));
  assert.equal(code, 4003);
});

after(() => {
  clearInterval(modTimer);
  for (const p of procs) p.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});
