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

const { pickDefaultCal, dayTimedLayout } = await import('../web/js/modules/calendar.js');

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

test('cross-midnight timed events split across day columns instead of going to all-day', () => {
  const evs = [
    { guid: 'all-day', all_day: true, s: new Date(2026, 10, 16), e: new Date(2026, 10, 17) },
    { guid: 'jazz', all_day: false, s: new Date(2026, 10, 16, 22, 15), e: new Date(2026, 10, 17, 1, 0) },
    { guid: 'gym', all_day: false, s: new Date(2026, 10, 16, 23, 30), e: new Date(2026, 10, 17, 0, 0) },
  ];

  const mon = dayTimedLayout(evs, new Date(2026, 10, 16));
  assert.equal(mon.length, 2);
  const jazzMon = mon.find((x) => x.ev.guid === 'jazz');
  const gymMon = mon.find((x) => x.ev.guid === 'gym');
  assert.equal(jazzMon.startMin, 22 * 60 + 15);
  assert.equal(jazzMon.endMin, 1440);
  assert.equal(jazzMon.contStart, false);
  assert.equal(jazzMon.contEnd, true);
  assert.equal(jazzMon.cols, 2);
  assert.equal(gymMon.cols, 2);

  const tue = dayTimedLayout(evs, new Date(2026, 10, 17));
  assert.equal(tue.length, 1);
  assert.equal(tue[0].ev.guid, 'jazz');
  assert.equal(tue[0].startMin, 0);
  assert.equal(tue[0].endMin, 60);
  assert.equal(tue[0].contStart, true);
  assert.equal(tue[0].contEnd, false);
  assert.equal(tue[0].cols, 1);
});
