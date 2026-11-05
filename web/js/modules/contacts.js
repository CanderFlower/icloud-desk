// Contacts: searchable list + detail card (read only).
import { get } from '../api.js';
import { h, clear, spinner, empty, debounce } from '../ui.js';

const LABELS = { HOME: '住宅', WORK: '工作', MOBILE: '手机', IPHONE: 'iPhone', MAIN: '主要', OTHER: '其他', HOMEPAGE: '主页', SCHOOL: '学校' };
const label = (l) => LABELS[(l || '').toUpperCase().replace(/[_$!<>]/g, '')] || l || '';
const initials = (c) => (c.name || '?').trim().slice(0, 1).toUpperCase();
const photoUrl = (c) => (c.photo ? `/api/contacts/photo?url=${encodeURIComponent(c.photo)}` : null);

function addressText(a) {
  const f = a.field || a;
  if (typeof f === 'string') return f;
  return [f.street, f.city, f.state, f.postalCode, f.country].filter(Boolean).join(', ');
}

export default {
  id: 'contacts',
  title: '通讯录',
  icon: '👤',
  color: '#8e8e93',
  mount(el) {
    let all = [];
    let current = null;
    let q = '';
    const listBox = h('div', { class: 'list contacts-list' });
    const detail = h('div', { class: 'contact-detail' });
    const search = h('input', { class: 'input search', placeholder: '搜索姓名、电话、邮箱' });
    search.addEventListener('input', debounce(() => { q = search.value.trim().toLowerCase(); renderList(); }, 120));

    clear(el, h('div', { class: 'split' },
      h('div', { class: 'pane pane-list wide' }, h('div', { class: 'pane-header' }, search), listBox),
      h('div', { class: 'pane pane-main' }, detail)));
    clear(detail, empty('选择一个联系人', '👤'));

    function haystack(c) {
      return [c.name, c.company, c.nickname, ...c.phones.map((p) => p.field), ...c.emails.map((e) => e.field)].join(' ').toLowerCase();
    }

    function renderList() {
      const rows = all.filter((c) => !q || haystack(c).includes(q));
      if (!rows.length) return clear(listBox, empty(q ? '无匹配结果' : '没有联系人'));
      const out = [];
      let letter = null;
      for (const c of rows) {
        const L = /^[a-z]/i.test(c.name) ? c.name[0].toUpperCase() : '#';
        if (L !== letter) { letter = L; out.push(h('div', { class: 'list-group' }, L)); }
        out.push(h('div', { class: `list-item ${current === c.id ? 'active' : ''}`, onclick: () => { current = c.id; renderList(); renderDetail(c); } },
          avatar(c, 'small'), h('span', { class: 'grow' }, c.name || c.emails[0]?.field || '(无名称)'), c.company && c.name !== c.company ? h('span', { class: 'muted small' }, c.company) : null));
      }
      clear(listBox, out);
    }

    function avatar(c, size = '') {
      const url = photoUrl(c);
      return url ? h('img', { class: `avatar ${size}`, src: url, alt: '' }) : h('div', { class: `avatar ${size}` }, initials(c));
    }

    function renderDetail(c) {
      const section = (title, rows) => rows.length ? h('div', { class: 'card' }, rows.map(([l, v]) => h('div', { class: 'kv' }, h('span', { class: 'k' }, l || title), h('span', { class: 'v' }, v)))) : null;
      clear(detail, h('div', { class: 'contact-card' },
        h('div', { class: 'contact-hero' }, avatar(c, 'large'),
          h('h2', {}, c.name || '(无名称)'),
          c.company || c.job_title ? h('div', { class: 'muted' }, [c.job_title, c.company].filter(Boolean).join(' · ')) : null,
          c.nickname ? h('div', { class: 'muted small' }, `昵称：${c.nickname}`) : null),
        section('电话', c.phones.map((p) => [label(p.label) || '电话', h('a', { href: `tel:${p.field}` }, p.field)])),
        section('邮箱', c.emails.map((e) => [label(e.label) || '邮箱', h('a', { href: `mailto:${e.field}` }, e.field)])),
        section('地址', c.addresses.map((a) => [label(a.label) || '地址', addressText(a)])),
        section('网址', c.urls.map((u) => [label(u.label) || '网址', h('a', { href: u.field, target: '_blank' }, u.field)])),
        section('', [c.birthday ? ['生日', c.birthday] : null, c.notes ? ['备注', c.notes] : null].filter(Boolean)),
        h('p', { class: 'muted small center' }, '通讯录为只读（Apple 网页接口的写入暂未接入）')));
    }

    (async () => {
      clear(listBox, spinner());
      try { all = await get('/api/contacts'); renderList(); } catch (e) { clear(listBox, h('div', { class: 'error-box' }, e.message)); }
    })();
  },
};
