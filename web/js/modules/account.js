// Account — profile, iCloud storage breakdown, signed-in devices, Family Sharing.
import { get } from '../api.js';
import { countText, tx } from '../i18n.js';
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
const kindOf = (d) => KINDS.find(([re]) => re.test(`${d.model || ''} ${d.name || ''}`)) || [null, 'monitor-smartphone', tx('设备', 'Device')];

function maskSerial(s) {
  const v = String(s || '');
  if (!v) return '';
  return v.length <= 4 ? v : `${'•'.repeat(Math.min(6, v.length - 4))}${v.slice(-4)}`;
}

export default {
  id: 'account',
  get title() { return tx('账户', 'Account'); },
  app: 'storage',
  mount(el) {
    let alive = true;
    const refreshBtn = iconBtn('refresh-cw', tx('刷新 (F5)', 'Refresh (F5)'), () => load());
    refreshBtn.dataset.refresh = '';
    const tb = toolbar({ title: tx('账户', 'Account'), right: [refreshBtn] });
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
      return h('div', { class: 'acc-err' }, icon('triangle-alert', { size: 'sm' }), h('span', {}, text, msg ? h('span', { class: 'acc-err-detail' }, tx(`（${msg}）`, ` (${msg})`)) : null));
    }

    function render(acc, st) {
      const user = st.user || {};
      const name = user.full_name || [user.last_name, user.first_name].filter(Boolean).join('') || st.apple_id || tx('iCloud 用户', 'iCloud User');
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
          btn(tx('在 iCloud.com 上管理', 'Manage on iCloud.com'), { kind: 'tinted', size: 'sm', icon: 'external-link', onclick: () => shell.openExternal('https://www.icloud.com/settings/') })));

      clear(content, profile, storageCard(acc), devicesSec(acc), familySec(acc));
    }

    // ------------------------------------------------------------ storage
    function storageCard(acc) {
      const head = sectionHead(tx('iCloud 储存空间', 'iCloud Storage'), 'cloud');
      if (!acc.storage) return h('section', { class: 'acc-sec' }, head, h('div', { class: 'card' }, inlineError(tx('无法读取储存空间信息', 'Could not load storage info'), acc.storage_error)));
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
      if (other > total * 0.002) segs.push({ label: tx('其他', 'Other'), bytes: other, color: 'var(--gray)' });

      const freeLabel = tx('可用', 'Available');
      const bar = h('div', { class: 'acc-bar', role: 'img', 'aria-label': tx(`已使用 ${fmt.bytes(used)}，共 ${fmt.bytes(total)}`, `${fmt.bytes(used)} of ${fmt.bytes(total)} used`) },
        segs.map((g) => h('span', { class: 'acc-seg', style: { flexGrow: String(g.bytes), background: g.color }, title: `${g.label}: ${fmt.bytes(g.bytes)}` })),
        free > 0 ? h('span', { class: 'acc-seg free', style: { flexGrow: String(free) }, title: `${freeLabel}: ${fmt.bytes(free)}` }) : null);

      const level = pct >= 95 ? 'red' : pct >= 85 ? 'orange' : '';
      return h('section', { class: 'acc-sec' }, head,
        h('div', { class: 'card acc-storage' },
          h('div', { class: 'acc-st-top' },
            h('div', { class: 'acc-st-used' },
              h('span', { class: 'acc-st-big' }, fmt.bytes(used)),
              h('span', { class: 'acc-st-of' }, tx(`已使用，共 ${fmt.bytes(total)}`, `of ${fmt.bytes(total)} used`))),
            h('div', { class: `acc-st-pct ${level}` }, h('b', {}, `${pct}%`), h('span', {}, tx(`剩余 ${fmt.bytes(free)}`, `${fmt.bytes(free)} free`)))),
          bar,
          h('div', { class: 'acc-legend' },
            segs.map((g) => h('span', { class: 'acc-chip', title: `${g.label}: ${fmt.bytes(g.bytes)} (${total ? ((g.bytes / total) * 100).toFixed(1) : 0}%)` },
              h('i', { style: { background: g.color } }), h('span', { class: 'acc-chip-l' }, g.label), h('span', { class: 'acc-chip-v' }, fmt.bytes(g.bytes)))),
            h('span', { class: 'acc-chip' }, h('i', { class: 'free' }), h('span', { class: 'acc-chip-l' }, freeLabel), h('span', { class: 'acc-chip-v' }, fmt.bytes(free)))),
          level ? h('div', { class: `acc-warn ${level}` }, icon('triangle-alert', { size: 'sm' }),
            pct >= 95
              ? tx('iCloud 储存空间几乎已满。照片、备份和文稿可能无法再同步。', 'iCloud storage is almost full. Photos, backups, and documents may stop syncing.')
              : tx('iCloud 储存空间即将用完，可考虑清理或升级方案。', 'iCloud storage is running low. Consider freeing up space or upgrading your plan.')) : null));
    }

    // ------------------------------------------------------------ devices
    function deviceCard(d) {
      const [, ic, kind] = kindOf(d);
      const serial = String(d.serial || '');
      let shown = false;
      const serialText = h('span', { class: 'acc-serial-v' }, maskSerial(serial));
      const eye = serial.length > 4 ? iconBtn('eye', tx('显示序列号', 'Show serial number'), () => {
        shown = !shown;
        serialText.textContent = shown ? serial : maskSerial(serial);
        clear(eye, icon(shown ? 'eye-off' : 'eye', { size: 'sm' }));
        eye.title = shown ? tx('隐藏序列号', 'Hide serial number') : tx('显示序列号', 'Show serial number');
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
            h('span', { class: 'acc-serial-k' }, tx('序列号', 'Serial')), serialText, eye,
            iconBtn('copy', tx('复制序列号', 'Copy serial number'), () => copyText(serial, tx('已复制序列号', 'Serial number copied')), { size: 'sm' })) : null));
    }

    function devicesSec(acc) {
      const list = acc.devices || [];
      const head = sectionHead(tx('设备', 'Devices'), 'monitor-smartphone', list.length ? h('span', { class: 'acc-count' }, countText(list.length, '台', 'device')) : null);
      if (!acc.devices) return h('section', { class: 'acc-sec' }, head, h('div', { class: 'card' }, inlineError(tx('无法读取设备列表', 'Could not load devices'), acc.devices_error)));
      if (!list.length) return h('section', { class: 'acc-sec' }, head, h('div', { class: 'card' }, empty({ icon: 'monitor-smartphone', title: tx('没有设备', 'No Devices'), text: tx('使用此 Apple 账户登录的设备会显示在这里。', 'Devices signed in with this Apple Account appear here.'), compact: true })));
      return h('section', { class: 'acc-sec' }, head,
        h('div', { class: 'acc-devs' }, list.map(deviceCard)),
        h('p', { class: 'acc-note' }, tx('这些设备使用你的 Apple 账户登录。若要移除设备，请在该设备上退出登录，或前往 iCloud.com。', 'These devices are signed in with your Apple Account. To remove a device, sign out on that device or visit iCloud.com.')));
    }

    // ------------------------------------------------------------- family
    function familySec(acc) {
      const list = acc.family || [];
      const head = sectionHead(tx('家人共享', 'Family Sharing'), 'users', list.length ? h('span', { class: 'acc-count' }, countText(list.length, '位成员', 'member')) : null);
      if (!acc.family) return h('section', { class: 'acc-sec' }, head, h('div', { class: 'card' }, inlineError(tx('无法读取家人共享信息', 'Could not load Family Sharing info'), acc.family_error)));
      if (!list.length) {
        return h('section', { class: 'acc-sec' }, head, h('div', { class: 'card' }, empty({ app: 'family', title: tx('未设置家人共享', 'Family Sharing Not Set Up'), text: tx('与最多五位家庭成员共享 iCloud+、订阅和购买项目。', 'Share iCloud+, subscriptions, and purchases with up to five family members.'), compact: true })));
      }
      return h('section', { class: 'acc-sec' }, head,
        h('div', { class: 'group acc-family' }, list.map((m) => {
          const nm = m.name || m.apple_id || tx('家庭成员', 'Family Member');
          return h('div', { class: 'group-row acc-member' },
            h('span', { class: `avatar acc-tint-${tint(nm)}` }, initials(nm)),
            h('div', { class: 'acc-member-main' },
              h('div', { class: 'acc-member-name' }, nm),
              m.apple_id ? h('div', { class: 'acc-member-id selectable' }, m.apple_id) : null),
            m.apple_id ? iconBtn('copy', tx('复制 Apple 账户', 'Copy Apple Account'), () => copyText(m.apple_id, tx(`已复制 ${m.apple_id}`, `Copied ${m.apple_id}`)), { size: 'sm' }) : null);
        })));
    }

    load();
    return () => { alive = false; };
  },
};
