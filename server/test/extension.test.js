// Twitch-extensie: menu, betaling via het paneel en via EventSub, dubbele betalingen, vervalste bevestiging, zip.
const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { signJwt, buildZip } = require('../src/extension');

const PORT = 3989;
const BASE = `http://127.0.0.1:${PORT}`;
const EXT_SECRET = crypto.randomBytes(32).toString('base64');
const EVENTSUB_SECRET = 'ext-eventsub-secret';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs25ext-'));
fs.mkdirSync(path.join(tmp, 'data'));
fs.writeFileSync(path.join(tmp, 'data', 'db.json'), JSON.stringify({
  users: { '555': { id: '555', login: 'papa', displayName: 'Papa', pairKey: 'PK5', overlayKey: 'O5', cmdEpoch: 'x', broadcasterType: '', config: { gapSeconds: 0 } } },
  eventIds: [],
  settings: { sessionSecret: 's', eventsubSecret: EVENTSUB_SECRET, clientId: 'c', clientSecret: 'd', adminHash: 'a:b', extClientId: 'extcid', extSecret: EXT_SECRET },
}));

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); }
  throw new Error('timeout');
}
const viewerJwt = channel => signJwt({ exp: Math.floor(Date.now() / 1000) + 3600, opaque_user_id: 'U123', channel_id: channel, role: 'viewer' }, EXT_SECRET);
const receipt = (txId, sku, amount, secret = EXT_SECRET) => signJwt({
  topic: 'bits_transaction_receipt', exp: Math.floor(Date.now() / 1000) + 3600,
  data: { transactionId: txId, time: new Date().toISOString(), userId: '999', product: { domainId: 'twitch.ext.extcid', sku, displayName: sku, cost: { amount, type: 'bits' } } },
}, secret);

let server; let ws; const commands = [];
test('server + nagebootst Windows-programma (game actief)', async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, PORT: String(PORT), DATA_DIR: path.join(tmp, 'data') }, stdio: 'ignore' });
  await waitFor(async () => (await fetch(`${BASE}/healthz`).catch(() => null))?.ok);
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?key=PK5`);
  ws.on('message', m => { const j = JSON.parse(m); if (j.type === 'command') commands.push(j.cmd); });
  await new Promise(r => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'status', gameActive: true, modVersion: '1.1.0', companionVersion: '1.3.0' }));
});

test('menu alleen met een geldige Twitch-token', async () => {
  assert.equal((await fetch(`${BASE}/ext/menu`)).status, 401);
  const fake = signJwt({ channel_id: '555' }, crypto.randomBytes(32).toString('base64'));
  assert.equal((await fetch(`${BASE}/ext/menu`, { headers: { Authorization: `Bearer ${fake}` } })).status, 401);
  const m = await (await fetch(`${BASE}/ext/menu`, { headers: { Authorization: `Bearer ${viewerJwt('555')}` } })).json();
  assert.equal(m.linked, true);
  assert.equal(m.gameActive, true);
  assert.ok(m.actions.find(a => a.sku === 'engine_off' && a.bits === 100));
  assert.ok(!m.actions.find(a => a.sku === 'message'), '"bericht" heeft tekst nodig en hoort niet in de extensie');
});

test('CORS alleen voor Twitch-extensies', async () => {
  const ok = await fetch(`${BASE}/ext/menu`, { method: 'OPTIONS', headers: { Origin: 'https://abc123.ext-twitch.tv' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://abc123.ext-twitch.tv');
  const bad = await fetch(`${BASE}/ext/menu`, { method: 'OPTIONS', headers: { Origin: 'https://kwaadaardig.example' } });
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
});

const postTx = (rcpt, channel = '555') => fetch(`${BASE}/ext/transaction`, {
  method: 'POST', headers: { Authorization: `Bearer ${viewerJwt(channel)}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ receipt: rcpt, displayName: 'Kijker7' }),
});

test('betaling vanuit het paneel → sabotage naar de game', async () => {
  const r = await postTx(receipt('tx-1', 'engine_off', 100));
  assert.equal(r.status, 200);
  await waitFor(() => commands.length === 1);
  assert.equal(commands[0].action, 'engine_off');
  assert.equal(commands[0].viewer, 'Kijker7');
  assert.equal(commands[0].source, 'bits');
});

function eventsub(body) {
  const id = crypto.randomUUID(); const ts = new Date().toISOString();
  const sig = 'sha256=' + crypto.createHmac('sha256', EVENTSUB_SECRET).update(id + ts + body).digest('hex');
  return fetch(`${BASE}/eventsub`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'Twitch-Eventsub-Message-Id': id, 'Twitch-Eventsub-Message-Timestamp': ts, 'Twitch-Eventsub-Message-Signature': sig, 'Twitch-Eventsub-Message-Type': 'notification' } });
}
const extEvent = (txId, sku) => JSON.stringify({
  subscription: { type: 'extension.bits_transaction.create', condition: { extension_client_id: 'extcid' } },
  event: { id: txId, extension_client_id: 'extcid', broadcaster_user_id: '555', user_name: 'Kijker8', product: { name: sku, sku, bits: 100, in_development: true } },
});

test('zelfde betaling nogmaals (paneel of Twitch-melding) wordt niet dubbel uitgevoerd', async () => {
  await postTx(receipt('tx-1', 'engine_off', 100));
  await eventsub(extEvent('tx-1', 'engine_off'));
  await sleep(800);
  assert.equal(commands.length, 1);
});

test('betaling die alleen via de Twitch-melding binnenkomt wordt ook uitgevoerd', async () => {
  const r = await eventsub(extEvent('tx-2', 'disco'));
  assert.equal(r.status, 204);
  await waitFor(() => commands.length === 2);
  assert.equal(commands[1].action, 'disco');
  assert.equal(commands[1].viewer, 'Kijker8');
});

test('vervalste betaalbevestiging wordt geweigerd', async () => {
  const r = await postTx(receipt('tx-3', 'money_loss', 1, crypto.randomBytes(32).toString('base64')));
  assert.equal(r.status, 400);
  await sleep(500);
  assert.equal(commands.length, 2);
});

test('extensie-zip: geldige zip met het adres van de site erin', () => {
  const zip = buildZip('https://sabotage.voorbeeld.nl');
  const file = path.join(tmp, 'ext.zip');
  fs.writeFileSync(file, zip);
  const out = execFileSync('python3', ['-c', `
import zipfile, sys, json
z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
print(json.dumps({ "names": sorted(z.namelist()), "app": z.read("app.js").decode() }))
`, file]).toString();
  const { names, app } = JSON.parse(out);
  assert.deepEqual(names, ['app.js', 'config.html', 'panel.html', 'style.css', 'video_overlay.html']);
  assert.ok(app.includes("var EBS = 'https://sabotage.voorbeeld.nl'"));
  assert.ok(!app.includes('__EBS_URL__'));
});

after(() => { ws?.close(); server?.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });
