// Nieuwste versies van de mod en het Windows-programma.
// In de Docker-image schrijft de workflow downloads/versions.json; lokaal lezen we de bronbestanden.
const fs = require('fs');
const path = require('path');

const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || path.join(__dirname, '..', 'downloads');
const REPO = path.join(__dirname, '..', '..');

function fromSource() {
  const out = {};
  try {
    const lua = fs.readFileSync(path.join(REPO, 'mod', 'FS25_TwitchSabotage', 'scripts', 'TwitchSabotage.lua'), 'utf8');
    out.mod = (lua.match(/TwitchSabotage\.VERSION\s*=\s*"([^"]+)"/) || [])[1];
  } catch {}
  try {
    const props = fs.readFileSync(path.join(REPO, 'companion', 'Directory.Build.props'), 'utf8');
    out.app = (props.match(/<Version>([^<]+)<\/Version>/) || [])[1];
  } catch {}
  return out;
}

let cached = null;
function latest() {
  if (cached) return cached;
  try { cached = JSON.parse(fs.readFileSync(path.join(DOWNLOADS_DIR, 'versions.json'), 'utf8')); }
  catch { cached = fromSource(); }
  return cached;
}

// -1 als a ouder is dan b, 0 gelijk, 1 nieuwer. Onbekend = 0 (geen melding).
function compare(a, b) {
  if (!a || !b) return 0;
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  }
  return 0;
}

const isOutdated = (current, newest) => compare(current, newest) < 0;

module.exports = { latest, compare, isOutdated };
