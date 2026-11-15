// End-to-end test: nep-Twitch-webhook → server → hulpprogramma → (nagebootste) mod → resultaat terug.
// Uitvoeren: cd server && npm test
const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stop, rmOpts } = require('./helpers');

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'testsecret-1234567890';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs25ts-'));
const dataDir = path.join(tmp, 'data');
const gameDir = path.join(tmp, 'game');
const modDir = path.join(gameDir, 'modSettings', 'FS25_TwitchSabotage');
const procs = [];

// Het echte hulpprogramma (zelfde logica als de Windows-app), als versie zonder venster.
const COMPANION_DIR = path.join(__dirname, '..', '..', 'companion', 'Fs25Sabotage.Cli');
const COMPANION_DLL = path.join(COMPANION_DIR, 'bin', 'Release', 'net8.0', 'Fs25Sabotage.Cli.dll');
if (!fs.existsSync(COMPANION_DLL)) {
  const r = require('node:child_process').spawnSync('dotnet', ['build', COMPANION_DIR, '-c', 'Release'], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('dotnet build van het hulpprogramma mislukt');
}

fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
  users: { '123': { id: '123', login: 'tester', displayName: 'Tester', pairKey: 'PAIR', overlayKey: 'OVL', cmdEpoch: 'ep1', broadcasterType: '', config: { gapSeconds: 0 } } },
  eventIds: [],
  settings: { sessionSecret: 'sess', eventsubSecret: SECRET },
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

// Geen Twitch-keys of geheimen via omgevingsvariabelen: alleen poort en datamap.
const downloadsDir = path.join(tmp, 'downloads');
fs.mkdirSync(downloadsDir, { recursive: true });
// Echte mod-zip maken van de bronbestanden (zoals de workflow doet).
require('node:child_process').execFileSync('python3', ['-c', `
import zipfile, os, sys
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w') as z:
    for root, _, files in os.walk(src):
        for f in files:
            full = os.path.join(root, f); z.write(full, os.path.relpath(full, src))
`, path.join(__dirname, '..', '..', 'mod', 'FS25_TwitchSabotage'), path.join(downloadsDir, 'FS25_TwitchSabotage.zip')]);
const env = { PORT: String(PORT), DATA_DIR: dataDir, DOWNLOADS_DIR: downloadsDir };
let server; let adminCookie = '';

test('server start zonder configuratie', async () => {
  server = start(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], env);
  await waitFor(async () => (await fetch(`${BASE}/healthz`).catch(() => null))?.ok);
  assert.deepEqual(await (await fetch(`${BASE}/api/status`)).json(), { configured: false });
});

test('installatie: verkeerde code geweigerd, juiste code uit de logs werkt', async () => {
  const code = await waitFor(() => (server.output.match(/Installatiecode: ([0-9A-F]+)/) || [])[1]);
  const bad = await fetch(`${BASE}/api/admin/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'FOUT', password: 'heelgeheim123' }) });
  assert.equal(bad.status, 403);
  const ok = await fetch(`${BASE}/api/admin/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, password: 'heelgeheim123' }) });
  assert.equal(ok.status, 200);
  adminCookie = ok.headers.get('set-cookie').split(';')[0];
  const again = await fetch(`${BASE}/api/admin/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, password: 'nogeenkeer123' }) });
  assert.equal(again.status, 409);
});

test('Twitch-keys instellen via beheer; secret gaat nooit terug naar de browser', async () => {
  const r = await fetch(`${BASE}/api/admin/settings`, { method: 'POST', headers: { cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: 'cid123', clientSecret: 'SUPERGEHEIM' }) });
  assert.equal(r.status, 200);
  const anon = await (await fetch(`${BASE}/api/admin/state`)).text();
  const admin = await (await fetch(`${BASE}/api/admin/state`, { headers: { cookie: adminCookie } })).text();
  assert.ok(!anon.includes('cid123') && !anon.includes('SUPERGEHEIM'));
  assert.ok(admin.includes('cid123') && !admin.includes('SUPERGEHEIM'));
  assert.ok(JSON.parse(admin).clientSecretSet);
  assert.deepEqual(await (await fetch(`${BASE}/api/status`)).json(), { configured: true });
  // zonder beheerder-cookie mag niemand instellingen wijzigen
  const hack = await fetch(`${BASE}/api/admin/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: 'x' }) });
  assert.equal(hack.status, 401);
});

test('basisadres komt uit de proxy-headers (Nginx Proxy Manager)', async () => {
  const s = await (await fetch(`${BASE}/api/admin/state`, { headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'sabotage.voorbeeld.nl' } })).json();
  assert.equal(s.redirectUrl, 'https://sabotage.voorbeeld.nl/auth/callback');
});

