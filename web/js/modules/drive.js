// iCloud Drive: browse, upload (button / drag & drop), download, mkdir, rename, move, trash.
import { get, post, api } from '../api.js';
import { h, clear, toast, toastError, modal, confirmDialog, promptDialog, spinner, empty, fmt, store, download } from '../ui.js';

const ROOT = 'FOLDER::com.apple.CloudDocs::root';
const ICONS = {
  folder: '📁', app_library: '🗂️', pdf: '📕', doc: '📘', docx: '📘', pages: '📘', xls: '📗', xlsx: '📗', numbers: '📗', csv: '📗',
  ppt: '📙', pptx: '📙', key: '📙', zip: '🗜️', rar: '🗜️', '7z': '🗜️', jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', heic: '🖼️', webp: '🖼️',
  mp4: '🎞️', mov: '🎞️', mp3: '🎵', m4a: '🎵', wav: '🎵', txt: '📄', md: '📄', json: '📄',
};
const PREVIEWABLE = /^(pdf|png|jpe?g|gif|webp|svg|txt|md|json|csv|mp4|mov|mp3|m4a|wav|html?)$/i;
const isFolder = (it) => it.type === 'folder' || it.type === 'app_library';
const iconOf = (it) => ICONS[it.type] || ICONS[(it.extension || '').toLowerCase()] || '📄';

