// Hide My Email — list (active / inactive), create with generated address, edit, deactivate, delete.
import { get, post, patch, del, enc } from '../api.js';
import { tx } from '../i18n.js';
import {
  h, clear, icon, appIcon, iconBtn, btn, toolbar, searchBox, field, modal, confirmDialog, menu,
  toast, toastError, empty, errorBox, skeleton, fmt, copyText,
} from '../ui.js';

function origin(a) {
  const o = String(a.origin || '');
  const list = [
    [/^ON_DEMAND$/i, tx('手动创建', 'Created manually'), 'square-pen'],
    [/SIWA|SIGN_?IN/i, tx('通过 Apple 登录', 'Sign in with Apple'), 'log-in'],
    [/MAIL/i, tx('来自“邮件”', 'From Mail'), 'mail'],
    [/SAFARI|AUTOFILL|WEB/i, tx('来自 Safari', 'From Safari'), 'globe'],
  ];
  const m = list.find(([re]) => re.test(o));
  return m ? { text: m[1], icon: m[2] } : o ? { text: o, icon: 'tag' } : null;
}

const TINTS = ['blue', 'indigo', 'purple', 'pink', 'orange', 'teal', 'green'];
function tint(s) { let x = 7; for (const ch of String(s)) x = (x * 33) ^ ch.codePointAt(0); return TINTS[(x >>> 0) % TINTS.length]; }

