// Reminders — smart lists (今天/计划/全部/旗标/已完成) + user lists, inline editing.
import { cachedGet, peekCache, post, patch, del, enc } from '../api.js';
import {
  h, clear, icon, iconBtn, btn, toolbar, segmented, searchBox, switchEl, field, menu, popover,
  toast, toastError, confirmDialog, empty, skeleton, errorBox, fmt, toDate, store, isTyping,
} from '../ui.js';

const SMART = [
  { id: 'today', title: '今天', icon: 'calendar-days', color: '#007aff' },
  { id: 'scheduled', title: '计划', icon: 'calendar', color: '#ff3b30' },
  { id: 'all', title: '全部', icon: 'inbox', color: '#5b5b60' },
  { id: 'flagged', title: '旗标', icon: 'flag', color: '#ff9500' },
  { id: 'completed', title: '已完成', icon: 'check', color: '#8e8e93' },
];
const PRIORITY = [
  { value: 0, label: '无' }, { value: 9, label: '低' }, { value: 5, label: '中' }, { value: 1, label: '高' },
];
const bangs = (p) => (p === 1 ? '!!!' : p === 5 ? '!!' : p === 9 ? '!' : '');

export function listColor(c) {
  if (!c) return '#007aff';
  if (typeof c === 'object') return c.daHexString || c.hex || '#007aff';
  const s = String(c).trim();
  if (s.startsWith('#')) return s;
  try { const o = JSON.parse(s); return o.daHexString || o.hex || '#007aff'; } catch { return '#007aff'; }
}

function endOfToday() { const d = new Date(); d.setHours(23, 59, 59, 999); return d; }
function isOverdue(r) {
  const d = toDate(r.due_date); if (!d || r.completed) return false;
  if (r.all_day || /^\d{4}-\d{2}-\d{2}$/.test(r.due_date)) { const t = new Date(); t.setHours(0, 0, 0, 0); return d < t; }
  return d < new Date();
}

