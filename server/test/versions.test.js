const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fs25ver-'));
const db = require('../src/db');
db.load();
const engine = require('../src/engine');
const versions = require('../src/versions');

test('versies vergelijken', () => {
  assert.equal(versions.isOutdated('1.0.0', '1.1.0'), true);
  assert.equal(versions.isOutdated('1.1.0', '1.1.0'), false);
  assert.equal(versions.isOutdated('1.10.0', '1.9.0'), false);
  assert.equal(versions.isOutdated('1.1', '1.1.0'), false);
  assert.equal(versions.isOutdated(null, '1.1.0'), false); // onbekend = geen melding
});

test('nieuwste versies komen uit de bronbestanden', () => {
  const l = versions.latest();
  assert.match(l.mod, /^\d+\.\d+\.\d+$/);
  assert.match(l.app, /^\d+\.\d+\.\d+$/);
});

function fakeLink() {
  const ws = new EventEmitter();
  ws.sent = [];
  ws.send = m => ws.sent.push(JSON.parse(m));
  ws.close = () => ws.emit('close');
  return ws;
}

test('oude mod en oud Windows-programma worden gemeld; hello bevat nieuwste versie', () => {
  const user = db.upsertUser('v1', { displayName: 'V', cmdEpoch: 'e' });
  const ws = fakeLink();
  engine.attachCompanion(user, ws);
  assert.equal(ws.sent[0].type, 'hello');
  assert.equal(ws.sent[0].latestApp, versions.latest().app);
  ws.emit('message', JSON.stringify({ type: 'status', gameActive: true, modVersion: '1.0.0', companionVersion: '1.0.0' }));
  let s = engine.publicStatus('v1');
  assert.equal(s.modOutdated, true);
  assert.equal(s.appOutdated, true);
  ws.emit('message', JSON.stringify({ type: 'status', gameActive: true, modVersion: versions.latest().mod, companionVersion: versions.latest().app }));
  s = engine.publicStatus('v1');
  assert.equal(s.modOutdated, false);
  assert.equal(s.appOutdated, false);
});

test('via FTP wordt nooit "Windows-programma verouderd" gemeld', () => {
  const user = db.upsertUser('v2', { displayName: 'F', cmdEpoch: 'e' });
  const link = fakeLink();
  engine.attachCompanion(user, link, 'Gameserver (FTP)');
  link.emit('message', JSON.stringify({ type: 'status', gameActive: true, modVersion: '1.0.0', companionVersion: 'ftp' }));
  const s = engine.publicStatus('v2');
  assert.equal(s.linkKind, 'ftp');
  assert.equal(s.modOutdated, true);
  assert.equal(s.appOutdated, false);
});
