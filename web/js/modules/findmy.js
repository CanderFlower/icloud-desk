// Find My — device list, map, play sound / message / lost mode. Auto-refreshes every minute.
import { get, post, enc } from '../api.js';
import {
  h, clear, icon, iconBtn, btn, toolbar, field, switchEl, modal, menu, toast, toastError,
  empty, errorBox, skeleton, fmt, toDate, store, copyText, isTyping, shell,
} from '../ui.js';

const AUTO_MS = 60000;

function kind(d) {
  const s = `${d.device_class || ''} ${d.model || ''} ${d.name || ''}`.toLowerCase();
  if (/watch/.test(s)) return { ic: 'watch', c: 'red', label: '手表' };
  if (/airpods|beats|headphone|耳机/.test(s)) return { ic: 'headphones', c: 'gray', label: '耳机' };
  if (/ipad/.test(s)) return { ic: 'tablet', c: 'indigo', label: '平板电脑' };
  if (/macbook|laptop/.test(s)) return { ic: 'laptop', c: 'blue', label: '笔记本电脑' };
  if (/imac|mac ?mini|mac ?pro|mac ?studio|\bmac\b/.test(s)) return { ic: 'monitor', c: 'blue', label: '电脑' };
  if (/iphone|ipod|phone/.test(s)) return { ic: 'smartphone', c: 'green', label: '手机' };
  if (/apple ?tv/.test(s)) return { ic: 'tv', c: 'gray', label: '电视' };
  if (/homepod/.test(s)) return { ic: 'speaker', c: 'gray', label: '扬声器' };
  return { ic: 'monitor-smartphone', c: 'teal', label: '设备' };
}

const online = (d) => String(d.status) === '200';
const loc = (d) => (d.location && Number.isFinite(+d.location.latitude) && Number.isFinite(+d.location.longitude) ? d.location : null);
const LOC_TYPE = { gps: 'GPS', wifi: 'Wi-Fi', cell: '蜂窝网络', celltower: '蜂窝网络' };

function coords(l) {
  const la = +l.latitude; const lo = +l.longitude;
  return `${Math.abs(la).toFixed(5)}° ${la >= 0 ? 'N' : 'S'}, ${Math.abs(lo).toFixed(5)}° ${lo >= 0 ? 'E' : 'W'}`;
}

