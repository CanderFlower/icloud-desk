// Hide My Email — list (active / inactive), create with generated address, edit, deactivate, delete.
import { get, post, patch, del, enc } from '../api.js';
import {
  h, clear, icon, appIcon, iconBtn, btn, toolbar, searchBox, field, modal, confirmDialog, menu,
  toast, toastError, empty, errorBox, skeleton, fmt, copyText,
} from '../ui.js';

const ORIGIN = [
  [/^ON_DEMAND$/i, '手动创建', 'square-pen'],
  [/SIWA|SIGN_?IN/i, '通过 Apple 登录', 'log-in'],
  [/MAIL/i, '来自“邮件”', 'mail'],
  [/SAFARI|AUTOFILL|WEB/i, '来自 Safari', 'globe'],
];
function origin(a) {
  const o = String(a.origin || '');
  const m = ORIGIN.find(([re]) => re.test(o));
  return m ? { text: m[1], icon: m[2] } : o ? { text: o, icon: 'tag' } : null;
}

const TINTS = ['blue', 'indigo', 'purple', 'pink', 'orange', 'teal', 'green'];
function tint(s) { let x = 7; for (const ch of String(s)) x = (x * 33) ^ ch.codePointAt(0); return TINTS[(x >>> 0) % TINTS.length]; }