export default {
  id: 'reminders',
  title: '提醒事项',
  app: 'reminders',
  mount(el) {
    const S = {
      lists: (peekCache('/api/reminders/lists') || []).filter((l) => !l.is_group),
      open: new Map(), // listId -> reminders (incomplete)
      done: new Map(), // listId -> reminders (completed), lazy
      sel: store.get('rem.sel', { type: 'smart', id: 'today' }),
      showDone: store.get('rem.showDone', false),
      query: '',
      focusId: null,
    };
    let alive = true;
    let loadSeq = 0;

    let tb_done;
    const sideBody = h('div', { class: 'pane-body' });
    const listBody = h('div', { class: 'pane-body rem-body' });
    const tb = toolbar({
      title: '',
      right: [
        iconBtn('list', '切换列表', (e) => switchMenu(e.currentTarget), { cls: 'when-side-hidden' }),
        h('span', { ref: (x) => { tb_done = x; } }),
        iconBtn('refresh-cw', '刷新 (F5)', () => reload({ quiet: true, force: true }), { cls: 'refresh' }),
        h('button', { class: 'btn primary sm', type: 'button', dataset: { new: '' }, onclick: () => focusNewRow() }, icon('plus'), '新提醒事项'),
      ],
    });
    tb.querySelector('.refresh').dataset.refresh = '';

    const search = searchBox({ placeholder: '搜索提醒事项', oninput: (q) => { S.query = q.toLowerCase(); renderMain(); } });

    el.append(h('div', { class: 'panes collapse-side' },
      h('div', { class: 'pane side rem-side' }, h('div', { class: 'rem-side-search' }, search), sideBody),
      h('div', { class: 'pane fill' }, tb, listBody)));

    // ------------------------------------------------------------ data
    const listById = (id) => S.lists.find((l) => l.id === id);
    const allOpen = () => [...S.open.values()].flat();
    const allDone = () => [...S.done.values()].flat();

    async function reload({ quiet = false, force = false } = {}) {
      const seq = ++loadSeq;
      if (!quiet && !S.lists.length) { clear(sideBody, skeleton(5, { avatar: true })); clear(listBody, skeleton(7)); }
      try {
        const lists = await cachedGet('/api/reminders/lists', undefined, {
          force, onUpdate: () => { if (alive && seq === loadSeq) reload({ quiet: true }); },
        });
        if (!alive || seq !== loadSeq) return;
        S.lists = lists.filter((l) => !l.is_group);
        const res = await Promise.all(S.lists.map((l) => cachedGet('/api/reminders', { list_id: l.id }, {
          force, onUpdate: (rows) => {
            if (!alive || seq !== loadSeq) return;
            S.open.set(l.id, rows); renderSide(); renderMain();
          },
        })));
        if (!alive || seq !== loadSeq) return;
        S.open = new Map(S.lists.map((l, i) => [l.id, res[i]]));
        S.done = new Map();
        if (S.sel.type === 'list' && !listById(S.sel.id)) S.sel = { type: 'smart', id: 'today' };
        if (needDone()) await loadDone(force);
        renderSide(); renderMain();
      } catch (e) {
        if (!alive || seq !== loadSeq) return;
        if (S.open.size) toastError(e);
        else { clear(listBody, errorBox(e)); clear(sideBody); }
      }
    }

    function needDone() { return S.sel.id === 'completed' || (S.sel.type === 'list' && S.showDone); }
    async function loadDone(force = false) {
      const ids = S.sel.type === 'list' ? [S.sel.id] : S.lists.map((l) => l.id);
      await Promise.all(ids.filter((id) => !S.done.has(id)).map(async (id) => {
        const rows = await cachedGet('/api/reminders', { list_id: id, include_completed: true }, {
          force, onUpdate: (updated) => {
            if (!alive) return;
            S.done.set(id, updated.filter((r) => r.completed)); renderMain();
          },
        });
        if (!alive) return;
        S.done.set(id, rows.filter((r) => r.completed));
      }));
    }

    function smartItems(id) {
      const open = allOpen();
      if (id === 'today') return open.filter((r) => { const d = toDate(r.due_date); return d && d <= endOfToday(); });
      if (id === 'scheduled') return open.filter((r) => r.due_date);
      if (id === 'flagged') return open.filter((r) => r.flagged);
      if (id === 'completed') return allDone();
      return open;
    }

    // ------------------------------------------------------------ side
    function renderSide() {
      const tiles = h('div', { class: 'smart-grid' }, SMART.map((s) => {
        const count = s.id === 'completed' ? null : smartItems(s.id).length;
        return h('button', {
          type: 'button', class: `smart-tile ${S.sel.type === 'smart' && S.sel.id === s.id ? 'active' : ''}`, style: { '--c': s.color },
          onclick: () => select({ type: 'smart', id: s.id }),
        },
        h('span', { class: 'smart-icon' }, icon(s.icon, { size: 15 })),
        h('span', { class: 'smart-count' }, count ?? ''),
        h('span', { class: 'smart-title' }, s.title));
      }));
      const lists = h('div', { class: 'side-list' },
        h('div', { class: 'side-title' }, '我的列表'),
        S.lists.length ? S.lists.map((l) => {
          const c = listColor(l.color);
          return h('div', {
            class: `side-item ${S.sel.type === 'list' && S.sel.id === l.id ? 'active' : ''}`, onclick: () => select({ type: 'list', id: l.id }),
            ondragover: (e) => { if (dragId) { e.preventDefault(); e.currentTarget.classList.add('drop-target'); } },
            ondragleave: (e) => e.currentTarget.classList.remove('drop-target'),
            ondrop: (e) => { e.currentTarget.classList.remove('drop-target'); if (dragId) moveTo(dragId, l.id); },
          },
          h('span', { class: 'list-badge', style: { '--c': c } }, icon('list', { size: 12 })),
          h('span', { class: 'label' }, l.title),
          h('span', { class: 'count' }, (S.open.get(l.id) || []).length || ''));
        }) : h('div', { class: 'small faint', style: { padding: '6px 8px' } }, '没有列表'));
      clear(sideBody, tiles, lists);
    }

    function select(sel) {
      S.sel = sel; store.set('rem.sel', sel); S.focusId = null;
      renderSide();
      if (needDone()) { clear(listBody, skeleton(5)); loadDone().then(renderMain).catch(toastError); } else renderMain();
    }

    function switchMenu(anchor) {
      menu(anchor, [
        ...SMART.map((s) => ({ label: s.title, icon: s.icon, checked: S.sel.type === 'smart' && S.sel.id === s.id, onClick: () => select({ type: 'smart', id: s.id }) })),
        '-',
        ...S.lists.map((l) => ({ label: l.title, dot: listColor(l.color), checked: S.sel.type === 'list' && S.sel.id === l.id, onClick: () => select({ type: 'list', id: l.id }) })),
      ]);
    }

    // ------------------------------------------------------------ main
    function renderMain() {
      const isList = S.sel.type === 'list';
      const list = isList ? listById(S.sel.id) : null;
      const smart = !isList ? SMART.find((s) => s.id === S.sel.id) : null;
      const color = list ? listColor(list.color) : smart?.color || '#007aff';
      const title = list?.title || smart?.title || '';
      tb.setTitle(S.query ? `搜索：${S.query}` : '');

      // show-completed toggle only makes sense for real lists
      clear(tb_done, isList ? btn(S.showDone ? '隐藏已完成' : '显示已完成', {
        kind: 'ghost', size: 'sm', icon: S.showDone ? 'eye-off' : 'eye',
        onclick: async () => { S.showDone = !S.showDone; store.set('rem.showDone', S.showDone); if (S.showDone) await loadDone(); renderMain(); },
      }) : null);

      let rows;
      if (S.query) rows = [...allOpen(), ...allDone()].filter((r) => `${r.title} ${r.desc || ''}`.toLowerCase().includes(S.query));
      else if (isList) rows = [...(S.open.get(list.id) || []), ...(S.showDone ? S.done.get(list.id) || [] : [])];
      else rows = smartItems(S.sel.id);

      const count = rows.filter((r) => !r.completed).length;
      const head = h('div', { class: 'rem-head', style: { '--c': color } },
        h('h1', {}, S.query ? '搜索结果' : title),
        h('span', { class: 'rem-head-count' }, S.sel.id === 'completed' && !S.query ? rows.length : count));

      const body = h('div', { class: 'rem-list' });
      if (S.query || !isList) {
        // group: scheduled → by day, others → by list
        const groups = new Map();
        const sorted = [...rows].sort((a, b) => (toDate(a.due_date) || 8.64e15) - (toDate(b.due_date) || 8.64e15));
        for (const r of sorted) {
          let key; let label; let c;
          if (S.sel.id === 'scheduled' && !S.query) {
            const d = toDate(r.due_date); key = fmt.isoDate(d);
            label = isOverdue(r) ? '已过期' : `${fmt.relDay(d)} · ${fmt.weekday(d)}`;
            if (isOverdue(r)) key = '0-overdue';
          } else {
            const l = listById(r.list_id); key = r.list_id; label = l?.title || '列表'; c = listColor(l?.color);
          }
          if (!groups.has(key)) groups.set(key, { label, c, rows: [] });
          groups.get(key).rows.push(r);
        }
        for (const g of [...groups.entries()].sort((a, b) => (S.sel.id === 'scheduled' ? a[0].localeCompare(b[0]) : 0)).map((x) => x[1])) {
          body.append(h('div', { class: 'rem-group-title', style: { '--c': g.c || 'var(--text)' } }, g.label));
          for (const r of g.rows) body.append(row(r, { showList: S.sel.id === 'scheduled' || S.query }));
        }
      } else {
        const ids = new Set(rows.map((r) => r.id));
        const top = rows.filter((r) => !r.parent_reminder_id || !ids.has(r.parent_reminder_id));
        top.sort((a, b) => Number(a.completed) - Number(b.completed));
        for (const r of top) {
          body.append(row(r));
          for (const c of rows.filter((x) => x.parent_reminder_id === r.id)) body.append(row(c, { sub: true }));
        }
      }

      const canAdd = !S.query && S.sel.id !== 'completed' && S.lists.length;
      clear(listBody, head, body, canAdd ? newRow(color) : null);
      if (!rows.length && !canAdd) listBody.append(empty({ icon: 'check-check', title: S.query ? '没有匹配的提醒事项' : '没有已完成的提醒事项' }));
      else if (!rows.length) listBody.append(h('div', { class: 'rem-empty' }, S.sel.id === 'today' ? '今天没有待办，享受一下吧 ☀' : '没有提醒事项'));
    }

    function row(r, { sub, showList } = {}) {
      const list = listById(r.list_id);
      const color = listColor(list?.color);
      const titleInput = h('input', { class: 'rem-title', value: r.title, spellcheck: false, 'aria-label': '标题' });
      titleInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); titleInput.blur(); }
        if (e.key === 'Escape') { titleInput.value = r.title; titleInput.blur(); }
      });
      titleInput.addEventListener('blur', () => {
        const v = titleInput.value.trim();
        if (!v) { titleInput.value = r.title; return; }
        if (v !== r.title) save(r, { title: v });
      });
      const due = toDate(r.due_date);
      const meta = [
        due ? h('span', { class: isOverdue(r) ? 'overdue' : '' }, icon('calendar', { size: 12 }),
          `${fmt.relDay(due)}${r.all_day || /^\d{4}-\d{2}-\d{2}$/.test(r.due_date) ? '' : ` ${fmt.time(due)}`}`) : null,
        showList || (S.sel.type === 'smart' && S.sel.id === 'scheduled') ? h('span', { class: 'rem-list-name', style: { '--c': color } }, list?.title) : null,
      ].filter(Boolean);
      const check = h('input', {
        type: 'checkbox', class: 'round-check', checked: !!r.completed, style: { '--c': color }, 'aria-label': '完成',
        onchange: () => toggleDone(r, check.checked, rowEl),
      });
      const rowEl = h('div', {
        class: `rem-row ${r.completed ? 'done' : ''} ${sub ? 'sub' : ''} ${S.focusId === r.id ? 'focus' : ''}`, draggable: true, dataset: { id: r.id },
        oncontextmenu: (e) => contextMenu(e, r),
        ondragstart: (e) => { dragId = r.id; e.dataTransfer.effectAllowed = 'move'; },
        ondragend: () => { dragId = null; },
      },
      check,
      h('div', { class: 'rem-main' },
        h('div', { class: 'row gap-6' },
          bangs(r.priority) ? h('span', { class: 'rem-bangs', style: { '--c': color } }, bangs(r.priority)) : null,
          titleInput,
          r.flagged ? h('span', { class: 'rem-flag' }, icon('flag', { size: 13 })) : null),
        r.desc ? h('div', { class: 'rem-notes' }, r.desc) : null,
        meta.length ? h('div', { class: 'rem-meta' }, meta) : null),
      h('div', { class: 'rem-actions' },
        iconBtn('flag', r.flagged ? '取消旗标' : '添加旗标', () => save(r, { flagged: !r.flagged }), { size: 'sm', cls: r.flagged ? 'on flag' : '' }),
        iconBtn('info', '详细信息', (e) => details(e.currentTarget, r), { size: 'sm' })));
      return rowEl;
    }

    function newRow(color) {
      const input = h('input', { class: 'rem-title', placeholder: '新提醒事项', spellcheck: false });
      const add = async () => {
        const title = input.value.trim(); if (!title) return;
        const listId = S.sel.type === 'list' ? S.sel.id : (S.lists.find((l) => l.title === '提醒') || S.lists[0]).id;
        const body = { list_id: listId, title };
        if (S.sel.id === 'today') body.due_date = fmt.isoDate(new Date());
        if (S.sel.id === 'flagged') body.flagged = true;
        if (body.due_date) body.all_day = true;
        input.value = '';
        try {
          const r = await post('/api/reminders', body);
          (S.open.get(listId) || S.open.set(listId, []).get(listId)).push(r);
          renderSide(); renderMain();
          listBody.querySelector('.rem-new .rem-title')?.focus();
        } catch (e) { toastError(e); input.value = title; }
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) add(); if (e.key === 'Escape') input.blur(); });
      return h('div', { class: 'rem-row rem-new', onclick: () => input.focus() },
        h('span', { class: 'rem-plus', style: { '--c': color } }, icon('plus', { size: 14 })),
        h('div', { class: 'rem-main' }, input));
    }

    function focusNewRow() {
      const i = listBody.querySelector('.rem-new .rem-title');
      if (i) { i.scrollIntoView({ block: 'nearest' }); i.focus(); }
      else if (S.lists.length) { select({ type: 'list', id: S.lists[0].id }); setTimeout(focusNewRow, 50); }
    }

    // ---------------------------------------------------------- actions
    function replace(updated) {
      for (const m of [S.open, S.done]) {
        for (const [k, rows] of m) m.set(k, rows.filter((x) => x.id !== updated.id));
      }
      if (updated.deleted) return;
      const target = updated.completed ? S.done : S.open;
      if (target.has(updated.list_id) || !updated.completed) {
        if (!target.has(updated.list_id)) target.set(updated.list_id, []);
        target.get(updated.list_id).push(updated);
      }
    }

    async function save(r, changes, { rerender = true } = {}) {
      const before = { ...r };
      Object.assign(r, changes);
      if (changes.clear_due_date) r.due_date = null;
      if (rerender) { renderSide(); renderMain(); }
      try {
        const updated = await patch(`/api/reminders/item/${enc(r.id)}`, changes);
        Object.assign(r, updated);
        replace(r);
        if (rerender) { renderSide(); renderMain(); }
      } catch (e) {
        Object.assign(r, before); renderSide(); renderMain(); toastError(e);
      }
    }

    function toggleDone(r, value, rowEl) {
      rowEl.classList.toggle('done', value);
      const hide = value && !(S.sel.type === 'list' && S.showDone) && S.sel.id !== 'completed';
      const commit = () => {
        r.completed = value;
        replace(r);
        renderSide(); renderMain();
      };
      if (hide) { rowEl.classList.add('leaving'); setTimeout(commit, 650); } else commit();
      patch(`/api/reminders/item/${enc(r.id)}`, { completed: value }).then((u) => Object.assign(r, u)).catch((e) => {
        r.completed = !value; replace(r); renderSide(); renderMain(); toastError(e);
      });
      if (value) toast(`已完成“${r.title}”`, 'success', { ms: 3500, action: { label: '撤销', onClick: () => save(r, { completed: false }) } });
    }

    async function remove(r) {
      if (!await confirmDialog(`删除“${r.title}”？`, { title: '删除提醒事项', okLabel: '删除', danger: true, icon: 'trash-2' })) return;
      try {
        await del(`/api/reminders/item/${enc(r.id)}`);
        r.deleted = true; replace(r); renderSide(); renderMain();
        toast('已删除', 'success');
      } catch (e) { toastError(e); }
    }

    let dragId = null;
    function moveTo(id, listId) {
      const r = [...allOpen(), ...allDone()].find((x) => x.id === id);
      if (r && r.list_id !== listId) save(r, { list_id: listId }).then(() => toast(`已移到“${listById(listId)?.title}”`, 'success'));
    }

    function contextMenu(e, r) {
      menu(e, [
        { label: r.completed ? '标记为未完成' : '标记为已完成', icon: 'circle-check', onClick: () => save(r, { completed: !r.completed }) },
        { label: r.flagged ? '取消旗标' : '添加旗标', icon: 'flag', onClick: () => save(r, { flagged: !r.flagged }) },
        { label: '详细信息…', icon: 'info', onClick: () => details(listBody.querySelector(`[data-id="${CSS.escape(r.id)}"] .rem-actions`) || e, r) },
        '-',
        { section: '截止日期' },
        { label: '今天', icon: 'calendar-days', onClick: () => save(r, { due_date: fmt.isoDate(new Date()), all_day: true }) },
        { label: '明天', icon: 'calendar-plus', onClick: () => { const d = new Date(); d.setDate(d.getDate() + 1); save(r, { due_date: fmt.isoDate(d), all_day: true }); } },
        { label: '移除日期', icon: 'calendar', disabled: !r.due_date, onClick: () => save(r, { clear_due_date: true }) },
        '-',
        { section: '移到' },
        ...S.lists.filter((l) => l.id !== r.list_id).map((l) => ({ label: l.title, dot: listColor(l.color), onClick: () => moveTo(r.id, l.id) })),
        '-',
        { label: '删除', icon: 'trash-2', danger: true, onClick: () => remove(r) },
      ]);
    }

    function details(anchor, r) {
      const due = toDate(r.due_date);
      const dateOnly = !due || r.all_day || /^\d{4}-\d{2}-\d{2}$/.test(r.due_date);
      const title = h('input', { class: 'input', value: r.title });
      const notes = h('textarea', { class: 'textarea', placeholder: '备注', rows: 3 }, r.desc || '');
      const date = h('input', { class: 'input', type: 'date', value: due ? fmt.isoDate(due) : fmt.isoDate(new Date()) });
      const time = h('input', { class: 'input', type: 'time', value: due && !dateOnly ? fmt.time(due) : '09:00' });
      const dateSw = switchEl(!!due, (v) => { dateRow.classList.toggle('off', !v); if (!v) timeSw.input.checked = false; timeRow.classList.toggle('off', !timeSw.input.checked); });
      const timeSw = switchEl(!!due && !dateOnly, (v) => { if (v) dateSw.input.checked = true; dateRow.classList.toggle('off', !dateSw.input.checked); timeRow.classList.toggle('off', !v); });
      const dateRow = h('div', { class: `group-row ${due ? '' : 'off'}` }, h('span', { class: 'gi red' }, icon('calendar', { size: 14 })), h('span', { class: 'label' }, '日期'), date, dateSw);
      const timeRow = h('div', { class: `group-row ${due && !dateOnly ? '' : 'off'}` }, h('span', { class: 'gi blue' }, icon('clock', { size: 14 })), h('span', { class: 'label' }, '时间'), time, timeSw);
      const flag = switchEl(r.flagged);
      const prio = segmented(PRIORITY, r.priority || 0, null);
      const listSel = h('select', { class: 'select' }, S.lists.map((l) => h('option', { value: l.id, selected: l.id === r.list_id }, l.title)));

      const p = popover(anchor, h('div', { class: 'rem-detail' },
        h('div', { class: 'rem-detail-head' }, title, notes),
        h('div', { class: 'group' }, dateRow, timeRow),
        h('div', { class: 'group' },
          h('div', { class: 'group-row' }, h('span', { class: 'gi orange' }, icon('flag', { size: 14 })), h('span', { class: 'label' }, '旗标'), flag),
          h('div', { class: 'group-row' }, h('span', { class: 'gi gray' }, icon('triangle-alert', { size: 14 })), h('span', { class: 'label' }, '优先级'), prio),
          h('div', { class: 'group-row' }, h('span', { class: 'gi indigo' }, icon('list', { size: 14 })), h('span', { class: 'label' }, '列表'), listSel)),
        h('div', { class: 'row between', style: { marginTop: '12px' } },
          btn('删除', { kind: 'danger-ghost', icon: 'trash-2', size: 'sm', onclick: () => { p.close(); remove(r); } }),
          btn('完成', { kind: 'primary', size: 'sm', onclick: apply }))), { align: 'end', width: '340px', cls: 'rem-pop' });
      setTimeout(() => title.focus(), 30);
      p.el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) apply(); });

      function apply() {
        const ch = {};
        if (title.value.trim() && title.value.trim() !== r.title) ch.title = title.value.trim();
        if (notes.value !== (r.desc || '')) ch.desc = notes.value;
        if (flag.input.checked !== !!r.flagged) ch.flagged = flag.input.checked;
        if (prio.value !== (r.priority || 0)) ch.priority = prio.value;
        if (listSel.value !== r.list_id) ch.list_id = listSel.value;
        if (!dateSw.input.checked) { if (r.due_date) ch.clear_due_date = true; } else {
          const v = timeSw.input.checked ? `${date.value}T${time.value}` : date.value;
          const cur = r.due_date ? (dateOnly ? fmt.isoDate(due) : fmt.isoLocal(due)) : null;
          if (v !== cur) { ch.due_date = v; ch.all_day = !timeSw.input.checked; }
        }
        p.close();
        if (Object.keys(ch).length) save(r, ch);
      }
    }

    const onKey = (e) => {
      if (isTyping(e) || document.querySelector('.overlay,.popover')) return;
      if (e.key === 'Enter' && !e.ctrlKey) { e.preventDefault(); focusNewRow(); }
    };
    document.addEventListener('keydown', onKey);
    for (const l of S.lists) {
      const rows = peekCache('/api/reminders', { list_id: l.id });
      if (rows) S.open.set(l.id, rows);
      const done = peekCache('/api/reminders', { list_id: l.id, include_completed: true });
      if (done) S.done.set(l.id, done.filter((r) => r.completed));
    }
    if (S.sel.type === 'list' && !listById(S.sel.id)) S.sel = { type: 'smart', id: 'today' };
    if (S.lists.length) { renderSide(); renderMain(); }
    reload();
    return () => { alive = false; loadSeq++; document.removeEventListener('keydown', onKey); };
  },
};
