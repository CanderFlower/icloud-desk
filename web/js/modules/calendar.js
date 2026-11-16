// Calendar — day / week / month / list views, drag to create · move · resize,
// event popover + editor, calendar visibility and management.
import { get, cachedGet, peekCache, post, put, del, enc } from '../api.js';
import { countText, lang, MONTHS_EN, MONTHS_SHORT_EN, tx } from '../i18n.js';
import {
  h, clear, icon, iconBtn, btn, toolbar, segmented, switchEl, field, menu, popover, modal, confirmDialog,
  toast, toastError, errorBox, empty, skeleton, colorSwatches, fmt, toDate, store, isTyping, shell,
} from '../ui.js';

const WD_ZH = ['一', '二', '三', '四', '五', '六', '日'];
const WD_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WD_MINI_EN = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const DAY = 86400000;
const HOUR = 48; // px per hour in the time grid
const SNAP = 15; // minutes
const LIST_DAYS = 35;
const alarmsList = () => [
  [-1, tx('无', 'None')], [0, tx('日程发生时', 'At time of event')],
  [5, tx('5 分钟前', '5 minutes before')], [10, tx('10 分钟前', '10 minutes before')],
  [15, tx('15 分钟前', '15 minutes before')], [30, tx('30 分钟前', '30 minutes before')],
  [60, tx('1 小时前', '1 hour before')], [120, tx('2 小时前', '2 hours before')],
  [1440, tx('1 天前', '1 day before')], [2880, tx('2 天前', '2 days before')],
  [10080, tx('1 周前', '1 week before')],
];
const viewsList = () => [
  { value: 'day', label: tx('日', 'Day'), tip: tx('日 (D)', 'Day (D)') },
  { value: 'week', label: tx('周', 'Week'), tip: tx('周 (W)', 'Week (W)') },
  { value: 'month', label: tx('月', 'Month'), tip: tx('月 (M)', 'Month (M)') },
  { value: 'list', label: tx('列表', 'List'), tip: tx('日程列表 (L)', 'Event list (L)') },
];

const sod = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const addMin = (d, n) => new Date(+d + n * 60000);
const monday = (d) => addDays(sod(d), -((d.getDay() + 6) % 7));
const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const dayDiff = (a, b) => Math.round((sod(b) - sod(a)) / DAY);
const wd = (d) => (lang.isEn ? WD_EN[(d.getDay() + 6) % 7] : `周${WD_ZH[(d.getDay() + 6) % 7]}`);
const md = (d) => fmt.shortDate(d);
const snap = (m) => Math.round(m / SNAP) * SNAP;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** API event → adds s / e Dates (e exclusive). */
function norm(ev) {
  const s = toDate(ev.start) || new Date();
  let e = toDate(ev.end) || s;
  if (ev.all_day && e <= s) e = addDays(s, 1);
  if (e < s) e = s;
  return { ...ev, s, e };
}
/** Last calendar day an event touches (inclusive). */
const lastDay = (ev) => sod(ev.e > ev.s ? addMin(ev.e, -1) : ev.s);
/** Drawn as a bar (all-day row / month bars) instead of a timed block. */
const isBar = (ev) => ev.all_day || dayDiff(ev.s, lastDay(ev)) > 0;
const order = (a, b) => (isBar(b) - isBar(a)) || (a.s - b.s) || ((b.e - b.s) - (a.e - a.s)) || String(a.title).localeCompare(String(b.title));

function whenText(ev) {
  const last = lastDay(ev);
  const allDayText = tx('全天', 'All day');
  if (ev.all_day) {
    return same(ev.s, last)
      ? `${fmt.date(ev.s)} ${wd(ev.s)} · ${allDayText}`
      : `${fmt.date(ev.s)} – ${fmt.date(last)} · ${allDayText}`;
  }
  if (same(ev.s, ev.e) || same(ev.s, last)) return `${fmt.date(ev.s)} ${wd(ev.s)} · ${fmt.time(ev.s)} – ${fmt.time(ev.e)}`;
  return `${md(ev.s)} ${fmt.time(ev.s)} – ${md(ev.e)} ${fmt.time(ev.e)}`;
}

/** Greedy lane assignment for bars spanning columns a..b. */
function lanes(items) {
  const occ = [];
  for (const it of items) {
    let lane = 0;
    while (occ[lane] && occ[lane].slice(it.a, it.b + 1).some(Boolean)) lane++;
    occ[lane] ||= [];
    for (let c = it.a; c <= it.b; c++) occ[lane][c] = true;
    it.lane = lane;
  }
  return occ.length;
}

/** Side-by-side layout of overlapping timed events in one day column. */
function layoutColumn(list) {
  const items = list.map((ev) => ({ ev, s: +ev.s, e: Math.max(+ev.e, +ev.s + 20 * 60000) })).sort((a, b) => a.s - b.s || b.e - a.e);
  const out = [];
  let cluster = []; let end = 0;
  const flush = () => {
    const cols = [];
    for (const it of cluster) {
      let c = cols.findIndex((x) => x <= it.s);
      if (c < 0) { c = cols.length; cols.push(it.e); } else cols[c] = it.e;
      it.col = c;
    }
    for (const it of cluster) { it.cols = cols.length; out.push(it); }
    cluster = []; end = 0;
  };
  for (const it of items) {
    if (cluster.length && it.s >= end) flush();
    cluster.push(it); end = Math.max(end, it.e);
  }
  if (cluster.length) flush();
  return out;
}

