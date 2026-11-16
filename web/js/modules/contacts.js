// Contacts — pinyin-aware alphabetical list, detail card, vCard export. Read-only.
import { get } from '../api.js';
import { countText, lang, MONTHS_SHORT_EN, tx } from '../i18n.js';
import {
  h, clear, icon, iconBtn, toolbar, searchBox, menu, toast, toastError, empty, errorBox, skeleton,
  fmt, store, copyText, isTyping, shell,
} from '../ui.js';

const COLL = new Intl.Collator('zh-Hans-CN-u-co-pinyin', { sensitivity: 'base', numeric: true });
// First character (in pinyin collation order) of each initial — B starts at 八, C at 嚓 …
const BOUND = '阿八嚓哒妸发旮哈讥咔垃妈拏噢妑七呥仨他屲夕丫帀';
const LETTERS = 'ABCDEFGHJKLMNOPQRSTWXYZ';
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

const LABELS_ZH = {
  MOBILE: '手机', CELL: '手机', IPHONE: 'iPhone', HOME: '住宅', WORK: '工作', MAIN: '主要', OTHER: '其他', PAGER: '传呼机',
  'HOME FAX': '住宅传真', 'WORK FAX': '工作传真', FAX: '传真', SCHOOL: '学校', HOMEPAGE: '主页', ICLOUD: 'iCloud',
};
const LABELS_EN = {
  MOBILE: 'mobile', CELL: 'mobile', IPHONE: 'iPhone', HOME: 'home', WORK: 'work', MAIN: 'main', OTHER: 'other', PAGER: 'pager',
  'HOME FAX': 'home fax', 'WORK FAX': 'work fax', FAX: 'fax', SCHOOL: 'school', HOMEPAGE: 'home page', ICLOUD: 'iCloud',
};
const rawLabel = (l) => String(l || '').replace(/^_\$!<(.+)>!\$_$/, '$1').trim();
const label = (l, fallback) => {
  const s = rawLabel(l);
  const dict = lang.isEn ? LABELS_EN : LABELS_ZH;
  return s ? (dict[s.toUpperCase()] || s) : fallback;
};

const TINTS = [
  ['#ffb340', '#ff8a00'], ['#6ac4ff', '#1f8fff'], ['#5fd3e6', '#20a5bd'], ['#62d77f', '#2fb350'],
  ['#c98bf2', '#9b51e0'], ['#ff8aa0', '#f2475f'], ['#b9a07f', '#937a58'], ['#a5abb8', '#858994'],
];

/** Pinyin/Latin initial letter used for grouping; '#' for everything else. */
export function initial(s) {
  const ch = String(s || '').trim().charAt(0);
  if (!ch) return '#';
  const base = ch.normalize('NFD').charAt(0);
  if (/[a-z]/i.test(base)) return base.toUpperCase();
  if (CJK.test(ch)) {
    for (let i = BOUND.length - 1; i >= 0; i--) if (COLL.compare(ch, BOUND[i]) >= 0) return LETTERS[i];
  }
  return '#';
}

function displayName(c) {
  const f = (c.first_name || '').trim(); const l = (c.last_name || '').trim(); const n = (c.name || '').trim();
  if (c.is_company && c.company) return c.company;
  if (n && n !== [l, f].filter(Boolean).join(' ')) return n;
  if (f || l) return CJK.test(f + l) ? l + f : [f, l].filter(Boolean).join(' ');
  return n || c.company || c.nickname || c.emails?.[0]?.field || c.phones?.[0]?.field || tx('无姓名', 'No Name');
}

