// Account: storage usage, devices, family (read only).
import { get } from '../api.js';
import { h, clear, load, fmt } from '../ui.js';

export default {
  id: 'account',
  title: '账户',
  icon: '⚙️',
  color: '#636366',
  mount(el) {
    const body = h('div', { class: 'pane-scroll account' });
    clear(el, h('div', { class: 'pane pane-main full' }, h('div', { class: 'toolbar' }, h('h2', { class: 'toolbar-title' }, '账户')), body));

    load(body, async () => {
      const [acc, status] = await Promise.all([get('/api/account'), get('/api/auth/status')]);
      const st = acc.storage;
      const storage = st ? h('div', { class: 'card' },
        h('h3', {}, 'iCloud 储存空间'),
        h('div', { class: 'muted' }, `已使用 ${fmt.bytes(st.used)}，共 ${fmt.bytes(st.total)}（剩余 ${fmt.bytes(st.available)}）`),
        h('div', { class: 'storage-bar' }, st.by_media.filter((m) => m.bytes > 0).map((m) => h('span', {
          style: { width: `${(m.bytes / st.total) * 100}%`, background: `#${(m.color || '999999').replace('#', '')}` }, title: `${m.label}: ${fmt.bytes(m.bytes)}`,
        }))),
        h('div', { class: 'legend' }, st.by_media.filter((m) => m.bytes > 0).map((m) => h('span', {},
          h('i', { style: { background: `#${(m.color || '999999').replace('#', '')}` } }), `${m.label} ${fmt.bytes(m.bytes)}`))))
        : h('div', { class: 'card error-box' }, '储存空间：', acc.storage_error || '不可用');

      const devices = h('div', { class: 'card' }, h('h3', {}, '设备'),
        acc.devices ? h('div', { class: 'device-grid' }, acc.devices.map((d) => h('div', { class: 'device-tile' },
          d.image ? h('img', { src: d.image, alt: '', referrerpolicy: 'no-referrer' }) : h('div', { class: 'device-icon big' }, '📱'),
          h('b', {}, d.name), h('span', { class: 'muted small' }, d.model || '')))) : h('div', { class: 'muted' }, acc.devices_error || '不可用'));

      const family = h('div', { class: 'card' }, h('h3', {}, '家人共享'),
        acc.family?.length ? acc.family.map((m) => h('div', { class: 'kv' }, h('span', { class: 'k' }, m.name), h('span', { class: 'v' }, m.apple_id || '')))
          : h('div', { class: 'muted' }, acc.family_error ? `不可用：${acc.family_error}` : '未加入家人共享'));

      const user = status.user || {};
      const me = h('div', { class: 'card' }, h('h3', {}, user.full_name || 'Apple 账户'),
        h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Apple 账户'), h('span', { class: 'v' }, user.apple_id || status.apple_id || '')),
        h('div', { class: 'kv' }, h('span', { class: 'k' }, '区域'), h('span', { class: 'v' }, status.china_mainland ? '中国大陆 (icloud.com.cn)' : '国际 (icloud.com)')),
        h('div', { class: 'kv' }, h('span', { class: 'k' }, '密码'), h('span', { class: 'v' }, status.password_saved ? '已保存在 Windows 凭据管理器（自动续期）' : '未保存（会话过期后需手动登录）')),
        status.services?.length ? h('details', {}, h('summary', { class: 'muted small' }, `可用的 iCloud Web 服务（${status.services.length}）`),
          h('div', { class: 'muted small mono' }, status.services.join(', '))) : null);

      clear(body, me, storage, devices, family);
    });
  },
};
