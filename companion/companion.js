#!/usr/bin/env node
// FS25 Twitch Sabotage: hulpprogramma
// Verbindt met de server (WebSocket) en geeft opdrachten via een XML-bestand door aan de FS25-mod.
//
//   inbox.xml  : hulpprogramma → mod (opdrachten)
//   outbox.xml : mod → hulpprogramma (resultaten + hartslag)
//
// Gebruik:  FS25TwitchSabotage.exe [--key KOPPELCODE] [--server URL] [--game-dir MAP] [--no-autostart] [--reset]

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');
const WebSocket = require('ws');

const VERSION = '1.0.0';
let BUILD = {};
try { BUILD = require('./build-config.json'); } catch {}
const DEFAULT_SERVER = process.env.FS25TS_SERVER || BUILD.serverUrl || 'http://localhost:3000';
const MOD_NAME = 'FS25_TwitchSabotage';
const IS_WIN = process.platform === 'win32';

// ---------- Argumenten & config ----------
const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const flag = name => args.includes(name);

const CONFIG_DIR = IS_WIN
  ? path.join(process.env.APPDATA || os.homedir(), 'FS25TwitchSabotage')
  : path.join(os.homedir(), '.config', 'fs25-twitch-sabotage');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

const say = (...m) => console.log(`[${new Date().toLocaleTimeString('nl-NL')}]`, ...m);

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, a => { rl.close(); resolve(a.trim()); }));
}

// ---------- FS25-map zoeken ----------
function documentsDirs() {
  const dirs = [];
  if (IS_WIN) {
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Personal'], { encoding: 'utf8' });
      const m = out.match(/Personal\s+REG_\w+\s+(.+)/);
      if (m) dirs.push(m[1].trim().replace(/%([^%]+)%/g, (_, v) => process.env[v] || ''));
    } catch {}
  }
  const home = os.homedir();
  dirs.push(path.join(home, 'Documents'), path.join(home, 'Documenten'),
    path.join(home, 'OneDrive', 'Documents'), path.join(home, 'OneDrive', 'Documenten'));
  return [...new Set(dirs)];
}

function findGameDir() {
  for (const d of documentsDirs()) {
    const p = path.join(d, 'My Games', 'FarmingSimulator2025');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ---------- Autostart (Windows) ----------
function setupAutostart() {
  if (!IS_WIN || !process.pkg) return; // alleen voor de .exe
  try {
    const value = `cmd /c start "" /min "${process.execPath}"`;
    execFileSync('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'FS25TwitchSabotage', '/t', 'REG_SZ', '/d', value, '/f'], { stdio: 'ignore' });
    say('Autostart ingesteld: het programma start voortaan mee met Windows.');
  } catch (e) {
    say('Autostart instellen mislukt:', e.message);
  }
}

// ---------- XML ----------
const xmlEsc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\r\n\t]/g, ' ');
const xmlUnesc = s => String(s ?? '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&amp;/g, '&');

function parseAttrs(str) {
  const out = {};
  for (const m of str.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1]] = xmlUnesc(m[2]);
  return out;
}

function writeAtomic(file, content) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  try { fs.renameSync(tmp, file); }
  catch { fs.writeFileSync(file, content, 'utf8'); try { fs.unlinkSync(tmp); } catch {} }
}

