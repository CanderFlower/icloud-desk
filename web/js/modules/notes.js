// Notes: folders → notes list → rendered note (read only; Apple has no write API).
import { get, enc } from '../api.js';
import { h, clear, spinner, empty, fmt, debounce, store, download } from '../ui.js';

const NOTE_CSS = `
  body{font:15px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#1d1d1f;margin:24px 32px;word-wrap:break-word}
  img{max-width:100%;height:auto;border-radius:6px} table{border-collapse:collapse} td,th{border:1px solid #ddd;padding:4px 8px}
  h1,h2,h3{line-height:1.3} pre,code{background:#f5f5f7;border-radius:4px;padding:2px 4px} a{color:#007aff}
  ul.checklist,ul[data-checklist]{list-style:none;padding-left:4px}
  @media (prefers-color-scheme: dark){body{color:#f5f5f7;background:#1e1e1e} pre,code{background:#2c2c2e}}`;

export default {
  id: 'notes',
  title: '备忘录',
  icon: '📝',
  color: '#ffcc00',
  mount(el) {
    const state = { folders: [], folder: store.get('notes.folder', ''), notes: [], q: '', current: null };
    const folderBox = h('div', { class: 'list' });
    const listBox = h('div', { class: 'list notes-list' });
    const viewer = h('div', { class: 'note-viewer' });
    const search = h('input', { class: 'input search', placeholder: '搜索当前列表' });
    search.addEventListener('input', debounce(() => { state.q = search.value.trim().toLowerCase(); renderNotes(); }, 150));

    clear(el, h('div', { class: 'split three' },
      h('div', { class: 'pane pane-side' }, h('div', { class: 'pane-header' }, h('h3', {}, '文件夹')), folderBox),
      h('div', { class: 'pane pane-list' }, h('div', { class: 'pane-header' }, search), listBox),
      h('div', { class: 'pane pane-main' }, viewer)));
    clear(viewer, empty('选择一条备忘录', '📝'));

    function renderFolders() {
      const children = new Map();
      for (const f of state.folders) {
        const p = f.parent_id && state.folders.some((x) => x.id === f.parent_id) ? f.parent_id : '';
        if (!children.has(p)) children.set(p, []);
        children.get(p).push(f);
      }
      const item = (id, name, count, depth) => h('div', {
        class: `list-item ${state.folder === id ? 'active' : ''}`, style: { paddingLeft: `${12 + depth * 16}px` },
        onclick: () => { state.folder = id; store.set('notes.folder', id); renderFolders(); loadNotes(); },
      }, h('span', {}, id ? '📁' : '🕘'), h('span', { class: 'grow' }, name), count != null ? h('span', { class: 'muted small' }, count) : null);
      const out = [item('', '最近', null, 0)];
      const walk = (pid, depth) => { for (const f of children.get(pid) || []) { out.push(item(f.id, f.name, f.count, depth)); walk(f.id, depth + 1); } };
      walk('', 0);
      clear(folderBox, out);
    }

    function renderNotes() {
      const list = state.notes.filter((n) => !state.q || `${n.title} ${n.snippet}`.toLowerCase().includes(state.q));
      if (!list.length) return clear(listBox, empty(state.q ? '无匹配结果' : '没有备忘录'));
      clear(listBox, list.map((n) => h('div', {
        class: `note-item ${state.current === n.id ? 'active' : ''}`,
        onclick: () => openNote(n),
      },
        h('div', { class: 'note-title' }, n.is_locked ? '🔒 ' : '', n.title || '(无标题)'),
        h('div', { class: 'note-meta' }, h('span', {}, fmt.smart(n.modified_at)), h('span', { class: 'muted' }, n.snippet || '')),
        !state.folder && n.folder_name ? h('div', { class: 'note-folder muted small' }, `📁 ${n.folder_name}`) : null)));
    }

    async function loadNotes() {
      clear(listBox, spinner());
      try {
        state.notes = await get('/api/notes', { folder_id: state.folder || undefined, limit: 300 });
        renderNotes();
      } catch (e) { clear(listBox, h('div', { class: 'error-box' }, e.message)); }
    }

    async function openNote(n) {
      state.current = n.id; renderNotes();
      clear(viewer, spinner());
      try {
        const note = await get(`/api/notes/item/${enc(n.id)}`);
        if (state.current !== n.id) return;
        const content = note.html || `<pre style="white-space:pre-wrap">${escapeHtml(note.text || '')}</pre>`;
        const frame = h('iframe', { class: 'note-frame', sandbox: 'allow-popups allow-popups-to-escape-sandbox' });
        frame.srcdoc = `<!doctype html><meta charset="utf-8"><base target="_blank"><style>${NOTE_CSS}</style>${content}`;
        clear(viewer,
          h('div', { class: 'note-head' },
            h('div', {}, h('h2', {}, note.title || '(无标题)'), h('div', { class: 'muted small' }, `${note.folder_name || ''} · ${fmt.datetime(note.modified_at)}`)),
            h('span', { class: 'badge' }, '只读')),
          note.attachments?.length ? h('div', { class: 'attachments' }, note.attachments.map((a) => h('button', {
            class: 'chip', title: a.uti || '', onclick: () => download(`/api/notes/attachment/${enc(note.id)}?att_id=${encodeURIComponent(a.id)}`),
          }, '📎 ', a.filename || a.id, a.size ? ` (${fmt.bytes(a.size)})` : ''))) : null,
          frame);
      } catch (e) {
        clear(viewer, h('div', { class: 'error-box' }, e.status === 423 ? '🔒 ' : '', e.message));
      }
    }

    (async () => {
      clear(folderBox, spinner());
      try { state.folders = await get('/api/notes/folders'); } catch (e) { clear(folderBox, h('div', { class: 'error-box' }, e.message)); }
      if (state.folder && !state.folders.some((f) => f.id === state.folder)) state.folder = '';
      renderFolders();
      loadNotes();
    })();
  },
};

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
