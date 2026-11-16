// Find My — device list, map, play sound / message / lost mode. Auto-refreshes every minute.
import { get, post, enc } from '../api.js';
import { countText, tx } from '../i18n.js';
import {
  h, clear, icon, iconBtn, btn, toolbar, field, switchEl, modal, menu, toast, toastError,
  empty, errorBox, skeleton, fmt, toDate, store, copyText, isTyping, shell,
} from '../ui.js';

const AUTO_MS = 60000;

function kind(d) {
  const s = `${d.device_class || ''} ${d.model || ''} ${d.name || ''}`.toLowerCase();
  if (/watch/.test(s)) return { ic: 'watch', c: 'red', label: tx('手表', 'Watch') };
  if (/airpods|beats|headphone|耳机/.test(s)) return { ic: 'headphones', c: 'gray', label: tx('耳机', 'Headphones') };
  if (/ipad/.test(s)) return { ic: 'tablet', c: 'indigo', label: tx('平板电脑', 'Tablet') };
  if (/macbook|laptop/.test(s)) return { ic: 'laptop', c: 'blue', label: tx('笔记本电脑', 'Laptop') };
  if (/imac|mac ?mini|mac ?pro|mac ?studio|\bmac\b/.test(s)) return { ic: 'monitor', c: 'blue', label: tx('电脑', 'Computer') };
  if (/iphone|ipod|phone/.test(s)) return { ic: 'smartphone', c: 'green', label: tx('手机', 'Phone') };
  if (/apple ?tv/.test(s)) return { ic: 'tv', c: 'gray', label: tx('电视', 'TV') };
  if (/homepod/.test(s)) return { ic: 'speaker', c: 'gray', label: tx('扬声器', 'Speaker') };
  return { ic: 'monitor-smartphone', c: 'teal', label: tx('设备', 'Device') };
}

const online = (d) => String(d.status) === '200';
const loc = (d) => (d.location && Number.isFinite(+d.location.latitude) && Number.isFinite(+d.location.longitude) ? d.location : null);
const locType = (t) => ({
  gps: 'GPS',
  wifi: 'Wi-Fi',
  cell: tx('蜂窝网络', 'Cellular'),
  celltower: tx('蜂窝网络', 'Cellular'),
}[String(t || '').toLowerCase()] || t);

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
  const tip = tx(
    `电量 ${pct}%${charging ? '，正在充电' : full ? '，已充满' : ''}`,
    `Battery ${pct}%${charging ? ', charging' : full ? ', charged' : ''}`,
  );
  return h('span', { class: `fm-batt${low ? ' low' : ''}${charging ? ' charging' : ''}`, title: tip, 'aria-label': tip },
    text ? h('span', { class: 'fm-batt-pct' }, `${pct}%`) : null,
    h('span', { class: 'fm-batt-shell', style: { '--lv': `${Math.max(4, pct)}%` } }, h('span', { class: 'fm-batt-fill' })),
    charging ? icon('zap', { cls: 'fm-batt-bolt' }) : null);
}

function seen(d) {
  const l = loc(d);
  const t = toDate(l?.timestamp);
  if (online(d)) {
    return t && Date.now() - t > 5 * 60000
      ? tx(`在线 · 定位于 ${fmt.ago(t)}`, `Online · Located ${fmt.ago(t)}`)
      : tx('在线', 'Online');
  }
  return t ? tx(`离线 · 最后定位于 ${fmt.ago(t)}`, `Offline · Last seen ${fmt.ago(t)}`) : tx('离线', 'Offline');
}