// ---------- Hoofdprogramma ----------
async function main() {
  console.log(`\n  FS25 Twitch Sabotage hulpprogramma v${VERSION}\n  ------------------------------------------\n`);
  let cfg = flag('--reset') ? {} : loadConfig();
  if (arg('--key')) cfg.pairKey = arg('--key');
  if (arg('--server')) cfg.serverUrl = arg('--server');
  if (arg('--game-dir')) cfg.gameDir = arg('--game-dir');
  cfg.serverUrl ||= DEFAULT_SERVER;

  const firstRun = !cfg.pairKey;
  while (!cfg.pairKey) {
    cfg.pairKey = await ask(`Plak je koppelcode van ${cfg.serverUrl} en druk op Enter:\n> `);
  }

  const gameDir = cfg.gameDir || process.env.FS25TS_GAME_DIR || findGameDir();
  if (!gameDir) {
    say('Kon de map "Documenten\\My Games\\FarmingSimulator2025" niet vinden.');
    cfg.gameDir = await ask('Plak het pad naar die map:\n> ');
    saveConfig(cfg);
    return main();
  }
  saveConfig(cfg);
  if (firstRun && !flag('--no-autostart')) setupAutostart();

  const dir = path.join(gameDir, 'modSettings', MOD_NAME);
  fs.mkdirSync(dir, { recursive: true });
  const INBOX = path.join(dir, 'inbox.xml');
  const OUTBOX = path.join(dir, 'outbox.xml');
  say('Gamemap:', gameDir);

  let ws = null;
  let epoch = '';
  let commands = [];               // nog niet door de mod bevestigd
  const sentResults = new Set();   // `${epoch}:${id}`
  let gameActive = false;
  let modVersion = null;
  let retry = 1000;

  function writeInbox() {
    const lines = commands.map(c =>
      `  <cmd id="${c.id}" action="${xmlEsc(c.action)}" param="${xmlEsc(c.param ?? '')}" viewer="${xmlEsc(c.viewer)}" source="${xmlEsc(c.source)}" amount="${c.amount || 0}" label="${xmlEsc(c.label)}" text="${xmlEsc(c.text)}"/>`);
    writeAtomic(INBOX, `<?xml version="1.0" encoding="utf-8" standalone="no"?>\n<inbox epoch="${xmlEsc(epoch)}" written="${Date.now()}">\n${lines.join('\n')}\n</inbox>\n`);
  }

  function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

  function readOutbox() {
    let stat, xml;
    try { stat = fs.statSync(OUTBOX); xml = fs.readFileSync(OUTBOX, 'utf8'); } catch { return setGame(false); }
    setGame(Date.now() - stat.mtimeMs < 8000); // mod schrijft elke 2 s een hartslag
    const root = xml.match(/<outbox\b([^>]*)>/);
    if (!root) return;
    const head = parseAttrs(root[1]);
    modVersion = head.version || modVersion;
    if (head.epoch !== epoch) return; // oude resultaten van een andere sessie
    const lastId = Number(head.lastId || 0);
    const before = commands.length;
    commands = commands.filter(c => c.id > lastId);
    if (commands.length !== before) writeInbox();
    for (const m of xml.matchAll(/<result\b([^>]*)\/>/g)) {
      const r = parseAttrs(m[1]);
      const k = `${epoch}:${r.id}`;
      if (sentResults.has(k) || !ws || ws.readyState !== WebSocket.OPEN) continue;
      sentResults.add(k);
      send({ type: 'result', id: Number(r.id), status: r.status, msg: r.msg });
      say(`${r.status === 'ok' ? '✔' : '✖'} #${r.id} ${r.action}${r.msg ? ' (' + r.msg + ')' : ''}`);
    }
  }

  function setGame(active) {
    if (active === gameActive) return;
    gameActive = active;
    say(active ? 'Game actief: sabotage staat AAN' : 'Game niet actief (geen savegame geladen of mod niet geïnstalleerd)');
    send({ type: 'status', gameActive, modVersion, companionVersion: VERSION });
  }

  function connect() {
    const url = cfg.serverUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws?key=' + encodeURIComponent(cfg.pairKey);
    ws = new WebSocket(url);
    ws.on('open', () => {
      retry = 1000;
      send({ type: 'status', gameActive, modVersion, companionVersion: VERSION });
    });
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'hello') {
        say(`Verbonden met de server als ${m.user}`);
        if (m.epoch !== epoch) { epoch = m.epoch; commands = []; }
        writeInbox();
      } else if (m.type === 'command') {
        if (m.epoch && m.epoch !== epoch) { epoch = m.epoch; commands = []; }
        if (!commands.some(c => c.id === m.cmd.id)) commands.push(m.cmd);
        writeInbox();
        say(`→ #${m.cmd.id} ${m.cmd.label} (door ${m.cmd.viewer})`);
      } else if (m.type === 'error') {
        say('Fout van de server:', m.message);
      }
    });
    ws.on('close', (code, reason) => {
      if (code === 4003 || code === 4001) {
        say(`Koppelcode niet (meer) geldig: ${reason}. Start het programma opnieuw met een nieuwe code.`);
        cfg.pairKey = ''; saveConfig(cfg);
        setTimeout(() => process.exit(1), 10_000);
        return;
      }
      say(`Verbinding verbroken, opnieuw proberen over ${Math.round(retry / 1000)} s…`);
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 30_000);
    });
    ws.on('error', e => say('Verbindingsfout:', e.message));
  }

  writeInbox();
  connect();
  setInterval(readOutbox, 500);
  setInterval(() => send({ type: 'status', gameActive, modVersion, companionVersion: VERSION }), 10_000);
  say('Laat dit venster open (minimaliseren mag). Veel plezier!');
}

main().catch(e => { console.error(e); setTimeout(() => process.exit(1), 15_000); });