export default {
  id: 'calendar',
  get title() { return tx('日历', 'Calendar'); },
  app: 'calendar',
  mount(el) {
    const VIEWS = viewsList();
    const S = {
      view: store.get('cal.view', 'month'),
      cursor: sod(new Date()),
      mini: null,
      cals: peekCache('/api/calendar/calendars') || null,
      calError: null,
      hidden: new Set(store.get('cal.hidden', [])),
      cache: new Map(),
      loading: 0,
      sel: null,
      drag: null,
    };
    if (!VIEWS.some((v) => v.value === S.view)) S.view = 'month';
    let disposed = false;

    // ------------------------------------------------------------- layout
    const miniEl = h('div', { class: 'cal-mini' });
    const calsEl = h('div', { class: 'side-list cal-list' });
    const side = h('div', { class: 'pane side cal-side' },
      h('div', { class: 'pane-body' },
        miniEl,
        h('div', { class: 'side-title' }, tx('日历', 'Calendars'), iconBtn('plus', tx('新建日历', 'New calendar'), () => newCalendar(), { size: 'sm' })),
        calsEl));

    const titleEl = h('div', { class: 'cal-title' });
    const seg = segmented(VIEWS, S.view, (v) => setView(v), { cls: 'hide-narrow' });
    const viewBtn = h('button', { type: 'button', class: 'btn sm only-narrow cal-viewbtn', onclick: (e) => viewMenu(e.currentTarget) });
    const refreshBtn = iconBtn('refresh-cw', tx('刷新 (F5)', 'Refresh (F5)'), () => reload(), { cls: 'hide-narrow' });
    refreshBtn.dataset.refresh = '';
    const tb = toolbar({
      title: titleEl,
      right: [
        iconBtn('calendar-days', tx('显示的日历', 'Visible calendars'), (e) => calsMenu(e.currentTarget), { cls: 'when-side-hidden' }),
        h('div', { class: 'cal-nav' },
          iconBtn('chevron-left', tx('上一页 (←)', 'Previous (←)'), () => step(-1)),
          h('button', { type: 'button', class: 'btn sm', 'data-tip': tx('回到今天 (T)', 'Go to Today (T)'), onclick: goToday }, tx('今天', 'Today')),
          iconBtn('chevron-right', tx('下一页 (→)', 'Next (→)'), () => step(1))),
        seg, viewBtn,
        h('span', { class: 'sep hide-narrow' }),
        refreshBtn,
        h('button', { class: 'btn primary sm cal-new', type: 'button', dataset: { new: '' }, 'aria-label': tx('新建日程', 'New Event'), 'data-tip': tx('新建日程 (Ctrl+N)', 'New Event (Ctrl+N)'), onclick: () => newAt() },
          icon('plus'), h('span', { class: 'hide-narrow' }, tx('新建日程', 'New Event'))),
      ],
    });
    const bar = h('div', { class: 'cal-loading' });
    const viewEl = h('div', { class: 'cal-view' });
    const main = h('div', { class: 'pane fill cal-main' }, tb, bar, viewEl);
    el.append(h('div', { class: 'panes collapse-side cal' }, side, main));

    // --------------------------------------------------------------- data
    const calOf = (guid) => S.cals?.find((c) => c.guid === guid);
    const colorOf = (ev) => calOf(ev.pguid)?.color || 'var(--blue)';
    const canEdit = (ev) => !ev.read_only && !ev.recurring && !calOf(ev.pguid)?.read_only;
    const writable = () => (S.cals || []).filter((c) => !c.read_only);

    function monthRange(c = S.cursor) {
      const first = new Date(c.getFullYear(), c.getMonth(), 1);
      const s = monday(first);
      const days = new Date(c.getFullYear(), c.getMonth() + 1, 0).getDate();
      return [s, addDays(s, Math.ceil((dayDiff(s, first) + days) / 7) * 7)];
    }
    const fetchRange = () => (S.view === 'list' ? [S.cursor, addDays(S.cursor, LIST_DAYS)] : monthRange());
    const keyOf = ([s, e]) => `${fmt.isoDate(s)}|${fmt.isoDate(e)}`;
    const loaded = () => S.cache.has(keyOf(fetchRange()));
    const visible = () => (S.cache.get(keyOf(fetchRange())) || []).filter((ev) => !S.hidden.has(ev.pguid));
    const findEv = (guid) => [...S.cache.values()].flat().find((ev) => ev.guid === guid);
    function eventsOn(d, list = visible()) {
      const a = sod(d); const b = addDays(a, 1);
      return list.filter((ev) => ev.s < b && (ev.e > a || (+ev.e === +ev.s && ev.s >= a))).sort(order);
    }

    async function ensure(force = false) {
      const r = fetchRange(); const key = keyOf(r);
      const query = { start: fmt.isoDate(r[0]), end: fmt.isoDate(r[1]) };
      const snapshot = !force && peekCache('/api/calendar/events', query);
      if (snapshot) {
        S.cache.set(key, snapshot.map(norm));
        if (!disposed && keyOf(fetchRange()) === key) render();
      }
      S.loading++; bar.classList.add('on');
      const apply = (list) => {
        if (disposed || list === undefined) return;
        S.cache.set(key, list.map(norm));
        if (keyOf(fetchRange()) === key) render();
      };
      try {
        apply(await cachedGet('/api/calendar/events', query, { force, onUpdate: apply }));
      } catch (e) {
        if (!disposed) toastError(e);
      } finally {
        S.loading--; if (!S.loading) bar.classList.remove('on');
      }
    }
    async function refetch() { await ensure(true); }
    async function loadCals(force = false) {
      const apply = (cals) => {
        if (disposed || cals === undefined) return;
        S.cals = cals;
        S.calError = null;
        renderCals(); render();
      };
      try {
        apply(await cachedGet('/api/calendar/calendars', undefined, { force, onUpdate: apply }));
      } catch (e) {
        if (S.cals) { toastError(e); return; }
        S.calError = e; S.cals = [];
      }
      if (!disposed) { renderCals(); render(); }
    }
    async function reload() { await Promise.all([loadCals(true), refetch()]); }

    // ---------------------------------------------------------- navigation
    function setView(v) {
      if (v === S.view) return;
      if (v === 'list' || S.view === 'list') S.cursor = sod(v === 'list' ? (same(S.cursor, new Date()) ? new Date() : S.cursor) : S.cursor);
      S.view = v; store.set('cal.view', v);
      update();
    }
    function step(n) {
      const c = S.cursor;
      if (S.view === 'day') S.cursor = addDays(c, n);
      else if (S.view === 'week') S.cursor = addDays(c, 7 * n);
      else if (S.view === 'list') S.cursor = addDays(c, 28 * n);
      else S.cursor = new Date(c.getFullYear(), c.getMonth() + n, Math.min(c.getDate(), new Date(c.getFullYear(), c.getMonth() + n + 1, 0).getDate()));
      S.mini = null;
      update();
    }
    function goToday() { S.cursor = sod(new Date()); S.mini = null; update(true); }
    function goto(d, view) { S.cursor = sod(d); S.mini = null; if (view && view !== S.view) { S.view = view; store.set('cal.view', view); } update(); }
    function update(scrollNow) { render(scrollNow); ensure(); }

    function viewMenu(at) {
      menu(at, VIEWS.map((v) => ({
        label: lang.isEn ? v.label : (v.value === 'list' ? '列表' : `按${v.label}`),
        checked: v.value === S.view,
        onClick: () => setView(v.value),
      })), { align: 'end' });
    }
    function calsMenu(at) {
      menu(at, [
        { section: tx('显示的日历', 'Visible Calendars') },
        ...(S.cals || []).map((c) => ({ label: c.title, dot: c.color, checked: !S.hidden.has(c.guid), onClick: () => toggleCal(c.guid) })),
        '-',
        { label: tx('显示全部', 'Show All'), checked: false, icon: 'eye', onClick: () => { S.hidden.clear(); saveHidden(); } },
        { label: tx('新建日历…', 'New Calendar…'), checked: false, icon: 'calendar-plus', onClick: () => newCalendar() },
      ], { align: 'end' });
    }

    // ------------------------------------------------------------- render
    function render(scrollNow) {
      if (disposed) return;
      seg.set(S.view);
      clear(viewBtn, VIEWS.find((v) => v.value === S.view).label, icon('chevron-down', { size: 'sm' }));
      main.dataset.view = S.view;
      renderTitle();
      renderMini();
      const narrow = viewEl.clientWidth > 0 && viewEl.clientWidth < 600;
      if (S.view === 'month') (narrow ? renderMonthCompact : renderMonth)();
      else if (S.view === 'list') renderList();
      else renderGrid(S.view === 'day' ? [S.cursor] : [...Array(7)].map((_, i) => addDays(monday(S.cursor), i)), scrollNow);
    }

    function renderTitle() {
      const c = S.cursor; let y = c.getFullYear(); let main_; let extra = null;
      if (lang.isEn) {
        if (S.view === 'day') { main_ = `${MONTHS_SHORT_EN[c.getMonth()]} ${c.getDate()}`; extra = wd(c); }
        else if (S.view === 'week') {
          const a = monday(c); const b = addDays(a, 6); y = b.getFullYear();
          main_ = a.getMonth() === b.getMonth() ? MONTHS_EN[a.getMonth()] : `${MONTHS_SHORT_EN[a.getMonth()]} – ${MONTHS_SHORT_EN[b.getMonth()]}`;
        } else if (S.view === 'month') main_ = MONTHS_EN[c.getMonth()];
        else { main_ = 'Events'; extra = `from ${md(c)}`; }
        clear(titleEl, h('b', {}, main_), h('span', { class: 'y' }, ` ${y}`), extra ? h('span', { class: 'x' }, extra) : null);
        return;
      }
      if (S.view === 'day') { main_ = md(c); extra = wd(c); }
      else if (S.view === 'week') {
        const a = monday(c); const b = addDays(a, 6); y = b.getFullYear();
        main_ = a.getMonth() === b.getMonth() ? `${a.getMonth() + 1}月` : `${a.getMonth() + 1}月 – ${b.getMonth() + 1}月`;
      } else if (S.view === 'month') main_ = `${c.getMonth() + 1}月`;
      else { main_ = '日程'; extra = `${md(c)}起`; }
      clear(titleEl, h('span', { class: 'y' }, `${y}年`), h('b', {}, main_), extra ? h('span', { class: 'x' }, extra) : null);
    }

    function renderMini() {
      const m = S.mini || S.cursor;
      const first = new Date(m.getFullYear(), m.getMonth(), 1);
      const s = monday(first);
      const today = sod(new Date());
      const wk = S.view === 'week' ? monday(S.cursor) : null;
      const busy = new Set();
      for (const ev of visible()) {
        for (let d = sod(ev.s), i = 0; d <= lastDay(ev) && i < 42; d = addDays(d, 1), i++) busy.add(fmt.isoDate(d));
      }
      const shift = (n) => { S.mini = new Date(m.getFullYear(), m.getMonth() + n, 1); renderMini(); };
      const miniHeadText = lang.isEn ? `${MONTHS_SHORT_EN[m.getMonth()]} ${m.getFullYear()}` : `${m.getFullYear()}年${m.getMonth() + 1}月`;
      clear(miniEl,
        h('div', { class: 'cal-mini-head' },
          h('button', { type: 'button', class: 'cal-mini-title', 'data-tip': tx('转到此月', 'Go to month'), onclick: () => goto(m.getMonth() === S.cursor.getMonth() && m.getFullYear() === S.cursor.getFullYear() ? S.cursor : first, 'month') },
            miniHeadText),
          iconBtn('chevron-left', tx('上个月', 'Previous month'), () => shift(-1), { size: 'sm' }),
          iconBtn('chevron-right', tx('下个月', 'Next month'), () => shift(1), { size: 'sm' })),
        h('div', { class: 'cal-mini-grid' },
          (lang.isEn ? WD_MINI_EN : WD_ZH).map((w) => h('span', { class: 'wd' }, w)),
          [...Array(42)].map((_, i) => {
            const d = addDays(s, i);
            const cls = ['d',
              d.getMonth() !== m.getMonth() && 'out',
              same(d, today) && 'today',
              same(d, S.cursor) && 'sel',
              wk && d >= wk && d < addDays(wk, 7) && 'wk',
              busy.has(fmt.isoDate(d)) && 'busy'].filter(Boolean).join(' ');
            return h('button', { type: 'button', class: cls, 'aria-label': fmt.date(d), onclick: () => goto(d, S.view === 'month' && d.getMonth() === m.getMonth() ? 'month' : S.view === 'month' ? 'month' : S.view) }, d.getDate());
          })));
    }

    function renderCals() {
      if (S.calError) { clear(calsEl, errorBox(S.calError)); return; }
      if (!S.cals) { clear(calsEl, skeleton(3, { avatar: false })); return; }
      if (!S.cals.length) { clear(calsEl, h('div', { class: 'cal-list-empty' }, tx('没有日历', 'No calendars'))); return; }
      clear(calsEl, S.cals.map((c) => {
        const on = !S.hidden.has(c.guid);
        return h('div', {
          class: `side-item cal-item${on ? '' : ' off'}`, style: { '--c': c.color }, role: 'checkbox', 'aria-checked': String(on), tabindex: '0',
          onclick: () => toggleCal(c.guid),
          onkeydown: (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleCal(c.guid); } },
          oncontextmenu: (e) => calMenu(e, c),
        },
        h('span', { class: 'cal-check' }, icon('check')),
        h('span', { class: 'label' }, c.title),
        c.read_only ? h('span', { class: 'cal-ro', 'data-tip': c.share_type === 'subscribed' ? tx('订阅日历 · 只读', 'Subscribed · Read-only') : tx('只读', 'Read-only') }, icon(c.share_type === 'subscribed' ? 'link' : 'lock', { size: 'sm' })) : null,
        iconBtn('ellipsis', tx('更多', 'More'), (e) => { e.stopPropagation(); calMenu(e.currentTarget, c); }, { cls: 'more', size: 'sm' }));
      }));
    }
    function toggleCal(guid) { S.hidden.has(guid) ? S.hidden.delete(guid) : S.hidden.add(guid); saveHidden(); }
    function saveHidden() { store.set('cal.hidden', [...S.hidden]); renderCals(); render(); }
    function calMenu(at, c) {
      menu(at, [
        { label: tx('仅显示此日历', 'Show Only This Calendar'), icon: 'eye', onClick: () => { S.hidden = new Set(S.cals.filter((x) => x.guid !== c.guid).map((x) => x.guid)); saveHidden(); } },
        { label: tx('显示全部日历', 'Show All Calendars'), icon: 'layers', onClick: () => { S.hidden.clear(); saveHidden(); } },
        '-',
        { label: tx('在此日历中新建日程', 'New Event in Calendar'), icon: 'calendar-plus', disabled: c.read_only, onClick: () => newAt(null, { pguid: c.guid }) },
        { label: tx('删除日历…', 'Delete Calendar…'), icon: 'trash-2', danger: true, disabled: c.read_only || c.is_default, onClick: () => removeCalendar(c) },
      ]);
    }

    // ---------------------------------------------------------- month view
    const colAt = (box, x, n = 7) => { const r = box.getBoundingClientRect(); return clamp(Math.floor((x - r.left) / (r.width / n)), 0, n - 1); };
    const untitled = () => tx('（无标题）', '(No Title)');

    function renderMonth() {
      const [s, e] = monthRange();
      const weeks = dayDiff(s, e) / 7;
      const body = h('div', { class: 'mv-body', style: { '--weeks': weeks } });
      clear(viewEl, h('div', { class: 'mv' },
        h('div', { class: 'mv-head' }, (lang.isEn ? WD_EN : WD_ZH.map((w) => `周${w}`)).map((w, i) => h('div', { class: i > 4 ? 'we' : '' }, w))),
        body));
      const rowH = body.clientHeight / weeks || 110;
      const maxLanes = Math.max(1, Math.floor((rowH - 30) / 21));
      const evs = visible(); const today = sod(new Date());
      for (let w = 0; w < weeks; w++) body.append(monthWeek(addDays(s, w * 7), evs, maxLanes, today));
    }

    function monthWeek(ws, evs, maxLanes, today) {
      const we = addDays(ws, 7);
      const days = [...Array(7)].map((_, i) => addDays(ws, i));
      const cells = days.map((d, i) => h('div', {
        class: `mv-cell${d.getMonth() !== S.cursor.getMonth() ? ' out' : ''}${same(d, today) ? ' today' : ''}${i > 4 ? ' we' : ''}`,
        ondblclick: () => newAt(startOn(d)),
      }, h('button', { type: 'button', class: 'mv-num', 'aria-label': fmt.date(d), onclick: () => goto(d, 'day') },
        d.getDate() === 1 ? (lang.isEn ? `${MONTHS_SHORT_EN[d.getMonth()]} 1` : `${d.getMonth() + 1}月1日`) : d.getDate())));
      const placed = evs.filter((ev) => ev.s < we && (ev.e > ws || (+ev.e === +ev.s && ev.s >= ws))).sort(order)
        .map((ev) => ({ ev, a: Math.max(0, dayDiff(ws, ev.s)), b: Math.min(6, dayDiff(ws, lastDay(ev))) }));
      lanes(placed);
      const count = days.map((_, c) => placed.filter((p) => p.a <= c && p.b >= c).length);
      const limit = (c) => (count[c] > maxLanes ? maxLanes - 1 : maxLanes);
      const shown = Array(7).fill(0);
      const layer = h('div', { class: 'mv-items', style: { '--lanes': maxLanes } });
      for (const p of placed) {
        let ok = true;
        for (let c = p.a; c <= p.b; c++) if (p.lane >= limit(c)) ok = false;
        if (!ok) continue;
        for (let c = p.a; c <= p.b; c++) shown[c]++;
        layer.append(monthItem(p, ws));
      }
      for (let c = 0; c < 7; c++) {
        const n = count[c] - shown[c];
        if (n > 0) {
          layer.append(h('button', { type: 'button', class: 'mv-more', style: { gridColumn: `${c + 1}`, gridRow: `${limit(c) + 1}` }, onclick: (e) => dayPopover(e.currentTarget, days[c]) }, tx(`还有 ${n} 项`, `+${n} more`)));
        }
      }
      const row = h('div', { class: 'mv-week' }, h('div', { class: 'mv-cells' }, cells), layer);
      const clearDrop = () => cells.forEach((x) => x.classList.remove('drop'));
      row.addEventListener('dragover', (e) => {
        if (!S.drag) return;
        e.preventDefault(); e.dataTransfer.dropEffect = 'move';
        const c = colAt(row, e.clientX); cells.forEach((x, i) => x.classList.toggle('drop', i === c));
      });
      row.addEventListener('dragleave', (e) => { if (!row.contains(e.relatedTarget)) clearDrop(); });
      row.addEventListener('drop', (e) => {
        e.preventDefault(); clearDrop();
        const d = S.drag; S.drag = null; if (!d) return;
        const delta = dayDiff(addDays(sod(d.ev.s), d.offset), days[colAt(row, e.clientX)]);
        if (delta) saveTimes(d.ev, addDays(d.ev.s, delta), addDays(d.ev.e, delta));
      });
      return row;
    }

    function monthItem({ ev, a, b, lane }, ws) {
      const isB = isBar(ev);
      const editable = canEdit(ev);
      const it = h('div', {
        class: `mv-ev ${isB ? 'ev-bar' : 'ev-pt'}${ev.s < ws ? ' cont-l' : ''}${lastDay(ev) > addDays(ws, 6) ? ' cont-r' : ''}${S.sel === ev.guid ? ' sel' : ''}`,
        style: { gridColumn: `${a + 1} / ${b + 2}`, gridRow: `${lane + 1}`, '--c': colorOf(ev) },
        tabindex: '0', draggable: editable, dataset: { guid: ev.guid }, title: `${ev.title || untitled()}\n${whenText(ev)}`,
        onclick: (e) => { e.stopPropagation(); showEvent(ev, it); },
        ondblclick: (e) => e.stopPropagation(),
        onkeydown: (e) => keyOnEvent(e, ev, it),
        oncontextmenu: (e) => eventMenu(e, ev),
        ondragstart: (e) => {
          const row = it.closest('.mv-week');
          S.drag = { ev, offset: dayDiff(sod(ev.s), addDays(ws, colAt(row, e.clientX))) };
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', ev.title || '');
          requestAnimationFrame(() => it.classList.add('dragging'));
        },
        ondragend: () => { it.classList.remove('dragging'); S.drag = null; },
      },
      isB ? null : h('span', { class: 'dotc' }),
      h('span', { class: 't' }, ev.title || untitled()),
      !isB ? h('span', { class: 'tm' }, fmt.time(ev.s)) : null);
      return it;
    }

    function dayPopover(at, d) {
      const list = eventsOn(d);
      const p = popover(at, h('div', { class: 'cal-daypop' },
        h('div', { class: 'cal-daypop-head' },
          h('div', {}, h('b', {}, md(d)), h('span', {}, ` ${wd(d)}`)),
          iconBtn('calendar-days', tx('打开日视图', 'Open Day View'), () => { p.close(); goto(d, 'day'); }, { size: 'sm' })),
        h('div', { class: 'ag-list' }, list.map((ev) => agendaRow(ev, d, (row) => { p.close(); showEvent(ev, at, row); })))),
      { width: '280px' });
    }

    function renderMonthCompact() {
      const [s, e] = monthRange();
      const n = dayDiff(s, e);
      const today = sod(new Date());
      const evs = visible();
      const list = eventsOn(S.cursor, evs);
      clear(viewEl, h('div', { class: 'mvc' },
        h('div', { class: 'mvc-grid' },
          (lang.isEn ? WD_MINI_EN : WD_ZH).map((w, i) => h('span', { class: `wd${i > 4 ? ' we' : ''}` }, w)),
          [...Array(n)].map((_, i) => {
            const d = addDays(s, i);
            const dots = eventsOn(d, evs).slice(0, 3);
            return h('button', {
              type: 'button',
              class: `mvc-d${d.getMonth() !== S.cursor.getMonth() ? ' out' : ''}${same(d, today) && ' today' || ''}${same(d, S.cursor) ? ' sel' : ''}`,
              onclick: () => { const m = d.getMonth() !== S.cursor.getMonth(); S.cursor = d; S.mini = null; m ? update() : render(); },
              ondblclick: () => newAt(startOn(d)),
            }, h('span', { class: 'n' }, d.getDate()), h('span', { class: 'dots' }, dots.map((ev) => h('i', { style: { '--c': colorOf(ev) } }))));
          })),
        h('div', { class: 'mvc-day' },
          h('div', { class: 'ag-day-head' }, h('span', { class: 'n' }, S.cursor.getDate()),
            h('div', {}, h('b', {}, relDay(S.cursor)), h('span', {}, `${fmt.date(S.cursor)} ${wd(S.cursor)}`))),
          !loaded() ? skeleton(2, { avatar: false })
            : list.length ? h('div', { class: 'ag-list' }, list.map((ev) => agendaRow(ev, S.cursor)))
              : h('div', { class: 'ag-none' }, tx('无日程', 'No Events'), btn(tx('添加', 'Add'), { kind: 'plain', size: 'sm', icon: 'plus', onclick: () => newAt(startOn(S.cursor)) })))));
    }

    // ----------------------------------------------------------- list view
    function relDay(d) {
      const n = dayDiff(new Date(), d);
      if (n === 0) return tx('今天', 'Today');
      if (n === 1) return tx('明天', 'Tomorrow');
      if (n === 2 && !lang.isEn) return '后天';
      if (n === -1) return tx('昨天', 'Yesterday');
      return wd(d);
    }
    function agendaTime(ev, d) {
      if (ev.all_day) return [h('span', {}, tx('全天', 'All day'))];
      const st = same(ev.s, d); const en = same(lastDay(ev), d);
      if (st && en) return [h('span', {}, fmt.time(ev.s)), h('span', { class: 'end' }, fmt.time(ev.e))];
      if (st) return [h('span', {}, fmt.time(ev.s)), h('span', { class: 'end' }, tx('开始', 'Starts'))];
      if (en) return [h('span', {}, tx('截至', 'Ends')), h('span', { class: 'end' }, fmt.time(ev.e))];
      return [h('span', {}, tx('全天', 'All day'))];
    }
    function agendaRow(ev, d, onOpen) {
      const row = h('div', {
        class: `ag-row${S.sel === ev.guid ? ' sel' : ''}`, tabindex: '0', style: { '--c': colorOf(ev) }, dataset: { guid: ev.guid },
        onclick: () => (onOpen ? onOpen(row) : showEvent(ev, row)),
        onkeydown: (e) => keyOnEvent(e, ev, row),
        oncontextmenu: (e) => eventMenu(e, ev),
      },
      h('div', { class: 'ag-time' }, agendaTime(ev, d)),
      h('span', { class: 'ag-bar' }),
      h('div', { class: 'ag-main' },
        h('div', { class: 't' }, ev.title || untitled(), ev.recurring ? icon('repeat', { size: 'sm', cls: 'rep' }) : null),
        ev.location ? h('div', { class: 'loc' }, icon('map-pin', { size: 'sm' }), h('span', {}, ev.location)) : null));
      return row;
    }

    function renderList() {
      const [s] = fetchRange();
      const evs = visible(); const today = sod(new Date());
      const out = [];
      for (let i = 0; i < LIST_DAYS; i++) {
        const d = addDays(s, i);
        const list = eventsOn(d, evs);
        if (!list.length) continue;
        out.push(h('section', { class: `ag-day${same(d, today) ? ' today' : ''}` },
          h('div', { class: 'ag-day-head' }, h('span', { class: 'n' }, d.getDate()),
            h('div', {}, h('b', {}, relDay(d)), h('span', {}, `${fmt.date(d)} ${wd(d)}`))),
          h('div', { class: 'ag-list' }, list.map((ev) => agendaRow(ev, d)))));
      }
      clear(viewEl, h('div', { class: 'ag' },
        !loaded() ? skeleton(6, { avatar: false })
          : out.length ? out
            : empty({
              icon: 'calendar-check', title: tx('没有日程', 'No Events'),
              text: tx(`${md(s)}起 5 周内没有安排。`, `No events scheduled for the 5 weeks starting ${md(s)}.`),
              action: { label: tx('新建日程', 'New Event'), icon: 'plus', onClick: () => newAt() },
            })));
    }

    // ---------------------------------------------------- day / week grid
    function renderGrid(days, scrollNow) {
      const n = days.length;
      const prev = viewEl.querySelector('.tg-scroll');
      const keep = !scrollNow && prev && prev.dataset.n === String(n) ? prev.scrollTop : null;
      const today = sod(new Date());
      const evs = visible();
      const d0 = days[0]; const d1 = addDays(days[n - 1], 1);

      const bars = evs.filter((ev) => isBar(ev) && ev.s < d1 && ev.e > d0).sort(order)
        .map((ev) => ({ ev, a: Math.max(0, dayDiff(d0, ev.s)), b: Math.min(n - 1, dayDiff(d0, lastDay(ev))) }));
      const laneN = lanes(bars);
      const allGrid = h('div', {
        class: 'tg-allday-grid', style: { '--lanes': Math.max(1, laneN) },
        ondblclick: (e) => { if (e.target === allGrid) { const d = days[colAt(allGrid, e.clientX, n)]; newAt(d, { end: addDays(d, 1), all_day: true }); } },
      }, bars.map((p) => {
        const editable = canEdit(p.ev);
        const it = h('div', {
          class: `mv-ev ev-bar${p.ev.s < d0 ? ' cont-l' : ''}${lastDay(p.ev) >= d1 ? ' cont-r' : ''}${S.sel === p.ev.guid ? ' sel' : ''}`,
          style: { gridColumn: `${p.a + 1} / ${p.b + 2}`, gridRow: `${p.lane + 1}`, '--c': colorOf(p.ev) },
          tabindex: '0', dataset: { guid: p.ev.guid }, title: `${p.ev.title || untitled()}\n${whenText(p.ev)}`,
          onclick: () => showEvent(p.ev, it), onkeydown: (e) => keyOnEvent(e, p.ev, it), oncontextmenu: (e) => eventMenu(e, p.ev),
          'aria-disabled': editable ? undefined : 'true',
        }, h('span', { class: 't' }, p.ev.title || untitled()));
        return it;
      }));

      const head = h('div', { class: 'tg-head' }, h('div', { class: 'tg-gutter' }),
        days.map((d) => h('button', {
          type: 'button', class: `tg-dh${same(d, today) ? ' today' : ''}${d.getDay() % 6 === 0 ? ' we' : ''}`,
          'aria-label': fmt.date(d), onclick: () => { if (n > 1) goto(d, 'day'); },
        }, h('span', { class: 'w' }, wd(d)), h('span', { class: 'n' }, d.getDate()))));

      const cols = days.map((d) => {
        const col = h('div', { class: `tg-col${same(d, today) ? ' today' : ''}${d.getDay() % 6 === 0 ? ' we' : ''}` });
        const timed = evs.filter((ev) => !isBar(ev) && same(ev.s, d));
        for (const it of layoutColumn(timed)) col.append(timedItem(it.ev, d, it.col, it.cols));
        if (same(d, today)) col.append(h('div', { class: 'tg-now' }));
        return col;
      });
      const hours = h('div', { class: 'tg-hours' },
        [...Array(24)].map((_, i) => h('div', { class: 'tg-hour' }, i ? h('span', {}, `${fmt.pad(i)}:00`) : null)),
        days.some((d) => same(d, today)) ? h('span', { class: 'tg-now-label' }) : null);
      const grid = h('div', { class: 'tg-grid', style: { height: `${HOUR * 24}px` } }, hours, cols);
      const scroll = h('div', { class: 'tg-scroll', dataset: { n: String(n) } }, grid);
      const root = h('div', { class: `tg ${n === 1 ? 'tg-1' : 'tg-7'}`, style: { '--cols': n } },
        head, h('div', { class: 'tg-allday' }, h('div', { class: 'tg-gutter' }, tx('全天', 'all-day')), allGrid), scroll);
      clear(viewEl, root);
      root.style.setProperty('--sbw', `${scroll.offsetWidth - scroll.clientWidth}px`);
      if (keep !== null) scroll.scrollTop = keep;
      else {
        const hasToday = days.some((d) => same(d, today));
        const first = evs.filter((ev) => !isBar(ev) && ev.s >= d0 && ev.s < d1).reduce((m, ev) => Math.min(m, ev.s.getHours()), 24);
        const hour = hasToday ? new Date().getHours() - 2 : Math.min(7.5, first - 0.5);
        scroll.scrollTop = Math.max(0, hour) * HOUR;
      }
      positionNow();
      gridPointer(grid, days);
    }

    function timedItem(ev, d, ci, cols) {
      const a = (ev.s - d) / 60000; const b = Math.min(1440, (ev.e - d) / 60000);
      const height = Math.max(((b - a) / 60) * HOUR, 18);
      const short = height < 36;
      const editable = canEdit(ev);
      const it = h('div', {
        class: `tg-ev${short ? ' short' : ''}${S.sel === ev.guid ? ' sel' : ''}${editable ? ' editable' : ''}`,
        tabindex: '0', dataset: { guid: ev.guid },
        style: { top: `${(a / 60) * HOUR}px`, height: `${height - 2}px`, left: `calc(${(ci / cols) * 100}% + 1px)`, width: `calc(${100 / cols}% - 3px)`, '--c': colorOf(ev) },
        title: `${ev.title || untitled()}\n${whenText(ev)}${ev.location ? `\n${ev.location}` : ''}`,
        onkeydown: (e) => keyOnEvent(e, ev, it),
        oncontextmenu: (e) => eventMenu(e, ev),
      },
      h('div', { class: 't' }, ev.title || untitled(), short ? h('span', { class: 'tm' }, fmt.time(ev.s)) : null),
      short ? null : h('div', { class: 'tm' }, `${fmt.time(ev.s)} – ${fmt.time(ev.e)}`),
      !short && ev.location && height > 60 ? h('div', { class: 'loc' }, ev.location) : null,
      editable ? h('div', { class: 'tg-resize' }) : null);
      it._ev = ev;
      return it;
    }

    function positionNow() {
      const now = new Date(); const top = ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR;
      viewEl.querySelectorAll('.tg-now').forEach((x) => { x.style.top = `${top}px`; });
      const lbl = viewEl.querySelector('.tg-now-label');
      if (lbl) { lbl.style.top = `${top}px`; lbl.textContent = fmt.time(now); }
    }

    /** Pointer interactions on the time grid: drag to create, move, resize; click to open. */
    function gridPointer(grid, days) {
      const n = days.length;
      const colEls = () => [...grid.querySelectorAll('.tg-col')];
      const minuteAt = (y) => clamp(snap(((y - grid.getBoundingClientRect().top) / HOUR) * 60), 0, 1440);
      const colAtX = (x) => { const cs = colEls(); const i = cs.findIndex((c) => x < c.getBoundingClientRect().right); return i < 0 ? n - 1 : i; };
      const place = (node, s, e) => {
        const top = ((s.getHours() * 60 + s.getMinutes()) / 60) * HOUR;
        const mins = Math.max(SNAP, (e - s) / 60000);
        node.style.top = `${top}px`;
        node.style.height = `${Math.max((Math.min(mins, 1440 - (top / HOUR) * 60) / 60) * HOUR, 18) - 2}px`;
        const tm = node.querySelector('.tm'); if (tm) tm.textContent = node.classList.contains('short') ? fmt.time(s) : `${fmt.time(s)} – ${fmt.time(e)}`;
      };

      grid.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const evEl = e.target.closest('.tg-ev');
        const colEl = e.target.closest('.tg-col');
        if (!evEl && !colEl) return;
        const hadPopover = !!document.querySelector('.popover,.menu');
        const x0 = e.clientX; const y0 = e.clientY;
        let moved = false;
        let onMove; let onUp;

        if (evEl) {
          const ev = evEl._ev; const editable = canEdit(ev);
          const mode = e.target.closest('.tg-resize') ? 'resize' : 'move';
          const c0 = colAtX(x0); const m0 = minuteAt(y0);
          const dur = (ev.e - ev.s) / 60000;
          let ns = ev.s; let ne = ev.e;
          onMove = (m) => {
            if (!editable) return;
            if (!moved && Math.hypot(m.clientX - x0, m.clientY - y0) < 4) return;
            if (!moved) { moved = true; evEl.classList.add('dragging'); document.body.classList.add('cal-dragging'); }
            if (mode === 'move') {
              const dc = n > 1 ? colAtX(m.clientX) - c0 : 0;
              const day = addDays(sod(ev.s), dc);
              const startMin = clamp(ev.s.getHours() * 60 + ev.s.getMinutes() + (minuteAt(m.clientY) - m0), 0, 1440 - SNAP);
              ns = addMin(day, startMin); ne = addMin(ns, dur);
              const target = colEls()[clamp(dayDiff(days[0], day), 0, n - 1)];
              if (evEl.parentNode !== target) target.append(evEl);
              evEl.style.left = '1px'; evEl.style.width = 'calc(100% - 3px)';
            } else {
              const base = sod(ev.s); const startMin = ev.s.getHours() * 60 + ev.s.getMinutes();
              ne = addMin(base, Math.max(startMin + SNAP, minuteAt(m.clientY)));
            }
            place(evEl, ns, ne);
          };
          onUp = () => {
            document.body.classList.remove('cal-dragging');
            if (!moved) { showEvent(ev, evEl); return; }
            evEl.classList.remove('dragging');
            if (+ns === +ev.s && +ne === +ev.e) { render(); return; }
            saveTimes(ev, ns, ne);
          };
        } else {
          if (hadPopover) return;
          e.preventDefault();
          const ci = colAtX(x0); const day = days[ci]; const col = colEls()[ci];
          const raw = ((y0 - grid.getBoundingClientRect().top) / HOUR) * 60;
          const anchor = clamp(snap(raw), 0, 1440 - SNAP);
          let a = Math.floor(raw / 30) * 30; let b = a + 60;
          let ghost = null;
          const mkGhost = () => {
            ghost = h('div', { class: 'tg-ev ghost', style: { left: '1px', width: 'calc(100% - 3px)', '--c': colorOf({ pguid: defaultCal() }) } },
              h('div', { class: 't' }, tx('新建日程', 'New Event')), h('div', { class: 'tm' }));
            col.append(ghost);
          };
          onMove = (m) => {
            if (!moved && Math.abs(m.clientY - y0) < 5) return;
            if (!moved) { moved = true; mkGhost(); document.body.classList.add('cal-dragging'); }
            const cur = minuteAt(m.clientY);
            a = Math.min(anchor, cur); b = Math.max(anchor, cur);
            if (b - a < SNAP) b = a + SNAP;
            place(ghost, addMin(day, a), addMin(day, b));
          };
          onUp = () => {
            document.body.classList.remove('cal-dragging');
            if (!ghost) { mkGhost(); b = Math.min(b, 1440); }
            place(ghost, addMin(day, a), addMin(day, b));
            newAt(addMin(day, a), { end: addMin(day, b), onClose: () => ghost.remove() });
          };
        }
        const move = (m) => onMove(m);
        const up = (u) => { window.removeEventListener('pointermove', move); window.removeEventListener('pointercancel', up); onUp(u); };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up, { once: true });
        window.addEventListener('pointercancel', up, { once: true });
      });
    }

    // ------------------------------------------------------------- events
    function markSel() {
      viewEl.querySelectorAll('[data-guid]').forEach((x) => x.classList.toggle('sel', x.dataset.guid === S.sel));
    }
    function keyOnEvent(e, ev, node) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showEvent(ev, node); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && canEdit(ev)) { e.preventDefault(); removeEvent(ev); }
    }

    function showEvent(ev, anchor, fallback) {
      const at = anchor?.isConnected ? anchor : fallback?.isConnected ? fallback : main;
      S.sel = ev.guid; markSel();
      const cal = calOf(ev.pguid);
      const editable = canEdit(ev);
      const row = (ic, ...content) => h('div', { class: 'evp-row' }, icon(ic, { size: 'sm' }), h('div', { class: 'evp-v' }, content));
      const rows = h('div', { class: 'evp-rows' },
        row('clock', whenText(ev)),
        row('calendar', h('span', { class: 'evp-cal' }, h('span', { class: 'dot sm', style: { '--c': colorOf(ev) } }), cal?.title || tx('日历', 'Calendar'))),
        ev.recurring ? row('repeat', tx('重复日程', 'Repeating event')) : null,
        ev.alarms?.length ? row('bell', countText(ev.alarms.length, '个提醒', 'alert')) : null,
        ev.url ? row('link', h('a', { href: ev.url, onclick: (x) => { x.preventDefault(); shell.openExternal(ev.url); } }, ev.url)) : null,
        ev.description ? h('div', { class: 'evp-notes selectable' }, ev.description) : null);
      const content = h('div', { class: 'evp', style: { '--c': colorOf(ev) } },
        h('div', { class: 'evp-head' },
          h('span', { class: 'evp-bar' }),
          h('div', { class: 'evp-title' },
            h('h3', { class: 'selectable' }, ev.title || untitled()),
            ev.location ? h('a', {
              class: 'evp-loc', href: '#', 'data-tip': tx('在地图中查看', 'Open in Maps'),
              onclick: (x) => { x.preventDefault(); shell.openExternal(`https://www.bing.com/maps?q=${encodeURIComponent(ev.location)}`); },
            }, icon('map-pin', { size: 'sm' }), ev.location) : null),
          h('div', { class: 'evp-tools' },
            editable ? iconBtn('pencil', tx('编辑 (Enter)', 'Edit (Enter)'), () => { p.close(); editEvent(ev); }, { size: 'sm' }) : null,
            iconBtn('ellipsis', tx('更多', 'More'), (x) => eventMenu(x.currentTarget, ev, () => p.close()), { size: 'sm' }))),
        rows,
        !editable ? h('div', { class: 'evp-note' }, icon('lock', { size: 'sm' }),
          ev.recurring
            ? tx('重复日程暂不支持在此修改，请在 Apple 设备上编辑。', 'Repeating events cannot be edited here yet. Edit on your Apple device.')
            : tx('此日程所在日历为只读。', 'This calendar is read-only.')) : null);
      const onKey = (k) => {
        if (isTyping(k) || document.querySelector('.overlay,.menu')) return;
        if (k.key === 'Enter' && editable) { k.preventDefault(); p.close(); editEvent(ev); }
        if ((k.key === 'Delete' || k.key === 'Backspace') && editable) { k.preventDefault(); p.close(); removeEvent(ev); }
      };
      document.addEventListener('keydown', onKey);
      const p = popover(at, content, {
        width: '320px', cls: 'evp-pop', align: 'start',
        onClose: () => { document.removeEventListener('keydown', onKey); if (S.sel === ev.guid) { S.sel = null; markSel(); } },
      });
      // Invitees only come with the detail call.
      get(`/api/calendar/events/${enc(ev.pguid)}/${enc(ev.guid)}`).then((d) => {
        const people = (d?.invitees || []).map((i) => i.commonName || String(i.email || '').replace(/^mailto:/i, '')).filter(Boolean);
        if (people.length && content.isConnected) { rows.insertBefore(row('users', people.join(lang.isEn ? ', ' : '、')), rows.querySelector('.evp-notes')); p.reposition(); }
      }).catch(() => {});
    }

    function eventMenu(at, ev, closePop) {
      const editable = canEdit(ev);
      const node = at instanceof Event ? at.target.closest('[data-guid]') : at;
      menu(at, [
        { label: tx('查看详情', 'Show Info'), icon: 'info', onClick: () => showEvent(ev, node) },
        { label: tx('编辑…', 'Edit…'), icon: 'pencil', disabled: !editable, onClick: () => { closePop?.(); editEvent(ev); } },
        { label: tx('复制为新日程…', 'Duplicate…'), icon: 'copy', onClick: () => { closePop?.(); editEvent(ev, { duplicate: true }); } },
        { label: tx('拷贝标题与时间', 'Copy Summary'), icon: 'clipboard', onClick: () => navigator.clipboard?.writeText(`${ev.title}\n${whenText(ev)}${ev.location ? `\n${ev.location}` : ''}`).then(() => toast(tx('已拷贝', 'Copied'), 'success')) },
        ...(editable && writable().length > 1 ? ['-', { section: tx('移到日历', 'Calendar') },
          ...writable().map((c) => ({
            label: c.title, dot: c.color, disabled: c.guid === ev.pguid,
            onClick: () => { closePop?.(); saveTimes(ev, ev.s, ev.e, { pguid: c.guid }); },
          }))] : []),
        '-',
        { label: tx('删除', 'Delete'), icon: 'trash-2', danger: true, disabled: !editable, onClick: () => { closePop?.(); removeEvent(ev); } },
      ]);
    }

    function payload(ev, o = {}) {
      const allDay = o.all_day ?? ev.all_day ?? false;
      const s = o.start ?? ev.s; const e = o.end ?? ev.e;
      return {
        pguid: o.pguid ?? ev.pguid,
        title: o.title ?? ev.title ?? '',
        location: o.location ?? ev.location ?? '',
        description: o.description ?? ev.description ?? '',
        all_day: allDay,
        start: allDay ? fmt.isoDate(s) : fmt.isoLocal(s),
        // The API takes the inclusive last day for all-day events.
        end: allDay ? fmt.isoDate(sod(addMin(e, -1))) : fmt.isoLocal(e),
        alarm_minutes: o.alarm_minutes ?? null,
        etag: ev.etag || null,
      };
    }

    async function saveTimes(ev, s, e, extra = {}, undoable = true) {
      const old = { s: ev.s, e: ev.e, pguid: ev.pguid };
      const body = payload(ev, { start: s, end: e, ...extra });
      Object.assign(ev, { s, e, pguid: body.pguid });
      render();
      try {
        await put(`/api/calendar/events/${enc(old.pguid)}/${enc(ev.guid)}`, body);
        const moved = extra.pguid && extra.pguid !== old.pguid;
        toast(moved ? tx(`已移到“${calOf(extra.pguid)?.title || '日历'}”`, `Moved to “${calOf(extra.pguid)?.title || 'Calendar'}”`) : tx(`已改到 ${whenText(ev)}`, `Rescheduled to ${whenText(ev)}`), 'success', undoable && !moved ? {
          ms: 5000,
          action: { label: tx('撤销', 'Undo'), onClick: () => { const cur = findEv(ev.guid); if (cur) saveTimes(cur, old.s, old.e, {}, false); } },
        } : 2400);
      } catch (err) {
        Object.assign(ev, old);
        toastError(err);
      }
      await refetch();
    }

    async function removeEvent(ev) {
      const ok = await confirmDialog(tx(`删除“${ev.title || '无标题'}”？`, `Delete “${ev.title || 'Untitled'}”?`), { title: tx('删除日程', 'Delete Event'), okLabel: tx('删除', 'Delete'), danger: true, icon: 'trash-2', detail: whenText(ev) });
      if (!ok) return;
      try {
        await del(`/api/calendar/events/${enc(ev.pguid)}/${enc(ev.guid)}`, { etag: ev.etag });
        toast(tx('已删除日程', 'Event deleted'), 'success');
      } catch (e) { toastError(e); }
      await refetch();
    }

    // ------------------------------------------------------------- editor
    function defaultCal() {
      const w = writable();
      return (w.find((c) => c.is_default && !S.hidden.has(c.guid)) || w.find((c) => !S.hidden.has(c.guid)) || w[0])?.guid;
    }
    function startOn(d) {
      const now = new Date();
      if (same(d, now)) { const m = Math.ceil((now.getHours() * 60 + now.getMinutes() + 1) / 30) * 30; return addMin(sod(now), Math.min(m, 1410)); }
      return addMin(sod(d), 9 * 60);
    }
    function newAt(start, o = {}) {
      editEvent(null, { start: start || startOn(S.view === 'list' ? new Date() : S.cursor), ...o });
    }

    function editEvent(ev, o = {}) {
      const w = writable();
      if (!S.cals) { toast(tx('日历仍在加载…', 'Calendars are still loading…')); return; }
      if (!w.length) { toast(tx('没有可写入的日历', 'No writable calendars available'), 'error'); return; }
      const isNew = !ev || o.duplicate;
      const src = ev || {};
      let allDay = o.all_day ?? src.all_day ?? false;
      let s = o.start || src.s; let e = o.end || src.e || addMin(s, allDay ? 1440 : 60);
      if (allDay) { s = sod(s); if (e <= s) e = addDays(s, 1); }

      const defaultTitle = tx('新建日程', 'New Event');
      const titleIn = h('input', { class: 'input ev-title-in', value: o.duplicate ? `${src.title || ''}` : (src.title || ''), placeholder: defaultTitle, autofocus: true, spellcheck: false });
      const locIn = h('input', { class: 'input ev-loc-in', value: src.location || '', placeholder: tx('添加地点或视频通话', 'Add location or video call'), spellcheck: false });
      const descIn = h('textarea', { class: 'textarea ev-notes-in', rows: 3, placeholder: tx('添加备注', 'Add notes') });
      descIn.value = src.description || '';
      const sDate = h('input', { class: 'input', type: 'date', 'aria-label': tx('开始日期', 'Start date') });
      const sTime = h('input', { class: 'input', type: 'time', step: 300, 'aria-label': tx('开始时间', 'Start time') });
      const eDate = h('input', { class: 'input', type: 'date', 'aria-label': tx('结束日期', 'End date') });
      const eTime = h('input', { class: 'input', type: 'time', step: 300, 'aria-label': tx('结束时间', 'End time') });
      const dot = h('span', { class: 'ev-color' });
      const calSel = h('select', { class: 'select' }, w.map((c) => h('option', { value: c.guid }, c.title)));
      calSel.value = (o.pguid && w.some((c) => c.guid === o.pguid) && o.pguid) || (w.some((c) => c.guid === src.pguid) && src.pguid) || defaultCal();
      const paint = () => dot.style.setProperty('--c', calOf(calSel.value)?.color || 'var(--blue)');
      calSel.addEventListener('change', paint); paint();
      const alarmSel = h('select', { class: 'select' }, alarmsList().map(([v, l]) => h('option', { value: String(v) }, l)));
      alarmSel.value = String(store.get('cal.alarm', -1));
      const durText = h('span', { class: 'ev-dur' });

      const form = h('div', { class: 'ev-form' });
      const fill = () => {
        sDate.value = fmt.isoDate(s); sTime.value = fmt.time(s);
        eDate.value = fmt.isoDate(allDay ? sod(addMin(e, -1)) : e); eTime.value = fmt.time(e);
        form.classList.toggle('all-day', allDay);
        check();
      };
      const fromInputs = (dIn, tIn, isEnd) => {
        const d = toDate(dIn.value); if (!d) return null;
        if (allDay) return isEnd ? addDays(d, 1) : d;
        const [hh, mm] = (tIn.value || '00:00').split(':').map(Number);
        return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh || 0, mm || 0);
      };
      const check = () => {
        const ok = e > s;
        [eDate, eTime].forEach((x) => x.classList.toggle('invalid', !ok));
        const mins = Math.round((e - s) / 60000);
        if (!ok) durText.textContent = tx('结束早于开始', 'Ends before start');
        else if (allDay) durText.textContent = countText(Math.round(mins / 1440), '天', 'day');
        else if (mins < 60) durText.textContent = tx(`${mins} 分钟`, `${mins} min`);
        else if (mins % 60) durText.textContent = tx(`${Math.floor(mins / 60)} 小时 ${mins % 60} 分`, `${Math.floor(mins / 60)}h ${mins % 60}m`);
        else if (mins >= 1440 && mins % 1440 === 0) durText.textContent = countText(mins / 1440, '天', 'day');
        else durText.textContent = countText(mins / 60, '小时', 'hour');
        durText.classList.toggle('bad', !ok);
        return ok;
      };
      const onStart = () => { const ns = fromInputs(sDate, sTime, false); if (!ns) return; e = new Date(+e + (ns - s)); s = ns; fill(); };
      const onEnd = () => { const ne = fromInputs(eDate, eTime, true); if (ne) e = ne; check(); };
      sDate.addEventListener('change', onStart); sTime.addEventListener('change', onStart);
      eDate.addEventListener('change', onEnd); eTime.addEventListener('change', onEnd);
      const allSw = switchEl(allDay, (v) => {
        allDay = v;
        if (v) { s = sod(s); e = addDays(sod(addMin(e, -1)), 1); if (e <= s) e = addDays(s, 1); }
        else if (!isNew && !src.all_day) { s = new Date(sod(s).getTime() + (src.s - sod(src.s))); e = addMin(s, (src.e - src.s) / 60000); }
        else { s = addMin(sod(s), 9 * 60); e = addMin(s, 60); }
        fill();
      });

      const row = (label, control, cls = '') => h('div', { class: `group-row ${cls}` }, h('span', { class: 'label' }, label), control);
      form.append(
        h('div', { class: 'ev-head' }, dot, titleIn),
        h('label', { class: 'ev-loc' }, icon('map-pin'), locIn),
        h('div', { class: 'group' },
          row(tx('全天', 'All-day'), allSw),
          row(tx('开始', 'Starts'), h('div', { class: 'ev-dt' }, sDate, sTime)),
          row(tx('结束', 'Ends'), h('div', { class: 'ev-dt' }, eDate, eTime)),
          h('div', { class: 'ev-dur-row' }, durText)),
        h('div', { class: 'group' },
          row(tx('日历', 'Calendar'), calSel),
          isNew ? row(tx('提醒', 'Alert'), alarmSel) : null),
        h('label', { class: 'ev-notes' }, descIn));
      fill();

      const save = async () => {
        if (!check()) { toast(tx('结束时间必须晚于开始时间', 'End time must be after start time'), 'error'); return false; }
        const alarm = Number(alarmSel.value);
        const body = payload(isNew ? {} : ev, {
          title: titleIn.value.trim() || defaultTitle, location: locIn.value.trim(), description: descIn.value,
          pguid: calSel.value, start: s, end: e, all_day: allDay, alarm_minutes: isNew && alarm >= 0 ? alarm : null,
        });
        if (isNew) {
          body.etag = null;
          await post('/api/calendar/events', body);
          store.set('cal.alarm', alarm);
        } else {
          await put(`/api/calendar/events/${enc(ev.pguid)}/${enc(ev.guid)}`, body);
        }
        if (S.hidden.has(body.pguid)) { S.hidden.delete(body.pguid); store.set('cal.hidden', [...S.hidden]); renderCals(); }
        toast(isNew ? tx('已添加日程', 'Event added') : tx('已保存更改', 'Changes saved'), 'success');
        if (isNew && !(s >= fetchRange()[0] && s < fetchRange()[1])) goto(s);
        refetch();
      };
      modal({
        title: isNew ? tx('新建日程', 'New Event') : tx('编辑日程', 'Edit Event'),
        body: form, cls: 'ev-modal', width: '460px', onClose: o.onClose,
        actions: [
          !isNew ? { label: tx('删除', 'Delete'), icon: 'trash-2', kind: 'danger-ghost', left: true, onClick: async ({ close }) => { close(); await removeEvent(ev); } } : null,
          { label: tx('取消', 'Cancel') },
          { label: isNew ? tx('添加', 'Add') : tx('保存', 'Save'), primary: true, onClick: save },
        ].filter(Boolean),
      });
    }

    // ---------------------------------------------------------- calendars
    function newCalendar() {
      const name = h('input', { class: 'input', placeholder: tx('例如：健身、学习、旅行', 'e.g. Fitness, Study, Travel'), autofocus: true });
      const sw = colorSwatches('#007aff');
      modal({
        title: tx('新建日历', 'New Calendar'), size: 'sm',
        body: h('div', { class: 'form' }, field(tx('名称', 'Name'), name), field(tx('颜色', 'Color'), sw)),
        actions: [
          { label: tx('取消', 'Cancel') },
          {
            label: tx('创建', 'Create'), primary: true,
            onClick: async () => {
              const t = name.value.trim();
              if (!t) { name.focus(); return false; }
              await post('/api/calendar/calendars', { title: t, color: sw.value });
              toast(tx(`已创建日历“${t}”`, `Created calendar “${t}”`), 'success');
              await loadCals();
            },
          },
        ],
      });
    }
    async function removeCalendar(c) {
      const ok = await confirmDialog(tx(`删除日历“${c.title}”？`, `Delete calendar “${c.title}”?`), {
        title: tx('删除日历', 'Delete Calendar'), okLabel: tx('删除', 'Delete'), danger: true, icon: 'trash-2',
        detail: tx('日历中的所有日程都会从你的所有设备上删除，且无法恢复。', 'All events in this calendar will be permanently deleted across all your devices.'),
      });
      if (!ok) return;
      try { await del(`/api/calendar/calendars/${enc(c.guid)}`); toast(tx('已删除日历', 'Calendar deleted'), 'success'); } catch (e) { toastError(e); }
      await reload();
    }

    // ---------------------------------------------------------- lifecycle
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e) || document.querySelector('.overlay,.menu,.popover')) return;
      const k = e.key.toLowerCase();
      if (k === 'arrowleft') step(-1);
      else if (k === 'arrowright') step(1);
      else if (k === 't') goToday();
      else if (k === 'd') setView('day');
      else if (k === 'w') setView('week');
      else if (k === 'm') setView('month');
      else if (k === 'l') setView('list');
      else return;
      e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    let lastW = 0;
    const ro = new ResizeObserver(() => {
      const w = viewEl.clientWidth; const hgt = viewEl.clientHeight;
      const sig = `${w < 600}|${S.view === 'month' ? Math.round(hgt / 40) : ''}`;
      if (sig !== lastW) { lastW = sig; render(); }
    });
    ro.observe(viewEl);
    let today = fmt.isoDate(new Date());
    const timer = setInterval(() => {
      if (fmt.isoDate(new Date()) !== today) { today = fmt.isoDate(new Date()); render(); } else positionNow();
    }, 30000);
    const onVisible = () => { if (document.visibilityState === 'visible') { loadCals(); ensure(); } };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    const initialRange = fetchRange();
    const initialEvents = peekCache('/api/calendar/events', { start: fmt.isoDate(initialRange[0]), end: fmt.isoDate(initialRange[1]) });
    if (initialEvents) S.cache.set(keyOf(initialRange), initialEvents.map(norm));
    renderCals();
    render(true);
    loadCals();
    ensure();

    return () => {
      disposed = true;
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      clearInterval(timer);
      ro.disconnect();
    };
  },
};
