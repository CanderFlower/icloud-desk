// Shared DOM + UI kit for all modules. See README "前端开发" for conventions.
//   h('div', {class, onclick, ...}, ...children)  – element factory
//   icon('trash-2')                                 – Lucide icon from assets/icons.svg
//   appIcon('notes')                                – real iCloud app icon (light/dark)
//   menu(eventOrEl, items) / modal() / confirmDialog() / promptDialog() / toast()

import { lang, tx, MONTHS_SHORT_EN, WEEKDAYS_ZH, WEEKDAYS_EN } from './i18n.js';

// ------------------------------------------------------------------ DOM
export function h(tag, attrs = {}, ...children) {
  const svg = tag === 'svg' || tag === 'use' || attrs?.__svg;
  const el = svg ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false || k === '__svg') continue;
    if (k === 'class') svg ? el.setAttribute('class', v) : (el.className = v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sv === undefined || sv === null) continue;
        if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv;
      }
    } else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'ref' && typeof v === 'function') v(el);
    else if (!svg && k in el && typeof v !== 'string') el[k] = v;
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

// ---------------------------------------------------------------- icons
export async function loadIcons() {
  if (document.getElementById('icon-sprite')) return;
  const text = await (await fetch('/assets/icons.svg')).text();
  const box = h('div', { id: 'icon-sprite', html: text, style: { display: 'none' } });
  document.body.prepend(box);
}

/** Lucide icon. size: 'sm' | 'lg' | 'xl' | number(px). */
export function icon(name, { size, cls = '', title } = {}) {
  const s = h('svg', { class: `ic ${typeof size === 'string' ? size : ''} ${cls}`.trim(), 'aria-hidden': title ? undefined : 'true' },
    h('use', { href: `#i-${name}` }));
  if (typeof size === 'number') { s.style.width = `${size}px`; s.style.height = `${size}px`; }
  if (title) s.append(h('title', { __svg: true }, title));
  return s;
}

const WEEKDAYS = WEEKDAYS_ZH;

/** Real iCloud app icon (assets/apps/<id>.png + -dark.png). Calendar is drawn live. */
export function appIcon(id, size = 24) {
  if (id === 'calendar') return calendarIcon(new Date(), size);
  return h('span', { class: 'app-icon', style: { width: `${size}px`, height: `${size}px` } },
    h('img', { class: 'light', src: `/assets/apps/${id}.png`, alt: '', draggable: false }),
    h('img', { class: 'dark', src: `/assets/apps/${id}-dark.png`, alt: '', draggable: false }));
}

export function calendarIcon(date = new Date(), size = 24) {
  const wd = lang.isEn ? WEEKDAYS_EN[date.getDay()].toUpperCase() : WEEKDAYS_ZH[date.getDay()].slice(1);
  return h('span', { class: 'cal-icon', style: { width: `${size}px`, height: `${size}px`, '--s': `${size}px` } },
    h('span', { class: 'wd' }, wd),
    h('span', { class: 'd' }, date.getDate()));
}

// ------------------------------------------------------------- controls
/** Button. btn('保存', {kind:'primary', icon:'check', onclick}) */
export function btn(label, { kind = '', icon: ic, onclick, title, size = '', type = 'button', disabled } = {}) {
  return h('button', { class: `btn ${kind} ${size}`.trim(), type, onclick, title, disabled },
    ic ? icon(ic) : null, label ?? null);
}

/** Icon-only button with a tooltip. */
export function iconBtn(ic, tip, onclick, { cls = '', disabled, size } = {}) {
  return h('button', { class: `icon-btn ${cls} ${size || ''}`.trim(), type: 'button', 'data-tip': tip, 'aria-label': tip, onclick, disabled }, icon(ic));
}

/** Segmented control. options: [{value, label, icon, tip}] */
export function segmented(options, value, onChange, { cls = '' } = {}) {
  const el = h('div', { class: `seg ${cls}`, role: 'tablist' });
  const render = (v) => {
    el.replaceChildren(...options.map((o) => h('button', {
      type: 'button', class: o.value === v ? 'on' : '', role: 'tab', 'data-tip': o.tip,
      onclick: () => { if (o.value !== el.value) { render(o.value); onChange?.(o.value); } },
    }, o.icon ? icon(o.icon, { size: 'sm' }) : null, o.label ?? null)));
    el.value = v;
  };
  render(value);
  el.set = render;
  return el;
}

