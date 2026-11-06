// Account — profile, iCloud storage breakdown, signed-in devices, Family Sharing.
import { get } from '../api.js';
import { h, clear, icon, iconBtn, btn, toolbar, empty, errorBox, skeleton, fmt, copyText, shell } from '../ui.js';

const TINTS = ['blue', 'indigo', 'purple', 'pink', 'orange', 'teal', 'green'];
function tint(s) { let x = 7; for (const ch of String(s)) x = (x * 33) ^ ch.codePointAt(0); return TINTS[(x >>> 0) % TINTS.length]; }

function initials(name) {
  const s = String(name || '?').trim();
  if (/^[\u3400-\u9fff]/.test(s)) return s.replace(/\s/g, '').slice(-2);
  return s.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
}

const KINDS = [
  [/iphone/i, 'smartphone', 'iPhone'],
  [/ipad/i, 'tablet', 'iPad'],
  [/macbook/i, 'laptop', 'Mac'],
  [/imac|mac ?mini|mac ?studio|mac ?pro|display|mac/i, 'monitor', 'Mac'],
  [/watch/i, 'watch', 'Apple Watch'],
  [/airpods|beats/i, 'headphones', 'AirPods'],
  [/apple ?tv/i, 'tv', 'Apple TV'],
  [/homepod/i, 'speaker', 'HomePod'],
  [/windows|pc/i, 'monitor', 'PC'],
];
const kindOf = (d) => KINDS.find(([re]) => re.test(`${d.model || ''} ${d.name || ''}`)) || [null, 'monitor-smartphone', '设备'];

function maskSerial(s) {
  const v = String(s || '');
  if (!v) return '';
  return v.length <= 4 ? v : `${'•'.repeat(Math.min(6, v.length - 4))}${v.slice(-4)}`;
}