test('webhook verificatie: challenge en ongeldige handtekening', async () => {
  const body = JSON.stringify({ challenge: 'abc123', subscription: { type: 'channel.cheer' } });
  const r = await fetch(`${BASE}/eventsub`, { method: 'POST', headers: signed(body, 'v1', 'webhook_callback_verification'), body });
  assert.equal(await r.text(), 'abc123');
  const bad = await fetch(`${BASE}/eventsub`, { method: 'POST', headers: { ...signed(body), 'Twitch-Eventsub-Message-Signature': 'sha256=00' }, body });
  assert.equal(bad.status, 403);
});

test('hulpprogramma verbindt en game wordt actief', async () => {
  const me = await (await fetch(`${BASE}/api/me`, { headers: { cookie: sessionCookie() } })).json();
  assert.ok(me.pairCode.startsWith('FS25-'));
  // alleen de koppelcode: het serveradres zit erin
  start('dotnet', [COMPANION_DLL, '--key', me.pairCode, '--game-dir', gameDir, '--config-dir', path.join(tmp, 'cfg')], {});
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
  const { defaultConfig } = require('../src/actions');
  const d = defaultConfig().actions;
  const at100 = Object.keys(d).filter(id => d[id].enabled && d[id].useBits && d[id].bits === 100);
  assert.ok(at100.includes(last), `${last} niet in ${at100}`);
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
    body: JSON.stringify({ gapSeconds: 3, bitsMode: 'random', actions: { engine_off: { enabled: false, useBits: true, usePoints: false, bits: -5, points: 10, cooldown: 1 } } }),
  });
  const j = await r.json();
  assert.equal(j.ok, true);
  const me = await (await fetch(`${BASE}/api/me`, { headers: { cookie: sessionCookie() } })).json();
  assert.equal(me.config.gapSeconds, 3);
  assert.equal(me.config.bitsMode, 'random');
  assert.equal(me.config.actions.engine_off.enabled, false);
  assert.equal(me.config.actions.engine_off.bits, 1);
  assert.equal(me.config.actions.engine_off.useBits, true);
  assert.equal(me.config.actions.engine_off.usePoints, false);
});

test('mod bijwerken via het Windows-programma: nieuwe zip, oude "(1)"-kopie naar back-up', async () => {
  const mods = path.join(gameDir, 'mods');
  fs.mkdirSync(mods, { recursive: true });
  fs.writeFileSync(path.join(mods, 'FS25_TwitchSabotage.zip'), 'oud');
  fs.writeFileSync(path.join(mods, 'FS25_TwitchSabotage (1).zip'), 'oud2');
  fs.writeFileSync(path.join(mods, 'AndereMod.zip'), 'blijft');
  const r = await fetch(`${BASE}/api/app/install-mod`, { method: 'POST', headers: { cookie: sessionCookie() } });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.match(j.message, /v\d+\.\d+\.\d+/);
  assert.deepEqual(fs.readdirSync(mods).sort(), ['AndereMod.zip', 'FS25_TwitchSabotage.zip']);
  assert.deepEqual(fs.readFileSync(path.join(mods, 'FS25_TwitchSabotage.zip')), fs.readFileSync(path.join(downloadsDir, 'FS25_TwitchSabotage.zip')));
  const backups = path.join(modDir, 'oude-versies');
  const moved = fs.readdirSync(backups).flatMap(d => fs.readdirSync(path.join(backups, d)));
  assert.deepEqual(moved, ['FS25_TwitchSabotage (1).zip']);
});

test('ongeldige koppelcode wordt geweigerd', async () => {
  const WebSocket = require('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?key=FOUT`);
  const code = await new Promise(r => ws.on('close', c => r(c)));
  assert.equal(code, 4003);
});

test('privacy- en voorwaardenpagina met het contactadres uit /admin', async () => {
  const bad = await fetch(`${BASE}/api/admin/settings`, { method: 'POST', headers: { cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ contactEmail: 'geen-adres' }) });
  assert.equal(bad.status, 400);
  await fetch(`${BASE}/api/admin/settings`, { method: 'POST', headers: { cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ contactEmail: 'support@voorbeeld.nl' }) });
  for (const p of ['/privacy', '/terms']) {
    const r = await fetch(`${BASE}${p}`);
    assert.equal(r.status, 200);
    assert.ok((await r.text()).includes('support@voorbeeld.nl'), p);
  }
});

test('account verwijderen wist de streamer', async () => {
  const r = await fetch(`${BASE}/api/account/delete`, { method: 'POST', headers: { cookie: sessionCookie() } });
  assert.equal(r.status, 200);
  assert.equal((await fetch(`${BASE}/api/me`, { headers: { cookie: sessionCookie() } })).status, 401);
});

after(async () => {
  clearInterval(modTimer);
  await Promise.all(procs.map(stop));
  fs.rmSync(tmp, rmOpts);
});