export default {
  id: 'hme',
  get title() { return tx('隐藏邮件地址', 'Hide My Email'); },
  app: 'hme',
  mount(el) {
    const S = { items: [], q: '', flash: null };
    let alive = true;

    const subEl = h('span');
    const refreshBtn = iconBtn('refresh-cw', tx('刷新 (F5)', 'Refresh (F5)'), () => load());
    refreshBtn.dataset.refresh = '';
    const tb = toolbar({
      title: tx('隐藏邮件地址', 'Hide My Email'),
      subtitle: subEl,
      right: [
        refreshBtn,
        h('button', { class: 'btn primary sm', type: 'button', dataset: { new: '' }, title: tx('创建新地址 (Ctrl+N)', 'Create new address (Ctrl+N)'), onclick: () => create() },
          icon('plus'), h('span', { class: 'hide-narrow' }, tx('创建新地址', 'New Address'))),
      ],
    });
    const search = searchBox({ placeholder: tx('搜索标签、地址或备注', 'Search label, address, or note'), oninput: (v) => { S.q = v; renderList(); } });
    search.input.setAttribute('aria-label', tx('搜索隐藏邮件地址', 'Search Hide My Email'));
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
      const offCount = S.items.length - act;
      subEl.textContent = S.items.length
        ? tx(`${act} 个有效${offCount ? ` · ${offCount} 个已停用` : ''}`, `${act} active${offCount ? ` · ${offCount} inactive` : ''}`)
        : '';
      const fwd = forwardTo();
      clear(hero, h('section', { class: 'card hme-hero' },
        appIcon('hme', 52),
        h('div', { class: 'hme-hero-text' },
          h('h2', {}, tx('隐藏邮件地址', 'Hide My Email')),
          h('p', {}, tx(
            '创建唯一、随机的电子邮件地址，邮件会自动转发到你的个人邮箱。你可以在注册网站或填写表单时使用这些地址，而无需透露真实邮箱，并可随时停用。',
            'Create unique, random email addresses that forward to your personal inbox. Use them for websites and forms without sharing your real email, and deactivate them anytime.',
          )),
          fwd ? h('div', { class: 'hme-fwd' }, icon('mail-check', { size: 'sm' }), tx('转发至', 'Forwards to'), h('b', { class: 'selectable' }, fwd)) : null)));
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
          app: 'hme', title: tx('还没有隐藏邮件地址', 'No Hide My Email Addresses Yet'),
          text: tx('创建一个地址，在需要留下邮箱的地方使用它。', 'Create a unique address whenever you need to share an email.'),
          action: { label: tx('创建新地址', 'New Address'), icon: 'plus', onClick: () => create() },
        }));
        return;
      }
      const view = S.q ? S.items.filter((a) => matches(a, S.q)) : S.items;
      if (!view.length) { clear(listEl, empty({ icon: 'search', title: tx('无结果', 'No Results'), text: tx(`没有与“${S.q}”匹配的地址。`, `No addresses matching “${S.q}”.`), compact: true })); return; }
      const on = view.filter((a) => a.active !== false);
      const off = view.filter((a) => a.active === false);
      clear(listEl,
        on.length ? section(tx('有效', 'Active'), on, 'circle-check') : null,
        off.length ? section(tx('已停用', 'Inactive'), off, 'ban', tx('停用的地址不会再转发邮件。你可以重新启用它们，或将其永久删除。', 'Inactive addresses do not forward email. You can reactivate or permanently delete them.')) : null);
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
      const name = a.label || a.domain || tx('未命名', 'Untitled');
      return h('div', {
        class: `group-row hme-row clickable${inactive ? ' inactive' : ''}`, tabindex: '0', role: 'button', dataset: { id: a.id },
        'aria-label': `${name}, ${a.email}`,
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
        iconBtn('copy', tx('复制地址', 'Copy address'), () => copyText(a.email, tx(`已复制 ${a.email}`, `Copied ${a.email}`)), { size: 'sm' }),
        iconBtn('ellipsis', tx('更多操作', 'More actions'), (e) => rowMenu(e.currentTarget, a), { size: 'sm' })));
    }

    function rowMenu(at, a) {
      const inactive = a.active === false;
      menu(at, [
        { label: tx('复制地址', 'Copy Address'), icon: 'copy', onClick: () => copyText(a.email, tx(`已复制 ${a.email}`, `Copied ${a.email}`)) },
        { label: tx('编辑标签和备注…', 'Edit Label & Note…'), icon: 'pencil', onClick: () => details(a) },
        '-',
        inactive
          ? { label: tx('重新启用', 'Reactivate'), icon: 'rotate-ccw', onClick: () => setActive(a, true) }
          : { label: tx('停用地址…', 'Deactivate Address…'), icon: 'ban', danger: true, onClick: () => setActive(a, false) },
        inactive && { label: tx('删除地址…', 'Delete Address…'), icon: 'trash-2', danger: true, onClick: () => remove(a) },
      ], { align: 'end' });
    }

    // ----------------------------------------------------------- actions
    async function setActive(a, on, { ask = true } = {}) {
      if (!on && ask) {
        const ok = await confirmDialog(tx(`停用“${a.label || a.email}”？`, `Deactivate “${a.label || a.email}”?`), {
          title: tx('停用地址', 'Deactivate Address'), okLabel: tx('停用', 'Deactivate'), danger: true, icon: 'ban',
          detail: tx(
            `停用后，发送到 ${a.email} 的邮件将不再转发给你。你可以随时重新启用。`,
            `Emails sent to ${a.email} will no longer be forwarded to you. You can reactivate it anytime.`,
          ),
        });
        if (!ok) return false;
      }
      try {
        await post(`/api/hme/${enc(a.id)}/${on ? 'reactivate' : 'deactivate'}`, {});
        a.active = on;
        render();
        toast(on ? tx(`已重新启用 ${a.email}`, `Reactivated ${a.email}`) : tx(`已停用 ${a.email}`, `Deactivated ${a.email}`), 'success', {
          ms: 5000, action: { label: tx('撤销', 'Undo'), onClick: () => setActive(a, !on, { ask: false }) },
        });
        return true;
      } catch (e) { toastError(e); return false; }
    }

    async function remove(a) {
      const ok = await confirmDialog(tx(`永久删除“${a.label || a.email}”？`, `Permanently delete “${a.label || a.email}”?`), {
        title: tx('删除地址', 'Delete Address'), okLabel: tx('删除', 'Delete'), danger: true, icon: 'trash-2',
        detail: tx(`${a.email} 将被永久删除且无法恢复。`, `${a.email} will be permanently deleted and cannot be recovered.`),
      });
      if (!ok) return false;
      try {
        await del(`/api/hme/${enc(a.id)}`);
        S.items = S.items.filter((x) => x.id !== a.id);
        render();
        toast(tx('已删除地址', 'Address deleted'), 'success');
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
      const label = h('input', { class: 'input', value: a.label || '', maxLength: 80, placeholder: tx('例如：购物网站', 'e.g. Shopping site') });
      const note = h('textarea', { class: 'textarea', rows: 3, maxLength: 400, placeholder: tx('可选', 'Optional') });
      note.value = a.note || '';
      const o = origin(a);
      const inactive = a.active === false;
      const statusKey = tx('状态', 'Status');
      const facts = [
        [tx('转发至', 'Forwards to'), a.forward_to || '—'],
        [statusKey, inactive ? tx('已停用', 'Inactive') : tx('有效', 'Active')],
        [tx('创建时间', 'Created'), a.created ? fmt.datetime(a.created) : '—'],
        o ? [tx('来源', 'Origin'), o.text] : null,
        a.domain ? [tx('网站', 'Website'), a.domain] : null,
      ].filter(Boolean);
      const m = modal({
        title: a.label || tx('隐藏邮件地址', 'Hide My Email'),
        size: 'sm',
        cls: 'hme-modal',
        body: h('div', { class: 'form' },
          emailBox(a.email, iconBtn('copy', tx('复制地址', 'Copy address'), () => copyText(a.email, tx(`已复制 ${a.email}`, `Copied ${a.email}`)), { size: 'sm' })),
          h('dl', { class: 'hme-facts' }, facts.map(([k, v]) => [h('dt', {}, k), h('dd', { class: k === statusKey ? (inactive ? 'off' : 'on') : '' }, v)])),
          field(tx('标签', 'Label'), label),
          field(tx('备注', 'Note'), note)),
        actions: [
          inactive
            ? { label: tx('重新启用', 'Reactivate'), left: true, kind: 'ghost', icon: 'rotate-ccw', onClick: async () => { await setActive(a, true); } }
            : { label: tx('停用', 'Deactivate'), left: true, kind: 'danger-ghost', icon: 'ban', onClick: async () => { if (!(await setActive(a, false))) return false; } },
          inactive ? { label: tx('删除', 'Delete'), left: true, kind: 'danger-ghost', icon: 'trash-2', onClick: async () => { if (!(await remove(a))) return false; } } : null,
          { label: tx('取消', 'Cancel') },
          {
            label: tx('存储', 'Save'), primary: true,
            onClick: async () => {
              const l = label.value.trim(); const n = note.value.trim();
              if (!l) { label.focus(); toast(tx('标签不能为空', 'Label cannot be empty'), 'error'); return false; }
              if (l === (a.label || '') && n === (a.note || '')) return true;
              await patch(`/api/hme/${enc(a.id)}`, { label: l, note: n });
              a.label = l; a.note = n;
              render();
              toast(tx('已存储更改', 'Changes saved'), 'success', 1600);
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
      const label = h('input', { class: 'input', maxLength: 80, placeholder: tx('例如：购物网站', 'e.g. Shopping site'), autofocus: true });
      const note = h('textarea', { class: 'textarea', rows: 2, maxLength: 400, placeholder: tx('可选，例如在哪里使用了这个地址', 'Optional, e.g. where you use this address') });
      const regen = btn(tx('换一个地址', 'Use different address'), { kind: 'plain', size: 'sm', icon: 'refresh-cw', onclick: () => generate() });
      const copyB = iconBtn('copy', tx('复制', 'Copy'), () => email && copyText(email, tx(`已复制 ${email}`, `Copied ${email}`)), { size: 'sm' });
      const box = emailBox(tx('正在生成…', 'Generating…'), copyB);
      const fwd = forwardTo();
      let createBtn = null;

      async function generate() {
        const my = ++gen;
        email = '';
        box.set(tx('正在生成…', 'Generating…'), true);
        regen.disabled = true; copyB.disabled = true;
        if (createBtn) createBtn.disabled = true;
        try {
          const r = await post('/api/hme/generate', {});
          if (my !== gen) return;
          email = r?.email || '';
          box.set(email || tx('生成失败', 'Failed to generate'), false);
        } catch (e) {
          if (my !== gen) return;
          box.set(tx('生成失败，请重试', 'Generation failed, please retry'), false);
          toastError(e);
        } finally {
          if (my === gen) { regen.disabled = false; copyB.disabled = !email; if (createBtn) createBtn.disabled = !email; }
        }
      }

      const m = modal({
        title: tx('创建新地址', 'New Hide My Email Address'),
        subtitle: tx('一个唯一、随机的地址，邮件将转发给你', 'A unique, random address that forwards to your inbox'),
        size: 'sm',
        cls: 'hme-modal',
        body: h('div', { class: 'form' },
          box,
          h('div', { class: 'hme-regen-row' }, regen,
            fwd ? h('span', { class: 'hint' }, tx(`转发至 ${fwd}`, `Forwards to ${fwd}`)) : null),
          field(tx('标签', 'Label'), label, tx('帮助你记住在哪里使用了这个地址。', 'Helps you remember where this address is used.')),
          field(tx('备注', 'Note'), note)),
        actions: [
          { label: tx('取消', 'Cancel') },
          {
            label: tx('创建', 'Create'), primary: true, icon: 'plus',
            onClick: async () => {
              const l = label.value.trim();
              if (!email) return false;
              if (!l) { label.focus(); toast(tx('请为地址添加标签', 'Please enter a label'), 'error'); return false; }
              const made = await post('/api/hme', { email, label: l, note: note.value.trim() });
              S.flash = made?.id || null;
              await load();
              if (!S.flash) {
                const hit = S.items.find((x) => x.email === email);
                if (hit) { S.flash = hit.id; renderList(); }
              }
              const addr = email;
              toast(tx(`已创建 ${addr}`, `Created ${addr}`), 'success', { ms: 5000, action: { label: tx('复制', 'Copy'), onClick: () => copyText(addr, tx(`已复制 ${addr}`, `Copied ${addr}`)) } });
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
