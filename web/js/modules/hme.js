// Hide My Email: list, create, edit label/note, deactivate/reactivate, delete.
import { get, post, patch, del } from '../api.js';
import { h, clear, toast, toastError, modal, confirmDialog, field, spinner, empty, fmt, debounce } from '../ui.js';

export default {
  id: 'hme',
  title: '隐藏邮件地址',
  icon: '✉️',
  color: '#5ac8fa',
  mount(el) {
    let all = [];
    let q = '';
    let showInactive = false;
    const listBox = h('div', { class: 'hme-list' });
    const search = h('input', { class: 'input search', placeholder: '搜索地址、标签、备注', style: { maxWidth: '280px' } });
    search.addEventListener('input', debounce(() => { q = search.value.trim().toLowerCase(); render(); }, 120));
    const inactive = h('input', { type: 'checkbox' });
    inactive.addEventListener('change', () => { showInactive = inactive.checked; render(); });

    clear(el, h('div', { class: 'pane pane-main full' },
      h('div', { class: 'toolbar' }, h('h2', { class: 'toolbar-title' }, '隐藏邮件地址'), h('div', { class: 'spacer' }), search,
        h('label', { class: 'check small' }, inactive, ' 显示已停用'),
        h('button', { class: 'btn primary', onclick: create }, '＋ 新建地址')),
      h('div', { class: 'pane-scroll' }, listBox)));

    function render() {
      const rows = all.filter((a) => (showInactive || a.active) && (!q || `${a.email} ${a.label} ${a.note}`.toLowerCase().includes(q)));
      if (!rows.length) return clear(listBox, empty('没有地址', '✉️'));
      clear(listBox, rows.map((a) => h('div', { class: `card hme-row ${a.active ? '' : 'inactive'}` },
        h('div', { class: 'grow' },
          h('div', { class: 'hme-email' }, a.email, a.active ? null : h('span', { class: 'badge' }, '已停用')),
          h('div', {}, a.label || h('span', { class: 'muted' }, '(无标签)')),
          h('div', { class: 'muted small' }, [a.note, a.forward_to ? `转发到 ${a.forward_to}` : null, a.created ? `创建于 ${fmt.date(a.created)}` : null].filter(Boolean).join(' · '))),
        h('button', { class: 'icon-btn', title: '复制地址', onclick: () => { navigator.clipboard.writeText(a.email); toast('已复制'); } }, '⧉'),
        h('button', { class: 'btn small', onclick: () => edit(a) }, '编辑'),
        a.active
          ? h('button', { class: 'btn small', onclick: () => act(a, 'deactivate', '已停用') }, '停用')
          : h('button', { class: 'btn small', onclick: () => act(a, 'reactivate', '已重新激活') }, '激活'),
        !a.active ? h('button', { class: 'btn small danger', onclick: async () => {
          if (await confirmDialog(`永久删除 ${a.email}？`, { danger: true, okLabel: '删除' })) act(a, null, '已删除');
        } }, '删除') : null)));
    }

    async function act(a, action, msg) {
      try {
        if (action) await post(`/api/hme/${encodeURIComponent(a.id)}/${action}`);
        else await del(`/api/hme/${encodeURIComponent(a.id)}`);
        toast(msg, 'success'); load();
      } catch (e) { toastError(e); }
    }

    function edit(a) {
      const label = h('input', { class: 'input', value: a.label || '' });
      const note = h('textarea', { class: 'input', rows: 3 }, a.note || '');
      modal({ title: a.email, body: h('div', { class: 'form' }, field('标签', label), field('备注', note)), actions: [
        { label: '取消' },
        { label: '保存', primary: true, onClick: async () => { await patch(`/api/hme/${encodeURIComponent(a.id)}`, { label: label.value, note: note.value }); toast('已保存', 'success'); load(); } },
      ] });
    }

    async function create() {
      const email = h('div', { class: 'hme-email big' }, '生成中…');
      const label = h('input', { class: 'input', placeholder: '标签（例如网站名称）' });
      const note = h('textarea', { class: 'input', rows: 2, placeholder: '备注（可选）' });
      let value = null;
      const gen = async () => {
        email.textContent = '生成中…';
        try { value = (await post('/api/hme/generate')).email; email.textContent = value; } catch (e) { email.textContent = '生成失败'; toastError(e); }
      };
      modal({ title: '新建隐藏邮件地址', width: '440px', body: h('div', { class: 'form' },
        h('div', { class: 'row gap' }, email, h('button', { class: 'icon-btn', title: '换一个', onclick: gen }, '⟳')),
        field('标签', label), field('备注', note)), actions: [
        { label: '取消' },
        { label: '创建', primary: true, onClick: async () => {
          if (!value) return false;
          if (!label.value.trim()) { toast('请填写标签', 'error'); return false; }
          await post('/api/hme', { email: value, label: label.value.trim(), note: note.value });
          navigator.clipboard?.writeText(value).catch(() => {});
          toast('已创建并复制到剪贴板', 'success'); load();
        } },
      ] });
      gen();
    }

    async function load() {
      if (!all.length) clear(listBox, spinner());
      try {
        all = await get('/api/hme');
        all.sort((a, b) => (b.created || 0) - (a.created || 0));
        render();
      } catch (e) { clear(listBox, h('div', { class: 'error-box' }, e.message)); }
    }
    load();
  },
};