export default {
  id: 'account',
  title: '账户',
  app: 'storage',
  mount(el) {
    let alive = true;
    const refreshBtn = iconBtn('refresh-cw', '刷新 (F5)', () => load());
    refreshBtn.dataset.refresh = '';
    const tb = toolbar({ title: '账户', right: [refreshBtn] });
    const content = h('div', { class: 'content acc-content' });
    el.append(tb, h('div', { class: 'pane-body acc-body' }, content));

    async function load() {
      refreshBtn.disabled = true;
      if (!content.childElementCount || content.querySelector('.error-box')) {
        clear(content, h('div', { class: 'acc-skel' }, h('div', { class: 'card' }, skeleton(2, { avatar: true })), h('div', { class: 'card' }, skeleton(3))));
      }
      try {
        const [acc, st] = await Promise.all([get('/api/account'), get('/api/auth/status').catch(() => null)]);
        if (!alive) return;
        render(acc || {}, st || {});
      } catch (e) {
        if (!alive) return;
        clear(content, errorBox(e));
      } finally {
        if (alive) refreshBtn.disabled = false;
      }
    }

    function sectionHead(title, ic, extra) {
      return h('div', { class: 'acc-sec-head' }, h('h2', {}, icon(ic), title), extra || null);
    }

    function inlineError(text, msg) {
      return h('div', { class: 'acc-err' }, icon('triangle-alert', { size: 'sm' }), h('span', {}, text, msg ? h('span', { class: 'acc-err-detail' }, `（${msg}）`) : null));
    }

    function render(acc, st) {
      const user = st.user || {};
      const name = user.full_name || [user.last_name, user.first_name].filter(Boolean).join('') || st.apple_id || 'iCloud 用户';
      const mail = user.apple_id || st.apple_id || '';
      const total = acc.storage?.total || 0;
      const plan = total > 5 * 1024 ** 3 ? `iCloud+ · ${fmt.bytes(total)}` : total ? `iCloud · ${fmt.bytes(total)}` : null;

      const profile = h('section', { class: 'acc-profile' },
        h('span', { class: `avatar acc-avatar acc-tint-${tint(name)}` }, initials(name)),
        h('div', { class: 'acc-who' },
          h('h1', {}, name),
          mail ? h('div', { class: 'acc-mail selectable' }, mail) : null,
          plan ? h('span', { class: 'tag accent acc-plan' }, icon('cloud', { size: 12 }), plan) : null),
        h('div', { class: 'acc-profile-actions' },
          btn('在 iCloud.com 上管理', { kind: 'tinted', size: 'sm', icon: 'external-link', onclick: () => shell.openExternal('https://www.icloud.com/settings/') })));

      clear(content, profile, storageCard(acc), devicesSec(acc), familySec(acc));
    }

    // ------------------------------------------------------------ storage
    function storageCard(acc) {
      const head = sectionHead('iCloud 储存空间', 'cloud');
      if (!acc.storage) return h('section', { class: 'acc-sec' }, head, h('div', { class: 'card' }, inlineError('无法读取储存空间信息', acc.storage_error)));
      const s = acc.storage;
      const total = s.total || (s.used || 0) + (s.available || 0);
      const used = s.used || 0;
      const free = Math.max(0, s.available ?? total - used);
      const pct = Math.round(s.percent ?? (total ? (used / total) * 100 : 0));
      const media = (s.by_media || []).filter((m) => m.bytes > 0).sort((a, b) => b.bytes - a.bytes);
      const color = (m) => (m.color ? `#${String(m.color).replace(/^#/, '')}` : 'var(--gray)');
      const known = media.reduce((n, m) => n + m.bytes, 0);
      const other = Math.max(0, used - known);
      const segs = media.map((m) => ({ label: m.label || m.key, bytes: m.bytes, color: color(m) }));
      if (other > total * 0.002) segs.push({ label: '其他', bytes: other, color: 'var(--gray)' });

      const bar = h('div', { class: 'acc-bar', role: 'img', 'aria-label': `已使用 ${fmt.bytes(used)}，共 ${fmt.bytes(total)}` },
        segs.map((g) => h('span', { class: 'acc-seg', style: { flexGrow: String(g.bytes), background: g.color }, title: `${g.label}：${fmt.bytes(g.bytes)}` })),
        free > 0 ? h('span', { class: 'acc-seg free', style: { flexGrow: String(free) }, title: `可用：${fmt.bytes(free)}` }) : null);

      const level = pct >= 95 ? 'red' : pct >= 85 ? 'orange' : '';
      return h('section', { class: 'acc-sec' }, head,
        h('div', { class: 'card acc-storage' },
          h('div', { class: 'acc-st-top' },
            h('div', { class: 'acc-st-used' },
              h('span', { class: 'acc-st-big' }, fmt.bytes(used)),
              h('span', { class: 'acc-st-of' }, `已使用，共 ${fmt.bytes(total)}`)),
            h('div', { class: `acc-st-pct ${level}` }, h('b', {}, `${pct}%`), h('span', {}, `剩余 ${fmt.bytes(free)}`))),
          bar,
          h('div', { class: 'acc-legend' },
            segs.map((g) => h('span', { class: 'acc-chip', title: `${g.label}：${fmt.bytes(g.bytes)}（${total ? ((g.bytes / total) * 100).toFixed(1) : 0}%）` },
              h('i', { style: { background: g.color } }), h('span', { class: 'acc-chip-l' }, g.label), h('span', { class: 'acc-chip-v' }, fmt.bytes(g.bytes)))),
            h('span', { class: 'acc-chip' }, h('i', { class: 'free' }), h('span', { class: 'acc-chip-l' }, '可用'), h('span', { class: 'acc-chip-v' }, fmt.bytes(free)))),
          level ? h('div', { class: `acc-warn ${level}` }, icon('triangle-alert', { size: 'sm' }),
            pct >= 95 ? 'iCloud 储存空间几乎已满。照片、备份和文稿可能无法再同步。' : 'iCloud 储存空间即将用完，可考虑清理或升级方案。') : null));
    }

    // ------------------------------------------------------------ devices
    function deviceCard(d) {
      const [, ic, kind] = kindOf(d);
      const serial = String(d.serial || '');
      let shown = false;
      const serialText = h('span', { class: 'acc-serial-v' }, maskSerial(serial));
      const eye = serial.length > 4 ? iconBtn('eye', '显示序列号', () => {
        shown = !shown;
        serialText.textContent = shown ? serial : maskSerial(serial);
        clear(eye, icon(shown ? 'eye-off' : 'eye', { size: 'sm' }));
        eye.title = shown ? '隐藏序列号' : '显示序列号';
        eye.setAttribute('aria-label', eye.title);
      }, { size: 'sm' }) : null;
      const glyph = h('div', { class: 'acc-dev-art' }, icon(ic, { size: 26 }));
      if (d.image && /^https?:/i.test(d.image)) {
        const img = h('img', { src: d.image, alt: '', loading: 'lazy', onerror: () => img.remove(), onload: () => glyph.classList.add('has-img') });
        glyph.append(img);
      }
      return h('article', { class: 'card acc-dev' },
        glyph,
        h('div', { class: 'acc-dev-main' },
          h('div', { class: 'acc-dev-name', title: d.name || '' }, d.name || kind),
          h('div', { class: 'acc-dev-model' }, d.model || kind),
          serial ? h('div', { class: 'acc-serial' },
            h('span', { class: 'acc-serial-k' }, '序列号'), serialText, eye,
            iconBtn('copy', '复制序列号', () => copyText(serial, '已复制序列号'), { size: 'sm' })) : null));
    }

    function devicesSec(acc) {
      const list = acc.devices || [];
      const head = sectionHead('设备', 'monitor-smartphone', list.length ? h('span', { class: 'acc-count' }, `${list.length} 台`) : null);
      if (!acc.devices) return h('section', { class: 'acc-sec' }, head, h('div', { class: 'card' }, inlineError('无法读取设备列表', acc.devices_error)));
      if (!list.length) return h('section', { class: 'acc-sec' }, head, h('div', { class: 'card' }, empty({ icon: 'monitor-smartphone', title: '没有设备', text: '使用此 Apple 账户登录的设备会显示在这里。', compact: true })));
      return h('section', { class: 'acc-sec' }, head,
        h('div', { class: 'acc-devs' }, list.map(deviceCard)),
        h('p', { class: 'acc-note' }, '这些设备使用你的 Apple 账户登录。若要移除设备，请在该设备上退出登录，或前往 iCloud.com。'));
    }

    // ------------------------------------------------------------- family
    function familySec(acc) {
      const list = acc.family || [];
      const head = sectionHead('家人共享', 'users', list.length ? h('span', { class: 'acc-count' }, `${list.length} 位成员`) : null);
      if (!acc.family) return h('section', { class: 'acc-sec' }, head, h('div', { class: 'card' }, inlineError('无法读取家人共享信息', acc.family_error)));
      if (!list.length) {
        return h('section', { class: 'acc-sec' }, head, h('div', { class: 'card' }, empty({ app: 'family', title: '未设置家人共享', text: '与最多五位家庭成员共享 iCloud+、订阅和购买项目。', compact: true })));
      }
      return h('section', { class: 'acc-sec' }, head,
        h('div', { class: 'group acc-family' }, list.map((m) => {
          const nm = m.name || m.apple_id || '家庭成员';
          return h('div', { class: 'group-row acc-member' },
            h('span', { class: `avatar acc-tint-${tint(nm)}` }, initials(nm)),
            h('div', { class: 'acc-member-main' },
              h('div', { class: 'acc-member-name' }, nm),
              m.apple_id ? h('div', { class: 'acc-member-id selectable' }, m.apple_id) : null),
            m.apple_id ? iconBtn('copy', '复制 Apple 账户', () => copyText(m.apple_id, `已复制 ${m.apple_id}`), { size: 'sm' }) : null);
        })));
    }

    load();
    return () => { alive = false; };
  },
};
