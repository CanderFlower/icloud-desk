// Lightweight UI localization (`zh-CN` / `en`, plus `system` auto-detection).
// Works both in browser/WebView2 and in Node unit tests without DOM globals.

const STORAGE_KEY = 'icd.lang';

export const MONTHS_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
export const MONTHS_SHORT_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const WEEKDAYS_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
export const WEEKDAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAYS_LONG_ZH = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
export const WEEKDAYS_LONG_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function resolveLang(pref = 'system', navLang) {
  const p = String(pref || 'system').trim().replace('_', '-').toLowerCase();
  if (p.startsWith('zh')) return 'zh-CN';
  if (p.startsWith('en')) return 'en';
  const sys = String(navLang ?? globalThis.navigator?.language ?? 'zh-CN').replace('_', '-').toLowerCase();
  return sys.startsWith('zh') ? 'zh-CN' : 'en';
}

function readPref(storage) {
  try {
    const raw = (storage ?? globalThis.localStorage)?.getItem(STORAGE_KEY);
    if (!raw) return 'system';
    const parsed = JSON.parse(raw);
    return ['system', 'zh-CN', 'en'].includes(parsed) ? parsed : 'system';
  } catch {
    return 'system';
  }
}

function writePref(pref, storage) {
  try {
    (storage ?? globalThis.localStorage)?.setItem(STORAGE_KEY, JSON.stringify(pref));
  } catch { /* ignore storage errors */ }
}

export class I18n {
  constructor({ storage, navLang } = {}) {
    this._storage = storage;
    this._navLang = navLang;
    this._override = null;
  }

  get pref() {
    return this._override ?? readPref(this._storage);
  }

  get code() {
    return resolveLang(this.pref, this._navLang);
  }

  get isEn() {
    return this.code === 'en';
  }

  get isZh() {
    return this.code !== 'en';
  }

  set(pref) {
    const next = ['system', 'zh-CN', 'en'].includes(pref) ? pref : 'system';
    this._override = this._storage || globalThis.localStorage ? null : next;
    writePref(next, this._storage);
    this.apply();
  }

  apply() {
    const code = this.code;
    const pref = this.pref;
    if (globalThis.document?.documentElement) {
      globalThis.document.documentElement.lang = code;
    }
    try {
      globalThis.window?.chrome?.webview?.postMessage({ type: 'lang', lang: code, pref });
    } catch { /* not hosted in WebView2 */ }
    if (typeof globalThis.window?.dispatchEvent === 'function' && typeof globalThis.CustomEvent === 'function') {
      globalThis.window.dispatchEvent(new CustomEvent('langchange', { detail: { code, pref } }));
    }
    return code;
  }
}

export const lang = new I18n();

export const tx = (zh, en) => (lang.isEn ? en : zh);

export const countText = (n, zhUnit, enOne, enMany = `${enOne}s`) =>
  (lang.isEn ? `${n} ${n === 1 ? enOne : enMany}` : `${n} ${zhUnit}`);

export const quote = (s) => (lang.isEn ? `“${s}”` : `“${s}”`);