function mapUrl(l) {
  const la = +l.latitude; const lo = +l.longitude;
  const dy = Math.min(0.2, Math.max(0.004, ((+l.accuracy || 50) * 5) / 111000));
  const dx = dy / Math.max(0.2, Math.cos((la * Math.PI) / 180)) * 1.6;
  const bbox = [lo - dx, la - dy, lo + dx, la + dy].map((v) => v.toFixed(5)).join(',');
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${la.toFixed(6)},${lo.toFixed(6)}`;
}
const extMap = (l) => `https://www.openstreetmap.org/?mlat=${(+l.latitude).toFixed(6)}&mlon=${(+l.longitude).toFixed(6)}#map=16/${(+l.latitude).toFixed(5)}/${(+l.longitude).toFixed(5)}`;

function battery(d, { text = true } = {}) {
  const lv = d.battery_level;
  if (lv === null || lv === undefined || lv < 0) return null;
  const pct = Math.round(lv * 100);
  const charging = /charging/i.test(d.battery_status || '') && !/not/i.test(d.battery_status || '');
  const full = /charged/i.test(d.battery_status || '');
  const low = pct <= 20 && !charging;
  const tip = `电量 ${pct}%${charging ? '，正在充电' : full ? '，已充满' : ''}`;
  return h('span', { class: `fm-batt${low ? ' low' : ''}${charging ? ' charging' : ''}`, title: tip, 'aria-label': tip },
    text ? h('span', { class: 'fm-batt-pct' }, `${pct}%`) : null,
    h('span', { class: 'fm-batt-shell', style: { '--lv': `${Math.max(4, pct)}%` } }, h('span', { class: 'fm-batt-fill' })),
    charging ? icon('zap', { cls: 'fm-batt-bolt' }) : null);
}

function seen(d) {
  const l = loc(d);
  const t = toDate(l?.timestamp);
  if (online(d)) return t && Date.now() - t > 5 * 60000 ? `在线 · 定位于 ${fmt.ago(t)}` : '在线';
  return t ? `离线 · 最后定位于 ${fmt.ago(t)}` : '离线';
}

export default {
  id: 'findmy',
  title: '查找',
  app: 'findmy',
  mount(el, { params } = {}) {
    const S = { devices: [], sel: params?.[0] || store.get('fm.sel', null), updated: null, mapKey: null };
    const rowEls = new Map();
    let alive = true;
    let timer = null;
    let loading = false;

    // ------------------------------------------------------------ layout
    const subEl = h('span');
    const refreshBtn = iconBtn('refresh-cw', '立即定位所有设备 (F5)', () => load({ force: true }));
    refreshBtn.dataset.refresh = '';
    const backBtn = iconBtn('chevron-left', '返回设备列表', () => showDetail(false), { cls: 'only-narrow fm-back' });
    const tb = toolbar({ title: '查找', subtitle: subEl, left: [backBtn], right: [refreshBtn] });
    const listBody = h('div', { class: 'pane-body fm-list' });
    const detail = h('div', { class: 'pane detail fm-detail' });
    const panes = h('div', { class: 'panes stack fm-panes' }, h('div', { class: 'pane list fm-list-pane' }, listBody), detail);
    el.append(tb, panes);

    // -------------------------------------------------------------- data
    async function load({ force = false, quiet = false } = {}) {
      if (loading) return;
      loading = true;
      if (!S.devices.length && !quiet) { clear(listBody, skeleton(4)); clear(detail); }
      refreshBtn.disabled = true;
      refreshBtn.classList.add('fm-spin');
      try {
        const rows = await get('/api/findmy/devices', force ? { refresh: 1 } : undefined);
        if (!alive) return;
        S.devices = rows || [];
        S.updated = new Date();
        if (!S.devices.some((d) => d.id === S.sel)) S.sel = S.devices[0]?.id ?? null;
        renderList();
        renderDetail();
        if (force) toast('已更新设备位置', 'success', 1400);
      } catch (e) {
        if (!alive) return;
        if (S.devices.length) { if (!quiet) toastError(e); } else {
          subEl.textContent = '';
          clear(listBody, errorBox(e));
          clear(detail, empty({ app: 'findmy', title: '无法载入设备', text: '请检查网络连接后重试。', action: { label: '重试', icon: 'refresh-cw', onClick: () => load() } }));
        }
      } finally {
        loading = false;
        if (alive) { refreshBtn.disabled = false; refreshBtn.classList.remove('fm-spin'); }
      }
    }

    function updateSub() {
      const n = S.devices.length;
      subEl.textContent = n ? `${n} 台设备${S.updated ? ` · 更新于 ${fmt.time(S.updated)}` : ''}` : '';
    }

    // -------------------------------------------------------------- list
    function renderList() {
      updateSub();
      rowEls.clear();
      if (!S.devices.length) {
        clear(listBody, empty({ icon: 'locate-off', title: '没有设备', text: '登录同一 Apple 账户并开启“查找”的设备会显示在这里。', compact: true }));
        return;
      }
      const on = S.devices.filter(online).length;
      clear(listBody,
        h('div', { class: 'list-header small fm-list-head' }, `我的设备`, h('span', {}, `${on} 台在线`)),
        h('div', { class: 'list-rows', role: 'listbox', 'aria-label': '设备' }, S.devices.map(row)));
    }

    function row(d) {
      const k = kind(d);
      const r = h('div', {
        class: `list-row fm-row${d.id === S.sel ? ' active' : ''}${online(d) ? '' : ' offline'}`, role: 'option',
        'aria-selected': String(d.id === S.sel), dataset: { id: d.id },
        onclick: () => select(d.id, { open: true }),
        oncontextmenu: (e) => { e.preventDefault(); select(d.id); rowMenu(e, d); },
      },
      h('span', { class: `fm-dev-ic ${k.c}` }, icon(k.ic), h('span', { class: `fm-online${online(d) ? ' on' : ''}` })),
      h('div', { class: 'fm-row-text' },
        h('div', { class: 'primary' }, d.name || d.model || '未命名设备', d.lost_mode ? h('span', { class: 'tag red fm-lost-tag' }, icon('lock', { size: 12 }), '丢失') : null),
        h('div', { class: 'secondary' }, seen(d))),
      battery(d, { text: false }));
      rowEls.set(d.id, r);
      return r;
    }

    function rowMenu(e, d) {
      const f = d.features || {}; const l = loc(d);
      menu(e, [
        { label: '播放声音', icon: 'volume-2', disabled: f.sound === false, onClick: () => playSound(d) },
        { label: '发送信息…', icon: 'message-square-text', disabled: f.message === false, onClick: () => sendMessage(d) },
        { label: d.lost_mode ? '丢失模式（已启用）…' : '标记为丢失…', icon: 'lock', danger: true, disabled: f.lost === false, onClick: () => lostMode(d) },
        '-',
        l && { label: '在地图中打开', icon: 'map', onClick: () => shell.openExternal(extMap(l)) },
        l && { label: '复制坐标', icon: 'copy', onClick: () => copyText(`${(+l.latitude).toFixed(6)}, ${(+l.longitude).toFixed(6)}`, '已复制坐标') },
      ]);
    }

    function select(id, { open = false, scroll = false } = {}) {
      if (id !== S.sel) {
        S.sel = id; store.set('fm.sel', id);
        for (const [rid, r] of rowEls) { r.classList.toggle('active', rid === id); r.setAttribute('aria-selected', String(rid === id)); }
        renderDetail();
      }
      if (scroll) rowEls.get(id)?.scrollIntoView({ block: 'nearest' });
      if (open) showDetail(true);
    }

    function showDetail(on) {
      panes.classList.toggle('show-detail', on);
      el.classList.toggle('fm-detail-open', on);
    }

    // ------------------------------------------------------------ detail
    let mapWrap = null;
    function renderDetail() {
      const d = S.devices.find((x) => x.id === S.sel);
      if (!d) {
        S.mapKey = null; mapWrap = null;
        clear(detail, S.devices.length ? empty({ app: 'findmy', title: '未选择设备', text: '从列表中选择一台设备以查看其位置。' }) : null);
        return;
      }
      const l = loc(d);
      const key = l ? `${d.id}|${(+l.latitude).toFixed(5)},${(+l.longitude).toFixed(5)}` : `${d.id}|none`;
      if (key !== S.mapKey || !mapWrap?.isConnected) {
        S.mapKey = key;
        mapWrap = h('div', { class: 'fm-map' }, l
          ? h('iframe', { src: mapUrl(l), title: `${d.name} 的位置地图`, loading: 'lazy', referrerPolicy: 'no-referrer-when-downgrade' })
          : h('div', { class: 'fm-nomap' }, h('div', { class: 'fm-nomap-ic' }, icon('locate-off', { size: 'xl' })),
            h('div', { class: 'fm-nomap-title' }, '无可用位置'),
            h('div', { class: 'fm-nomap-text' }, online(d) ? '正在等待设备报告位置。' : '设备离线或已关闭“查找”。设备重新联网后将显示其位置。')));
      }
      clear(detail, h('div', { class: 'fm-stage' }, mapWrap, card(d)));
    }

    function card(d) {
      const k = kind(d); const l = loc(d); const f = d.features || {};
      const t = toDate(l?.timestamp);
      const infoRows = [];
      if (l) {
        infoRows.push(info('map-pin', '坐标', h('span', { class: 'fm-mono selectable' }, coords(l)),
          iconBtn('copy', '复制坐标', () => copyText(`${(+l.latitude).toFixed(6)}, ${(+l.longitude).toFixed(6)}`, '已复制坐标'), { size: 'sm' })));
        infoRows.push(info('crosshair', '精度', l.accuracy ? `约 ${Math.round(+l.accuracy)} 米${l.type ? ` · ${LOC_TYPE[String(l.type).toLowerCase()] || l.type}` : ''}` : '未知'));
        if (t) infoRows.push(info('clock', '定位时间', `${fmt.ago(t)}（${fmt.smart(t)}${fmt.sameDay(t, new Date()) ? '' : ` ${fmt.time(t)}`}）`));
      }
      const b = d.battery_level;
      if (b !== null && b !== undefined && b >= 0) {
        const st = d.battery_status || '';
        const stTxt = /not/i.test(st) ? '' : /charging/i.test(st) ? ' · 正在充电' : /charged/i.test(st) ? ' · 已充满' : '';
        infoRows.push(info(b <= 0.2 ? 'battery-low' : b < 0.6 ? 'battery-medium' : 'battery-full', '电池', `${Math.round(b * 100)}%${stTxt}`));
      }

      return h('section', { class: 'fm-card', 'aria-label': d.name },
        h('div', { class: 'fm-card-head' },
          h('span', { class: `fm-dev-ic lg ${k.c}` }, icon(k.ic), h('span', { class: `fm-online${online(d) ? ' on' : ''}` })),
          h('div', { class: 'fm-card-title' },
            h('div', { class: 'fm-card-name selectable' }, d.name || '未命名设备'),
            h('div', { class: 'fm-card-model' }, d.model || k.label)),
          battery(d)),
        h('div', { class: `fm-status${online(d) ? ' on' : ''}` }, h('span', { class: 'dot sm' }), seen(d)),
        d.lost_mode ? h('div', { class: 'fm-lost-banner' }, icon('lock', { size: 'sm' }), h('div', {},
          h('b', {}, '丢失模式已启用'), h('div', {}, '设备已锁定，并在屏幕上显示你的信息。'))) : null,
        infoRows.length ? h('div', { class: 'fm-info' }, infoRows) : null,
        h('div', { class: 'fm-actions' },
          tile('volume-2', 'blue', '播放声音', f.sound === false ? '不支持' : online(d) ? '' : '上线后播放', f.sound === false, (b2) => playSound(d, b2)),
          tile('message-square-text', 'green', '发送信息', f.message === false ? '不支持' : '', f.message === false, () => sendMessage(d)),
          tile('lock', 'red', '丢失模式', f.lost === false ? '不支持' : d.lost_mode ? '已启用' : '', f.lost === false, () => lostMode(d))),
        l ? btn('在地图中打开', { kind: 'tinted', icon: 'square-arrow-out-up-right', onclick: () => shell.openExternal(extMap(l)) }) : null);
    }

    function info(ic, label, value, extra) {
      return h('div', { class: 'fm-info-row' }, icon(ic, { size: 'sm' }),
        h('span', { class: 'fm-info-label' }, label), h('span', { class: 'fm-info-value' }, value), extra || null);
    }

    function tile(ic, color, label, sub, disabled, onClick) {
      const b = h('button', {
        type: 'button', class: `fm-tile ${color}`, disabled, title: disabled ? `此设备不支持${label}` : label,
        onclick: () => onClick(b),
      }, h('span', { class: 'fm-tile-ic' }, icon(ic)), h('span', { class: 'fm-tile-label' }, label), sub ? h('span', { class: 'fm-tile-sub' }, sub) : null);
      return b;
    }

    // ----------------------------------------------------------- actions
    async function playSound(d, tileBtn) {
      if (tileBtn) { tileBtn.disabled = true; tileBtn.classList.add('busy'); }
      try {
        await post(`/api/findmy/devices/${enc(d.id)}/sound`, {});
        toast(online(d) ? `正在“${d.name}”上播放声音` : `设备上线后将在“${d.name}”上播放声音`, 'success');
      } catch (e) { toastError(e); } finally {
        if (tileBtn) { tileBtn.disabled = false; tileBtn.classList.remove('busy'); }
      }
    }

    function sendMessage(d) {
      const subject = h('input', { class: 'input', value: '查找提醒', maxLength: 60 });
      const msg = h('textarea', { class: 'textarea', rows: 4, placeholder: '例如：如果你捡到了这台设备，请联系我。', maxLength: 500 });
      const sw = switchEl(true);
      modal({
        title: '发送信息',
        subtitle: `信息将显示在“${d.name}”的屏幕上`,
        size: 'sm',
        body: h('div', { class: 'form' },
          field('标题', subject),
          field('信息', msg),
          h('label', { class: 'fm-switch-row' }, icon('volume-2', { size: 'sm' }), h('span', {}, '同时播放声音'), sw)),
        actions: [
          { label: '取消' },
          {
            label: '发送', primary: true, icon: 'send',
            onClick: async () => {
              const text = msg.value.trim();
              if (!text) { msg.focus(); toast('请输入要显示的信息', 'error'); return false; }
              await post(`/api/findmy/devices/${enc(d.id)}/message`, { subject: subject.value.trim() || '查找提醒', message: text, sound: sw.input.checked });
              toast(`已向“${d.name}”发送信息`, 'success');
              return true;
            },
          },
        ],
      });
      setTimeout(() => msg.focus(), 40);
    }

    function lostMode(d) {
      const number = h('input', { class: 'input', type: 'tel', placeholder: '可选，例如 138 0000 0000', autocomplete: 'tel', maxLength: 40 });
      const text = h('textarea', { class: 'textarea', rows: 3, maxLength: 300 });
      text.value = '这台设备已丢失。请致电与我联系。';
      modal({
        title: d.lost_mode ? '更新丢失模式' : '标记为丢失',
        subtitle: d.name,
        size: 'sm',
        cls: 'fm-lost-modal',
        body: h('div', { class: 'form' },
          h('div', { class: 'fm-lost-intro' }, h('span', { class: 'gi red' }, icon('lock', { size: 'sm' })),
            h('div', {}, '启用后，设备将被锁定，Apple Pay 将被停用，并在锁定屏幕上显示下方的电话号码和信息。')),
          field('电话号码', number, '捡到设备的人可以直接拨打此号码。'),
          field('锁定屏幕信息', text)),
        actions: [
          { label: '取消' },
          {
            label: d.lost_mode ? '更新' : '启用丢失模式', danger: true, icon: 'lock',
            onClick: async () => {
              if (!text.value.trim() && !number.value.trim()) { toast('请填写电话号码或信息', 'error'); return false; }
              await post(`/api/findmy/devices/${enc(d.id)}/lost`, { number: number.value.trim(), text: text.value.trim() });
              d.lost_mode = true;
              renderList(); renderDetail();
              toast(`“${d.name}”已进入丢失模式`, 'success');
              return true;
            },
          },
        ],
      });
      setTimeout(() => number.focus(), 40);
    }

    // ---------------------------------------------------------- keyboard
    function onKey(e) {
      if (document.querySelector('.overlay') || isTyping(e)) return;
      if (!el.contains(e.target) && e.target !== document.body) return;
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.altKey && !e.ctrlKey && S.devices.length) {
        e.preventDefault();
        const i = S.devices.findIndex((d) => d.id === S.sel);
        const n = i < 0 ? 0 : Math.max(0, Math.min(S.devices.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
        select(S.devices[n].id, { scroll: true });
      } else if (e.key === 'Enter' && S.sel) {
        showDetail(true);
      } else if (e.key === 'Escape' && panes.classList.contains('show-detail')) {
        showDetail(false);
      }
    }
    document.addEventListener('keydown', onKey);

    const tick = () => { if (!document.hidden && !document.querySelector('.overlay')) load({ quiet: true }); };
    timer = setInterval(tick, AUTO_MS);
    load();
    return () => { alive = false; clearInterval(timer); document.removeEventListener('keydown', onKey); };
  },
};
