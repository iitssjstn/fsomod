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
  state.settings ||= {};
  // Interne geheimen worden automatisch aangemaakt; niemand hoeft ze in te stellen.
  const crypto = require('crypto');
  if (!state.settings.sessionSecret) state.settings.sessionSecret = crypto.randomBytes(32).toString('hex');
  if (!state.settings.eventsubSecret) state.settings.eventsubSecret = crypto.randomBytes(32).toString('hex');
  save();
}

// Instellingen die de beheerder via /admin invult (Twitch-keys, admin-wachtwoord, optioneel basisadres).
const getSettings = () => state.settings;
function updateSettings(fields) {
  state.settings = { ...state.settings, ...fields };
  save();
  return state.settings;
}
const isConfigured = () => !!(state.settings.clientId && state.settings.clientSecret && state.settings.adminHash);

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

function deleteUser(id) {
  delete state.users[id];
  save();
}

module.exports = { load, save, flush, getUser, allUsers, findUserBy, upsertUser, deleteUser, seenEvent, getSettings, updateSettings, isConfigured };
