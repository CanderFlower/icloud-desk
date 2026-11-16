import test from 'node:test';
import assert from 'node:assert/strict';
import { I18n, resolveLang } from '../web/js/i18n.js';

test('resolveLang handles explicit preferences and system fallbacks', () => {
  assert.equal(resolveLang('en', 'zh-CN'), 'en');
  assert.equal(resolveLang('zh-CN', 'en-US'), 'zh-CN');
  assert.equal(resolveLang('system', 'en-US'), 'en');
  assert.equal(resolveLang('system', 'fr-FR'), 'en');
  assert.equal(resolveLang('system', 'zh-Hans-CN'), 'zh-CN');
  assert.equal(resolveLang('system', 'zh-TW'), 'zh-CN');
});

test('I18n persists preference and applies document lang and WebView2 message', () => {
  const store = new Map();
  const storage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };
  const posted = [];
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  globalThis.document = { documentElement: { lang: 'zh-CN' } };
  globalThis.window = {
    chrome: { webview: { postMessage: (msg) => posted.push(msg) } },
    dispatchEvent: () => {},
  };
  try {
    const i18n = new I18n({ storage, navLang: 'zh-CN' });
    assert.equal(i18n.pref, 'system');
    assert.equal(i18n.code, 'zh-CN');
    assert.equal(i18n.isZh, true);

    i18n.set('en');
    assert.equal(i18n.pref, 'en');
    assert.equal(i18n.code, 'en');
    assert.equal(i18n.isEn, true);
    assert.equal(globalThis.document.documentElement.lang, 'en');
    assert.deepEqual(posted.at(-1), { type: 'lang', lang: 'en', pref: 'en' });

    const reloaded = new I18n({ storage, navLang: 'zh-CN' });
    assert.equal(reloaded.pref, 'en');
    assert.equal(reloaded.code, 'en');
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  }
});