/** Search box with icon + clear. oninput gets debounced value. */
export function searchBox({ placeholder, oninput, delay = 200, value = '' } = {}) {
  const input = h('input', { class: 'input', type: 'search', placeholder: placeholder ?? tx('搜索', 'Search'), value, spellcheck: false });
  const fire = debounce(() => oninput?.(input.value.trim()), delay);
  input.addEventListener('input', fire);
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && input.value) { e.stopPropagation(); input.value = ''; fire(); } });
  const el = h('label', { class: 'search' }, icon('search'), input);
  el.input = input;
  return el;
}

export function switchEl(checked, onchange) {
  const input = h('input', { type: 'checkbox', checked: !!checked, onchange: () => onchange?.(input.checked) });
  const el = h('label', { class: 'switch' }, input, h('span'));
  el.input = input;
  return el;
}

export function field(label, control, hint) {
  return h('label', { class: 'field' }, label ? h('span', { class: 'field-label' }, label) : null, control, hint ? h('small', { class: 'hint' }, hint) : null);
}

/** Standard module toolbar. */
export function toolbar({ title, subtitle, left = [], right = [], cls = '' } = {}) {
  const t = h('div', { class: 'title' }, title ?? '');
  const el = h('div', { class: `toolbar ${cls}` },
    h('button', { class: 'icon-btn menu-toggle', 'aria-label': tx('菜单', 'Menu'), onclick: () => window.dispatchEvent(new Event('toggle-drawer')) }, icon('panel-left')),
    left, t, subtitle ? h('div', { class: 'subtitle' }, subtitle) : null,
    h('div', { class: 'tools' }, right));
  el.setTitle = (s) => { t.textContent = s; };
  return el;
}

export const COLORS = [
  ['red', '#ff3b30'], ['orange', '#ff9500'], ['yellow', '#ffcc00'], ['green', '#34c759'],
  ['blue', '#007aff'], ['purple', '#af52de'], ['brown', '#a2845e'], ['gray', '#8e8e93'],
];
export function colorSwatches(value, onChange) {
  const el = h('div', { class: 'color-swatches' });
  const render = (v) => el.replaceChildren(...COLORS.map(([name, c]) => h('button', {
    type: 'button', class: c.toLowerCase() === (v || '').toLowerCase() ? 'on' : '', style: { '--c': c }, title: name,
    onclick: () => { render(c); el.value = c; onChange?.(c); },
  })));
  el.value = value; render(value);
  return el;
}

// --------------------------------------------------------- feedback
const TOAST_ICONS = { success: 'circle-check', error: 'circle-alert', info: 'info' };
/** toast(msg, type?, ms | {ms, action:{label,onClick}}) */
export function toast(message, type = 'info', opt = 3200) {
  const o = typeof opt === 'number' ? { ms: opt } : { ms: 3200, ...opt };
  const box = document.getElementById('toasts');
  const t = h('div', { class: `toast ${type}`, role: 'status' }, icon(TOAST_ICONS[type] || 'info'), h('div', { class: 'msg' }, message));
  if (o.action) t.append(h('button', { class: 'btn sm', onclick: () => { o.action.onClick(); dismiss(); } }, o.action.label));
  box.append(t);
  let timer = setTimeout(dismiss, o.ms);
  t.addEventListener('mouseenter', () => clearTimeout(timer));
  t.addEventListener('mouseleave', () => { timer = setTimeout(dismiss, 1500); });
  function dismiss() { t.classList.add('hide'); setTimeout(() => t.remove(), 320); }
  return dismiss;
}

export function toastError(err) {
  console.error(err);
  toast(err?.message || String(err), 'error', 5200);
}

export function spinner(text) {
  return h('div', { class: 'loading' }, h('div', { class: 'spin' }), text ?? tx('加载中…', 'Loading…'));
}