function monogram(name) {
  const s = name.replace(/\s+/g, ' ').trim();
  if (CJK.test(s)) return s.replace(/\s/g, '').slice(-2);
  const w = s.split(' ').filter((x) => /^[\p{L}]/u.test(x));
  if (!w.length) return '';
  return (w[0][0] + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase();
}

function hash(s) { let x = 0; for (const ch of s) x = (x * 31 + ch.codePointAt(0)) | 0; return Math.abs(x); }

function prep(c) {
  const name = displayName(c);
  const f = (c.first_name || '').trim(); const l = (c.last_name || '').trim();
  const key = c.is_company ? name : (l || f) ? (CJK.test(l + f) ? l + f : `${l} ${f}`.trim()) : name;
  const [a, b] = TINTS[hash(c.id || name) % TINTS.length];
  const sub = c.is_company ? (c.job_title || '') : [c.job_title, c.company].filter(Boolean).join(' · ');
  return {
    ...c, _name: name, _key: key, _letter: initial(key), _mono: monogram(name), _tint: `linear-gradient(180deg, ${a}, ${b})`, _sub: sub,
    _search: [name, c.nickname, c.company, c.job_title, ...(c.emails || []).map((e) => e.field)].filter(Boolean).join(' ').toLowerCase(),
    _digits: (c.phones || []).map((p) => String(p.field || '').replace(/\D/g, '')).join(' '),
  };
}

const order = (L) => (L === '#' ? 99 : L.charCodeAt(0));
const cmp = (a, b) => order(a._letter) - order(b._letter) || COLL.compare(a._key, b._key) || COLL.compare(a._name, b._name);

function parseBday(s) {
  const m = /^(?:(\d{4})-|--)(\d{1,2})-(\d{1,2})/.exec(String(s || ''));
  if (!m) return null;
  return { y: m[1] && m[1] !== '1604' ? +m[1] : null, m: +m[2], d: +m[3] };
}

function bdayInfo(b) {
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const next = new Date(now.getFullYear(), b.m - 1, b.d);
  if (next < now) next.setFullYear(now.getFullYear() + 1);
  const days = Math.round((next - now) / 86400000);
  const age = b.y ? next.getFullYear() - b.y : null;
  const when = days === 0 ? tx('今天生日', 'Birthday today') : days === 1 ? tx('明天生日', 'Birthday tomorrow') : tx(`还有 ${days} 天`, `in ${days} days`);
  return {
    text: lang.isEn
      ? `${MONTHS_SHORT_EN[b.m - 1]} ${b.d}${b.y ? `, ${b.y}` : ''}`
      : `${b.y ? `${b.y}年` : ''}${b.m}月${b.d}日`,
    sub: [when, age ? (days === 0 ? tx(`${age} 岁`, `Turns ${age}`) : tx(`将满 ${age} 岁`, `Turning ${age}`)) : null].filter(Boolean).join(' · '),
    days,
  };
}

function addrText(a, oneLine = false) {
  const f = a?.field ?? a ?? {};
  if (typeof f === 'string') return f;
  if (CJK.test([f.street, f.city, f.state, f.country].join(''))) {
    return [f.country, f.state, f.city, f.street, f.postalCode].filter(Boolean).join(' ');
  }
  const lines = [f.street, [f.city, f.state, f.postalCode].filter(Boolean).join(' '), f.country].filter(Boolean);
  return lines.join(oneLine ? ', ' : '\n');
}

// ------------------------------------------------------------------ vCard
const vesc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
function vtype(l, extra = '') {
  const s = rawLabel(l).toUpperCase();
  const map = { MOBILE: 'CELL', IPHONE: 'CELL', 'HOME FAX': 'HOME,FAX', 'WORK FAX': 'WORK,FAX' };
  const t = map[s] || (/^[A-Z]+$/.test(s) ? s : '');
  const all = [extra, t].filter(Boolean).join(',');
  return all ? `;TYPE=${all}` : '';
}
function vcard(c) {
  const L = ['BEGIN:VCARD', 'VERSION:3.0', `N:${vesc(c.last_name)};${vesc(c.first_name)};;;`, `FN:${vesc(c._name)}`];
  if (c.nickname) L.push(`NICKNAME:${vesc(c.nickname)}`);
  if (c.company) L.push(`ORG:${vesc(c.company)}`);
  if (c.job_title) L.push(`TITLE:${vesc(c.job_title)}`);
  for (const p of c.phones || []) L.push(`TEL${vtype(p.label)}:${vesc(p.field)}`);
  for (const m of c.emails || []) L.push(`EMAIL${vtype(m.label, 'INTERNET')}:${vesc(m.field)}`);
  for (const a of c.addresses || []) {
    const f = a.field || {};
    L.push(`ADR${vtype(a.label)}:;;${vesc(f.street)};${vesc(f.city)};${vesc(f.state)};${vesc(f.postalCode)};${vesc(f.country)}`);
  }
  for (const u of c.urls || []) L.push(`URL:${String(u.field || '').replace(/\r?\n/g, '')}`);
  const b = parseBday(c.birthday);
  if (b) L.push(`BDAY:${b.y ? b.y : '-'}-${fmt.pad(b.m)}-${fmt.pad(b.d)}`);
  if (c.notes) L.push(`NOTE:${vesc(c.notes)}`);
  if (c.is_company) L.push('X-ABShowAs:COMPANY');
  L.push('END:VCARD');
  return L.join('\r\n');
}
function saveVcf(list, base) {
  const blob = new Blob([`${list.map(vcard).join('\r\n')}\r\n`], { type: 'text/vcard;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `${base.replace(/[\\/:*?"<>|]/g, '_')}.vcf` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(list.length > 1
    ? tx(`已导出 ${list.length} 位联系人`, `Exported ${list.length} contacts`)
    : tx(`已导出“${list[0]._name}”`, `Exported “${list[0]._name}”`), 'success', 1800);
}

function cardText(c) {
  const sep = lang.isEn ? ': ' : '：';
  return [
    c._name, c._sub,
    ...(c.phones || []).map((p) => `${label(p.label, tx('电话', 'Phone'))}${sep}${p.field}`),
    ...(c.emails || []).map((m) => `${label(m.label, tx('邮件', 'Email'))}${sep}${m.field}`),
    ...(c.addresses || []).map((a) => `${label(a.label, tx('地址', 'Address'))}${sep}${addrText(a, true)}`),
  ].filter(Boolean).join('\n');
}

function avatar(c, size = '') {
  const el = h('span', { class: `avatar ct-av ${size}`, style: { '--a-bg': c._tint }, 'aria-hidden': 'true' });
  const fallback = () => {
    el.classList.toggle('cjk', CJK.test(c._mono));
    el.replaceChildren(c.is_company ? icon('building-2', { cls: 'ct-av-ic' }) : (c._mono || icon('user', { cls: 'ct-av-ic' })));
  };
  if (c.photo) {
    el.append(h('img', { src: `/api/contacts/photo?url=${encodeURIComponent(c.photo)}`, alt: '', loading: 'lazy', onerror: fallback }));
  } else fallback();
  return el;
}

const openMap = (a) => shell.openExternal(`https://maps.apple.com/?q=${encodeURIComponent(addrText(a, true))}`);
const openUrl = (u) => shell.openExternal(/^[a-z][\w+.-]*:/i.test(u) ? u : `https://${u}`);

export default {
  id: 'contacts',
  get title() { return tx('通讯录', 'Contacts'); },
  app: 'contacts',
  mount(el, { params } = {}) {
    const S = { all: [], view: [], q: '', sel: params?.[0] || store.get('ct.sel', null) };
    const rowEls = new Map();
    let alive = true;

    // ------------------------------------------------------------ layout
    const countEl = h('span');
    const refreshBtn = iconBtn('refresh-cw', tx('刷新 (F5)', 'Refresh (F5)'), () => load());
    refreshBtn.dataset.refresh = '';
    const exportBtn = iconBtn('file-down', tx('导出 vCard', 'Export vCard'), (e) => exportMenu(e.currentTarget));
    const backBtn = iconBtn('chevron-left', tx('返回通讯录', 'Back to Contacts'), () => showDetail(false), { cls: 'only-narrow ct-back' });
    const tb = toolbar({ title: tx('通讯录', 'Contacts'), subtitle: countEl, left: [backBtn], right: [exportBtn, refreshBtn] });

    const search = searchBox({ placeholder: tx('搜索姓名、电话或邮件', 'Search name, phone, or email'), oninput: (v) => { S.q = v; renderList(); } });
    search.input.setAttribute('aria-label', tx('搜索联系人', 'Search contacts'));
    const listBody = h('div', { class: 'pane-body ct-list' });
    const index = h('nav', { class: 'ct-index', 'aria-label': tx('字母索引', 'Alphabetical index') });
    const detailBody = h('div', { class: 'pane-body ct-detail' });
    const panes = h('div', { class: 'panes stack ct-panes' },
      h('div', { class: 'pane list ct-list-pane' }, h('div', { class: 'ct-search' }, search), h('div', { class: 'ct-list-wrap' }, listBody, index)),
      h('div', { class: 'pane detail ct-detail-pane' }, detailBody));
    el.append(tb, panes);

    // ------------------------------------------------------------- data
    async function load() {
      if (!S.all.length) { clear(listBody, skeleton(9)); clear(detailBody); }
      refreshBtn.disabled = true;
      try {
        const rows = await get('/api/contacts');
        if (!alive) return;
        S.all = (rows || []).map(prep).sort(cmp);
      } catch (e) {
        if (!alive) return;
        if (S.all.length) toastError(e);
        else {
          countEl.textContent = '';
          clear(listBody, errorBox(e));
          clear(detailBody, empty({
            app: 'contacts', title: tx('无法载入通讯录', 'Could Not Load Contacts'),
            text: tx('请检查网络连接后重试。', 'Check your internet connection and try again.'),
            action: { label: tx('重试', 'Retry'), icon: 'refresh-cw', onClick: load },
          }));
          return;
        }
      } finally {
        refreshBtn.disabled = false;
      }
      renderList();
      if (!S.all.some((c) => c.id === S.sel)) S.sel = S.view[0]?.id ?? null;
      markActive();
      renderDetail();
      rowEls.get(S.sel)?.scrollIntoView({ block: 'nearest' });
    }

    function matches(c, q) {
      const ql = q.toLowerCase();
      if (c._search.includes(ql)) return true;
      const qd = q.replace(/[\s()+-]/g, '');
      if (/^\d{3,}$/.test(qd) && c._digits.includes(qd)) return true;
      return /^[a-z]$/i.test(q) && c._letter === q.toUpperCase();
    }

    // ------------------------------------------------------------- list
    function renderList() {
      S.view = S.q ? S.all.filter((c) => matches(c, S.q)) : S.all;
      countEl.textContent = S.q
        ? `${S.view.length} / ${countText(S.all.length, '位联系人', 'contact')}`
        : countText(S.all.length, '位联系人', 'contact');
      rowEls.clear();
      index.replaceChildren();
      if (!S.all.length) {
        clear(listBody, empty({ icon: 'contact-round', title: tx('没有联系人', 'No Contacts'), text: tx('在 iPhone 或 iCloud.com 上添加的联系人会显示在这里。', 'Contacts added on your iPhone or iCloud.com appear here.'), compact: true }));
        return;
      }
      if (!S.view.length) {
        clear(listBody, empty({ icon: 'search', title: tx('无结果', 'No Results'), text: tx(`没有与“${S.q}”匹配的联系人。`, `No contacts matching “${S.q}”.`), compact: true }));
        return;
      }
      const out = []; const letters = []; let cur = null;
      for (const c of S.view) {
        if (c._letter !== cur) {
          cur = c._letter; letters.push(cur);
          out.push(h('div', { class: 'list-header ct-letter', dataset: { letter: cur } }, cur));
        }
        out.push(row(c));
      }
      clear(listBody, h('div', { class: 'ct-rows', role: 'listbox', 'aria-label': tx('联系人', 'Contacts') }, out),
        h('div', { class: 'ct-list-foot' }, countText(S.view.length, '位联系人', 'contact')));
      if (letters.length > 1) index.append(...letters.map((L) => h('button', { type: 'button', tabindex: '-1', dataset: { letter: L }, 'aria-label': tx(`跳到 ${L}`, `Jump to ${L}`) }, L)));
    }

    function row(c) {
      const b = parseBday(c.birthday);
      const soon = b && bdayInfo(b).days <= 7;
      const r = h('div', {
        class: 'list-row ct-row', role: 'option', 'aria-selected': 'false', dataset: { id: c.id },
        onclick: () => select(c.id, { open: true }),
        oncontextmenu: (e) => { e.preventDefault(); select(c.id); rowMenu(e, c); },
      },
      avatar(c),
      h('div', { class: 'ct-row-text' },
        h('div', { class: 'primary' }, c._name),
        c._sub ? h('div', { class: 'secondary' }, c._sub) : null),
      soon ? icon('cake', { size: 'sm', cls: 'ct-row-bday', title: tx('生日快到了', 'Upcoming birthday') }) : null);
      rowEls.set(c.id, r);
      return r;
    }

    function markActive() {
      for (const [id, r] of rowEls) {
        const on = id === S.sel;
        r.classList.toggle('active', on);
        r.setAttribute('aria-selected', String(on));
      }
    }

    function select(id, { open = false, scroll = false } = {}) {
      if (id !== S.sel) {
        S.sel = id; store.set('ct.sel', id);
        markActive();
        renderDetail();
      }
      if (scroll) rowEls.get(id)?.scrollIntoView({ block: 'nearest' });
      if (open) showDetail(true);
    }

    function showDetail(on) {
      panes.classList.toggle('show-detail', on);
      el.classList.toggle('ct-detail-open', on);
      if (!on) rowEls.get(S.sel)?.scrollIntoView({ block: 'nearest' });
    }

    function jump(L) {
      const hd = listBody.querySelector(`.ct-letter[data-letter="${CSS.escape(L)}"]`);
      const first = hd?.nextElementSibling;
      if (first) listBody.scrollTop = first.offsetTop - hd.offsetHeight;
    }
    // Index scrubber: click or drag over the letters.
    let scrubbing = false;
    const scrubAt = (e) => {
      const b = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.ct-index button');
      if (b) jump(b.dataset.letter);
    };
    index.addEventListener('pointerdown', (e) => { scrubbing = true; index.setPointerCapture(e.pointerId); index.classList.add('scrub'); scrubAt(e); e.preventDefault(); });
    index.addEventListener('pointermove', (e) => { if (scrubbing) scrubAt(e); });
    const endScrub = () => { scrubbing = false; index.classList.remove('scrub'); };
    index.addEventListener('pointerup', endScrub);
    index.addEventListener('pointercancel', endScrub);

    function rowMenu(e, c) {
      const phone = c.phones?.[0]?.field; const mail = c.emails?.[0]?.field;
      menu(e, [
        { label: tx('复制姓名', 'Copy Name'), icon: 'copy', onClick: () => copyText(c._name) },
        phone && { label: tx('复制电话号码', 'Copy Phone Number'), icon: 'phone', onClick: () => copyText(phone) },
        mail && { label: tx('复制电子邮件', 'Copy Email'), icon: 'mail', onClick: () => copyText(mail) },
        { label: tx('复制全部信息', 'Copy Contact Info'), icon: 'clipboard', onClick: () => copyText(cardText(c), tx('已复制联系人信息', 'Contact info copied')) },
        '-',
        mail && { label: tx('发送邮件', 'Send Email'), icon: 'send', onClick: () => shell.openExternal(`mailto:${mail}`) },
        { label: tx('导出 vCard', 'Export vCard'), icon: 'file-down', onClick: () => saveVcf([c], c._name) },
      ]);
    }

    function exportMenu(at) {
      if (!S.all.length) { toast(tx('没有可导出的联系人', 'No contacts to export')); return; }
      const cur = S.all.find((c) => c.id === S.sel);
      const baseName = tx('通讯录', 'Contacts');
      menu(at, [
        { section: tx('导出为 vCard 文件', 'Export as vCard') },
        { label: tx(`所有联系人（${S.all.length}）`, `All Contacts (${S.all.length})`), icon: 'users', onClick: () => saveVcf(S.all, baseName) },
        S.q && S.view.length && { label: tx(`搜索结果（${S.view.length}）`, `Search Results (${S.view.length})`), icon: 'search', onClick: () => saveVcf(S.view, `${baseName} - ${S.q}`) },
        cur && { label: `“${cur._name}”`, icon: 'contact-round', onClick: () => saveVcf([cur], cur._name) },
      ], { align: 'end' });
    }

    // ----------------------------------------------------------- detail
    function infoRow(lbl, value, { open, openTip, ic, extra, copy = value } = {}) {
      const copyTip = tx(`复制${lbl}`, `Copy ${lbl}`);
      const v = open
        ? h('button', { type: 'button', class: 'ct-value link', title: openTip, onclick: open }, value)
        : h('button', { type: 'button', class: 'ct-value', title: tx('点按以复制', 'Click to copy'), onclick: () => copyText(copy) }, value);
      return h('div', {
        class: 'group-row ct-info',
        oncontextmenu: (e) => {
          e.preventDefault();
          menu(e, [{ label: copyTip, icon: 'copy', onClick: () => copyText(copy) }, open && { label: openTip, icon: ic || 'external-link', onClick: open }]);
        },
      },
      h('div', { class: 'ct-info-main' }, h('div', { class: 'ct-label' }, lbl), v, extra || null),
      h('div', { class: 'ct-info-actions' },
        open && ic ? iconBtn(ic, openTip, open, { size: 'sm' }) : null,
        iconBtn('copy', copyTip, () => copyText(copy), { size: 'sm' })));
    }

    function quick(ic, text, fn, tip) {
      return h('button', { type: 'button', class: 'ct-quick-btn', disabled: !fn, onclick: fn || null, title: tip || text },
        h('span', { class: 'ct-quick-ic' }, icon(ic)), h('span', {}, text));
    }

    function renderDetail() {
      const c = S.all.find((x) => x.id === S.sel);
      detailBody.scrollTop = 0;
      if (!c) {
        clear(detailBody, S.all.length ? empty({ app: 'contacts', title: tx('未选择联系人', 'No Contact Selected'), text: tx('从列表中选择一位联系人以查看详细信息。', 'Select a contact from the list to view details.') }) : null);
        return;
      }
      const phone = c.phones?.[0]?.field; const mail = c.emails?.[0]?.field; const addr = c.addresses?.[0];
      const groups = [];
      const grp = (rows) => rows.length && groups.push(h('div', { class: 'group ct-group' }, rows));

      grp((c.phones || []).map((p) => infoRow(label(p.label, tx('电话', 'phone')), p.field)));
      grp((c.emails || []).map((m) => infoRow(label(m.label, tx('电子邮件', 'email')), m.field, {
        open: () => shell.openExternal(`mailto:${m.field}`), openTip: tx('发送邮件', 'Send email'), ic: 'send',
      })));
      grp((c.addresses || []).map((a) => infoRow(label(a.label, tx('地址', 'address')), addrText(a), {
        open: () => openMap(a), openTip: tx('在地图中打开', 'Open in Maps'), ic: 'map-pin', copy: addrText(a, true),
      })));
      const b = parseBday(c.birthday);
      const extra = [];
      if (b) {
        const bi = bdayInfo(b);
        extra.push(infoRow(tx('生日', 'birthday'), bi.text, { extra: h('div', { class: `ct-sub${bi.days <= 7 ? ' soon' : ''}` }, icon('cake', { size: 'sm' }), bi.sub) }));
      }
      if (c.nickname) extra.push(infoRow(tx('昵称', 'nickname'), c.nickname));
      grp(extra);
      grp((c.urls || []).map((u) => infoRow(label(u.label, tx('网址', 'website')), u.field, { open: () => openUrl(u.field), openTip: tx('在浏览器中打开', 'Open in browser'), ic: 'external-link' })));
      if (c.notes) {
        groups.push(h('div', { class: 'group ct-group' }, h('div', { class: 'group-row ct-notes' },
          h('div', { class: 'ct-info-main' }, h('div', { class: 'ct-label' }, tx('备注', 'notes')), h('div', { class: 'ct-note-text selectable' }, c.notes)))));
      }

      const role = c.is_company ? c.job_title : [c.job_title, c.company].filter(Boolean).join(' · ');
      clear(detailBody, h('article', { class: 'ct-card' },
        h('header', { class: 'ct-head' },
          avatar(c, 'xl'),
          h('h1', { class: 'ct-name selectable' }, c._name),
          c.nickname ? h('div', { class: 'ct-nick' }, `“${c.nickname}”`) : null,
          role ? h('div', { class: 'ct-role' }, c.is_company ? icon('building-2', { size: 'sm' }) : null, role) : null,
          h('div', { class: 'ct-quick' },
            quick('phone', tx('电话', 'Call'), phone && (() => copyText(phone, tx(`已复制 ${phone}`, `Copied ${phone}`))), phone ? tx(`复制 ${phone}`, `Copy ${phone}`) : tx('无电话号码', 'No phone number')),
            quick('mail', tx('邮件', 'Mail'), mail && (() => shell.openExternal(`mailto:${mail}`)), mail ? tx(`发送邮件至 ${mail}`, `Email ${mail}`) : tx('无电子邮件', 'No email')),
            quick('map-pin', tx('地图', 'Maps'), addr && (() => openMap(addr)), addr ? tx('在地图中打开', 'Open in Maps') : tx('无地址', 'No address')),
            quick('file-down', tx('导出', 'Export'), () => saveVcf([c], c._name), tx('导出为 vCard', 'Export as vCard')))),
        groups.length ? h('div', { class: 'ct-groups' }, groups)
          : h('div', { class: 'ct-none' }, tx('此联系人没有其他信息。', 'No additional details for this contact.')),
        h('p', { class: 'ct-foot' }, icon('info', { size: 'sm' }), tx('通讯录为只读，请在 iPhone 或 iCloud.com 上编辑联系人。', 'Contacts are read-only here. Edit contacts on your iPhone or iCloud.com.'))));
    }

    // --------------------------------------------------------- keyboard
    function onKey(e) {
      if (document.querySelector('.overlay')) return;
      const inSearch = e.target === search.input;
      if (isTyping(e) && !inSearch) return;
      if (!el.contains(e.target) && e.target !== document.body) return;
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.altKey && !e.ctrlKey) {
        if (!S.view.length) return;
        e.preventDefault();
        const i = S.view.findIndex((c) => c.id === S.sel);
        const n = i < 0 ? 0 : Math.max(0, Math.min(S.view.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
        select(S.view[n].id, { scroll: true });
      } else if ((e.key === 'Home' || e.key === 'End') && !inSearch && S.view.length) {
        e.preventDefault();
        select(S.view[e.key === 'Home' ? 0 : S.view.length - 1].id, { scroll: true });
      } else if (e.key === 'Enter' && S.sel && (inSearch || !isTyping(e))) {
        if (S.view.some((c) => c.id === S.sel)) showDetail(true);
      } else if (e.key === 'Escape' && panes.classList.contains('show-detail')) {
        showDetail(false);
      }
    }
    document.addEventListener('keydown', onKey);

    load();
    return () => { alive = false; document.removeEventListener('keydown', onKey); };
  },
};