export default {
  id: 'findmy',
  get title() { return tx('查找', 'Find My'); },
  app: 'findmy',
  mount(el, { params } = {}) {
    const S = { devices: [], sel: params?.[0] || store.get('fm.sel', null), updated: null, mapKey: null };
    const rowEls = new Map();
    let alive = true;
    let timer = null;
    let loading = false;

    // ------------------------------------------------------------ layout
    const subEl = h('span');
    const refreshBtn = iconBtn('refresh-cw', tx('立即定位所有设备 (F5)', 'Refresh device locations (F5)'), () => load({ force: true }));
    refreshBtn.dataset.refresh = '';
    const backBtn = iconBtn('chevron-left', tx('返回设备列表', 'Back to devices'), () => showDetail(false), { cls: 'only-narrow fm-back' });
    const tb = toolbar({ title: tx('查找', 'Find My'), subtitle: subEl, left: [backBtn], right: [refreshBtn] });
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
        if (force) toast(tx('已更新设备位置', 'Device locations updated'), 'success', 1400);
      } catch (e) {
        if (!alive) return;
        if (S.devices.length) { if (!quiet) toastError(e); } else {
          subEl.textContent = '';
          clear(listBody, errorBox(e));
          clear(detail, empty({
            app: 'findmy', title: tx('无法载入设备', 'Could Not Load Devices'),
            text: tx('请检查网络连接后重试。', 'Check your internet connection and try again.'),
            action: { label: tx('重试', 'Retry'), icon: 'refresh-cw', onClick: () => load() },
          }));
        }
      } finally {
        loading = false;
        if (alive) { refreshBtn.disabled = false; refreshBtn.classList.remove('fm-spin'); }
      }
    }

    function updateSub() {
      const n = S.devices.length;
      subEl.textContent = n
        ? `${countText(n, '台设备', 'device')}${S.updated ? ` · ${tx(`更新于 ${fmt.time(S.updated)}`, `Updated ${fmt.time(S.updated)}`)}` : ''}`
        : '';
    }

    // -------------------------------------------------------------- list
    function renderList() {
      updateSub();
      rowEls.clear();
      if (!S.devices.length) {
        clear(listBody, empty({ icon: 'locate-off', title: tx('没有设备', 'No Devices'), text: tx('登录同一 Apple 账户并开启“查找”的设备会显示在这里。', 'Devices signed in to your Apple Account with Find My enabled appear here.'), compact: true }));
        return;
      }
      const on = S.devices.filter(online).length;
      clear(listBody,
        h('div', { class: 'list-header small fm-list-head' }, tx('我的设备', 'My Devices'), h('span', {}, tx(`${on} 台在线`, `${on} online`))),
        h('div', { class: 'list-rows', role: 'listbox', 'aria-label': tx('设备', 'Devices') }, S.devices.map(row)));
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
        h('div', { class: 'primary' }, d.name || d.model || tx('未命名设备', 'Unnamed Device'), d.lost_mode ? h('span', { class: 'tag red fm-lost-tag' }, icon('lock', { size: 12 }), tx('丢失', 'Lost')) : null),
        h('div', { class: 'secondary' }, seen(d))),
      battery(d, { text: false }));
      rowEls.set(d.id, r);
      return r;
    }

    function rowMenu(e, d) {
      const f = d.features || {}; const l = loc(d);
      menu(e, [
        { label: tx('播放声音', 'Play Sound'), icon: 'volume-2', disabled: f.sound === false, onClick: () => playSound(d) },
        { label: tx('发送信息…', 'Send Message…'), icon: 'message-square-text', disabled: f.message === false, onClick: () => sendMessage(d) },
        { label: d.lost_mode ? tx('丢失模式（已启用）…', 'Lost Mode (Active)…') : tx('标记为丢失…', 'Mark As Lost…'), icon: 'lock', danger: true, disabled: f.lost === false, onClick: () => lostMode(d) },
        '-',
        l && { label: tx('在地图中打开', 'Open in Maps'), icon: 'map', onClick: () => shell.openExternal(extMap(l)) },
        l && { label: tx('复制坐标', 'Copy Coordinates'), icon: 'copy', onClick: () => copyText(`${(+l.latitude).toFixed(6)}, ${(+l.longitude).toFixed(6)}`, tx('已复制坐标', 'Coordinates copied')) },
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
        clear(detail, S.devices.length ? empty({ app: 'findmy', title: tx('未选择设备', 'No Device Selected'), text: tx('从列表中选择一台设备以查看其位置。', 'Select a device from the list to view its location.') }) : null);
        return;
      }
      const l = loc(d);
      const key = l ? `${d.id}|${(+l.latitude).toFixed(5)},${(+l.longitude).toFixed(5)}` : `${d.id}|none`;
      if (key !== S.mapKey || !mapWrap?.isConnected) {
        S.mapKey = key;
        mapWrap = h('div', { class: 'fm-map' }, l
          ? h('iframe', { src: mapUrl(l), title: tx(`${d.name} 的位置地图`, `Map of ${d.name}`), loading: 'lazy', referrerPolicy: 'no-referrer-when-downgrade' })
          : h('div', { class: 'fm-nomap' }, h('div', { class: 'fm-nomap-ic' }, icon('locate-off', { size: 'xl' })),
            h('div', { class: 'fm-nomap-title' }, tx('无可用位置', 'No Location Found')),
            h('div', { class: 'fm-nomap-text' }, online(d)
              ? tx('正在等待设备报告位置。', 'Waiting for device to report its location.')
              : tx('设备离线或已关闭“查找”。设备重新联网后将显示其位置。', 'Device is offline or Find My is turned off. Its location will appear once online.'))));
      }
      clear(detail, h('div', { class: 'fm-stage' }, mapWrap, card(d)));
    }

    function card(d) {
      const k = kind(d); const l = loc(d); const f = d.features || {};
      const t = toDate(l?.timestamp);
      const infoRows = [];
      if (l) {
        infoRows.push(info('map-pin', tx('坐标', 'Coordinates'), h('span', { class: 'fm-mono selectable' }, coords(l)),
          iconBtn('copy', tx('复制坐标', 'Copy coordinates'), () => copyText(`${(+l.latitude).toFixed(6)}, ${(+l.longitude).toFixed(6)}`, tx('已复制坐标', 'Coordinates copied')), { size: 'sm' })));
        infoRows.push(info('crosshair', tx('精度', 'Accuracy'), l.accuracy
          ? tx(`约 ${Math.round(+l.accuracy)} 米${l.type ? ` · ${locType(l.type)}` : ''}`, `~${Math.round(+l.accuracy)} m${l.type ? ` · ${locType(l.type)}` : ''}`)
          : tx('未知', 'Unknown')));
        if (t) infoRows.push(info('clock', tx('定位时间', 'Located'), `${fmt.ago(t)} (${fmt.smart(t)}${fmt.sameDay(t, new Date()) ? '' : ` ${fmt.time(t)}`})`));
      }
      const b = d.battery_level;
      if (b !== null && b !== undefined && b >= 0) {
        const st = d.battery_status || '';
        const stTxt = /not/i.test(st) ? '' : /charging/i.test(st) ? tx(' · 正在充电', ' · Charging') : /charged/i.test(st) ? tx(' · 已充满', ' · Charged') : '';
        infoRows.push(info(b <= 0.2 ? 'battery-low' : b < 0.6 ? 'battery-medium' : 'battery-full', tx('电池', 'Battery'), `${Math.round(b * 100)}%${stTxt}`));
      }

      return h('section', { class: 'fm-card', 'aria-label': d.name },
        h('div', { class: 'fm-card-head' },
          h('span', { class: `fm-dev-ic lg ${k.c}` }, icon(k.ic), h('span', { class: `fm-online${online(d) ? ' on' : ''}` })),
          h('div', { class: 'fm-card-title' },
            h('div', { class: 'fm-card-name selectable' }, d.name || tx('未命名设备', 'Unnamed Device')),
            h('div', { class: 'fm-card-model' }, d.model || k.label)),
          battery(d)),
        h('div', { class: `fm-status${online(d) ? ' on' : ''}` }, h('span', { class: 'dot sm' }), seen(d)),
        d.lost_mode ? h('div', { class: 'fm-lost-banner' }, icon('lock', { size: 'sm' }), h('div', {},
          h('b', {}, tx('丢失模式已启用', 'Lost Mode Active')), h('div', {}, tx('设备已锁定，并在屏幕上显示你的信息。', 'This device is locked and displaying your contact message.')))) : null,
        infoRows.length ? h('div', { class: 'fm-info' }, infoRows) : null,
        h('div', { class: 'fm-actions' },
          tile('volume-2', 'blue', tx('播放声音', 'Play Sound'), f.sound === false ? tx('不支持', 'Unavailable') : online(d) ? '' : tx('上线后播放', 'When online'), f.sound === false, (b2) => playSound(d, b2)),
          tile('message-square-text', 'green', tx('发送信息', 'Send Message'), f.message === false ? tx('不支持', 'Unavailable') : '', f.message === false, () => sendMessage(d)),
          tile('lock', 'red', tx('丢失模式', 'Lost Mode'), f.lost === false ? tx('不支持', 'Unavailable') : d.lost_mode ? tx('已启用', 'Active') : '', f.lost === false, () => lostMode(d))),
        l ? btn(tx('在地图中打开', 'Open in Maps'), { kind: 'tinted', icon: 'square-arrow-out-up-right', onclick: () => shell.openExternal(extMap(l)) }) : null);
    }

    function info(ic, label, value, extra) {
      return h('div', { class: 'fm-info-row' }, icon(ic, { size: 'sm' }),
        h('span', { class: 'fm-info-label' }, label), h('span', { class: 'fm-info-value' }, value), extra || null);
    }

    function tile(ic, color, label, sub, disabled, onClick) {
      const b = h('button', {
        type: 'button', class: `fm-tile ${color}`, disabled, title: disabled ? tx(`此设备不支持${label}`, `${label} is not supported on this device`) : label,
        onclick: () => onClick(b),
      }, h('span', { class: 'fm-tile-ic' }, icon(ic)), h('span', { class: 'fm-tile-label' }, label), sub ? h('span', { class: 'fm-tile-sub' }, sub) : null);
      return b;
    }

    // ----------------------------------------------------------- actions
    async function playSound(d, tileBtn) {
      if (tileBtn) { tileBtn.disabled = true; tileBtn.classList.add('busy'); }
      try {
        await post(`/api/findmy/devices/${enc(d.id)}/sound`, {});
        toast(online(d) ? tx(`正在“${d.name}”上播放声音`, `Playing sound on “${d.name}”`) : tx(`设备上线后将在“${d.name}”上播放声音`, `Sound will play on “${d.name}” when online`), 'success');
      } catch (e) { toastError(e); } finally {
        if (tileBtn) { tileBtn.disabled = false; tileBtn.classList.remove('busy'); }
      }
    }

    function sendMessage(d) {
      const defaultSubject = tx('查找提醒', 'Find My Alert');
      const subject = h('input', { class: 'input', value: defaultSubject, maxLength: 60 });
      const msg = h('textarea', { class: 'textarea', rows: 4, placeholder: tx('例如：如果你捡到了这台设备，请联系我。', 'e.g. If you find this device, please contact me.'), maxLength: 500 });
      const sw = switchEl(true);
      modal({
        title: tx('发送信息', 'Send Message'),
        subtitle: tx(`信息将显示在“${d.name}”的屏幕上`, `Message will appear on “${d.name}”`),
        size: 'sm',
        body: h('div', { class: 'form' },
          field(tx('标题', 'Subject'), subject),
          field(tx('信息', 'Message'), msg),
          h('label', { class: 'fm-switch-row' }, icon('volume-2', { size: 'sm' }), h('span', {}, tx('同时播放声音', 'Also play sound')), sw)),
        actions: [
          { label: tx('取消', 'Cancel') },
          {
            label: tx('发送', 'Send'), primary: true, icon: 'send',
            onClick: async () => {
              const text = msg.value.trim();
              if (!text) { msg.focus(); toast(tx('请输入要显示的信息', 'Please enter a message'), 'error'); return false; }
              await post(`/api/findmy/devices/${enc(d.id)}/message`, { subject: subject.value.trim() || defaultSubject, message: text, sound: sw.input.checked });
              toast(tx(`已向“${d.name}”发送信息`, `Message sent to “${d.name}”`), 'success');
              return true;
            },
          },
        ],
      });
      setTimeout(() => msg.focus(), 40);
    }

    function lostMode(d) {
      const number = h('input', { class: 'input', type: 'tel', placeholder: tx('可选，例如 138 0000 0000', 'Optional, e.g. +1 555 0100'), autocomplete: 'tel', maxLength: 40 });
      const text = h('textarea', { class: 'textarea', rows: 3, maxLength: 300 });
      text.value = tx('这台设备已丢失。请致电与我联系。', 'This device has been lost. Please call me.');
      modal({
        title: d.lost_mode ? tx('更新丢失模式', 'Update Lost Mode') : tx('标记为丢失', 'Mark As Lost'),
        subtitle: d.name,
        size: 'sm',
        cls: 'fm-lost-modal',
        body: h('div', { class: 'form' },
          h('div', { class: 'fm-lost-intro' }, h('span', { class: 'gi red' }, icon('lock', { size: 'sm' })),
            h('div', {}, tx(
              '启用后，设备将被锁定，Apple Pay 将被停用，并在锁定屏幕上显示下方的电话号码和信息。',
              'Locks the device, suspends Apple Pay, and displays your phone number and message on the Lock Screen.',
            ))),
          field(tx('电话号码', 'Phone Number'), number, tx('捡到设备的人可以直接拨打此号码。', 'Someone who finds your device can call this number from the Lock Screen.')),
          field(tx('锁定屏幕信息', 'Lock Screen Message'), text)),
        actions: [
          { label: tx('取消', 'Cancel') },
          {
            label: d.lost_mode ? tx('更新', 'Update') : tx('启用丢失模式', 'Enable Lost Mode'), danger: true, icon: 'lock',
            onClick: async () => {
              if (!text.value.trim() && !number.value.trim()) { toast(tx('请填写电话号码或信息', 'Enter a phone number or message'), 'error'); return false; }
              await post(`/api/findmy/devices/${enc(d.id)}/lost`, { number: number.value.trim(), text: text.value.trim() });
              d.lost_mode = true;
              renderList(); renderDetail();
              toast(tx(`“${d.name}”已进入丢失模式`, `Lost Mode enabled on “${d.name}”`), 'success');
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