export function skeleton(rows = 6, { avatar = true } = {}) {
  return h('div', { class: 'skeleton-rows' }, Array.from({ length: rows }, () => h('div', { class: 'skeleton-row' },
    avatar ? h('div', { class: 'a skeleton' }) : null,
    h('div', { class: 'l' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' })))));
}

/** empty('没有内容') or empty({icon:'inbox', title, text, action:{label, icon, onClick}, app:'notes'}) */
export function empty(opts, legacyIcon) {
  const o = typeof opts === 'string' ? { title: opts } : opts;
  const ic = o.app ? h('div', { class: 'empty-icon', style: { background: 'none' } }, appIcon(o.app, 56))
    : (o.icon || legacyIcon) ? h('div', { class: 'empty-icon' }, icon(o.icon || 'inbox')) : null;
  return h('div', { class: `empty ${o.compact ? 'compact' : ''}` }, ic,
    o.title ? h('div', { class: 'empty-title' }, o.title) : null,
    o.text ? h('div', { class: 'empty-text' }, o.text) : null,
    o.action ? btn(o.action.label, { kind: 'tinted', icon: o.action.icon, onclick: o.action.onClick }) : null);
}

export function errorBox(e) {
  return h('div', { class: 'error-box' }, icon('circle-alert'), h('div', {}, h('div', { class: 'strong' }, tx('加载失败', 'Failed to load')), h('div', { class: 'small' }, e?.message || String(e))));
}

/** Run an async loader showing a spinner/skeleton then error in the target element. */
export async function load(el, fn, { placeholder } = {}) {
  clear(el, placeholder ?? spinner());
  try {
    await fn();
  } catch (e) {
    clear(el, errorBox(e));
    console.error(e);
  }
}

// ---------------------------------------------------------------- modal
/**
 * modal({title, subtitle, body, actions:[{label, primary, danger, left, onClick}], size:'sm'|'lg'|'xl', width, onClose})
 * An action's onClick may return false to keep the dialog open. Ctrl+Enter triggers the primary action.
 */
export function modal({ title, subtitle, body, actions = [], width, size = '', onClose, cls = '', closeButton = true }) {
  const prevFocus = document.activeElement;
  const close = () => {
    if (!overlay.isConnected) return;
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
    prevFocus?.focus?.();
  };
  let primaryBtn = null;
  const onKey = (e) => {
    if (overlay !== [...document.querySelectorAll('.overlay')].pop()) return;
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && primaryBtn) { e.preventDefault(); primaryBtn.click(); }
  };
  const footer = h('div', { class: 'modal-footer' });
  const dialog = h('div', { class: `modal ${size} ${cls}`.trim(), role: 'dialog', 'aria-modal': 'true', style: width ? { width } : undefined },
    title || closeButton ? h('div', { class: 'modal-header' },
      h('h3', {}, title ?? '', subtitle ? h('div', { class: 'sub' }, subtitle) : null),
      closeButton && !cls.includes('alert') ? iconBtn('x', tx('关闭 (Esc)', 'Close (Esc)'), close, { size: 'sm' }) : null) : null,
    h('div', { class: 'modal-body' }, body),
    footer);
  for (const a of actions) {
    const b = h('button', { type: 'button', class: `btn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''} ${a.left ? 'left' : ''} ${a.kind || ''}`, disabled: !!a.disabled },
      a.icon ? icon(a.icon) : null, a.label);
    if (a.primary || (a.danger && !primaryBtn)) primaryBtn = b;
    b.addEventListener('click', async () => {
      if (!a.onClick) return close();
      b.disabled = true;
      try {
        const keep = await a.onClick({ close, button: b });
        if (keep !== false) close();
      } catch (e) {
        toastError(e);
      } finally {
        b.disabled = false;
      }
    });
    footer.append(b);
  }
  if (!actions.length) footer.remove();
  const overlay = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === overlay) close(); } }, dialog);
  document.body.append(overlay);
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => (dialog.querySelector('[autofocus]') || dialog.querySelector('.modal-body input:not([type=checkbox]):not([type=radio]),.modal-body textarea,.modal-body [contenteditable]') || primaryBtn)?.focus(), 30);
  return { close, dialog, footer };
}

