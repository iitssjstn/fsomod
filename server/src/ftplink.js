// FTP-koppeling met een gehuurde FS25-server (bijv. G-Portal).
// Gedraagt zich voor de engine precies als het Windows-programma (zelfde berichten),
// maar schrijft inbox.xml en leest outbox.xml via FTP in de profielmap van de server.
const { EventEmitter } = require('events');
const { Readable, Writable } = require('stream');
const ftp = require('basic-ftp');

const MOD_NAME = 'FS25_TwitchSabotage';
const POLL_MS = Number(process.env.FTP_POLL_MS || 2500);
const INACTIVE_MS = 12_000; // geen nieuwe hartslag van de mod → game niet actief

const xmlEsc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u001f]/g, ' ');
const xmlUnesc = s => String(s ?? '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&amp;/g, '&');
function attrs(str) {
  const out = {};
  for (const m of str.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1]] = xmlUnesc(m[2]);
  return out;
}

function buildInbox(epoch, commands) {
  const lines = commands.map(c =>
    `  <cmd id="${c.id}" action="${xmlEsc(c.action)}" param="${xmlEsc(c.param ?? '')}" viewer="${xmlEsc(c.viewer)}" source="${xmlEsc(c.source)}" amount="${Number(c.amount) || 0}" label="${xmlEsc(c.label)}" text="${xmlEsc(c.text)}" target="${xmlEsc(c.target)}" player="${xmlEsc(c.player)}"/>`);
  return `<?xml version="1.0" encoding="utf-8" standalone="no"?>\n<inbox epoch="${xmlEsc(epoch)}" written="${Date.now()}">\n${lines.join('\n')}\n</inbox>\n`;
}

async function connect(cfg) {
  const client = new ftp.Client(20_000);
  const base = { host: cfg.host, port: Number(cfg.port) || 21, user: cfg.user, password: cfg.password };
  try {
    // Eerst versleuteld proberen (FTPS); veel gameservers ondersteunen alleen gewone FTP.
    await client.access({ ...base, secure: true });
  } catch {
    client.close();
    const plain = new ftp.Client(20_000);
    await plain.access({ ...base, secure: false });
    return plain;
  }
  return client;
}

async function download(client, path) {
  const chunks = [];
  await client.downloadTo(new Writable({ write(chunk, _, cb) { chunks.push(chunk); cb(); } }), path);
  return Buffer.concat(chunks).toString('utf8');
}

async function upload(client, path, text) {
  await client.uploadFrom(Readable.from(Buffer.from(text, 'utf8')), path);
}

// Zoek de profielmap: de map met "mods" erin (daar zet FS25 ook "modSettings").
async function detectProfile(client) {
  const queue = [{ path: '/', depth: 0 }];
  let listed = 0;
  while (queue.length && listed < 80) {
    const { path, depth } = queue.shift();
    let entries;
    try { entries = await client.list(path); } catch { continue; }
    listed++;
    const dirs = entries.filter(e => e.isDirectory).map(e => e.name);
    if (dirs.includes('mods')) return path === '/' ? '' : path.replace(/\/$/, '');
    if (depth < 4) for (const d of dirs) if (!d.startsWith('.')) queue.push({ path: `${path.replace(/\/$/, '')}/${d}`, depth: depth + 1 });
  }
  return null;
}

async function resolveDirs(client, cfg) {
  let profile = (cfg.path || '').trim().replace(/\/$/, '');
  if (!profile) {
    profile = await detectProfile(client);
    if (profile === null) throw new Error('Geen map met "mods" gevonden op de FTP-server. Vul de map handmatig in.');
  }
  const modDir = `${profile}/modSettings/${MOD_NAME}`;
  return { profile: profile || '/', modDir, modsDir: `${profile}/mods` };
}

// Alle "mods"-mappen op de FTP met daarin een Twitch Sabotage-mod (om dubbele/oude kopieën te vinden).
async function findModCopies(client) {
  const copies = []; const modsDirs = [];
  const queue = [{ path: '/', depth: 0 }];
  let listed = 0;
  while (queue.length && listed < 120) {
    const { path, depth } = queue.shift();
    let entries;
    try { entries = await client.list(path); } catch { continue; }
    listed++;
    const base = path.replace(/\/$/, '');
    if (/\/mods$/i.test(base)) {
      modsDirs.push(base);
      for (const e of entries) {
        if (/twitch.?sabotage/i.test(e.name)) copies.push({ path: `${base}/${e.name}`, size: e.size, date: e.modifiedAt ? e.modifiedAt.toISOString() : (e.rawModifiedAt || '') });
      }
    }
    if (depth < 5) for (const e of entries) if (e.isDirectory && !e.name.startsWith('.')) queue.push({ path: `${base}/${e.name}`, depth: depth + 1 });
  }
  return { modsDirs, copies };
}

