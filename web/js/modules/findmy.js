// Find My: devices, map, play sound, show message, lost mode.
import { get, post } from '../api.js';
import { h, clear, toast, toastError, modal, field, spinner, empty, fmt } from '../ui.js';

const CLASS_ICON = { iPhone: '📱', iPad: '📱', MacBookPro: '💻', MacBookAir: '💻', MacBook: '💻', iMac: '🖥️', Mac: '🖥️', Watch: '⌚', AirPods: '🎧', Accessory: '🎧', iPod: '🎵' };

function battery(d) {
  if (d.battery_level == null) return null;
  const pct = Math.round(d.battery_level * 100);
  return h('span', { class: `battery ${pct < 20 ? 'low' : ''}` }, `${d.battery_status === 'Charging' ? '⚡' : '🔋'} ${pct}%`);
}

function mapEmbed(loc) {
  const { latitude: lat, longitude: lon } = loc;
  const d = 0.01;
  const src = `https://www.openstreetmap.org/export/embed.html?bbox=${lon - d},${lat - d},${lon + d},${lat + d}&layer=mapnik&marker=${lat},${lon}`;
  return h('iframe', { class: 'map', src, loading: 'lazy', referrerpolicy: 'no-referrer' });
}

export default {
  id: 'findmy',
  title: '查找',
  icon: '📍',
  color: '#34c759',
  mount(el) {
    let devices = [];
    let current = null;
    const listBox = h('div', { class: 'list' });
    const detail = h('div', { class: 'findmy-detail' });
    const refreshBtn = h('button', { class: 'icon-btn', title: '重新定位', onclick: () => load(true) }, '⟳');

    clear(el, h('div', { class: 'split' },
      h('div', { class: 'pane pane-list wide' }, h('div', { class: 'pane-header' }, h('h3', {}, '设备'), refreshBtn), listBox),
      h('div', { class: 'pane pane-main' }, detail)));
    clear(detail, empty('选择一个设备', '📍'));

    function renderList() {
      if (!devices.length) return clear(listBox, empty('没有设备'));
      clear(listBox, devices.map((d) => h('div', { class: `list-item device ${current === d.id ? 'active' : ''}`, onclick: () => { current = d.id; renderList(); renderDetail(d); } },
        h('span', { class: 'device-icon' }, CLASS_ICON[d.device_class] || '📟'),
        h('div', { class: 'grow' }, h('div', {}, d.name), h('div', { class: 'muted small' }, d.model || '', d.location ? ` · ${fmt.smart(d.location.timestamp)}` : ' · 无位置')),
        battery(d))));
    }

    function renderDetail(d) {
      const loc = d.location;
      const act = (label, fn, enabled = true) => h('button', { class: 'btn', disabled: !enabled, onclick: fn }, label);
      clear(detail,
        h('div', { class: 'device-head' },
          h('span', { class: 'device-icon big' }, CLASS_ICON[d.device_class] || '📟'),
          h('div', { class: 'grow' }, h('h2', {}, d.name), h('div', { class: 'muted' }, d.model || '', d.lost_mode ? h('span', { class: 'badge danger' }, '丢失模式') : null)),
          battery(d)),
        loc ? h('div', { class: 'card' },
          mapEmbed(loc),
          h('div', { class: 'row gap muted small', style: { padding: '8px 12px' } },
            h('span', {}, `更新于 ${fmt.datetime(loc.timestamp)}`),
            loc.accuracy ? h('span', {}, `精度 ±${Math.round(loc.accuracy)} 米`) : null,
            h('a', { href: `https://www.openstreetmap.org/?mlat=${loc.latitude}&mlon=${loc.longitude}#map=16/${loc.latitude}/${loc.longitude}`, target: '_blank' }, '在地图中打开'),
            h('span', {}, `${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}`)))
          : h('div', { class: 'card notice' }, '当前没有位置信息（设备可能离线或未开启“查找”）。'),
        h('div', { class: 'row gap wrap' },
          act('🔊 播放声音', async () => { try { await post(`/api/findmy/devices/${encodeURIComponent(d.id)}/sound`); toast('已发送播放声音请求', 'success'); } catch (e) { toastError(e); } }, d.features.sound),
          act('💬 显示信息', () => messageDialog(d), d.features.message),
          act('🔒 丢失模式', () => lostDialog(d), d.features.lost)));
    }

    function messageDialog(d) {
      const msg = h('textarea', { class: 'input', rows: 3, placeholder: '显示在设备屏幕上的信息' });
      const sound = h('input', { type: 'checkbox' });
      modal({ title: `向“${d.name}”发送信息`, body: h('div', { class: 'form' }, msg, h('label', { class: 'check' }, sound, ' 同时播放声音')), actions: [
        { label: '取消' },
        { label: '发送', primary: true, onClick: async () => {
          await post(`/api/findmy/devices/${encodeURIComponent(d.id)}/message`, { message: msg.value, sound: sound.checked }); toast('已发送', 'success');
        } },
      ] });
    }

    function lostDialog(d) {
      const number = h('input', { class: 'input', placeholder: '联系电话' });
      const text = h('textarea', { class: 'input', rows: 3 }, '这台设备已丢失，请联系我。');
      modal({ title: `将“${d.name}”标记为丢失`, body: h('div', { class: 'form' },
        h('div', { class: 'notice' }, '开启丢失模式会锁定设备并在屏幕上显示以下信息。'),
        field('电话号码', number), field('信息', text)), actions: [
        { label: '取消' },
        { label: '开启丢失模式', danger: true, onClick: async () => {
          if (!number.value.trim()) { toast('请填写电话号码', 'error'); return false; }
          await post(`/api/findmy/devices/${encodeURIComponent(d.id)}/lost`, { number: number.value.trim(), text: text.value }); toast('已开启丢失模式', 'success'); load(true);
        } },
      ] });
    }

    async function load(refresh = false) {
      if (!devices.length) clear(listBox, spinner());
      refreshBtn.disabled = true;
      try {
        devices = await get('/api/findmy/devices', { refresh: refresh || undefined });
        renderList();
        const d = devices.find((x) => x.id === current);
        if (d) renderDetail(d);
      } catch (e) { clear(listBox, h('div', { class: 'error-box' }, e.message)); }
      refreshBtn.disabled = false;
    }

    load();
    const timer = setInterval(() => load(true), 120000);
    return () => clearInterval(timer);
  },
};