/** Promise<boolean>. Alert-style confirmation. */
export function confirmDialog(message, { title, okLabel, cancelLabel, danger = false, icon: ic, detail } = {}) {
  return new Promise((resolve) => {
    let result = false;
    modal({
      title: title ?? tx('确认', 'Confirm'),
      cls: 'alert',
      body: h('div', {}, typeof message === 'string' ? h('p', {}, message) : message, detail ? h('p', { class: 'small faint' }, detail) : null),
      onClose: () => resolve(result),
      actions: [
        { label: cancelLabel ?? tx('取消', 'Cancel') },
        { label: okLabel ?? tx('确定', 'OK'), primary: !danger, danger, onClick: () => { result = true; } },
      ],
    });
    if (ic || danger) {
      const d = [...document.querySelectorAll('.modal.alert')].pop();
      d?.querySelector('.modal-header')?.prepend(h('div', { class: `alert-icon ${danger ? 'danger' : ''}` }, icon(ic || 'triangle-alert')));
      d?.querySelector('.modal-header')?.style.setProperty('flex-direction', 'column');
    }
  });
}

/** Promise<string|null>. */
export function promptDialog(title, value = '', { placeholder = '', label, okLabel, hint } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const input = h('input', { class: 'input', value, placeholder, spellcheck: false });
    const m = modal({
      title, size: 'sm',
      body: label || hint ? field(label, input, hint) : input,
      onClose: () => resolve(result),
      actions: [{ label: tx('取消', 'Cancel') }, { label: okLabel ?? tx('确定', 'OK'), primary: true, onClick: () => { result = input.value.trim() || null; } }],
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { result = input.value.trim() || null; m.close(); } });
    setTimeout(() => input.select(), 40);
  });
}

// ---------------------------------------------------------------- menus
let openMenu = null;
function anchorRect(at) {
  if (at instanceof Event) return { left: at.clientX, right: at.clientX, top: at.clientY, bottom: at.clientY, point: true };
  if (at instanceof Element) return at.getBoundingClientRect();
  return { left: at.x, right: at.x, top: at.y, bottom: at.y, point: true };
}
function place(el, at, align = 'start') {
  const r = anchorRect(at);
  el.style.left = '0px'; el.style.top = '0px';
  const w = el.offsetWidth; const ht = el.offsetHeight;
  let x = align === 'end' && !r.point ? r.right - w : r.left;
  let y = r.point ? r.top : r.bottom + 4;
  if (x + w > innerWidth - 8) x = Math.max(8, (r.point ? r.left - w : innerWidth - w - 8));
  if (y + ht > innerHeight - 8) y = Math.max(8, (r.point ? r.top : r.top - 4) - ht);
  el.style.left = `${Math.max(8, x)}px`; el.style.top = `${y}px`;
}

/**
 * menu(eventOrElement, items, {align}) – context / dropdown menu.
 * items: [{label, icon, onClick, danger, disabled, checked, shortcut}] | '-' | {section:'标题'}
 */
export function menu(at, items, { align = 'start', onClose } = {}) {
  if (at instanceof Event) { at.preventDefault(); at.stopPropagation(); }
  closeMenu();
  const el = h('div', { class: 'menu', role: 'menu', tabindex: -1 });
  const hasChecks = items.some((i) => i && typeof i === 'object' && 'checked' in i);
  const rows = [];
  for (const it of items.filter(Boolean)) {
    if (it === '-') { el.append(h('div', { class: 'menu-sep' })); continue; }
    if (it.section) { el.append(h('div', { class: 'menu-label' }, it.section)); continue; }
    const row = h('div', { class: `menu-item ${it.danger ? 'danger' : ''} ${it.disabled ? 'disabled' : ''}`, role: 'menuitem',
      onclick: () => { closeMenu(); it.onClick?.(); } },
      hasChecks ? h('span', { class: 'check-mark' }, it.checked ? icon('check', { size: 'sm' }) : null) : null,
      it.icon ? icon(it.icon) : (it.dot ? h('span', { class: 'dot sm', style: { '--c': it.dot } }) : null),
      h('span', { class: 'label' }, it.label),
      it.shortcut ? h('span', { class: 'shortcut' }, it.shortcut) : null);
    if (!it.disabled) rows.push(row);
    el.append(row);
  }
  document.body.append(el);
  place(el, at, align);
  const anchorEl = at instanceof Element ? at : null;
  anchorEl?.classList.add('active');
  let idx = -1;
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      idx = (idx + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      rows.forEach((r, i) => r.classList.toggle('focus', i === idx));
    } else if (e.key === 'Enter' && idx >= 0) { e.preventDefault(); rows[idx].click(); }
  };
  const onDown = (e) => { if (!el.contains(e.target)) closeMenu(); };
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('resize', closeMenu);
  });
  openMenu = () => {
    el.remove(); anchorEl?.classList.remove('active');
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', closeMenu);
    window.removeEventListener('resize', closeMenu);
    onClose?.();
  };
  return el;
}
export function closeMenu() { const f = openMenu; openMenu = null; f?.(); }

