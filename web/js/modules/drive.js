// iCloud Drive — Finder-style browser.
// Icon / list views, breadcrumbs, multi-select (Ctrl / Shift / keyboard), drag & drop upload
// (onto the pane or a folder), drag-to-move, inline rename, quick look (Space), trash with undo,
// app libraries, upload progress panel.
import { get, post, upload as sendForm } from '../api.js';
import {
  h, clear, icon, btn, iconBtn, segmented, searchBox, toast, toastError, empty, errorBox, modal,
  confirmDialog, promptDialog, menu, fmt, toDate, store, download, copyText, pickFiles, isTyping, spinner,
} from '../ui.js';

const ROOT = 'FOLDER::com.apple.CloudDocs::root';
const DRAG_MIME = 'application/x-icd-drive';
const LOCS = {
  drive: { name: 'iCloud 云盘', icon: 'cloud' },
  apps: { name: 'App 文件夹', icon: 'layout-grid' },
  trash: { name: '最近删除', icon: 'trash-2' },
};

// ------------------------------------------------------------------ file types
const words = (s) => s.split(' ');
const GROUPS = {
  pdf: { color: '#e5483d', glyph: 'file-text', exts: { pdf: 'PDF 文稿' } },
  doc: { color: '#2f6fde', glyph: 'file-text', exts: { doc: 'Word 文稿', docx: 'Word 文稿', pages: 'Pages 文稿', rtf: 'RTF 文稿', odt: 'OpenDocument 文稿' } },
  sheet: { color: '#1e9b57', glyph: 'file-spreadsheet', exts: { xls: 'Excel 表格', xlsx: 'Excel 表格', numbers: 'Numbers 表格', csv: 'CSV 表格', tsv: 'TSV 表格', ods: 'OpenDocument 表格' } },
  slide: { color: '#ef7d1a', glyph: 'presentation', exts: { ppt: 'PowerPoint 演示文稿', pptx: 'PowerPoint 演示文稿', key: 'Keynote 演示文稿', odp: 'OpenDocument 演示文稿' } },
  image: { color: '#1ba6c9', glyph: 'file-image', exts: words('jpg jpeg png gif webp heic heif bmp svg tif tiff ico avif'), label: '图像' },
  video: { color: '#5e5ce6', glyph: 'file-video', exts: words('mp4 mov m4v avi mkv webm wmv flv'), label: '影片' },
  audio: { color: '#ff2d55', glyph: 'file-audio', exts: words('mp3 m4a wav aac flac ogg aiff wma'), label: '音频' },
  archive: { color: '#8a7456', glyph: 'file-archive', exts: words('zip rar 7z tar gz tgz bz2 xz dmg iso'), label: '归档' },
  code: { color: '#4b5563', glyph: 'file-code', exts: words('js mjs ts jsx tsx py java c cpp h hpp cs go rs rb php sh ps1 bat html htm css scss json xml yml yaml toml sql swift kt lua'), label: '源代码' },
  text: { color: '#8e8e93', glyph: 'file-text', exts: { txt: '纯文本', md: 'Markdown 文稿', log: '日志文件', ini: '配置文件' } },
};
const EXT = {};
for (const [g, def] of Object.entries(GROUPS)) {
  if (Array.isArray(def.exts)) for (const e of def.exts) EXT[e] = { g, label: `${e.toUpperCase()} ${def.label}` };
  else for (const [e, label] of Object.entries(def.exts)) EXT[e] = { g, label };
}

const isFolder = (it) => it.type === 'folder' || it.type === 'app_library';
function extOf(it) {
  if (isFolder(it)) return '';
  if (it.extension) return String(it.extension).toLowerCase();
  const i = it.name.lastIndexOf('.');
  return i > 0 ? it.name.slice(i + 1).toLowerCase() : '';
}
function kindOf(it) {
  if (it.type === 'app_library') return 'App 文件夹';
  if (isFolder(it)) return '文件夹';
  const e = extOf(it);
  return EXT[e]?.label || (e ? `${e.toUpperCase()} 文件` : '文稿');
}
function previewKind(it) {
  if (isFolder(it)) return null;
  const e = extOf(it); const g = EXT[e]?.g;
  if (g === 'image' && !/^(heic|heif|tiff?)$/.test(e)) return 'image';
  if (e === 'pdf') return 'pdf';
  if (g === 'video' && /^(mp4|m4v|mov|webm)$/.test(e)) return 'video';
  if (g === 'audio' && /^(mp3|m4a|wav|aac|flac|ogg)$/.test(e)) return 'audio';
  if ((g === 'text' || g === 'code' || e === 'csv' || e === 'tsv') && (it.size ?? 0) < 2_000_000) return 'text';
  return null;
}
const canThumb = (it) => previewKind(it) === 'image' && (it.size ?? 0) <= 12_000_000;
const fileUrl = (it, inline = false) => `/api/drive/download?${inline ? 'inline=true&' : ''}id=${encodeURIComponent(it.id)}`;

const FOLDER_SVG = '<svg viewBox="0 0 60 48" aria-hidden="true"><path class="fb" d="M2 7a4 4 0 0 1 4-4h14.6c1.1 0 2.1.4 2.8 1.2L27 8h27a4 4 0 0 1 4 4v30a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4z"/><rect class="ff" x="2" y="13" width="56" height="33" rx="4"/><rect class="fh" x="2" y="13" width="56" height="1.4" rx=".7"/></svg>';
const PAGE_SVG = '<svg viewBox="0 0 48 60" aria-hidden="true"><path class="pg" d="M6 .5h26.3c.8 0 1.5.3 2 .8l12.4 12.4c.5.5.8 1.2.8 2V54a5.5 5.5 0 0 1-5.5 5.5H6A5.5 5.5 0 0 1 .5 54V6A5.5 5.5 0 0 1 6 .5z"/><path class="pf" d="M33 1v10.5a4 4 0 0 0 4 4H47"/></svg>';

