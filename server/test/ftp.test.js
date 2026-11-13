// End-to-end via FTP (zoals bij G-Portal): website → FTP → (nagebootste) mod op de server → resultaat terug.
const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const FtpSrv = require('ftp-srv');

const PORT = 3995;
const FTP_PORT = 2121;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'ftp-eventsub-secret';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs25ftp-'));
const dataDir = path.join(tmp, 'data');
const downloads = path.join(tmp, 'downloads');
const ftpRoot = path.join(tmp, 'ftproot');
// Indeling zoals op een gehuurde server: ergens een profielmap met "mods" erin.
const profile = path.join(ftpRoot, 'fs25', 'profile');
const modDir = path.join(profile, 'modSettings', 'FS25_TwitchSabotage');
fs.mkdirSync(path.join(profile, 'mods'), { recursive: true });
fs.mkdirSync(path.join(ftpRoot, 'logs'), { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(downloads, { recursive: true });
fs.writeFileSync(path.join(downloads, 'FS25_TwitchSabotage.zip'), 'nep-zip');
fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
  users: { '777': { id: '777', login: 'papa', displayName: 'Papa', pairKey: 'PK', overlayKey: 'OK', cmdEpoch: 'ftp1', broadcasterType: '', config: { gapSeconds: 0 } } },
  eventIds: [],
  settings: { sessionSecret: 'sess', eventsubSecret: SECRET, clientId: 'x', clientSecret: 'y', adminHash: 'a:b' },
}));

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150); }
  throw new Error('timeout');
}
const cookie = `sid=777.${crypto.createHmac('sha256', 'sess').update('777').digest('base64url')}`;
const post = (p, body) => fetch(`${BASE}${p}`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const me = async () => (await fetch(`${BASE}/api/me`, { headers: { cookie } })).json();

// Nagebootste mod op de gameserver (leest/schrijft rechtstreeks in de FTP-map).
let beat = 0; let lastId = 0; let epoch = ''; const results = []; const executed = []; let modRunning = false;
const modTimer = setInterval(() => {
  if (!modRunning) return;
  fs.mkdirSync(modDir, { recursive: true });
  const inbox = path.join(modDir, 'inbox.xml');
  if (fs.existsSync(inbox)) {
    const xml = fs.readFileSync(inbox, 'utf8');
    const ep = (xml.match(/<inbox epoch="([^"]*)"/) || [])[1] || '';
    if (ep !== epoch) { epoch = ep; lastId = 0; }
    for (const m of xml.matchAll(/<cmd id="(\d+)" action="([^"]+)"[^>]*target="([^"]*)" player="([^"]*)"/g)) {
      const id = Number(m[1]);
      if (id > lastId) { lastId = id; executed.push({ action: m[2], target: m[3], player: m[4] }); results.push(`<result id="${id}" action="${m[2]}" status="ok" msg="Papa"/>`); }
    }
  }
  beat++;
  fs.writeFileSync(path.join(modDir, 'outbox.xml'), `<outbox version="1.1.0" epoch="${epoch}" lastId="${lastId}" beat="${beat}">${results.join('')}</outbox>`);
}, 300);

let ftpServer; let server;
test('FTP-server en website starten', async () => {
  ftpServer = new FtpSrv({ url: `ftp://127.0.0.1:${FTP_PORT}`, pasv_url: '127.0.0.1', pasv_min: 31000, pasv_max: 31100, anonymous: false, greeting: 'nep G-Portal' });
  ftpServer.on('login', ({ username, password }, resolve, reject) =>
    username === 'papa' && password === 'geheim' ? resolve({ root: ftpRoot }) : reject(new Error('fout wachtwoord')));
  ftpServer.on('client-error', () => {});
  await ftpServer.listen();
  server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')],
    { env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, DOWNLOADS_DIR: downloads, FTP_POLL_MS: '300' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.out = ''; server.stdout.on('data', d => { server.out += d; }); server.stderr.on('data', d => { server.out += d; });
  await waitFor(async () => (await fetch(`${BASE}/healthz`).catch(() => null))?.ok);
});

test('verkeerd FTP-wachtwoord geeft een duidelijke fout', async () => {
  await post('/api/link', { mode: 'ftp', host: '127.0.0.1', port: FTP_PORT, user: 'papa', password: 'fout' });
  const r = await post('/api/link/test');
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Verbinding mislukt/);
});

test('FTP-gegevens opslaan: wachtwoord gaat niet terug naar de browser, map wordt automatisch gevonden', async () => {
  const r = await (await post('/api/link', { mode: 'ftp', host: 'ftp://127.0.0.1/', port: FTP_PORT, user: 'papa', password: 'geheim' })).json();
  assert.equal(r.link.ftp.host, '127.0.0.1');
  assert.equal(r.link.ftp.passwordSet, true);
  assert.ok(!JSON.stringify(await me()).includes('geheim'));
  const t = await (await post('/api/link/test')).json();
  assert.equal(t.ok, true);
  assert.equal(t.profile, '/fs25/profile');
  assert.equal(t.modInstalled, false);
});

test('mod met één klik op de server zetten', async () => {
  const r = await (await post('/api/link/install-mod')).json();
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(profile, 'mods', 'FS25_TwitchSabotage.zip'), 'utf8'), 'nep-zip');
  const t = await (await post('/api/link/test')).json();
  assert.equal(t.modInstalled, true);
});

test('game wordt actief zodra de mod op de server draait (hartslag via FTP)', async () => {
  let m = await me();
  assert.equal(m.status.gameActive, false);
  modRunning = true;
  m = await waitFor(async () => { const x = await me(); return x.status.companionConnected && x.status.gameActive ? x : null; });
  assert.ok(m);
});

test('cheer gaat via FTP naar de server, met spelernaam en doelwit', async () => {
  await post('/api/config', { playerName: 'Papa', target: 'all' });
  const body = JSON.stringify({ subscription: { type: 'channel.cheer', condition: { broadcaster_user_id: '777' } }, event: { user_name: 'Kijker', bits: 100, message: 'Cheer100 !motor' } });
  const id = crypto.randomUUID(); const ts = new Date().toISOString();
  const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(id + ts + body).digest('hex');
  const r = await fetch(`${BASE}/eventsub`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'Twitch-Eventsub-Message-Id': id, 'Twitch-Eventsub-Message-Timestamp': ts, 'Twitch-Eventsub-Message-Signature': sig, 'Twitch-Eventsub-Message-Type': 'notification' } });
  assert.equal(r.status, 204);
  await waitFor(() => executed.length > 0);
  assert.deepEqual(executed[0], { action: 'engine_off', target: 'all', player: 'Papa' });
  await waitFor(async () => (await me()).log.find(l => l.kind === 'done' && l.label === 'Motor uit'));
});

test('Windows-programma wordt geweigerd als het kanaal FTP gebruikt', async () => {
  const WebSocket = require('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?key=PK`);
  const code = await new Promise(r => ws.on('close', c => r(c)));
  assert.equal(code, 4002);
});

test('game niet actief als de mod stopt (server uit of gepauzeerd)', async () => {
  modRunning = false;
  await waitFor(async () => !(await me()).status.gameActive, 20000);
});

after(async () => {
  clearInterval(modTimer);
  server?.kill();
  await ftpServer?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