/** Floating popover anchored to an element/event. Returns {el, close}. */
export function popover(at, content, { align = 'start', onClose, cls = '', width } = {}) {
  closeMenu();
  const el = h('div', { class: `popover ${cls}`, style: width ? { width } : undefined }, content);
  document.body.append(el);
  place(el, at, align);
  const close = () => {
    if (!el.isConnected) return;
    el.remove();
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const onDown = (e) => { if (!el.contains(e.target) && !e.target.closest('.menu,.overlay,.popover')) close(); };
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.overlay,.menu')) { e.stopPropagation(); close(); } };
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  });
  return { el, close, reposition: () => place(el, at, align) };
}

// -------------------------------------------------------------- tooltips
(function initTooltips() {
  let tip = null; let timer = null;
  const hide = () => { clearTimeout(timer); tip?.remove(); tip = null; };
  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest?.('[data-tip]');
    if (!t || !t.dataset.tip) return hide();
    if (tip && tip._for === t) return;
    hide();
    timer = setTimeout(() => {
      if (!t.isConnected) return;
      tip = h('div', { class: 'tip' }, t.dataset.tip);
      tip._for = t;
      document.body.append(tip);
      const r = t.getBoundingClientRect();
      let x = r.left + r.width / 2 - tip.offsetWidth / 2;
      x = Math.min(Math.max(6, x), innerWidth - tip.offsetWidth - 6);
      const y = r.bottom + 6 + tip.offsetHeight > innerHeight ? r.top - tip.offsetHeight - 6 : r.bottom + 6;
      tip.style.left = `${x}px`; tip.style.top = `${y}px`;
    }, 450);
  });
  document.addEventListener('mousedown', hide, true);
  window.addEventListener('blur', hide);
})();

// ------------------------------------------------------------ formatting
const pad = (n) => String(n).padStart(2, '0');