/** Finder-like icon: blue folder, or a page with a coloured type glyph + extension label. */
function fileIcon(it, { thumb = false } = {}) {
  if (isFolder(it)) {
    const el = h('span', { class: `dv-ic folder ${it.type === 'app_library' ? 'app' : ''}`, html: FOLDER_SVG });
    if (it.type === 'app_library') el.append(icon('layout-grid', { cls: 'dv-ic-glyph' }));
    else if (it.shared) el.append(icon('users', { cls: 'dv-ic-glyph' }));
    return el;
  }
  const e = extOf(it); const def = GROUPS[EXT[e]?.g];
  const el = h('span', { class: 'dv-ic file', style: { '--c': def?.color || '#8e8e93' }, html: PAGE_SVG });
  el.append(icon(def?.glyph || 'file', { cls: 'dv-ic-glyph' }));
  if (e) el.append(h('span', { class: 'dv-ic-ext' }, e.length > 4 ? e.slice(0, 4) : e));
  if (thumb && canThumb(it)) {
    const img = h('img', { class: 'dv-ic-img', loading: 'lazy', decoding: 'async', alt: '', draggable: false, src: fileUrl(it, true) });
    img.addEventListener('load', () => el.classList.add('has-img'));
    img.addEventListener('error', () => img.remove());
    el.append(img);
  }
  return el;
}

function fmtDate(v) {
  const d = toDate(v); if (!d) return '—';
  const now = new Date(); const y = new Date(now); y.setDate(now.getDate() - 1);
  if (fmt.sameDay(d, now)) return `今天 ${fmt.time(d)}`;
  if (fmt.sameDay(d, y)) return `昨天 ${fmt.time(d)}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${fmt.time(d)}`;
  return fmt.date(d);
}
const sizeText = (it) => (isFolder(it) ? (it.item_count != null ? `${it.item_count} 项` : '—') : fmt.bytes(it.size));
const tidy = (items) => {
  const out = [];
  for (const it of items.filter(Boolean)) {
    if (it === '-' && (!out.length || out[out.length - 1] === '-')) continue;
    out.push(it);
  }
  while (out[out.length - 1] === '-') out.pop();
  return out;
};

