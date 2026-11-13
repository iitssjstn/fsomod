// Alle sabotage-acties. De `id` moet exact overeenkomen met de handler in de FS25-mod
// (mod/FS25_TwitchSabotage/scripts/TwitchSabotage.lua).
//
// bits    = minimaal aantal bits (0 = niet via bits)
// points  = kosten in channel points (0 = geen beloning aanmaken)
// cooldown = cooldown van de channel-points-beloning in seconden
// param   = optionele waarde voor de actie (percentage, bedrag, seconden...)
// keyword = wat een kijker in zijn cheer-bericht typt, bijv. "cheer100 !motor"

const ACTIONS = [
  // --- Motor & rijden ---
  { id: 'engine_off',     keyword: 'motor',     label: 'Motor uit',             desc: 'Zet de motor van de trekker uit.',                          bits: 100,  points: 1000,  cooldown: 60,  enabled: true },
  { id: 'engine_lock',    keyword: 'blokkade',  label: 'Motorblokkade',         desc: 'Motor gaat uit en blijft X seconden uit.',                  bits: 300,  points: 3000,  cooldown: 180, enabled: true, param: 20, paramLabel: 'seconden' },
  { id: 'cruise_max',     keyword: 'turbo',     label: 'Turbo cruise control',  desc: 'Cruise control vol aan op topsnelheid.',                    bits: 150,  points: 1500,  cooldown: 90,  enabled: true },
  { id: 'cruise_slow',    keyword: 'slak',      label: 'Slakkengang',           desc: 'Cruise control op X km/u.',                                 bits: 100,  points: 1000,  cooldown: 90,  enabled: true, param: 3, paramLabel: 'km/u' },
  { id: 'kick_out',       keyword: 'eruit',     label: 'Eruit gegooid',         desc: 'Gooit de speler uit het voertuig.',                         bits: 250,  points: 2500,  cooldown: 180, enabled: true },
  { id: 'fuel_leak',      keyword: 'lek',       label: 'Brandstoflek',          desc: 'Haalt X% brandstof uit de tank.',                           bits: 200,  points: 2000,  cooldown: 120, enabled: true, param: 25, paramLabel: '% brandstof' },
  { id: 'fuel_empty',     keyword: 'leeg',      label: 'Tank leeg',             desc: 'Tank bijna helemaal leeg (5% over).',                       bits: 1000, points: 10000, cooldown: 600, enabled: true },
  { id: 'damage',         keyword: 'schade',    label: 'Schade',                desc: 'Voegt X% schade toe aan trekker en werktuigen.',            bits: 200,  points: 2000,  cooldown: 120, enabled: true, param: 20, paramLabel: '% schade' },
  { id: 'dirt',           keyword: 'modder',    label: 'Modderbad',             desc: 'Maakt alles helemaal vies.',                                bits: 50,   points: 500,   cooldown: 60,  enabled: true },

  // --- Werktuigen ---
  { id: 'detach_one',     keyword: 'los',       label: 'Werktuig ontkoppelen',  desc: 'Ontkoppelt een willekeurig werktuig.',                      bits: 200,  points: 2000,  cooldown: 120, enabled: true },
  { id: 'detach_all',     keyword: 'allesLos',  label: 'Alles ontkoppelen',     desc: 'Ontkoppelt alle werktuigen.',                               bits: 500,  points: 5000,  cooldown: 300, enabled: true },
  { id: 'implement_off',  keyword: 'uit',       label: 'Werktuig uit',          desc: 'Zet alle werktuigen uit (aftakas stopt).',                  bits: 100,  points: 1000,  cooldown: 60,  enabled: true },
  { id: 'implement_lift', keyword: 'omhoog',    label: 'Werktuig omhoog/omlaag',desc: 'Heft alle werktuigen op of laat ze zakken.',                bits: 100,  points: 1000,  cooldown: 60,  enabled: true },
  { id: 'fold_toggle',    keyword: 'klap',      label: 'In-/uitklappen',        desc: 'Klapt werktuigen in of uit.',                               bits: 150,  points: 1500,  cooldown: 90,  enabled: true },
  { id: 'cargo_loss',     keyword: 'lading',    label: 'Lading kwijt',          desc: 'X% van de lading (aanhanger, zaaimachine, spuit) verdwijnt.', bits: 500, points: 5000, cooldown: 300, enabled: true, param: 50, paramLabel: '% lading' },

  // --- Licht & geluid ---
  { id: 'lights_off',     keyword: 'donker',    label: 'Lichten uit',           desc: 'Zet alle lichten uit.',                                     bits: 50,   points: 500,   cooldown: 60,  enabled: true },
  { id: 'disco',          keyword: 'disco',     label: 'Disco',                 desc: 'Zwaailichten, alarmlichten en knipperende lampen.',         bits: 100,  points: 800,   cooldown: 90,  enabled: true, param: 20, paramLabel: 'seconden' },
  { id: 'honk',           keyword: 'toet',      label: 'Toeteren',              desc: 'Toetert X seconden lang.',                                  bits: 25,   points: 300,   cooldown: 30,  enabled: true, param: 4, paramLabel: 'seconden' },

  // --- Boerderij & wereld ---
  { id: 'money_loss',     keyword: 'boete',     label: 'Boete',                 desc: 'Haalt geld van de boerderij af.',                           bits: 300,  points: 3000,  cooldown: 180, enabled: true, param: 5000, paramLabel: 'euro' },
  { id: 'time_warp',      keyword: 'tijd',      label: 'Tijdsprong',            desc: 'Tijd gaat X seconden lang op 120x snelheid.',               bits: 300,  points: 3000,  cooldown: 300, enabled: true, param: 20, paramLabel: 'seconden' },
  { id: 'message',        keyword: 'bericht',   label: 'Bericht op scherm',     desc: 'Toont het bericht van de kijker groot in beeld.',           bits: 0,    points: 200,   cooldown: 30,  enabled: true, userInput: true },
  { id: 'random',         keyword: 'random',    label: 'Willekeurige sabotage', desc: 'Kiest een willekeurige andere actie.',                      bits: 150,  points: 1500,  cooldown: 60,  enabled: true },

  // --- Hulp (standaard uit) ---
  { id: 'money_gift',     keyword: 'cadeau',    label: 'Geldcadeau',            desc: 'Geeft geld aan de boerderij.',                              bits: 0,    points: 0,     cooldown: 300, enabled: false, param: 5000, paramLabel: 'euro' },
  { id: 'repair',         keyword: 'repareer',  label: 'Reparatie',             desc: 'Repareert en wast alles.',                                  bits: 0,    points: 0,     cooldown: 300, enabled: false },
  { id: 'refuel',         keyword: 'tanken',    label: 'Gratis tanken',         desc: 'Tank weer vol.',                                            bits: 0,    points: 0,     cooldown: 300, enabled: false },
];

const BY_ID = Object.fromEntries(ACTIONS.map(a => [a.id, a]));

function defaultConfig() {
  const actions = {};
  for (const a of ACTIONS) {
    actions[a.id] = {
      enabled: a.enabled,
      bits: a.bits,
      points: a.points,
      cooldown: a.cooldown,
      param: a.param ?? null,
    };
  }
  return {
    actions,
    bitsMode: 'highest',   // 'highest' | 'random' | 'keyword_only'
    gapSeconds: 5,         // minimale tijd tussen twee sabotages in de game
    pauseWhenOffline: true // channel-points-beloningen pauzeren als de game niet draait
  };
}

// Vult ontbrekende acties aan (bijv. na een update met nieuwe acties).
function mergeConfig(cfg) {
  const def = defaultConfig();
  if (!cfg) return def;
  const out = { ...def, ...cfg, actions: { ...def.actions } };
  for (const id of Object.keys(def.actions)) {
    if (cfg.actions && cfg.actions[id]) out.actions[id] = { ...def.actions[id], ...cfg.actions[id] };
  }
  return out;
}

module.exports = { ACTIONS, BY_ID, defaultConfig, mergeConfig };
