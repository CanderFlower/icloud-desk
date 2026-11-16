import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal browser globals so ui.js / api.js can load in Node without a DOM.
globalThis.window ??= {
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  addEventListener: () => {},
  dispatchEvent: () => {},
};
globalThis.localStorage ??= globalThis.window.localStorage;
globalThis.document ??= { addEventListener: () => {}, visibilityState: 'hidden', documentElement: { dataset: {} } };
globalThis.matchMedia ??= () => ({ matches: false, addEventListener: () => {} });

const { pickDefaultCal } = await import('../web/js/modules/calendar.js');

const cals = [
  { guid: 'top-work', title: '工作', is_default: false },
  { guid: 'mid-study', title: '学习', is_default: false },
  { guid: 'bottom-home', title: '个人', is_default: true },
];

test('pickDefaultCal prefers last used calendar over Apple is_default at bottom', () => {
  assert.equal(pickDefaultCal(cals, new Set(), 'top-work'), 'top-work');
  assert.equal(pickDefaultCal(cals, new Set(['top-work']), 'top-work'), 'top-work');
});

test('pickDefaultCal falls back to visible is_default when lastGuid is absent or deleted', () => {
  assert.equal(pickDefaultCal(cals, new Set(), null), 'bottom-home');
  assert.equal(pickDefaultCal(cals, new Set(), 'deleted-guid'), 'bottom-home');
  assert.equal(pickDefaultCal(cals, new Set(['bottom-home']), null), 'top-work');
});