// Test vanaf het dashboard: verbinden, map zoeken, kijken of de mod al gedraaid heeft.
async function testConnection(cfg) {
  const client = await connect(cfg);
  try {
    const dirs = await resolveDirs(client, cfg);
    await client.ensureDir(dirs.modDir);
    let modRan = false;
    try { modRan = (await client.list(dirs.modDir)).some(e => e.name === 'outbox.xml'); } catch {}
    let modInstalled = false;
    try { modInstalled = (await client.list(dirs.modsDir)).some(e => e.name === `${MOD_NAME}.zip` || e.name === MOD_NAME); } catch {}
    let outboxVersion = null;
    try { outboxVersion = ((await download(client, `${dirs.modDir}/outbox.xml`)).match(/<outbox\b[^>]*version="([^"]*)"/) || [])[1] || null; } catch {}
    await client.cd('/');
    const found = await findModCopies(client);
    return { ok: true, profile: dirs.profile, modsDir: dirs.modsDir, modInstalled, modRan, outboxVersion, ...found, secure: client.ftp.socket?.encrypted === true };
  } finally { client.close(); }
}

// Mod-zip naar de mods-map van de server uploaden.
async function installMod(cfg, zipPath) {
  const client = await connect(cfg);
  try {
    const dirs = await resolveDirs(client, cfg);
    await client.ensureDir(dirs.modsDir);
    await client.uploadFrom(zipPath, `${dirs.modsDir}/${MOD_NAME}.zip`);
    return { ok: true, path: `${dirs.modsDir}/${MOD_NAME}.zip` };
  } finally { client.close(); }
}

class FtpLink extends EventEmitter {
  constructor(cfg, log) {
    super();
    this.cfg = cfg;
    this.log = log || (() => {});
    this.readyState = 1; // OPEN, zoals een WebSocket
    this.epoch = '';
    this.commands = [];
    this.dirty = true;
    this.sentResults = new Set();
    this.gameActive = false;
    this.lastBeat = null;
    this.lastBeatChange = 0;
    this.client = null;
    this.dirs = null;
    this.stopped = false;
    this.timer = setTimeout(() => this.tick(), 50);
  }

  // Berichten van de engine (zelfde als naar het Windows-programma).
  send(raw) {
    const m = JSON.parse(raw);
    if (m.type === 'hello') this.setEpoch(m.epoch);
    if (m.type === 'command') {
      if (m.epoch) this.setEpoch(m.epoch);
      if (!this.commands.some(c => c.id === m.cmd.id)) this.commands.push(m.cmd);
      this.dirty = true;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.tick(), 50); // meteen doorsturen
    }
  }

  setEpoch(epoch) {
    if (epoch === this.epoch) return;
    this.epoch = epoch || '';
    this.commands = [];
    this.dirty = true;
  }

  close() {
    if (this.stopped) return;
    this.stopped = true;
    this.readyState = 3;
    clearTimeout(this.timer);
    if (this.client) this.client.close();
    this.emit('close');
  }

  emitMsg(obj) { this.emit('message', JSON.stringify(obj)); }

  setGame(active, modVersion) {
    if (active === this.gameActive && !modVersion) return;
    const changed = active !== this.gameActive;
    this.gameActive = active;
    if (changed || modVersion) this.emitMsg({ type: 'status', gameActive: active, modVersion, companionVersion: 'ftp' });
  }

  async tick() {
    if (this.stopped || this.busy) return;
    this.busy = true;
    try {
      if (!this.client || this.client.closed) {
        this.client = await connect(this.cfg);
        this.dirs = await resolveDirs(this.client, this.cfg);
        await this.client.ensureDir(this.dirs.modDir);
        await this.client.cd('/');
        this.log(`FTP verbonden (${this.dirs.modDir})`);
        this.dirty = true;
      }
      if (this.dirty) {
        await upload(this.client, `${this.dirs.modDir}/inbox.xml`, buildInbox(this.epoch, this.commands));
        this.dirty = false;
      }
      await this.readOutbox();
      this.failures = 0;
    } catch (e) {
      this.failures = (this.failures || 0) + 1;
      if (this.failures === 1 || this.failures % 20 === 0) this.log(`FTP-fout: ${e.message}`);
      if (this.client) this.client.close();
      this.client = null;
      if (this.failures >= 3) this.setGame(false);
    } finally {
      this.busy = false;
      if (!this.stopped) this.timer = setTimeout(() => this.tick(), this.failures ? Math.min(30_000, POLL_MS * 2 ** this.failures) : POLL_MS);
    }
  }

  async readOutbox() {
    let xml;
    try { xml = await download(this.client, `${this.dirs.modDir}/outbox.xml`); }
    catch { this.setGame(false); return; } // mod heeft nog niet gedraaid
    const root = xml.match(/<outbox\b([^>]*)>/);
    if (!root) return;
    const head = attrs(root[1]);

    // Hartslag: "beat" telt op zolang de server draait en niet gepauzeerd is.
    const beat = head.beat ?? head.time;
    const now = Date.now();
    if (beat !== this.lastBeat) {
      const first = this.lastBeat === null;
      this.lastBeat = beat;
      this.lastBeatChange = now;
      if (!first) this.setGame(true, head.version);
    } else if (now - this.lastBeatChange > INACTIVE_MS) {
      this.setGame(false);
    }

    if (head.epoch !== this.epoch) return;
    const lastId = Number(head.lastId || 0);
    const before = this.commands.length;
    this.commands = this.commands.filter(c => c.id > lastId);
    if (this.commands.length !== before) this.dirty = true;

    for (const m of xml.matchAll(/<result\b([^>]*)\/>/g)) {
      const r = attrs(m[1]);
      const key = `${this.epoch}:${r.id}`;
      if (this.sentResults.has(key)) continue;
      this.sentResults.add(key);
      this.emitMsg({ type: 'result', id: Number(r.id), status: r.status, msg: r.msg });
    }
  }
}

module.exports = { FtpLink, testConnection, installMod, buildInbox };
