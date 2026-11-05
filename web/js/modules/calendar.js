// Calendar: month / week views, create / edit / delete events, manage calendars.
import { get, post, put, del, enc } from '../api.js';
import { h, clear, toast, toastError, modal, confirmDialog, field, spinner, fmt, toDate, store } from '../ui.js';

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
const DAY = 86400000;
const COLORS = ['#1BADF8', '#63DA38', '#FFCC00', '#FF9500', '#FF2968', '#CC73E1', '#A2845E'];
const ALARMS = [
  ['', '无'], ['0', '日程发生时'], ['5', '5 分钟前'], ['15', '15 分钟前'], ['30', '30 分钟前'],
  ['60', '1 小时前'], ['120', '2 小时前'], ['1440', '1 天前'], ['2880', '2 天前'],
];

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
const mondayOf = (d) => addDays(startOfDay(d), -((d.getDay() + 6) % 7));
const sameDay = (a, b) => a.toDateString() === b.toDateString();

export default {
  id: 'calendar',
  title: '日历',
  icon: '📅',
  color: '#ff3b30',
  mount(el) {
    const state = {
      view: store.get('cal.view', 'month'),
      cursor: startOfDay(new Date()),
      calendars: [],
      hidden: new Set(store.get('cal.hidden', [])),
      events: [],
    };

    const calList = h('div', { class: 'list' });
    const title = h('h2', { class: 'toolbar-title' });
    const body = h('div', { class: 'cal-body' });
    const viewBtns = {
      month: h('button', { class: 'seg-btn', onclick: () => setView('month') }, '月'),
      week: h('button', { class: 'seg-btn', onclick: () => setView('week') }, '周'),
    };

    clear(el, h('div', { class: 'split' },
      h('div', { class: 'pane pane-side' },
        h('div', { class: 'pane-header' }, h('h3', {}, '日历'),
          h('button', { class: 'icon-btn', title: '新建日历', onclick: newCalendar }, '＋')),
        calList),
      h('div', { class: 'pane pane-main' },
        h('div', { class: 'toolbar' },
          title,
          h('div', { class: 'spacer' }),
          h('div', { class: 'seg' }, viewBtns.month, viewBtns.week),
          h('button', { class: 'btn', onclick: () => move(-1) }, '‹'),
          h('button', { class: 'btn', onclick: () => { state.cursor = startOfDay(new Date()); refresh(); } }, '今天'),
          h('button', { class: 'btn', onclick: () => move(1) }, '›'),
          h('button', { class: 'btn primary', onclick: () => editEvent(null, defaultStart()) }, '＋ 新建日程'),
        ),
        body)));

    function setView(v) { state.view = v; store.set('cal.view', v); refresh(); }
    function move(n) {
      const c = state.cursor;
      state.cursor = state.view === 'month' ? new Date(c.getFullYear(), c.getMonth() + n, 1) : addDays(c, 7 * n);
      refresh();
    }
    function defaultStart() {
      const now = new Date();
      const d = sameDay(state.cursor, startOfDay(now)) || state.view === 'week' ? now : state.cursor;
      return new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.min(now.getHours() + 1, 23), 0);
    }

    function range() {
      if (state.view === 'week') { const s = mondayOf(state.cursor); return [s, addDays(s, 7)]; }
      const first = new Date(state.cursor.getFullYear(), state.cursor.getMonth(), 1);
      const s = mondayOf(first);
      return [s, addDays(s, 42)];
    }

    function calOf(pguid) { return state.calendars.find((c) => c.guid === pguid); }
    function colorOf(ev) { return calOf(ev.pguid)?.color || '#1BADF8'; }
    function visible() { return state.events.filter((e) => !state.hidden.has(e.pguid)); }

    // Normalize to {s, e} Date objects, e exclusive.
    function span(ev) {
      const s = toDate(ev.start);
      let e = toDate(ev.end) || s;
      if (ev.all_day && e <= s) e = addDays(s, 1);
      return { s, e };
    }
    function eventsOn(day) {
      const ds = day; const de = addDays(day, 1);
      return visible().filter((ev) => { const { s, e } = span(ev); return s < de && (e > ds || (+e === +s && s >= ds)); })
        .sort((a, b) => (b.all_day - a.all_day) || (toDate(a.start) - toDate(b.start)));
    }

    function renderCalendars() {
      clear(calList, state.calendars.map((c) => {
        const cb = h('input', { type: 'checkbox', checked: !state.hidden.has(c.guid), style: { accentColor: c.color } });
        cb.addEventListener('change', () => {
          cb.checked ? state.hidden.delete(c.guid) : state.hidden.add(c.guid);
          store.set('cal.hidden', [...state.hidden]);
          renderBody();
        });
        return h('div', { class: 'list-item cal-item' },
          h('label', { class: 'check grow' }, cb, h('span', { class: 'dot', style: { background: c.color } }), c.title,
            c.read_only ? h('span', { class: 'badge' }, '只读') : null),
          !c.read_only && !c.is_default ? h('button', { class: 'icon-btn small hover-show', title: '删除日历', onclick: () => removeCalendar(c) }, '🗑') : null);
      }));
    }

    function renderBody() {
      const c = state.cursor;
      if (state.view === 'month') {
        title.textContent = `${c.getFullYear()}年${c.getMonth() + 1}月`;
        renderMonth();
      } else {
        const s = mondayOf(c); const e = addDays(s, 6);
        title.textContent = `${s.getFullYear()}年${s.getMonth() + 1}月${s.getDate()}日 – ${e.getMonth() + 1}月${e.getDate()}日`;
        renderWeek();
      }
      viewBtns.month.classList.toggle('active', state.view === 'month');
      viewBtns.week.classList.toggle('active', state.view === 'week');
    }

    function evChip(ev, showTime = true) {
      const color = colorOf(ev);
      return h('div', {
        class: `ev-chip ${ev.all_day ? 'all-day' : ''}`,
        style: ev.all_day ? { background: color } : { '--c': color },
        title: `${ev.title}${ev.location ? ' @ ' + ev.location : ''}`,
        onclick: (e) => { e.stopPropagation(); openEvent(ev); },
      }, !ev.all_day && showTime ? h('span', { class: 'ev-time' }, fmt.time(ev.start)) : null, ev.title || '(无标题)');
    }

    function renderMonth() {
      const [s] = range();
      const today = startOfDay(new Date());
      const grid = h('div', { class: 'month-grid' }, WEEKDAYS.map((w) => h('div', { class: 'month-head' }, `周${w}`)));
      for (let i = 0; i < 42; i++) {
        const day = addDays(s, i);
        const evs = eventsOn(day);
        const max = 4;
        const cell = h('div', {
          class: `month-cell ${day.getMonth() !== state.cursor.getMonth() ? 'other' : ''} ${sameDay(day, today) ? 'today' : ''}`,
          ondblclick: () => editEvent(null, new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 0)),
        },
          h('div', { class: 'day-num' }, day.getDate() === 1 ? `${day.getMonth() + 1}月${day.getDate()}日` : day.getDate()),
          evs.slice(0, max).map((ev) => evChip(ev)),
          evs.length > max ? h('div', { class: 'more', onclick: () => { state.cursor = day; setView('week'); } }, `还有 ${evs.length - max} 项…`) : null);
        grid.append(cell);
      }
      clear(body, grid);
    }

    function renderWeek() {
      const s = mondayOf(state.cursor);
      const days = [...Array(7)].map((_, i) => addDays(s, i));
      const today = startOfDay(new Date());
      const HOUR = 48;
      const head = h('div', { class: 'week-head' }, h('div', { class: 'week-gutter' }),
        days.map((d) => h('div', { class: `week-day-head ${sameDay(d, today) ? 'today' : ''}` },
          h('span', {}, `周${WEEKDAYS[(d.getDay() + 6) % 7]}`), h('b', {}, d.getDate()))));
      const allDay = h('div', { class: 'week-allday' }, h('div', { class: 'week-gutter small muted' }, '全天'),
        days.map((d) => h('div', { class: 'week-allday-cell' }, eventsOn(d).filter((e) => e.all_day).map((ev) => evChip(ev)))));
      const grid = h('div', { class: 'week-grid', style: { height: `${HOUR * 24}px` } });
      const gutter = h('div', { class: 'week-gutter hours' }, [...Array(24)].map((_, i) => h('div', { class: 'hour-label', style: { height: `${HOUR}px` } }, i ? `${fmt.pad(i)}:00` : '')));
      grid.append(gutter);
      for (const d of days) {
        const col = h('div', { class: `week-col ${sameDay(d, today) ? 'today' : ''}` });
        for (let i = 0; i < 24; i++) col.append(h('div', { class: 'hour-slot', style: { height: `${HOUR}px` }, onclick: () => editEvent(null, new Date(d.getFullYear(), d.getMonth(), d.getDate(), i, 0)) }));
        const timed = eventsOn(d).filter((e) => !e.all_day);
        // Simple overlap layout: assign columns greedily.
        const cols = [];
        const placed = timed.map((ev) => {
          let { s: es, e: ee } = span(ev);
          if (es < d) es = d;
          const dEnd = addDays(d, 1); if (ee > dEnd) ee = dEnd;
          let ci = cols.findIndex((end) => end <= es);
          if (ci < 0) { ci = cols.length; cols.push(ee); } else cols[ci] = ee;
          return { ev, es, ee, ci };
        });
        for (const p of placed) {
          const top = ((p.es - d) / 3600000) * HOUR;
          const height = Math.max(((p.ee - p.es) / 3600000) * HOUR, 20);
          const width = 100 / cols.length;
          col.append(h('div', {
            class: 'week-ev', style: { top: `${top}px`, height: `${height}px`, left: `${p.ci * width}%`, width: `calc(${width}% - 2px)`, '--c': colorOf(p.ev) },
            onclick: (e) => { e.stopPropagation(); openEvent(p.ev); },
          }, h('b', {}, p.ev.title || '(无标题)'), h('span', {}, `${fmt.time(p.es)} – ${fmt.time(p.ee)}`), p.ev.location ? h('span', {}, p.ev.location) : null));
        }
        if (sameDay(d, today)) {
          const now = new Date();
          col.append(h('div', { class: 'now-line', style: { top: `${((now - d) / 3600000) * HOUR}px` } }));
        }
        grid.append(col);
      }
      const scroller = h('div', { class: 'week-scroll' }, grid);
      clear(body, h('div', { class: 'week' }, head, allDay, scroller));
      scroller.scrollTop = HOUR * 7.5;
    }

    async function refresh() {
      renderBody();
      const [s, e] = range();
      try {
        const events = await get('/api/calendar/events', { start: fmt.isoDate(s), end: fmt.isoDate(e) });
        state.events = events;
        renderBody();
      } catch (err) { toastError(err); }
    }

    async function loadCalendars() {
      clear(calList, spinner());
      try {
        state.calendars = await get('/api/calendar/calendars');
        renderCalendars();
      } catch (err) { clear(calList, h('div', { class: 'error-box' }, err.message)); }
    }

    async function openEvent(ev) {
      let detail = ev;
      try { detail = await get(`/api/calendar/events/${enc(ev.pguid)}/${enc(ev.guid)}`); } catch (e) { console.warn(e); }
      editEvent({ ...ev, ...detail });
    }

    function editEvent(ev, startAt) {
      const isNew = !ev;
      const writable = state.calendars.filter((c) => !c.read_only);
      const ro = !isNew && (ev.read_only || calOf(ev.pguid)?.read_only || ev.recurring);
      let s; let e; let allDayVal;
      if (isNew) { s = startAt; e = new Date(+startAt + 3600000); allDayVal = false; } else {
        ({ s, e } = span(ev)); allDayVal = ev.all_day;
        if (allDayVal) e = addDays(e, -1); // inclusive last day for the form
      }
      const titleIn = h('input', { class: 'input', value: isNew ? '' : ev.title, placeholder: '标题' });
      const locIn = h('input', { class: 'input', value: isNew ? '' : ev.location, placeholder: '地点' });
      const descIn = h('textarea', { class: 'input', rows: 4, placeholder: '备注' }, isNew ? '' : ev.description);
      const allDay = h('input', { type: 'checkbox', checked: allDayVal });
      const startIn = h('input', { class: 'input' });
      const endIn = h('input', { class: 'input' });
      const setInputs = () => {
        const t = allDay.checked ? 'date' : 'datetime-local';
        startIn.type = t; endIn.type = t;
        startIn.value = allDay.checked ? fmt.isoDate(s) : fmt.isoLocal(s);
        endIn.value = allDay.checked ? fmt.isoDate(e < s ? s : e) : fmt.isoLocal(e <= s ? new Date(+s + 3600000) : e);
      };
      setInputs();
      allDay.addEventListener('change', () => { s = toDate(startIn.value) || s; e = toDate(endIn.value) || e; setInputs(); });
      startIn.addEventListener('change', () => {
        const ns = toDate(startIn.value); if (!ns) return;
        const diff = ns - s; s = ns; e = new Date(+(toDate(endIn.value) || e) + diff);
        endIn.value = allDay.checked ? fmt.isoDate(e) : fmt.isoLocal(e);
      });
      const calSel = h('select', { class: 'input' }, (ro ? state.calendars : writable).map((c) =>
        h('option', { value: c.guid, selected: isNew ? c.is_default : c.guid === ev.pguid }, c.title)));
      if (isNew && !writable.some((c) => c.is_default) && writable[0]) calSel.value = writable[0].guid;
      const alarmSel = h('select', { class: 'input' }, ALARMS.map(([v, l]) => h('option', { value: v }, l)));

      const form = h('div', { class: 'form' },
        ro ? h('div', { class: 'notice' }, ev.recurring ? '重复日程暂只支持查看（编辑需在 Apple 设备上进行）。' : '此日程或日历为只读。') : null,
        titleIn,
        h('label', { class: 'check' }, allDay, ' 全天'),
        h('div', { class: 'row gap' }, field('开始', startIn), field('结束', endIn)),
        field('日历', calSel),
        locIn,
        isNew ? field('提醒', alarmSel) : null,
        descIn,
        !isNew && ev.invitees?.length ? field('参与者', h('div', { class: 'small' }, ev.invitees.map((i) => i.commonName || i.email || i.guid).join('、'))) : null,
      );
      if (ro) form.querySelectorAll('input,select,textarea').forEach((x) => { x.disabled = true; });

      const save = async () => {
        const payload = {
          pguid: calSel.value,
          title: titleIn.value.trim() || '新建日程',
          start: startIn.value,
          end: endIn.value,
          all_day: allDay.checked,
          location: locIn.value,
          description: descIn.value,
          alarm_minutes: isNew && alarmSel.value !== '' ? Number(alarmSel.value) : null,
          etag: isNew ? null : ev.etag,
        };
        if (!payload.start || !payload.end) { toast('请填写时间', 'error'); return false; }
        if (isNew) await post('/api/calendar/events', payload);
        else await put(`/api/calendar/events/${enc(ev.pguid)}/${enc(ev.guid)}`, payload);
        toast(isNew ? '已创建日程' : '已保存', 'success');
        await refresh();
      };
      const actions = ro ? [{ label: '关闭' }] : [
        !isNew ? { label: '删除', danger: true, left: true, onClick: async () => {
          if (!await confirmDialog(`删除日程“${ev.title}”？`, { danger: true, okLabel: '删除' })) return false;
          await del(`/api/calendar/events/${enc(ev.pguid)}/${enc(ev.guid)}`, { etag: ev.etag });
          toast('已删除'); await refresh();
        } } : null,
        { label: '取消' },
        { label: isNew ? '创建' : '保存', primary: true, onClick: save },
      ].filter(Boolean);
      modal({ title: isNew ? '新建日程' : (ro ? '日程详情' : '编辑日程'), body: form, actions, width: '480px' });
    }

    function newCalendar() {
      const name = h('input', { class: 'input', placeholder: '日历名称' });
      let color = COLORS[0];
      const swatches = h('div', { class: 'swatches' }, COLORS.map((c) => {
        const sw = h('button', { class: `swatch ${c === color ? 'active' : ''}`, style: { background: c }, onclick: () => {
          color = c; swatches.querySelectorAll('.swatch').forEach((x) => x.classList.remove('active')); sw.classList.add('active');
        } });
        return sw;
      }));
      modal({ title: '新建日历', body: h('div', { class: 'form' }, name, field('颜色', swatches)), actions: [
        { label: '取消' },
        { label: '创建', primary: true, onClick: async () => {
          if (!name.value.trim()) return false;
          await post('/api/calendar/calendars', { title: name.value.trim(), color });
          toast('已创建日历', 'success'); await loadCalendars(); await refresh();
        } },
      ] });
    }

    async function removeCalendar(cal) {
      if (!await confirmDialog(`删除日历“${cal.title}”及其中所有日程？此操作不可撤销。`, { danger: true, okLabel: '删除' })) return;
      try { await del(`/api/calendar/calendars/${enc(cal.guid)}`); toast('已删除日历'); await loadCalendars(); await refresh(); } catch (e) { toastError(e); }
    }

    const timer = setInterval(() => { if (state.view === 'week') renderBody(); }, 60000);
    loadCalendars().then(refresh);
    return () => clearInterval(timer);
  },
};