export function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { const [y, m, d] = v.split('-').map(Number); return new Date(y, m - 1, d); }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(v)) {
    const [date, time] = v.split('T'); const [y, m, d] = date.split('-').map(Number); const [hh, mm, ss] = time.split(':').map(Number);
    return new Date(y, m - 1, d, hh, mm, ss || 0);
  }
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export const fmt = {
  pad,
  get WEEKDAYS() { return lang.isEn ? WEEKDAYS_EN : WEEKDAYS_ZH; },
  bytes(n) {
    if (n === null || n === undefined || n === '') return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let v = Number(n);
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  },
  date(d) {
    d = toDate(d);
    if (!d) return '';
    return lang.isEn
      ? `${MONTHS_SHORT_EN[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
      : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  },
  shortDate(d) {
    d = toDate(d);
    if (!d) return '';
    return lang.isEn
      ? `${MONTHS_SHORT_EN[d.getMonth()]} ${d.getDate()}`
      : `${d.getMonth() + 1}月${d.getDate()}日`;
  },
  time(d) { d = toDate(d); return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : ''; },
  datetime(d) { d = toDate(d); return d ? `${fmt.date(d)} ${fmt.time(d)}` : ''; },
  weekday(d) { d = toDate(d); return d ? fmt.WEEKDAYS[d.getDay()] : ''; },
  /** 今天 14:30 / 昨天 / 周三 / 3月5日 / 2023年3月5日 */
  smart(d, { time = true } = {}) {
    d = toDate(d); if (!d) return '';
    const now = new Date();
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (sameDay(d, now)) return time ? fmt.time(d) : tx('今天', 'Today');
    if (sameDay(d, y)) return tx('昨天', 'Yesterday');
    const diff = (now - d) / 86400000;
    if (diff > 0 && diff < 6) return fmt.WEEKDAYS[d.getDay()];
    if (d.getFullYear() === now.getFullYear()) return fmt.shortDate(d);
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  },
  /** 今天 / 明天 / 昨天 / 周五 / 3月5日 — for due dates. */
  relDay(d) {
    d = toDate(d); if (!d) return '';
    const a = new Date(); a.setHours(0, 0, 0, 0);
    const b = new Date(d); b.setHours(0, 0, 0, 0);
    const n = Math.round((b - a) / 86400000);
    if (n === 0) return tx('今天', 'Today');
    if (n === 1) return tx('明天', 'Tomorrow');
    if (n === -1) return tx('昨天', 'Yesterday');
    if (n > 1 && n < 7) return fmt.WEEKDAYS[d.getDay()];
    return d.getFullYear() === a.getFullYear() ? fmt.shortDate(d) : fmt.date(d);
  },
  ago(d) {
    d = toDate(d); if (!d) return '';
    const s = (Date.now() - d) / 1000;
    if (s < 60) return tx('刚刚', 'Just now');
    if (s < 3600) { const m = Math.floor(s / 60); return tx(`${m} 分钟前`, `${m}m ago`); }
    if (s < 86400) { const hr = Math.floor(s / 3600); return tx(`${hr} 小时前`, `${hr}h ago`); }
    if (s < 86400 * 7) { const dy = Math.floor(s / 86400); return tx(`${dy} 天前`, `${dy}d ago`); }
    return fmt.smart(d);
  },
  isoDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; },
  isoLocal(d) { return `${fmt.isoDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; },
  sameDay,
};

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export const store = {
  get(key, fallback) { try { const v = localStorage.getItem(`icd.${key}`); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { localStorage.setItem(`icd.${key}`, JSON.stringify(value)); },
};

/** Trigger a download for a backend URL (WebView2 shows its download UI). */
export function download(url) {
  const a = h('a', { href: url, download: '' });
  document.body.append(a);
  a.click();
  a.remove();
}

export function copyText(text, msg) {
  navigator.clipboard.writeText(text).then(() => toast(msg ?? tx('已复制', 'Copied'), 'success', 1600), toastError);
}

/** Pick files with the native dialog. Promise<File[]> */
export function pickFiles({ multiple = true, accept } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', multiple, accept, style: { display: 'none' } });
    input.addEventListener('change', () => { resolve([...input.files]); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

/** Ignore global shortcuts while typing. */
export const isTyping = (e) => !!e.target.closest?.('input,textarea,select,[contenteditable="true"],[contenteditable=""]');

// ---------------------------------------------------------- native shell
// When hosted by iCloudDesk.exe (WebView2) we talk to the shell via postMessage.
export const shell = {
  get available() { return !!window.chrome?.webview; },
  post(msg) { try { window.chrome?.webview?.postMessage(msg); } catch { /* not in shell */ } },
  openExternal(url) {
    if (this.available) this.post({ type: 'open-external', url });
    else window.open(url, '_blank', 'noopener');
  },
  notify(title, body) { if (this.available) this.post({ type: 'notify', title, body }); },
};

// ----------------------------------------------------------------- theme
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
export const theme = {
  get pref() { return store.get('theme', 'system'); },
  set(pref) { store.set('theme', pref); this.apply(); },
  get dark() { return this.pref === 'dark' || (this.pref === 'system' && darkQuery.matches); },
  apply() {
    const dark = this.dark;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    shell.post({ type: 'theme', dark, titlebar: dark ? '#262628' : '#ececf0' });
    window.dispatchEvent(new CustomEvent('themechange', { detail: { dark } }));
  },
};
darkQuery.addEventListener('change', () => theme.apply());