// ------------------------------------------------------------------ module
export default {
  id: 'drive',
  title: 'iCloud 云盘',
  app: 'drive',
  mount(el) {
    let sort = store.get('drive.sort', { key: 'name', dir: 1 });
    if (typeof sort !== 'object' || !sort?.key) sort = { key: 'name', dir: 1 };
    const S = {
      loc: LOCS[store.get('drive.loc')] ? store.get('drive.loc') : 'drive',
      path: store.get('drive.path', null),
      items: [],
      list: [],
      loading: true,
      error: null,
      sel: new Set(),
      anchor: null, // keyboard cursor / last clicked
      pivot: null, // shift-range origin
      view: store.get('drive.view', 'grid') === 'list' ? 'list' : 'grid',
      sort,
      query: '',
    };
    if (!Array.isArray(S.path) || !S.path.length) S.path = rootPath(S.loc);
    let alive = true;
    let seq = 0;
    let dragIds = null;
    let pendingSingle = null;

    function rootPath(loc) { return [{ id: loc === 'drive' ? ROOT : null, name: LOCS[loc].name }]; }
    const cwd = () => S.path[S.path.length - 1];
    const writable = () => S.loc === 'drive' || (S.loc === 'apps' && S.path.length > 1);
    const itemById = (id) => S.items.find((i) => i.id === id);
    const selItems = () => S.items.filter((i) => S.sel.has(i.id));
    const selIds = () => selItems().map((i) => i.id);

    // ---- layout
    const sideList = h('div', { class: 'side-list dv-locs' });
    const crumbs = h('div', { class: 'dv-crumbs' });
    const upBtn = iconBtn('chevron-left', '上一级 (Alt+↑)', () => goUp(), { cls: 'dv-up' });
    const locBtn = iconBtn('cloud', '位置', (e) => locMenu(e.currentTarget), { cls: 'when-side-hidden' });
    const search = searchBox({ placeholder: '搜索', oninput: (q) => { S.query = q.toLowerCase(); S.sel.clear(); render(); } });
    search.classList.add('dv-search');
    const viewSeg = segmented([
      { value: 'grid', icon: 'layout-grid', tip: '图标视图' },
      { value: 'list', icon: 'list', tip: '列表视图' },
    ], S.view, (v) => setView(v), { cls: 'icons hide-narrow' });
    const dynTools = h('div', { class: 'dv-dyn' });
    const head = h('div', { class: 'toolbar dv-tb' },
      h('button', { class: 'icon-btn menu-toggle', type: 'button', 'aria-label': '菜单', onclick: () => window.dispatchEvent(new Event('toggle-drawer')) }, icon('panel-left')),
      upBtn, crumbs,
      h('div', { class: 'tools' }, locBtn, search, dynTools));
    const body = h('div', { class: 'pane-body dv-body', tabindex: 0 });
    const foot = h('div', { class: 'pane-foot dv-foot' });
    const dropText = h('div', { class: 'dv-drop-text' });
    const dropOv = h('div', { class: 'drop-overlay dv-drop', hidden: true }, icon('cloud-upload', { size: 'xl' }), dropText);
    const uploads = h('div', { class: 'dv-uploads' });
    const main = h('div', { class: 'pane fill dv-main' }, head, body, foot, dropOv, uploads);
    el.append(h('div', { class: 'panes collapse-side dv' },
      h('div', { class: 'pane side dv-side' }, h('div', { class: 'pane-body' }, sideList)),
      main));

    // ---- side
    function renderSide() {
      clear(sideList, h('div', { class: 'side-title' }, '位置'), Object.entries(LOCS).map(([k, v]) => {
        const it = h('div', {
          class: `side-item ${S.loc === k ? 'active' : ''}`, tabindex: 0, role: 'button', dataset: { loc: k },
          onclick: () => goLoc(k), onkeydown: (e) => { if (e.key === 'Enter') goLoc(k); },
        }, icon(v.icon, { cls: 'ic' }), h('span', { class: 'label' }, v.name));
        if (k === 'drive') dropTarget(it, () => ({ id: ROOT, name: v.name }));
        if (k === 'trash') dropTarget(it, () => 'trash');
        return it;
      }));
      clear(locBtn, icon(LOCS[S.loc].icon));
    }

    function locMenu(at) {
      menu(at, Object.entries(LOCS).map(([k, v]) => ({ label: v.name, icon: v.icon, checked: S.loc === k, onClick: () => goLoc(k) })));
    }

    /** Internal drag target (sidebar entries, breadcrumbs). dest() → {id,name} | 'trash' | null */
    function dropTarget(node, dest) {
      node.addEventListener('dragover', (e) => {
        if (!dragIds || !dest() || S.loc === 'trash') return;
        e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move';
        node.classList.add('drop-target');
      });
      node.addEventListener('dragleave', () => node.classList.remove('drop-target'));
      node.addEventListener('drop', (e) => {
        node.classList.remove('drop-target');
        if (!dragIds) return;
        e.preventDefault(); e.stopPropagation();
        const ids = dragIds; const d = dest(); dragIds = null;
        if (d === 'trash') trashItems(ids); else if (d && d.id !== cwd().id) moveItems(ids, d);
      });
    }

    // ---- toolbar / crumbs / footer
    function renderCrumbs() {
      const p = S.path; const n = p.length;
      const sep = () => icon('chevron-right', { cls: 'dv-sep' });
      const crumb = (x, i) => {
        const last = i === n - 1;
        const b = h('button', { class: `dv-crumb ${last ? 'cur' : ''}`, type: 'button', title: x.name, onclick: () => { if (!last) goTo(i); } },
          i === 0 ? icon(LOCS[S.loc].icon, { cls: 'dv-crumb-ic' }) : null, h('span', {}, x.name));
        if (!last && x.id) dropTarget(b, () => x);
        return b;
      };
      const parts = [];
      if (n > 4) {
        parts.push(crumb(p[0], 0), sep(),
          h('button', { class: 'dv-crumb more', type: 'button', 'data-tip': '更多位置',
            onclick: (e) => menu(e.currentTarget, p.slice(1, n - 2).map((x, j) => ({ label: x.name, icon: 'folder', onClick: () => goTo(j + 1) }))) }, '…'),
          sep(), crumb(p[n - 2], n - 2), sep(), crumb(p[n - 1], n - 1));
      } else p.forEach((x, i) => { if (i) parts.push(sep()); parts.push(crumb(x, i)); });
      clear(crumbs, parts);
      upBtn.style.display = n > 1 ? '' : 'none';
    }

    function renderTools() {
      const n = S.sel.size; const files = selItems().filter((i) => !isFolder(i));
      const t = [];
      if (S.loc === 'trash') {
        t.push(iconBtn('archive-restore', n > 1 ? `恢复 ${n} 项` : '恢复', () => recover(selIds()), { disabled: !n }),
          iconBtn('trash-2', '永久删除', () => deleteForever(selIds()), { disabled: !n }));
      } else {
        if (writable()) {
          const nf = iconBtn('folder-plus', '新建文件夹 (Ctrl+N)', () => newFolder(), { cls: 'hide-narrow' });
          nf.dataset.new = '';
          t.push(nf, iconBtn('upload', '上传文件', () => pickUpload()), h('span', { class: 'dv-tsep hide-narrow' }));
        }
        t.push(iconBtn('download', files.length > 1 ? `下载 ${files.length} 个文件` : '下载', () => downloadSel(), { disabled: !files.length, cls: 'hide-narrow' }));
        if (writable()) t.push(iconBtn('trash-2', '删除 (Delete)', () => trashItems(selIds()), { disabled: !n }));
      }
      const rf = iconBtn('refresh-cw', '刷新 (F5)', () => load({ keepSel: true }), { cls: 'hide-narrow' });
      rf.dataset.refresh = '';
      t.push(h('span', { class: 'dv-tsep hide-narrow' }), viewSeg, rf, iconBtn('ellipsis', '更多', (e) => bgMenu(e.currentTarget)));
      clear(dynTools, t);
    }

    function renderFoot() {
      const total = S.list.length; const n = S.sel.size;
      if (S.loading && !S.items.length) { foot.textContent = ''; return; }
      if (n) {
        const size = selItems().reduce((a, i) => a + (isFolder(i) ? 0 : i.size || 0), 0);
        foot.textContent = `已选择 ${n} 项，共 ${total} 项${size ? `（${fmt.bytes(size)}）` : ''}`;
      } else foot.textContent = S.query ? `找到 ${total} 项` : `${total} 项`;
    }

    // ---- content
    function visible() {
      let arr = S.items;
      if (S.query) arr = arr.filter((i) => i.name.toLowerCase().includes(S.query));
      const { key, dir } = S.sort;
      const val = (i) => (key === 'size' ? (isFolder(i) ? i.item_count ?? -1 : i.size ?? -1)
        : key === 'modified' ? (toDate(i.modified)?.getTime() ?? 0) : key === 'kind' ? kindOf(i) : 0);
      const byName = (a, b) => a.name.localeCompare(b.name, 'zh', { numeric: true, sensitivity: 'base' });
      return [...arr].sort((a, b) => {
        const f = isFolder(b) - isFolder(a);
        if (f) return f;
        if (key === 'name') return byName(a, b) * dir;
        const x = val(a); const y = val(b);
        const c = typeof x === 'string' ? x.localeCompare(y, 'zh') : x - y;
        return c * dir || byName(a, b);
      });
    }

    function render() {
      renderSide(); renderCrumbs();
      S.list = S.error ? [] : visible();
      renderTools();
      body.classList.toggle('busy', S.loading && S.items.length > 0);
      body.dataset.view = S.view;
      if (S.loading && !S.items.length) { clear(body, h('div', { class: 'dv-center' }, spinner())); renderFoot(); return; }
      if (S.error) {
        clear(body, h('div', { class: 'dv-center' }, errorBox(S.error), btn('重试', { kind: 'tinted', icon: 'refresh-cw', onclick: () => load() })));
        renderFoot(); return;
      }
      const banner = S.loc === 'trash' && S.items.length
        ? h('div', { class: 'dv-banner' }, icon('info'), h('span', {}, '“最近删除”中的项目会在 30 天后永久删除。'),
          btn('清空', { kind: 'plain', size: 'sm', onclick: () => emptyTrash() }))
        : null;
      if (!S.list.length) { clear(body, banner, emptyState()); renderFoot(); return; }
      clear(body, banner, S.view === 'grid' ? gridView() : listView());
      renderFoot();
    }

    function emptyState() {
      if (S.query) return empty({ icon: 'search', title: '无结果', text: `当前文件夹中没有名称包含“${S.query}”的项目。` });
      if (S.loc === 'trash') return empty({ icon: 'trash-2', title: '“最近删除”为空', text: '删除的文件会在这里保留 30 天，之后被永久删除。' });
      if (S.loc === 'apps' && S.path.length === 1) return empty({ icon: 'layout-grid', title: '没有 App 文件夹', text: '使用 iCloud 存储文稿的 App 会显示在这里。' });
      return empty({
        app: 'drive', title: '此文件夹为空', text: '将文件拖放到这里，或点击“上传”。',
        action: writable() ? btn('上传文件', { kind: 'tinted', icon: 'upload', onclick: () => pickUpload() }) : null,
      });
    }

    const draggable = () => S.loc !== 'trash' && writable();
    const itemAttrs = (it, cls) => ({
      class: `dv-item ${cls} ${S.sel.has(it.id) ? 'sel' : ''}`, draggable: draggable(), title: it.name,
      dataset: isFolder(it) && S.loc !== 'trash' ? { id: it.id, folder: '' } : { id: it.id },
    });

    function gridView() {
      return h('div', { class: 'dv-grid' }, S.list.map((it) => h('div', itemAttrs(it, 'dv-tile'),
        h('div', { class: 'dv-tile-ic' }, fileIcon(it, { thumb: true })),
        h('div', { class: 'dv-name' }, h('span', {}, it.name)),
        h('div', { class: 'dv-meta' }, S.loc === 'trash' ? fmtDate(it.modified) : sizeText(it)))));
    }

    function listView() {
      const trash = S.loc === 'trash';
      const cols = trash
        ? [['name', '名称'], ['restore', '原位置'], ['size', '大小'], ['modified', '修改日期']]
        : [['name', '名称'], ['modified', '修改日期'], ['size', '大小'], ['kind', '种类']];
      const headRow = h('div', { class: `dv-lhead ${trash ? 'trash' : ''}` }, cols.map(([k, l]) => h('button', {
        class: `dv-c c-${k} ${S.sort.key === k ? 'on' : ''}`, type: 'button', disabled: k === 'restore',
        onclick: () => setSort(k),
      }, h('span', {}, l), S.sort.key === k ? icon(S.sort.dir > 0 ? 'chevron-up' : 'chevron-down', { cls: 'dv-sort-ic' }) : null)));
      const rows = S.list.map((it) => h('div', itemAttrs(it, `dv-row ${trash ? 'trash' : ''}`),
        h('div', { class: 'dv-c c-name' }, fileIcon(it, { thumb: true }),
          h('div', { class: 'dv-nm' }, h('div', { class: 'dv-name' }, h('span', {}, it.name)),
            h('div', { class: 'dv-sub' }, [fmtDate(it.modified), sizeText(it)].filter((x) => x && x !== '—').join(' · ')))),
        trash ? h('div', { class: 'dv-c c-restore' }, it.restore_path || '—') : h('div', { class: 'dv-c c-modified' }, fmtDate(it.modified)),
        h('div', { class: 'dv-c c-size' }, sizeText(it)),
        trash ? h('div', { class: 'dv-c c-modified' }, fmtDate(it.modified)) : h('div', { class: 'dv-c c-kind' }, kindOf(it))));
      return h('div', { class: 'dv-list' }, headRow, rows);
    }

    // ---- selection
    function paintSel() {
      for (const n of body.querySelectorAll('.dv-item')) n.classList.toggle('sel', S.sel.has(n.dataset.id));
      renderTools(); renderFoot();
    }
    function selectOnly(id) { S.sel = new Set(id ? [id] : []); S.anchor = S.pivot = id; paintSel(); }
    function selectRange(to, additive) {
      const ids = S.list.map((i) => i.id);
      const a = ids.indexOf(S.pivot ?? to); const b = ids.indexOf(to);
      if (!additive) S.sel.clear();
      if (a < 0 || b < 0) S.sel.add(to);
      else for (const i of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) S.sel.add(i);
      S.anchor = to;
      paintSel();
    }
    function scrollToItem(id) {
      body.querySelector(`.dv-item[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
    }
    function columns() {
      if (S.view !== 'grid') return 1;
      const tiles = body.querySelectorAll('.dv-tile');
      if (!tiles.length) return 1;
      const top = tiles[0].offsetTop; let n = 0;
      for (const t of tiles) { if (t.offsetTop !== top) break; n++; }
      return n || 1;
    }

    body.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('input, .dv-lhead, .dv-banner, .empty button')) return;
      const node = e.target.closest('.dv-item');
      body.focus({ preventScroll: true });
      pendingSingle = null;
      if (!node) { if (!e.ctrlKey && !e.shiftKey) selectOnly(null); return; }
      const id = node.dataset.id;
      if (e.shiftKey) selectRange(id, e.ctrlKey || e.metaKey);
      else if (e.ctrlKey || e.metaKey) {
        S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id);
        S.anchor = S.pivot = id; paintSel();
      } else if (S.sel.has(id)) pendingSingle = id; // keep multi-selection for dragging; collapse on click
      else selectOnly(id);
    });
    body.addEventListener('click', (e) => {
      const node = e.target.closest('.dv-item');
      if (node && pendingSingle === node.dataset.id) selectOnly(node.dataset.id);
      pendingSingle = null;
    });
    body.addEventListener('dblclick', (e) => {
      const node = e.target.closest('.dv-item');
      if (node && !e.target.closest('input')) open(itemById(node.dataset.id));
    });
    body.addEventListener('contextmenu', (e) => {
      if (e.target.closest('input')) return;
      const node = e.target.closest('.dv-item');
      if (node) { if (!S.sel.has(node.dataset.id)) selectOnly(node.dataset.id); itemMenu(e); } else bgMenu(e);
    });

    // ---- drag & drop
    let dropEl = null;
    const setDropEl = (n) => { if (dropEl !== n) { dropEl?.classList.remove('drop-into'); dropEl = n; n?.classList.add('drop-into'); } };
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    const showDrop = (name) => { dropText.textContent = `松开以上传到“${name}”`; dropOv.hidden = false; };
    const hideDrop = () => { dropOv.hidden = true; };

    body.addEventListener('dragstart', (e) => {
      const node = e.target.closest?.('.dv-item');
      if (!node || !draggable()) { e.preventDefault(); return; }
      pendingSingle = null;
      if (!S.sel.has(node.dataset.id)) selectOnly(node.dataset.id);
      dragIds = selIds();
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(DRAG_MIME, JSON.stringify(dragIds));
      e.dataTransfer.setData('text/plain', selItems().map((i) => i.name).join('\n'));
      if (dragIds.length > 1) {
        const ghost = h('div', { class: 'dv-ghost' }, icon('layers'), `${dragIds.length} 项`);
        document.body.append(ghost);
        e.dataTransfer.setDragImage(ghost, 18, 18);
        setTimeout(() => ghost.remove());
      }
    });
    body.addEventListener('dragend', () => {
      dragIds = null; setDropEl(null);
      for (const n of el.querySelectorAll('.drop-target')) n.classList.remove('drop-target');
    });
    main.addEventListener('dragover', (e) => {
      const tile = e.target.closest?.('.dv-item[data-folder]');
      if (dragIds) {
        const ok = tile && !dragIds.includes(tile.dataset.id);
        setDropEl(ok ? tile : null);
        if (ok) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
        return;
      }
      if (!hasFiles(e) || S.loc === 'trash') return;
      if (!tile && !writable()) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
      setDropEl(tile);
      if (tile) hideDrop(); else showDrop(cwd().name);
    });
    main.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget || !main.contains(e.relatedTarget)) { setDropEl(null); hideDrop(); }
    });
    main.addEventListener('drop', (e) => {
      const tile = dropEl; setDropEl(null); hideDrop();
      if (dragIds) {
        e.preventDefault();
        const ids = dragIds; dragIds = null;
        if (tile) { const it = itemById(tile.dataset.id); moveItems(ids, { id: it.id, name: it.name }); }
        return;
      }
      if (!hasFiles(e)) return;
      e.preventDefault();
      const entries = [...(e.dataTransfer.items || [])].map((i) => i.webkitGetAsEntry?.());
      const dirs = entries.filter((x) => x?.isDirectory).length;
      const files = [...e.dataTransfer.files].filter((f, i) => !entries[i]?.isDirectory);
      if (dirs) toast(`暂不支持上传文件夹，已跳过 ${dirs} 个文件夹`, 'info');
      const it = tile && itemById(tile.dataset.id);
      if (it) startUpload(files, { id: it.id, name: it.name });
      else if (writable()) startUpload(files, cwd());
    });

    // ---- navigation
    function goLoc(loc) {
      S.loc = loc; S.path = rootPath(loc); S.query = ''; search.input.value = '';
      load();
    }
    function goTo(i) { S.path = S.path.slice(0, i + 1); load(); }
    function goUp() {
      if (S.path.length < 2) return;
      const from = cwd().id;
      S.path = S.path.slice(0, -1);
      load({ select: from });
    }
    function enter(it) {
      S.path = [...S.path, { id: it.id, name: it.name }]; S.query = ''; search.input.value = '';
      load();
    }
    function open(it) {
      if (!it) return;
      if (S.loc === 'trash') return info(it);
      if (isFolder(it)) return enter(it);
      if (previewKind(it)) return quickLook(it);
      downloadItem(it);
    }

    async function load({ keepSel = false, select = null, names = null } = {}) {
      const my = ++seq;
      store.set('drive.loc', S.loc); store.set('drive.path', S.path);
      if (!keepSel) { S.sel = new Set(); S.anchor = S.pivot = null; }
      S.error = null; S.loading = true;
      const slow = setTimeout(() => { if (my === seq && S.loading && !keepSel) { S.items = []; render(); } }, 220);
      render();
      try {
        let items;
        if (S.loc === 'trash') items = (await get('/api/drive/trash')).items;
        else if (S.loc === 'apps' && S.path.length === 1) items = await get('/api/drive/apps');
        else items = (await get('/api/drive/list', { id: cwd().id })).items;
        if (my !== seq || !alive) return;
        S.items = items || [];
      } catch (e) {
        if (my !== seq || !alive) return;
        if (e.status === 404 && S.path.length > 1) { clearTimeout(slow); goLoc(S.loc); return; }
        S.error = e; S.items = [];
      } finally {
        clearTimeout(slow);
        if (my === seq) S.loading = false;
      }
      if (select) S.sel = new Set([select]);
      else if (names) S.sel = new Set(S.items.filter((i) => names.includes(i.name)).map((i) => i.id));
      else { const ids = new Set(S.items.map((i) => i.id)); S.sel = new Set([...S.sel].filter((i) => ids.has(i))); }
      const first = select || [...S.sel][0] || null;
      if (select || names) S.anchor = S.pivot = first;
      render();
      if (first) scrollToItem(first);
    }

    // ---- actions
    function setView(v) {
      S.view = v; store.set('drive.view', v); viewSeg.set(v);
      render();
      if (S.anchor) scrollToItem(S.anchor);
    }
    function setSort(key, dir) {
      if (dir) S.sort = { key, dir };
      else if (S.sort.key === key) S.sort = { key, dir: -S.sort.dir };
      else S.sort = { key, dir: key === 'modified' || key === 'size' ? -1 : 1 };
      store.set('drive.sort', S.sort);
      render();
    }

    function downloadItem(it) { download(fileUrl(it)); }
    function downloadSel() {
      const files = selItems().filter((i) => !isFolder(i));
      files.forEach((f, i) => setTimeout(() => downloadItem(f), i * 400));
      if (files.length > 1) toast(`正在下载 ${files.length} 个文件`, 'info');
    }
    function pickUpload() {
      if (!writable()) return;
      const dest = cwd();
      pickFiles().then((files) => startUpload(files, dest));
    }

    function startUpload(files, dest) {
      if (!files?.length) return;
      const total = files.reduce((a, f) => a + f.size, 0);
      const fill = h('div', { style: { width: '0%' } });
      const ic = h('span', { class: 'dv-up-ic' }, icon('cloud-upload'));
      const status = h('div', { class: 'dv-up-status' }, `等待上传 · ${fmt.bytes(total)}`);
      const mainCol = h('div', { class: 'dv-up-main' },
        h('div', { class: 'dv-up-name' }, files.length === 1 ? files[0].name : `${files.length} 个文件`),
        status, h('div', { class: 'progress' }, fill));
      const row = h('div', { class: 'dv-up' }, ic, mainCol, iconBtn('x', '隐藏', () => row.remove(), { size: 'sm', cls: 'dv-up-x' }));
      uploads.append(row);
      const form = new FormData();
      form.append('folder', dest.id);
      for (const f of files) form.append('files', f, f.name);
      sendForm('/api/drive/upload', form, {
        onProgress: (p) => {
          fill.style.width = `${Math.round(p * 100)}%`;
          if (p < 1) status.textContent = `正在上传到“${dest.name}”… ${Math.round(p * 100)}%`;
          else { status.textContent = '正在存入 iCloud…'; row.classList.add('processing'); }
        },
      }).then(() => {
        row.classList.remove('processing'); row.classList.add('done');
        clear(ic, icon('circle-check')); fill.style.width = '100%';
        status.textContent = `已上传到“${dest.name}”`;
        setTimeout(() => row.remove(), 4000);
        if (!alive) return;
        if (cwd().id === dest.id) load({ keepSel: true, names: files.map((f) => f.name) });
        else if (S.items.some((i) => i.id === dest.id)) load({ keepSel: true });
      }).catch((e) => {
        row.classList.remove('processing'); row.classList.add('error');
        clear(ic, icon('circle-alert'));
        status.textContent = e.message || '上传失败';
        mainCol.append(h('button', { class: 'dv-up-retry', type: 'button', onclick: () => { row.remove(); startUpload(files, dest); } }, '重试'));
      });
    }

    async function newFolder() {
      if (!writable()) return;
      const names = new Set(S.items.map((i) => i.name));
      let name = '未命名文件夹'; let k = 2;
      while (names.has(name)) name = `未命名文件夹 ${k++}`;
      const at = cwd().id;
      try { await post('/api/drive/mkdir', { id: at, name }); } catch (e) { toastError(e); return; }
      if (!alive || cwd().id !== at) return;
      S.query = ''; search.input.value = '';
      await load({ keepSel: true });
      const it = S.items.find((i) => i.name === name && isFolder(i));
      if (it) { selectOnly(it.id); scrollToItem(it.id); rename(it); }
    }

    function rename(it) {
      if (!it || !writable()) return;
      const node = body.querySelector(`.dv-item[data-id="${CSS.escape(it.id)}"] .dv-name`);
      if (!node) return;
      const input = h('input', { class: 'dv-rename', value: it.name, spellcheck: false, 'aria-label': '名称' });
      let done = false;
      const finish = async (commit) => {
        if (done) return;
        done = true;
        const v = input.value.trim();
        if (!commit || !v || v === it.name) { render(); return; }
        if (/[/:]/.test(v)) { toast('名称不能包含“/”或“:”', 'error'); render(); return; }
        if (S.items.some((i) => i !== it && i.name === v)) { toast(`名称“${v}”已被使用，请换一个名称。`, 'error'); render(); return; }
        const old = it.name;
        it.name = v; render(); scrollToItem(it.id);
        try { await post('/api/drive/rename', { id: it.id, name: v }); load({ keepSel: true }); } catch (e) { it.name = old; render(); toastError(e); }
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); finish(true); body.focus({ preventScroll: true }); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); body.focus({ preventScroll: true }); }
      });
      input.addEventListener('blur', () => finish(true));
      for (const ev of ['mousedown', 'click', 'dblclick']) input.addEventListener(ev, (e) => e.stopPropagation());
      node.replaceWith(input);
      input.closest('.dv-item').draggable = false;
      input.focus();
      const dot = isFolder(it) ? -1 : it.name.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : it.name.length);
    }

    async function trashItems(ids) {
      ids = ids.filter((i) => itemById(i));
      if (!ids.length || !writable()) return;
      const first = itemById(ids[0])?.name;
      const before = S.items;
      S.items = S.items.filter((i) => !ids.includes(i.id)); S.sel = new Set(); render();
      try { await post('/api/drive/trash', { ids }); } catch (e) { S.items = before; render(); toastError(e); return; }
      toast(ids.length === 1 ? `已将“${first}”移到“最近删除”` : `已将 ${ids.length} 项移到“最近删除”`, 'success',
        { ms: 6000, action: { label: '撤销', onClick: () => undoTrash(ids) } });
      load({ keepSel: true });
    }
    async function undoTrash(ids) {
      try {
        await get('/api/drive/trash'); // refresh etags of the trashed nodes
        await post('/api/drive/recover', { ids });
        toast('已撤销删除', 'success');
      } catch (e) { toastError(e); }
      if (alive) load({ keepSel: true });
    }
    async function recover(ids) {
      if (!ids.length) return;
      try { await post('/api/drive/recover', { ids }); toast(ids.length === 1 ? '已恢复' : `已恢复 ${ids.length} 项`, 'success'); } catch (e) { toastError(e); }
      load();
    }
    async function deleteForever(ids) {
      if (!ids.length) return;
      const name = ids.length === 1 ? `“${itemById(ids[0])?.name}”` : `这 ${ids.length} 项`;
      const ok = await confirmDialog(`永久删除${name}？`, { title: '永久删除', okLabel: '永久删除', danger: true, icon: 'trash-2', detail: '此操作无法撤销。' });
      if (!ok) return;
      try { await post('/api/drive/delete-forever', { ids }); toast('已永久删除', 'success'); } catch (e) { toastError(e); }
      load();
    }
    async function emptyTrash() {
      const ids = S.items.map((i) => i.id);
      if (!ids.length) return;
      const ok = await confirmDialog(`永久删除“最近删除”中的全部 ${ids.length} 项？`, { title: '清空“最近删除”', okLabel: '清空', danger: true, icon: 'trash-2', detail: '此操作无法撤销。' });
      if (!ok) return;
      try { await post('/api/drive/delete-forever', { ids }); toast('已清空“最近删除”', 'success'); } catch (e) { toastError(e); }
      load();
    }

    async function moveItems(ids, dest) {
      ids = ids.filter((i) => i !== dest.id && itemById(i));
      if (!ids.length || dest.id === cwd().id) return;
      const before = S.items;
      S.items = S.items.filter((i) => !ids.includes(i.id)); S.sel = new Set(); render();
      try {
        await post('/api/drive/move', { ids, dest: dest.id });
        toast(ids.length === 1 ? `已移到“${dest.name}”` : `已将 ${ids.length} 项移到“${dest.name}”`, 'success');
      } catch (e) { S.items = before; render(); toastError(e); }
      if (alive) load({ keepSel: true });
    }

    function moveDialog(ids) {
      if (!ids.length) return;
      const nav = [{ id: ROOT, name: LOCS.drive.name }];
      const crumbEl = h('div', { class: 'dv-pick-crumbs' });
      const box = h('div', { class: 'dv-pick-list' });
      let m = null;
      const draw = async () => {
        const here = nav[nav.length - 1];
        clear(crumbEl, nav.map((p, i) => [i ? icon('chevron-right', { cls: 'dv-sep' }) : null,
          h('button', { class: `dv-crumb ${i === nav.length - 1 ? 'cur' : ''}`, type: 'button', onclick: () => { nav.splice(i + 1); draw(); } },
            i === 0 ? icon('cloud', { cls: 'dv-crumb-ic' }) : null, h('span', {}, p.name))]));
        clear(box, h('div', { class: 'dv-center sm' }, spinner()));
        const ok = m?.footer.querySelector('.btn.primary');
        if (ok) ok.disabled = here.id === cwd().id;
        try {
          const data = await get('/api/drive/list', { id: here.id });
          if (nav[nav.length - 1] !== here) return;
          const fs = data.items.filter((i) => i.type === 'folder' && !ids.includes(i.id))
            .sort((a, b) => a.name.localeCompare(b.name, 'zh', { numeric: true }));
          clear(box, fs.length
            ? fs.map((f) => h('button', { class: 'dv-pick-row', type: 'button', onclick: () => { nav.push({ id: f.id, name: f.name }); draw(); } },
              fileIcon(f), h('span', { class: 'dv-pick-name' }, f.name), icon('chevron-right', { cls: 'dv-pick-go' })))
            : h('div', { class: 'dv-pick-empty' }, '没有子文件夹'));
        } catch (e) { clear(box, errorBox(e)); }
      };
      const one = ids.length === 1 ? itemById(ids[0]) : null;
      m = modal({
        title: one ? `移动“${one.name}”` : `移动 ${ids.length} 项`, subtitle: '选择目标文件夹', width: '480px',
        body: h('div', { class: 'dv-pick' }, crumbEl, box),
        actions: [
          { label: '新建文件夹', left: true, kind: 'ghost', icon: 'folder-plus', onClick: async () => {
            const name = await promptDialog('新建文件夹', '未命名文件夹', { okLabel: '创建' });
            if (name) { await post('/api/drive/mkdir', { id: nav[nav.length - 1].id, name }); draw(); }
            return false;
          } },
          { label: '取消' },
          { label: '移到这里', primary: true, onClick: () => moveItems(ids, nav[nav.length - 1]) },
        ],
      });
      draw();
    }

    function info(it) {
      const where = S.loc === 'trash' ? (it.restore_path || '—') : S.path.map((p) => p.name).join(' › ');
      const rows = [
        ['种类', kindOf(it)],
        ['大小', isFolder(it) ? sizeText(it) : `${fmt.bytes(it.size)}${it.size >= 1024 ? `（${Number(it.size).toLocaleString()} 字节）` : ''}`],
        [S.loc === 'trash' ? '原位置' : '位置', where],
        ['创建时间', it.created ? fmt.datetime(it.created) : '—'],
        ['修改时间', it.modified ? fmt.datetime(it.modified) : '—'],
        it.shared ? ['共享', '已与他人共享'] : null,
      ].filter(Boolean);
      modal({
        title: '简介', width: '420px',
        body: h('div', { class: 'dv-info' },
          h('div', { class: 'dv-info-top' }, fileIcon(it, { thumb: true }), h('div', { class: 'dv-info-name' }, it.name)),
          h('dl', { class: 'dv-info-list' }, rows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]))),
        actions: [{ label: '完成', primary: true }],
      });
    }

    function quickLook(start) {
      const files = S.list.filter((i) => !isFolder(i));
      let idx = Math.max(0, files.findIndex((i) => i.id === start.id));
      const stage = h('div', { class: 'dv-ql-stage' });
      const title = h('div', { class: 'dv-ql-title' });
      const sub = h('div', { class: 'dv-ql-sub' });
      const prev = iconBtn('chevron-left', '上一个 (←)', () => step(-1));
      const next = iconBtn('chevron-right', '下一个 (→)', () => step(1));
      const onKey = (e) => {
        if (document.querySelectorAll('.overlay').length > 1) return;
        if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
        else if (e.key === ' ' && !e.target.closest?.('video, audio')) { e.preventDefault(); m.close(); }
      };
      const m = modal({
        cls: 'dv-ql-modal', closeButton: false,
        onClose: () => document.removeEventListener('keydown', onKey, true),
        body: h('div', { class: 'dv-ql' },
          h('div', { class: 'dv-ql-bar' }, h('div', { class: 'dv-ql-head' }, title, sub), prev, next,
            iconBtn('download', '下载', () => downloadItem(files[idx])),
            iconBtn('info', '简介', () => info(files[idx])),
            iconBtn('x', '关闭 (Esc)', () => m.close())),
          stage),
      });
      document.addEventListener('keydown', onKey, true);
      function step(d) {
        const j = idx + d;
        if (j < 0 || j >= files.length) return;
        idx = j; show();
        if (alive) { selectOnly(files[idx].id); scrollToItem(files[idx].id); }
      }
      async function show() {
        const it = files[idx];
        title.textContent = it.name;
        sub.textContent = [kindOf(it), fmt.bytes(it.size), fmtDate(it.modified)].filter((x) => x && x !== '—').join(' · ');
        prev.disabled = idx === 0; next.disabled = idx === files.length - 1;
        const kind = previewKind(it); const u = fileUrl(it, true);
        if (kind === 'image') clear(stage, h('img', { class: 'dv-ql-img', src: u, alt: it.name }));
        else if (kind === 'pdf') clear(stage, h('iframe', { class: 'dv-ql-frame', src: u, title: it.name }));
        else if (kind === 'video') clear(stage, h('video', { class: 'dv-ql-media', src: u, controls: true, autoplay: true }));
        else if (kind === 'audio') clear(stage, h('div', { class: 'dv-ql-audio' }, fileIcon(it), h('audio', { src: u, controls: true, autoplay: true })));
        else if (kind === 'text') {
          clear(stage, h('div', { class: 'dv-center' }, spinner()));
          try {
            const r = await fetch(u, { credentials: 'same-origin' });
            if (!r.ok) throw new Error(`加载失败（${r.status}）`);
            const text = await r.text();
            if (files[idx] === it) clear(stage, h('pre', { class: 'dv-ql-text' }, text));
          } catch (e) { if (files[idx] === it) clear(stage, h('div', { class: 'dv-center' }, errorBox(e))); }
        } else {
          clear(stage, h('div', { class: 'dv-ql-none' }, fileIcon(it),
            h('div', { class: 'dv-ql-none-name' }, it.name),
            h('div', { class: 'dv-ql-none-sub' }, `${kindOf(it)} · ${fmt.bytes(it.size)} · 不支持预览`),
            btn('下载', { kind: 'primary', icon: 'download', onclick: () => downloadItem(it) })));
        }
      }
      show();
    }

    // ---- menus
    function itemMenu(e) {
      const items = selItems(); const one = items.length === 1 ? items[0] : null;
      const files = items.filter((i) => !isFolder(i));
      const n = items.length;
      if (S.loc === 'trash') {
        menu(e, tidy([
          { label: n > 1 ? `恢复 ${n} 项` : '恢复', icon: 'archive-restore', onClick: () => recover(selIds()) },
          one ? { label: '简介', icon: 'info', onClick: () => info(one) } : null,
          '-',
          { label: n > 1 ? `永久删除 ${n} 项…` : '永久删除…', icon: 'trash-2', danger: true, onClick: () => deleteForever(selIds()) },
        ]));
        return;
      }
      const w = writable();
      menu(e, tidy([
        one ? { label: '打开', icon: isFolder(one) ? 'folder-open' : 'external-link', shortcut: 'Enter', onClick: () => open(one) } : null,
        one && previewKind(one) ? { label: '快速查看', icon: 'eye', shortcut: '空格', onClick: () => quickLook(one) } : null,
        files.length ? { label: files.length > 1 ? `下载 ${files.length} 个文件` : '下载', icon: 'download', onClick: () => downloadSel() } : null,
        '-',
        one && w ? { label: '重命名', icon: 'pencil', shortcut: 'F2', onClick: () => rename(one) } : null,
        w ? { label: n > 1 ? `移动 ${n} 项到…` : '移动到…', icon: 'folder-input', onClick: () => moveDialog(selIds()) } : null,
        one ? { label: '简介', icon: 'info', onClick: () => info(one) } : null,
        one ? { label: '拷贝名称', icon: 'copy', onClick: () => copyText(one.name, '已拷贝名称') } : null,
        '-',
        w ? { label: n > 1 ? `删除 ${n} 项` : '删除', icon: 'trash-2', danger: true, shortcut: 'Delete', onClick: () => trashItems(selIds()) } : null,
      ]));
    }

    function bgMenu(at) {
      const sortItem = (k, l) => ({ label: l, checked: S.sort.key === k, onClick: () => setSort(k, S.sort.key === k ? S.sort.dir : (k === 'modified' || k === 'size' ? -1 : 1)) });
      menu(at, tidy([
        writable() ? { label: '新建文件夹', icon: 'folder-plus', shortcut: 'Ctrl+N', onClick: () => newFolder() } : null,
        writable() ? { label: '上传文件…', icon: 'upload', onClick: () => pickUpload() } : null,
        S.loc === 'trash' && S.items.length ? { label: '清空“最近删除”…', icon: 'trash-2', danger: true, onClick: () => emptyTrash() } : null,
        S.list.length ? { label: '全选', icon: 'check-check', shortcut: 'Ctrl+A', onClick: () => selectAll() } : null,
        '-', { section: '显示方式' },
        { label: '图标', checked: S.view === 'grid', onClick: () => setView('grid') },
        { label: '列表', checked: S.view === 'list', onClick: () => setView('list') },
        '-', { section: '排序方式' },
        sortItem('name', '名称'), sortItem('kind', '种类'), sortItem('modified', '修改日期'), sortItem('size', '大小'),
        '-',
        { label: '升序', checked: S.sort.dir > 0, onClick: () => setSort(S.sort.key, 1) },
        { label: '降序', checked: S.sort.dir < 0, onClick: () => setSort(S.sort.key, -1) },
        '-',
        { label: '刷新', icon: 'refresh-cw', shortcut: 'F5', onClick: () => load({ keepSel: true }) },
      ]));
    }

    function selectAll() {
      S.sel = new Set(S.list.map((i) => i.id));
      S.anchor = S.list[S.list.length - 1]?.id ?? null; S.pivot = S.list[0]?.id ?? null;
      paintSel();
    }

    // ---- keyboard
    const onKey = (e) => {
      if (!el.isConnected || document.querySelector('.overlay, .menu') || isTyping(e)) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const list = S.list;
      const cur = S.anchor ? list.findIndex((i) => i.id === S.anchor) : -1;
      const move = (d, abs) => {
        e.preventDefault();
        if (!list.length) return;
        const i = abs != null ? abs : cur < 0 ? (d > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, cur + d));
        const id = list[i].id;
        if (e.shiftKey) selectRange(id, false); else selectOnly(id);
        scrollToItem(id);
      };
      const one = () => (S.sel.size === 1 ? selItems()[0] : null);
      if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); goUp(); }
      else if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); open(one()); }
      else if (e.altKey) return;
      else if (e.key === 'ArrowDown') move(columns());
      else if (e.key === 'ArrowUp') move(-columns());
      else if (e.key === 'ArrowRight' && S.view === 'grid') move(1);
      else if (e.key === 'ArrowLeft' && S.view === 'grid') move(-1);
      else if (e.key === 'Home') move(0, 0);
      else if (e.key === 'End') move(0, list.length - 1);
      else if (e.key === 'Enter') { if (one()) { e.preventDefault(); open(one()); } }
      else if (e.key === 'Backspace') { e.preventDefault(); goUp(); }
      else if (e.key === 'Delete') { e.preventDefault(); if (S.loc === 'trash') deleteForever(selIds()); else trashItems(selIds()); }
      else if (e.key === 'F2') { e.preventDefault(); rename(one()); }
      else if (e.key === ' ') { const it = one() || selItems().find((i) => !isFolder(i)); if (it && !isFolder(it) && S.loc !== 'trash') { e.preventDefault(); quickLook(it); } }
      else if (e.key === 'Escape') { if (S.sel.size) { e.preventDefault(); selectOnly(null); } }
      else if (ctrl && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); }
      else if (ctrl && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newFolder(); }
      else if (ctrl && e.key.toLowerCase() === 'o') { e.preventDefault(); if (writable()) pickUpload(); }
    };
    document.addEventListener('keydown', onKey);

    load();
    return () => {
      alive = false;
      document.removeEventListener('keydown', onKey);
    };
  },
};
