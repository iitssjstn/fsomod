const { test } = require('node:test');
const assert = require('node:assert');
const { pickForBits } = require('../src/engine');
const { defaultConfig, mergeConfig, ACTIONS } = require('../src/actions');

test('keyword wint als er genoeg bits zijn', () => {
  const cfg = defaultConfig();
  assert.equal(pickForBits(cfg, 1000, 'Cheer1000 !motor').id, 'engine_off');
});

test('keyword met te weinig bits valt terug op duurste die past', () => {
  const cfg = defaultConfig();
  const a = pickForBits(cfg, 100, 'Cheer100 !leeg');
  assert.equal(cfg.actions[a.id].bits, 100);
});

test('keyword_only zonder woord doet niets', () => {
  const cfg = { ...defaultConfig(), bitsMode: 'keyword_only' };
  assert.equal(pickForBits(cfg, 5000, 'Cheer5000'), null);
});

test('te weinig bits voor alles → null', () => {
  assert.equal(pickForBits(defaultConfig(), 1, 'Cheer1'), null);
});

test('uitgeschakelde acties worden nooit gekozen', () => {
  const cfg = defaultConfig();
  for (const id of Object.keys(cfg.actions)) cfg.actions[id].enabled = id === 'honk';
  assert.equal(pickForBits(cfg, 10000, 'Cheer10000 !motor').id, 'honk');
});

test('mergeConfig vult nieuwe acties aan', () => {
  const merged = mergeConfig({ actions: { honk: { enabled: false, bits: 1, points: 2, cooldown: 3 } }, gapSeconds: 9 });
  assert.equal(merged.gapSeconds, 9);
  assert.equal(merged.actions.honk.enabled, false);
  assert.equal(Object.keys(merged.actions).length, ACTIONS.length);
});

test('alle keywords zijn uniek', () => {
  const kws = ACTIONS.map(a => a.keyword.toLowerCase());
  assert.equal(new Set(kws).size, kws.length);
});