export default {
  id: 'hme',
  title: '隐藏邮件地址',
  app: 'hme',
  mount(el) {
    const S = { items: [], q: '', flash: null };
    let alive = true;

    const subEl = h('span');
    const refreshBtn = iconBtn('refresh-cw', '刷新 (F5)', () => load());
    refreshBtn.dataset.refresh = '';
    const tb = toolbar({
      title: '隐藏邮件地址',
      subtitle: subEl,
      right: [
        refreshBtn,
        h('button', { class: 'btn primary sm', type: 'button', dataset: { new: '' }, title: '创建新地址 (Ctrl+N)', onclick: () => create() },
          icon('plus'), h('span', { class: 'hide-narrow' }, '创建新地址')),
      ],
    });
    const search = searchBox({ placeholder: '搜索标签、地址或备注', oninput: (v) => { S.q = v; renderList(); } });
    search.input.setAttribute('aria-label', '搜索隐藏邮件地址');
    const hero = h('div');
    const listEl = h('div', { class: 'hme-list' });
    const body = h('div', { class: 'pane-body hme-body' },
      h('div', { class: 'content hme-content' }, hero, h('div', { class: 'hme-search' }, search), listEl));
    el.append(tb, body);

    // -------------------------------------------------------------- data
    async function load() {
      if (!S.items.length) { clear(listEl, h('div', { class: 'group hme-skel' }, skeleton(4))); }
      refreshBtn.disabled = true;
      try {
        const rows = await get('/api/hme');
        if (!alive) return;
        S.items = (rows || []).slice().sort((a, b) => (b.created || 0) - (a.created || 0));
        render();
      } catch (e) {
        if (!alive) return;
        if (S.items.length) toastError(e);
        else { subEl.textContent = ''; clear(hero); clear(listEl, errorBox(e)); }
      } finally {
        if (alive) refreshBtn.disabled = false;
      }
    }

    const forwardTo = () => S.items.find((a) => a.forward_to)?.forward_to;

    function render() {
      const act = S.items.filter((a) => a.active !== false).length;
      subEl.textContent = S.items.length ? `${act} 个有效${S.items.length - act ? ` · ${S.items.length - act} 个已停用` : ''}` : '';
      const fwd = forwardTo();
      clear(hero, h('section', { class: 'card hme-hero' },
        appIcon('hme', 52),
        h('div', { class: 'hme-hero-text' },
          h('h2', {}, '隐藏邮件地址'),
          h('p', {}, '创建唯一、随机的电子邮件地址，邮件会自动转发到你的个人邮箱。你可以在注册网站或填写表单时使用这些地址，而无需透露真实邮箱，并可随时停用。'),
          fwd ? h('div', { class: 'hme-fwd' }, icon('mail-check', { size: 'sm' }), '转发至', h('b', { class: 'selectable' }, fwd)) : null)));
      renderList();
    }

    function matches(a, q) {
      const s = `${a.label || ''} ${a.email || ''} ${a.note || ''} ${a.domain || ''}`.toLowerCase();
      return s.includes(q.toLowerCase());
    }

    function renderList() {
      search.classList.toggle('hidden', !S.items.length);
      if (!S.items.length) {
        clear(listEl, empty({
          app: 'hme', title: '还没有隐藏邮件地址', text: '创建一个地址，在需要留下邮箱的地方使用它。',
          action: { label: '创建新地址', icon: 'plus', onClick: () => create() },
        }));
        return;
      }
      const view = S.q ? S.items.filter((a) => matches(a, S.q)) : S.items;
      if (!view.length) { clear(listEl, empty({ icon: 'search', title: '无结果', text: `没有与“${S.q}”匹配的地址。`, compact: true })); return; }
      const on = view.filter((a) => a.active !== false);
      const off = view.filter((a) => a.active === false);
      clear(listEl,
        on.length ? section('有效', on, 'circle-check') : null,
        off.length ? section('已停用', off, 'ban', '停用的地址不会再转发邮件。你可以重新启用它们，或将其永久删除。') : null);
      if (S.flash) {
        const r = listEl.querySelector(`[data-id="${CSS.escape(S.flash)}"]`);
        S.flash = null;
        if (r) { r.classList.add('flash'); r.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
      }
    }

    function section(title, items, ic, hint) {
      return h('section', { class: 'hme-sec' },
        h('div', { class: 'group-title hme-sec-title' }, icon(ic, { size: 'sm' }), `${title}`, h('span', { class: 'badge' }, String(items.length))),
        h('div', { class: 'group hme-group' }, items.map(row)),
        hint ? h('div', { class: 'hme-sec-hint' }, hint) : null);
    }

    function row(a) {
      const o = origin(a);
      const inactive = a.active === false;
      const name = a.label || a.domain || '未命名';
      return h('div', {
        class: `group-row hme-row clickable${inactive ? ' inactive' : ''}`, tabindex: '0', role: 'button', dataset: { id: a.id },
        'aria-label': `${name}，${a.email}`,
        onclick: (e) => { if (!e.target.closest('.icon-btn')) details(a); },
        onkeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); details(a); } },
        oncontextmenu: (e) => { e.preventDefault(); rowMenu(e, a); },
      },
      h('span', { class: `hme-av ${inactive ? 'gray' : tint(name)}` }, inactive ? icon('mail-x') : (name.trim()[0] || '@').toUpperCase()),
      h('div', { class: 'hme-main' },
        h('div', { class: 'hme-label' }, name),
        h('div', { class: 'hme-email' }, a.email),
        a.note ? h('div', { class: 'hme-note' }, a.note) : null),
      h('div', { class: 'hme-meta' },
        a.created ? h('span', { class: 'hme-date' }, fmt.date(a.created)) : null,
        o ? h('span', { class: 'tag hme-origin' }, icon(o.icon, { size: 12 }), o.text) : null),
      h('div', { class: 'hme-actions' },
        iconBtn('copy', '复制地址', () => copyText(a.email, `已复制 ${a.email}`), { size: 'sm' }),
        iconBtn('ellipsis', '更多操作', (e) => rowMenu(e.currentTarget, a), { size: 'sm' })));
    }

    function rowMenu(at, a) {
      const inactive = a.active === false;
      menu(at, [
        { label: '复制地址', icon: 'copy', onClick: () => copyText(a.email, `已复制 ${a.email}`) },
        { label: '编辑标签和备注…', icon: 'pencil', onClick: () => details(a) },
        '-',
        inactive
          ? { label: '重新启用', icon: 'rotate-ccw', onClick: () => setActive(a, true) }
          : { label: '停用地址…', icon: 'ban', danger: true, onClick: () => setActive(a, false) },
        inactive && { label: '删除地址…', icon: 'trash-2', danger: true, onClick: () => remove(a) },
      ], { align: 'end' });
    }

    // ----------------------------------------------------------- actions
    async function setActive(a, on, { ask = true } = {}) {
      if (!on && ask) {
        const ok = await confirmDialog(`停用“${a.label || a.email}”？`, {
          title: '停用地址', okLabel: '停用', danger: true, icon: 'ban',
          detail: `停用后，发送到 ${a.email} 的邮件将不再转发给你。你可以随时重新启用。`,
        });
        if (!ok) return false;
      }
      try {
        await post(`/api/hme/${enc(a.id)}/${on ? 'reactivate' : 'deactivate'}`, {});
        a.active = on;
        render();
        toast(on ? `已重新启用 ${a.email}` : `已停用 ${a.email}`, 'success', {
          ms: 5000, action: { label: '撤销', onClick: () => setActive(a, !on, { ask: false }) },
        });
        return true;
      } catch (e) { toastError(e); return false; }
    }

    async function remove(a) {
      const ok = await confirmDialog(`永久删除“${a.label || a.email}”？`, {
        title: '删除地址', okLabel: '删除', danger: true, icon: 'trash-2',
        detail: `${a.email} 将被永久删除且无法恢复。`,
      });
      if (!ok) return false;
      try {
        await del(`/api/hme/${enc(a.id)}`);
        S.items = S.items.filter((x) => x.id !== a.id);
        render();
        toast('已删除地址', 'success');
        return true;
      } catch (e) { toastError(e); return false; }
    }

    function emailBox(text, extra) {
      const t = h('span', { class: 'hme-box-email selectable' }, text);
      const box = h('div', { class: 'hme-box' }, icon('at-sign', { cls: 'hme-box-ic' }), t, h('div', { class: 'hme-box-tools' }, extra));
      box.set = (s, busy = false) => { t.textContent = s; box.classList.toggle('busy', busy); };
      return box;
    }

    function details(a) {
      const label = h('input', { class: 'input', value: a.label || '', maxLength: 80, placeholder: '例如：购物网站' });
      const note = h('textarea', { class: 'textarea', rows: 3, maxLength: 400, placeholder: '可选' });
      note.value = a.note || '';
      const o = origin(a);
      const inactive = a.active === false;
      const facts = [
        ['转发至', a.forward_to || '—'],
        ['状态', inactive ? '已停用' : '有效'],
        ['创建时间', a.created ? fmt.datetime(a.created) : '—'],
        o ? ['来源', o.text] : null,
        a.domain ? ['网站', a.domain] : null,
      ].filter(Boolean);
      const m = modal({
        title: a.label || '隐藏邮件地址',
        size: 'sm',
        cls: 'hme-modal',
        body: h('div', { class: 'form' },
          emailBox(a.email, iconBtn('copy', '复制地址', () => copyText(a.email, `已复制 ${a.email}`), { size: 'sm' })),
          h('dl', { class: 'hme-facts' }, facts.map(([k, v]) => [h('dt', {}, k), h('dd', { class: k === '状态' ? (inactive ? 'off' : 'on') : '' }, v)])),
          field('标签', label),
          field('备注', note)),
        actions: [
          inactive
            ? { label: '重新启用', left: true, kind: 'ghost', icon: 'rotate-ccw', onClick: async () => { await setActive(a, true); } }
            : { label: '停用', left: true, kind: 'danger-ghost', icon: 'ban', onClick: async () => { if (!(await setActive(a, false))) return false; } },
          inactive ? { label: '删除', left: true, kind: 'danger-ghost', icon: 'trash-2', onClick: async () => { if (!(await remove(a))) return false; } } : null,
          { label: '取消' },
          {
            label: '存储', primary: true,
            onClick: async () => {
              const l = label.value.trim(); const n = note.value.trim();
              if (!l) { label.focus(); toast('标签不能为空', 'error'); return false; }
              if (l === (a.label || '') && n === (a.note || '')) return true;
              await patch(`/api/hme/${enc(a.id)}`, { label: l, note: n });
              a.label = l; a.note = n;
              render();
              toast('已存储更改', 'success', 1600);
              return true;
            },
          },
        ].filter(Boolean),
      });
      return m;
    }

    function create() {
      if (document.querySelector('.hme-modal')) return;
      let email = '';
      let gen = 0;
      const label = h('input', { class: 'input', maxLength: 80, placeholder: '例如：购物网站', autofocus: true });
      const note = h('textarea', { class: 'textarea', rows: 2, maxLength: 400, placeholder: '可选，例如在哪里使用了这个地址' });
      const regen = btn('换一个地址', { kind: 'plain', size: 'sm', icon: 'refresh-cw', onclick: () => generate() });
      const copyB = iconBtn('copy', '复制', () => email && copyText(email, `已复制 ${email}`), { size: 'sm' });
      const box = emailBox('正在生成…', copyB);
      const fwd = forwardTo();
      let createBtn = null;

      async function generate() {
        const my = ++gen;
        email = '';
        box.set('正在生成…', true);
        regen.disabled = true; copyB.disabled = true;
        if (createBtn) createBtn.disabled = true;
        try {
          const r = await post('/api/hme/generate', {});
          if (my !== gen) return;
          email = r?.email || '';
          box.set(email || '生成失败', false);
        } catch (e) {
          if (my !== gen) return;
          box.set('生成失败，请重试', false);
          toastError(e);
        } finally {
          if (my === gen) { regen.disabled = false; copyB.disabled = !email; if (createBtn) createBtn.disabled = !email; }
        }
      }

      const m = modal({
        title: '创建新地址',
        subtitle: '一个唯一、随机的地址，邮件将转发给你',
        size: 'sm',
        cls: 'hme-modal',
        body: h('div', { class: 'form' },
          box,
          h('div', { class: 'hme-regen-row' }, regen,
            fwd ? h('span', { class: 'hint' }, `转发至 ${fwd}`) : null),
          field('标签', label, '帮助你记住在哪里使用了这个地址。'),
          field('备注', note)),
        actions: [
          { label: '取消' },
          {
            label: '创建', primary: true, icon: 'plus',
            onClick: async () => {
              const l = label.value.trim();
              if (!email) return false;
              if (!l) { label.focus(); toast('请为地址添加标签', 'error'); return false; }
              const made = await post('/api/hme', { email, label: l, note: note.value.trim() });
              S.flash = made?.id || null;
              await load();
              if (!S.flash) {
                const hit = S.items.find((x) => x.email === email);
                if (hit) { S.flash = hit.id; renderList(); }
              }
              const addr = email;
              toast(`已创建 ${addr}`, 'success', { ms: 5000, action: { label: '复制', onClick: () => copyText(addr, `已复制 ${addr}`) } });
              return true;
            },
          },
        ],
      });
      createBtn = m.footer.querySelector('.btn.primary');
      generate();
    }

    load();
    return () => { alive = false; };
  },
};
