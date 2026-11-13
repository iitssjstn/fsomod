// Simpele JSON-opslag. Ruim voldoende voor tientallen streamers.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'db.json');

let state = { users: {}, eventIds: [] };
let saveTimer = null;

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(FILE)) {
    try { state = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
    catch (e) { console.error('[db] kon db.json niet lezen:', e.message); }
  }
  state.users ||= {};
  state.eventIds ||= [];
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, FILE);
  }, 300);
}

function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
}

const getUser = id => state.users[id] || null;
const allUsers = () => Object.values(state.users);
const findUserBy = (key, value) => allUsers().find(u => u[key] === value) || null;

function upsertUser(id, fields) {
  state.users[id] = { ...(state.users[id] || { id }), ...fields };
  save();
  return state.users[id];
}

// Twitch kan hetzelfde event meerdere keren sturen; onthoud de laatste 2000 message-ids.
function seenEvent(messageId) {
  if (state.eventIds.includes(messageId)) return true;
  state.eventIds.push(messageId);
  if (state.eventIds.length > 2000) state.eventIds.splice(0, state.eventIds.length - 2000);
  save();
  return false;
}

module.exports = { load, save, flush, getUser, allUsers, findUserBy, upsertUser, seenEvent };