export default {
  id: 'drive',
  title: 'iCloud 云盘',
  icon: '☁️',
  color: '#007aff',
  mount(el) {
    const state = {
      section: 'drive', // drive | apps | trash
      path: [{ id: ROOT, name: 'iCloud 云盘' }],
      items: [],
      selected: new Set(),
      sort: store.get('drive.sort', 'name'),
    };
    const sideItems = {
      drive: h('div', { class: 'list-item', onclick: () => go('drive') }, '☁️ iCloud 云盘'),
      apps: h('div', { class: 'list-item', onclick: () => go('apps') }, '🗂️ App 文件夹'),
      trash: h('div', { class: 'list-item', onclick: () => go('trash') }, '🗑 最近删除'),
    };
    const crumbs = h('div', { class: 'crumbs' });
    const actions = h('div', { class: 'row gap' });
    const listEl = h('div', { class: 'file-list' });
    const fileInput = h('input', { type: 'file', multiple: true, style: { display: 'none' } });
    fileInput.addEventListener('change', () => { upload([...fileInput.files]); fileInput.value = ''; });
    const drop = h('div', { class: 'drop-hint' }, '松开以上传到当前文件夹');
    const mainPane = h('div', { class: 'pane pane-main drive-main' },
      h('div', { class: 'toolbar' }, crumbs, h('div', { class: 'spacer' }), actions),
      h('div', { class: 'pane-scroll' }, listEl), drop, fileInput);

    clear(el, h('div', { class: 'split' },
      h('div', { class: 'pane pane-side' }, h('div', { class: 'pane-header' }, h('h3', {}, '位置')), h('div', { class: 'list' }, Object.values(sideItems))),
      mainPane));

    // Drag & drop upload
    let dragDepth = 0;
    mainPane.addEventListener('dragenter', (e) => { if (canUpload() && e.dataTransfer.types.includes('Files')) { dragDepth++; mainPane.classList.add('dragging'); } });
    mainPane.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; mainPane.classList.remove('dragging'); } });
    mainPane.addEventListener('dragover', (e) => { if (canUpload()) e.preventDefault(); });
    mainPane.addEventListener('drop', (e) => {
      e.preventDefault(); dragDepth = 0; mainPane.classList.remove('dragging');
      if (canUpload() && e.dataTransfer.files.length) upload([...e.dataTransfer.files]);
    });

    function canUpload() { return state.section === 'drive' || (state.section === 'apps' && state.path.length > 1); }
    function cwd() { return state.path[state.path.length - 1]; }

    function go(section) {
      state.section = section;
      state.path = section === 'drive' ? [{ id: ROOT, name: 'iCloud 云盘' }] : [{ id: null, name: section === 'apps' ? 'App 文件夹' : '最近删除' }];
      refresh();
    }

    function renderChrome() {
      for (const [k, v] of Object.entries(sideItems)) v.classList.toggle('active', k === state.section);
      clear(crumbs, state.path.map((p, i) => [
        i ? h('span', { class: 'crumb-sep' }, '›') : null,
        h('button', { class: `crumb ${i === state.path.length - 1 ? 'current' : ''}`, onclick: () => { state.path = state.path.slice(0, i + 1); refresh(); } }, p.name),
      ]));
      const sel = [...state.selected];
      const btns = [];
      if (state.section === 'trash') {
        btns.push(h('button', { class: 'btn', disabled: !sel.length, onclick: () => bulk('recover', '已恢复') }, '恢复'));
        btns.push(h('button', { class: 'btn danger', disabled: !sel.length, onclick: async () => {
          if (await confirmDialog(`永久删除 ${sel.length} 项？此操作不可撤销。`, { danger: true, okLabel: '永久删除' })) bulk('delete-forever', '已永久删除');
        } }, '永久删除'));
      } else {
        if (sel.length) {
          btns.push(h('button', { class: 'btn', onclick: () => moveDialog(sel) }, `移动 (${sel.length})`));
          btns.push(h('button', { class: 'btn danger', onclick: async () => {
            if (await confirmDialog(`将 ${sel.length} 项移到“最近删除”？`, { okLabel: '删除', danger: true })) bulk('trash', '已移到最近删除');
          } }, '删除'));
        }
        if (canUpload()) {
          btns.push(h('button', { class: 'btn', onclick: mkdir }, '新建文件夹'));
          btns.push(h('button', { class: 'btn primary', onclick: () => fileInput.click() }, '上传'));
        }
      }
      btns.push(h('select', { class: 'input small-select', onchange: (e) => { state.sort = e.target.value; store.set('drive.sort', state.sort); renderList(); } },
        [['name', '按名称'], ['modified', '按修改时间'], ['size', '按大小']].map(([v, l]) => h('option', { value: v, selected: state.sort === v }, l))));
      btns.push(h('button', { class: 'icon-btn', title: '刷新', onclick: refresh }, '⟳'));
      clear(actions, btns);
    }

    function sorted() {
      const arr = [...state.items];
      const k = state.sort;
      arr.sort((a, b) => (isFolder(b) - isFolder(a)) || (k === 'name' ? a.name.localeCompare(b.name, 'zh') : k === 'size' ? (b.size || 0) - (a.size || 0) : String(b.modified || '').localeCompare(String(a.modified || ''))));
      return arr;
    }

    function renderList() {
      renderChrome();
      if (!state.items.length) return clear(listEl, empty(state.section === 'trash' ? '“最近删除”为空' : '此文件夹为空，可拖放文件到这里上传', state.section === 'trash' ? '🗑' : '📂'));
      const allCb = h('input', { type: 'checkbox', checked: state.selected.size && state.selected.size === state.items.length });
      allCb.addEventListener('change', () => { state.selected = new Set(allCb.checked ? state.items.map((i) => i.id) : []); renderList(); });
      const head = h('div', { class: 'file-row head' }, h('span', { class: 'c-check' }, allCb), h('span', { class: 'c-name' }, '名称'), h('span', { class: 'c-date' }, '修改时间'), h('span', { class: 'c-size' }, '大小'), h('span', { class: 'c-act' }));
      clear(listEl, head, sorted().map((it) => {
        const cb = h('input', { type: 'checkbox', checked: state.selected.has(it.id) });
        cb.addEventListener('change', () => { cb.checked ? state.selected.add(it.id) : state.selected.delete(it.id); renderChrome(); });
        const ext = (it.extension || '').toLowerCase();
        const acts = [];
        if (state.section !== 'trash' && it.type !== 'app_library') {
          if (!isFolder(it)) {
            acts.push(h('button', { class: 'icon-btn small', title: '下载', onclick: () => download(`/api/drive/download?id=${encodeURIComponent(it.id)}`) }, '⬇'));
            if (PREVIEWABLE.test(ext)) acts.push(h('a', { class: 'icon-btn small', title: '预览', target: '_blank', href: `/api/drive/download?inline=true&id=${encodeURIComponent(it.id)}` }, '👁'));
          }
          acts.push(h('button', { class: 'icon-btn small', title: '重命名', onclick: () => rename(it) }, '✎'));
        }
        return h('div', { class: `file-row ${state.selected.has(it.id) ? 'selected' : ''}`, ondblclick: () => open(it) },
          h('span', { class: 'c-check' }, cb),
          h('span', { class: 'c-name' }, h('span', { class: 'file-icon' }, iconOf(it)),
            h('span', { class: 'file-name', onclick: () => open(it) }, it.name), it.shared ? h('span', { class: 'badge' }, '共享') : null,
            state.section === 'trash' && it.restore_path ? h('span', { class: 'muted small' }, ` ← ${it.restore_path}`) : null),
          h('span', { class: 'c-date muted' }, it.modified ? fmt.datetime(it.modified) : '—'),
          h('span', { class: 'c-size muted' }, isFolder(it) ? (it.item_count != null ? `${it.item_count} 项` : '—') : fmt.bytes(it.size)),
          h('span', { class: 'c-act hover-show' }, acts));
      }));
    }

    function open(it) {
      if (state.section === 'trash') return;
      if (isFolder(it)) { state.path.push({ id: it.id, name: it.name }); refresh(); } else download(`/api/drive/download?id=${encodeURIComponent(it.id)}`);
    }

    async function refresh() {
      state.selected.clear();
      renderChrome();
      clear(listEl, spinner());
      try {
        if (state.section === 'trash') state.items = (await get('/api/drive/trash')).items;
        else if (state.section === 'apps' && state.path.length === 1) state.items = await get('/api/drive/apps');
        else state.items = (await get('/api/drive/list', { id: cwd().id })).items;
        renderList();
      } catch (e) { clear(listEl, h('div', { class: 'error-box' }, e.message)); }
    }

    async function bulk(action, msg) {
      try { await post(`/api/drive/${action}`, { ids: [...state.selected] }); toast(msg, 'success'); } catch (e) { toastError(e); }
      refresh();
    }

    async function mkdir() {
      const name = await promptDialog('新建文件夹', '未命名文件夹');
      if (!name) return;
      try { await post('/api/drive/mkdir', { id: cwd().id, name }); toast('已创建', 'success'); refresh(); } catch (e) { toastError(e); }
    }

    async function rename(it) {
      const name = await promptDialog('重命名', it.name);
      if (!name || name === it.name) return;
      try { await post('/api/drive/rename', { id: it.id, name }); toast('已重命名', 'success'); refresh(); } catch (e) { toastError(e); }
    }

    async function upload(files) {
      if (!files.length) return;
      const form = new FormData();
      form.append('folder', cwd().id);
      let total = 0;
      for (const f of files) { form.append('files', f, f.name); total += f.size; }
      toast(`正在上传 ${files.length} 个文件（${fmt.bytes(total)}）…`, 'info', 4000);
      try { await api('/api/drive/upload', { method: 'POST', form }); toast('上传完成', 'success'); } catch (e) { toastError(e); }
      setTimeout(refresh, 800);
    }

    function moveDialog(ids) {
      const nav = [{ id: ROOT, name: 'iCloud 云盘' }];
      const crumb = h('div', { class: 'crumbs small' });
      const box = h('div', { class: 'list picker' });
      const render = async () => {
        clear(crumb, nav.map((p, i) => [i ? ' › ' : '', h('button', { class: 'crumb', onclick: () => { nav.splice(i + 1); render(); } }, p.name)]));
        clear(box, spinner());
        try {
          const data = await get('/api/drive/list', { id: nav[nav.length - 1].id });
          const folders = data.items.filter((i) => i.type === 'folder' && !ids.includes(i.id));
          clear(box, folders.length ? folders.map((f) => h('div', { class: 'list-item', onclick: () => { nav.push({ id: f.id, name: f.name }); render(); } }, '📁 ', f.name)) : empty('没有子文件夹'));
        } catch (e) { clear(box, h('div', { class: 'error-box' }, e.message)); }
      };
      render();
      modal({ title: `移动 ${ids.length} 项到…`, body: h('div', {}, crumb, box), width: '440px', actions: [
        { label: '取消' },
        { label: '移动到此处', primary: true, onClick: async () => {
          await post('/api/drive/move', { ids, dest: nav[nav.length - 1].id }); toast('已移动', 'success'); refresh();
        } },
      ] });
    }

    refresh();
  },
};
