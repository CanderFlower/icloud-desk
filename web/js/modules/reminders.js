// Reminders: lists, quick add, complete, edit, delete, subtasks.
import { get, post, patch, del, enc } from '../api.js';
import { h, clear, toast, toastError, modal, confirmDialog, field, spinner, empty, fmt, toDate, store } from '../ui.js';

const PRIORITY = [[0, '无'], [9, '低'], [5, '中'], [1, '高']];
const PRIO_MARK = { 1: '!!!', 5: '!!', 9: '!' };

export function listColor(lst) {
  const c = lst?.color;
  if (!c) return '#007aff';
  if (typeof c === 'string' && c.startsWith('#')) return c;
  try {
    const o = typeof c === 'string' ? JSON.parse(c) : c;
    return o.daHexString || o.hex || '#007aff';
  } catch { return '#007aff'; }
}

export default {
  id: 'reminders',
  title: '提醒事项',
  icon: '☑️',
  color: '#ff9500',
  mount(el) {
    const state = {
      lists: [],
      current: store.get('rem.list', null),
      showCompleted: store.get('rem.showCompleted', false),
      items: [],
    };
    const listBox = h('div', { class: 'list' });
    const header = h('h2', { class: 'toolbar-title' });
    const items = h('div', { class: 'rem-items' });
    const showDone = h('input', { type: 'checkbox', checked: state.showCompleted });
    showDone.addEventListener('change', () => { state.showCompleted = showDone.checked; store.set('rem.showCompleted', showDone.checked); loadItems(); });
    const quick = h('input', { class: 'input', placeholder: '＋ 新建提醒事项，回车添加' });
    quick.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter' || !quick.value.trim() || !state.current) return;
      const title = quick.value.trim(); quick.value = '';
      try { await post('/api/reminders', { list_id: state.current, title }); await loadItems(); } catch (err) { toastError(err); }
    });

    clear(el, h('div', { class: 'split' },
      h('div', { class: 'pane pane-side' }, h('div', { class: 'pane-header' }, h('h3', {}, '我的列表')), listBox),
      h('div', { class: 'pane pane-main' },
        h('div', { class: 'toolbar' }, header, h('div', { class: 'spacer' }),
          h('label', { class: 'check small' }, showDone, ' 显示已完成'),
          h('button', { class: 'btn', onclick: () => loadItems() }, '刷新')),
        h('div', { class: 'pane-scroll' }, h('div', { class: 'rem-quick' }, quick), items))));

    function current() { return state.lists.find((l) => l.id === state.current); }

    function renderLists() {
      clear(listBox, state.lists.map((l) => h('div', {
        class: `list-item ${l.id === state.current ? 'active' : ''}`,
        onclick: () => { state.current = l.id; store.set('rem.list', l.id); renderLists(); loadItems(); },
      }, h('span', { class: 'dot big', style: { background: listColor(l) } }), h('span', { class: 'grow' }, l.title), h('span', { class: 'muted small' }, l.count ?? ''))));
    }

    function row(r, depth = 0) {
      const cb = h('input', { type: 'checkbox', class: 'round-check', checked: r.completed, style: { '--c': listColor(current()) } });
      cb.addEventListener('change', async () => {
        try { await patch(`/api/reminders/item/${enc(r.id)}`, { completed: cb.checked }); r.completed = cb.checked; setTimeout(loadItems, 600); } catch (e) { toastError(e); cb.checked = !cb.checked; }
      });
      const due = toDate(r.due_date);
      const overdue = due && !r.completed && due < new Date();
      return h('div', { class: `rem-row ${r.completed ? 'done' : ''}`, style: { paddingLeft: `${12 + depth * 28}px` } },
        cb,
        h('div', { class: 'rem-main', onclick: () => edit(r) },
          h('div', { class: 'rem-title' }, PRIO_MARK[r.priority] ? h('span', { class: 'prio' }, PRIO_MARK[r.priority] + ' ') : null, r.title || '(无标题)', r.flagged ? h('span', { class: 'flag' }, ' 🚩') : null),
          r.desc ? h('div', { class: 'rem-desc' }, r.desc) : null,
          due ? h('div', { class: `rem-due ${overdue ? 'overdue' : ''}` }, r.all_day ? fmt.date(due) : fmt.datetime(due)) : null),
        h('button', { class: 'icon-btn small hover-show', title: '添加子任务', onclick: () => addSub(r) }, '↳'),
        h('button', { class: 'icon-btn small hover-show', title: '删除', onclick: () => remove(r) }, '🗑'));
    }

    function renderItems() {
      const lst = current();
      header.textContent = lst ? lst.title : '提醒事项';
      header.style.color = lst ? listColor(lst) : '';
      if (!state.items.length) return clear(items, empty('没有提醒事项', '🎉'));
      const byParent = new Map();
      const ids = new Set(state.items.map((r) => r.id));
      for (const r of state.items) {
        const p = r.parent_reminder_id && ids.has(r.parent_reminder_id) ? r.parent_reminder_id : null;
        if (!byParent.has(p)) byParent.set(p, []);
        byParent.get(p).push(r);
      }
      const sortFn = (a, b) => (a.completed - b.completed) || ((toDate(a.due_date) || 8.64e15) - (toDate(b.due_date) || 8.64e15)) || ((toDate(b.created) || 0) - (toDate(a.created) || 0));
      const out = [];
      const walk = (pid, depth) => { for (const r of (byParent.get(pid) || []).sort(sortFn)) { out.push(row(r, depth)); walk(r.id, depth + 1); } };
      walk(null, 0);
      clear(items, out);
    }

    async function loadItems() {
      if (!state.current) return clear(items, empty('请选择一个列表'));
      clear(items, spinner());
      try {
        state.items = await get('/api/reminders', { list_id: state.current, include_completed: state.showCompleted });
        renderItems();
      } catch (e) { clear(items, h('div', { class: 'error-box' }, e.message)); }
    }

    async function loadLists() {
      clear(listBox, spinner());
      try {
        state.lists = (await get('/api/reminders/lists')).filter((l) => !l.is_group);
        if (!state.lists.some((l) => l.id === state.current)) state.current = state.lists[0]?.id || null;
        renderLists();
        loadItems();
      } catch (e) { clear(listBox, h('div', { class: 'error-box' }, e.message)); }
    }

    function form(r) {
      const title = h('input', { class: 'input', value: r?.title || '', placeholder: '标题' });
      const desc = h('textarea', { class: 'input', rows: 3, placeholder: '备注' }, r?.desc || '');
      const due = toDate(r?.due_date);
      const allDay = h('input', { type: 'checkbox', checked: r ? !!r.all_day : false });
      const hasDue = h('input', { type: 'checkbox', checked: !!due });
      const dueIn = h('input', { class: 'input' });
      const sync = () => {
        dueIn.type = allDay.checked ? 'date' : 'datetime-local';
        const d = toDate(dueIn.dataset.v) || due || new Date(Date.now() + 3600000);
        dueIn.value = allDay.checked ? fmt.isoDate(d) : fmt.isoLocal(d);
        dueIn.disabled = !hasDue.checked; allDay.disabled = !hasDue.checked;
      };
      dueIn.addEventListener('change', () => { dueIn.dataset.v = dueIn.value; });
      allDay.addEventListener('change', sync); hasDue.addEventListener('change', sync); sync();
      const prio = h('select', { class: 'input' }, PRIORITY.map(([v, l]) => h('option', { value: v, selected: (r?.priority || 0) === v }, l)));
      const flagged = h('input', { type: 'checkbox', checked: !!r?.flagged });
      const listSel = h('select', { class: 'input' }, state.lists.map((l) => h('option', { value: l.id, selected: l.id === (r?.list_id || state.current) }, l.title)));
      const body = h('div', { class: 'form' }, title, desc,
        h('div', { class: 'row gap' }, h('label', { class: 'check' }, hasDue, ' 截止日期'), h('label', { class: 'check' }, allDay, ' 全天')),
        dueIn,
        h('div', { class: 'row gap' }, field('优先级', prio), field('列表', listSel)),
        h('label', { class: 'check' }, flagged, ' 旗标'));
      const values = () => ({
        title: title.value.trim() || '新提醒事项',
        desc: desc.value,
        due_date: hasDue.checked ? dueIn.value : null,
        clear_due_date: !hasDue.checked,
        all_day: allDay.checked,
        priority: Number(prio.value),
        flagged: flagged.checked,
        list_id: listSel.value,
      });
      return { body, values };
    }

    function edit(r) {
      const f = form(r);
      modal({ title: '编辑提醒事项', body: f.body, width: '460px', actions: [
        { label: '删除', danger: true, left: true, onClick: async () => { await remove(r); } },
        { label: '取消' },
        { label: '保存', primary: true, onClick: async () => {
          await patch(`/api/reminders/item/${enc(r.id)}`, f.values()); toast('已保存', 'success'); await loadItems();
        } },
      ] });
    }

    function addSub(parent) {
      const f = form(null);
      modal({ title: `子任务：${parent.title}`, body: f.body, width: '460px', actions: [
        { label: '取消' },
        { label: '添加', primary: true, onClick: async () => {
          const v = f.values();
          await post('/api/reminders', { ...v, list_id: parent.list_id || state.current, parent_reminder_id: parent.id });
          await loadItems();
        } },
      ] });
    }

    async function remove(r) {
      if (!await confirmDialog(`删除“${r.title}”？`, { danger: true, okLabel: '删除' })) return false;
      try { await del(`/api/reminders/item/${enc(r.id)}`); toast('已删除'); await loadItems(); } catch (e) { toastError(e); }
    }

    loadLists();
  },
};
