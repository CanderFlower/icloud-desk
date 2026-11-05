// Small DOM + UI helpers shared by all modules.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export function toast(message, type = 'info', ms = 3200) {
  const box = document.getElementById('toasts');
  const t = h('div', { class: `toast ${type}` }, message);
  box.append(t);
  setTimeout(() => t.classList.add('hide'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

export function toastError(err) {
  console.error(err);
  toast(err?.message || String(err), 'error', 5000);
}

// Generic dialog. Action onClick may return false to keep the dialog open.
export function modal({ title, body, actions = [], width, onClose }) {
  const close = () => {
    if (!overlay.isConnected) return;
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const footer = h('div', { class: 'modal-footer' });
  const dialog = h('div', { class: 'modal', style: width ? { width } : undefined },
    h('div', { class: 'modal-header' }, h('h3', {}, title), h('button', { class: 'icon-btn', onclick: close, title: '关闭' }, '✕')),
    h('div', { class: 'modal-body' }, body),
    footer,
  );
  for (const a of actions) {
    const btn = h('button', { class: `btn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''}`, style: a.left ? { marginRight: 'auto' } : undefined, disabled: !!a.disabled }, a.label);
    btn.addEventListener('click', async () => {
      if (!a.onClick) return close();
      btn.disabled = true;
      try {
        const keep = await a.onClick({ close, button: btn });
        if (keep !== false) close();
      } catch (e) {
        toastError(e);
      } finally {
        btn.disabled = false;
      }
    });
    footer.append(btn);
  }
  if (!actions.length) footer.remove();
  const overlay = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === overlay) close(); } }, dialog);
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
  setTimeout(() => dialog.querySelector('.modal-body input:not([type=checkbox]),.modal-body textarea')?.focus(), 30);
  return { close, dialog };
}

export function confirmDialog(message, { title = '确认', okLabel = '确定', danger = false } = {}) {
  return new Promise((resolve) => {
    let result = false;
    modal({
      title,
      body: h('p', {}, message),
      onClose: () => resolve(result),
      actions: [
        { label: '取消' },
        { label: okLabel, primary: !danger, danger, onClick: () => { result = true; } },
      ],
    });
  });
}

export function promptDialog(title, value = '', { placeholder = '' } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const input = h('input', { class: 'input', value, placeholder });
    const m = modal({
      title,
      body: input,
      onClose: () => resolve(result),
      actions: [{ label: '取消' }, { label: '确定', primary: true, onClick: () => { result = input.value.trim() || null; } }],
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { result = input.value.trim() || null; m.close(); } });
  });
}

export function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('small', { class: 'hint' }, hint) : null);
}

export function spinner(text = '加载中…') {
  return h('div', { class: 'loading' }, h('div', { class: 'spin' }), text);
}

export function empty(text, icon = '') {
  return h('div', { class: 'empty' }, icon ? h('div', { class: 'empty-icon' }, icon) : null, text);
}

// Run an async loader and show spinner / error in the target element.
export async function load(el, fn) {
  clear(el, spinner());
  try {
    await fn();
  } catch (e) {
    clear(el, h('div', { class: 'error-box' }, '加载失败：', e.message || String(e)));
    console.error(e);
  }
}

const pad = (n) => String(n).padStart(2, '0');

export function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { const [y, m, d] = v.split('-').map(Number); return new Date(y, m - 1, d); }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) {
    const [date, time] = v.split('T'); const [y, m, d] = date.split('-').map(Number); const [hh, mm] = time.split(':').map(Number);
    return new Date(y, m - 1, d, hh, mm);
  }
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

export const fmt = {
  pad,
  bytes(n) {
    if (n === null || n === undefined) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let v = Number(n);
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  },
  date(d) { d = toDate(d); return d ? `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}` : ''; },
  time(d) { d = toDate(d); return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : ''; },
  datetime(d) { d = toDate(d); return d ? `${fmt.date(d)} ${fmt.time(d)}` : ''; },
  smart(d) {
    d = toDate(d); if (!d) return '';
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return fmt.time(d);
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
    return fmt.date(d);
  },
  isoDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; },
  isoLocal(d) { return `${fmt.isoDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; },
};

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export const store = {
  get(key, fallback) { try { const v = localStorage.getItem(`icd.${key}`); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { localStorage.setItem(`icd.${key}`, JSON.stringify(value)); },
};

// Trigger a browser download for a backend URL.
export function download(url) {
  const a = h('a', { href: url, download: '' });
  document.body.append(a);
  a.click();
  a.remove();
}
