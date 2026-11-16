// Photos — library + albums, justified day-grouped grid, viewer, multi-select, upload.
import { get, post, del, upload } from '../api.js';
import { countText, lang, tx } from '../i18n.js';
import {
  h, clear, icon, appIcon, iconBtn, btn, toolbar, segmented, menu, toast, toastError, confirmDialog,
  empty, errorBox, fmt, toDate, store, download, pickFiles, isTyping, copyText,
} from '../ui.js';

const PAGE = 120;
const GAP = 4;
const ZOOM = { s: 110, m: 170, l: 256 };
const KNOWN = [
  [/^(favou?rites|个人收藏)$/i, '个人收藏', 'Favorites', 'heart'],
  [/^(videos?|视频)$/i, '视频', 'Videos', 'video'],
  [/^(live( photos)?|实况照片?)$/i, '实况照片', 'Live Photos', 'aperture'],
  [/^(screenshots?|截屏)$/i, '截屏', 'Screenshots', 'monitor-smartphone'],
  [/^(selfies|自拍)$/i, '自拍', 'Selfies', 'camera'],
  [/^(panoramas?|全景照片)$/i, '全景照片', 'Panoramas', 'image'],
  [/^(bursts?|连拍快照)$/i, '连拍快照', 'Bursts', 'layers'],
  [/^(slo-?mo|慢动作)$/i, '慢动作', 'Slo-mo', 'film'],
  [/^(time-?lapse|延时摄影)$/i, '延时摄影', 'Time-lapse', 'clock'],
  [/^(hidden|已隐藏)$/i, '已隐藏', 'Hidden', 'eye-off'],
  [/^(recently deleted|最近删除)$/i, '最近删除', 'Recently Deleted', 'trash-2'],
  [/^(recently added|最近添加)$/i, '最近添加', 'Recently Added', 'history'],
];
const PHOTO_EXT = /\.(heic|heif|jpe?g|png|gif|webp|tiff?|bmp|dng|mov|mp4|m4v|avi|3gp)$/i;

export function albumMeta(a) {
  if (!a || a.id === '__all__') return { name: tx('图库', 'Library'), icon: 'images', smart: true };
  const n = (a.name || '').trim();
  for (const [re, zh, en, ic] of KNOWN) if (re.test(n)) return { name: tx(zh, en), icon: ic, smart: true };
  return { name: n || tx('未命名相簿', 'Untitled Album'), icon: 'image', smart: false };
}

const fileUrl = (p, version = 'thumb', dl = false) => `/api/photos/file?id=${encodeURIComponent(p.id)}&version=${version}${dl ? '&download=1' : ''}`;
const aspect = (p) => (p.width > 0 && p.height > 0 ? Math.min(3, Math.max(0.4, p.width / p.height)) : 1);
const kindLabel = (p) => (p.type === 'movie' ? tx('视频', 'Video') : p.live ? tx('实况照片', 'Live Photo') : tx('照片', 'Photo'));

function dayLabel(d) {
  if (!d) return tx('未知日期', 'Unknown Date');
  const now = new Date(); const y = new Date(); y.setDate(now.getDate() - 1);
  if (fmt.sameDay(d, now)) return tx('今天', 'Today');
  if (fmt.sameDay(d, y)) return tx('昨天', 'Yesterday');
  return d.getFullYear() === now.getFullYear() ? fmt.shortDate(d) : fmt.date(d);
}

export default {
  id: 'photos',
  get title() { return tx('照片', 'Photos'); },
  app: 'photos',
  mount(el, { params } = {}) {
    const S = {
      albums: [],
      album: params?.[0] || store.get('ph.album', '__all__'),
      items: [], hasMore: false, loading: false, gen: 0,
      zoom: store.get('ph.zoom', 'm'),
      sel: new Set(), anchor: null,
    };
    const tiles = new Map();
    let viewer = null;

    // ------------------------------------------------------------- layout
    const sideBody = h('div', { class: 'pane-body' });
    const body = h('div', { class: 'pane-body ph-body' });
    const grid = h('div', { class: 'ph-grid', role: 'grid', 'aria-label': tx('照片', 'Photos') });
    const sentinel = h('div', { class: 'ph-sentinel' });
    const foot = h('div', { class: 'ph-foot' });
    const selbar = h('div', { class: 'ph-selbar', role: 'toolbar', 'aria-label': tx('所选项目', 'Selected items') });
    const dropOv = h('div', { class: 'drop-overlay hidden' }, icon('cloud-upload', { size: 'xl' }), h('span', {}, tx('松开以上传', 'Drop to upload')));
    const countEl = h('span');
    let dayHeads = [];

    const zoomSeg = segmented([
      { value: 's', icon: 'grid-3x3', tip: tx('小', 'Small') },
      { value: 'm', icon: 'layout-grid', tip: tx('中', 'Medium') },
      { value: 'l', icon: 'square', tip: tx('大', 'Large') },
    ], S.zoom, (v) => { S.zoom = v; store.set('ph.zoom', v); layout(); }, { cls: 'icons ph-zoom' });
    const refreshBtn = iconBtn('refresh-cw', tx('刷新 (F5)', 'Refresh (F5)'), () => refresh());
    refreshBtn.dataset.refresh = '';
    const tb = toolbar({
      title: '',
      subtitle: countEl,
      right: [
        iconBtn('images', tx('切换相簿', 'Switch album'), (e) => albumMenu(e.currentTarget), { cls: 'when-side-hidden' }),
        zoomSeg,
        h('span', { class: 'sep hide-narrow' }),
        refreshBtn,
        h('button', { class: 'btn primary sm', type: 'button', dataset: { new: '' }, title: tx('上传照片或视频 (Ctrl+N)', 'Upload photos or videos (Ctrl+N)'), onclick: pickUpload },
          icon('upload'), h('span', { class: 'hide-narrow' }, tx('上传', 'Upload'))),
      ],
    });

    const main = h('div', { class: 'pane fill ph-main' }, tb, body, selbar, dropOv);
    el.append(h('div', { class: 'panes collapse-side' },
      h('div', { class: 'pane side ph-side' }, h('div', { class: 'pane-head ph-side-head' }, appIcon('photos', 22), h('span', { class: 'title' }, tx('照片', 'Photos'))), sideBody),
      main));

    // ------------------------------------------------------------ albums
    const curAlbum = () => S.albums.find((a) => a.id === S.album) || { id: '__all__' };

    async function init() {
      clear(sideBody, skelSide()); clear(body, skelGrid());
      try {
        S.albums = await get('/api/photos/albums');
      } catch (e) {
        clear(sideBody); clear(body, errorBox(e)); return;
      }
      if (!S.albums.some((a) => a.id === S.album)) S.album = '__all__';
      openAlbum(S.album);
    }

    function renderSide() {
      const lib = S.albums.filter((a) => albumMeta(a).smart);
      const mine = S.albums.filter((a) => !albumMeta(a).smart);
      const item = (a) => {
        const m = albumMeta(a);
        return h('div', {
          class: `side-item ${a.id === S.album ? 'active' : ''}`, tabindex: 0, role: 'button',
          onclick: () => openAlbum(a.id),
          onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAlbum(a.id); } },
        }, icon(m.icon), h('span', { class: 'label' }, m.name));
      };
      clear(sideBody, h('div', { class: 'side-list' },
        h('div', { class: 'side-title' }, tx('照片', 'Photos')), lib.map(item),
        mine.length ? [h('div', { class: 'side-title' }, tx('我的相簿', 'My Albums')), mine.map(item)] : null));
    }

    function albumMenu(anchor) {
      menu(anchor, S.albums.map((a) => {
        const m = albumMeta(a);
        return { label: m.name, icon: m.icon, checked: a.id === S.album, onClick: () => openAlbum(a.id) };
      }));
    }

    function openAlbum(id) {
      S.album = id; store.set('ph.album', id);
      S.items = []; S.hasMore = true; S.loading = false; S.gen += 1;
      S.sel.clear(); S.anchor = null; tiles.clear();
      viewer?.close();
      renderSide(); updateTitle(); updateSelbar();
      clear(body, skelGrid());
      body.scrollTop = 0;
      loadMore();
    }

    async function refresh() {
      try { await post('/api/photos/refresh'); } catch { /* best effort */ }
      init();
    }

    // -------------------------------------------------------------- data
    async function loadMore() {
      if (S.loading || !S.hasMore) return;
      S.loading = true;
      const gen = S.gen; const first = !S.items.length;
      if (!first) foot.replaceChildren(h('div', { class: 'spin' }));
      try {
        const r = await get('/api/photos/list', { album: S.album, offset: S.items.length, limit: PAGE });
        if (gen !== S.gen) return;
        const known = new Set(S.items.map((p) => p.id));
        const rows = (r?.items || []).filter((p) => !known.has(p.id));
        S.items.push(...rows);
        S.hasMore = !!r?.has_more && rows.length > 0;
        render();
      } catch (e) {
        if (gen !== S.gen) return;
        if (first) { S.hasMore = false; clear(body, errorBox(e)); } else {
          foot.replaceChildren(btn(tx('重试', 'Retry'), { size: 'sm', icon: 'rotate-ccw', onclick: () => loadMore() }));
          toastError(e);
        }
      } finally {
        if (gen === S.gen) S.loading = false;
      }
      if (gen === S.gen) requestAnimationFrame(checkSentinel);
    }

    function checkSentinel() {
      if (!S.hasMore || S.loading || !sentinel.isConnected) return;
      if (sentinel.getBoundingClientRect().top < body.getBoundingClientRect().bottom + 900) loadMore();
    }

    function updateTitle() {
      tb.setTitle(albumMeta(curAlbum()).name);
      const n = S.items.length;
      countEl.textContent = n ? (lang.isEn ? `${n}${S.hasMore ? '+' : ''} ${n === 1 ? 'item' : 'items'}` : `${n}${S.hasMore ? '+' : ''} 项`) : '';
    }

    // ------------------------------------------------------------ render
    function render() {
      updateTitle();
      if (!S.items.length) {
        clear(body, empty({
          app: 'photos', title: S.album === '__all__' ? tx('图库中没有照片', 'No Photos in Library') : tx('这个相簿是空的', 'This Album Is Empty'),
          text: tx('把照片或视频拖到这里，或点击“上传”。', 'Drag photos or videos here, or click Upload.'),
          action: { label: tx('上传照片', 'Upload Photos'), icon: 'upload', onClick: pickUpload },
        }));
        return;
      }
      if (!grid.isConnected) clear(body, grid, sentinel, foot);
      layout();
      if (S.hasMore) foot.replaceChildren();
      else {
        const v = S.items.filter((p) => p.type === 'movie').length;
        const pCount = S.items.length - v;
        foot.replaceChildren(h('div', { class: 'ph-total' },
          [pCount ? countText(pCount, '张照片', 'photo') : null, v ? countText(v, '个视频', 'video') : null]
            .filter(Boolean).join(lang.isEn ? ', ' : '、')));
      }
    }

    function sections() {
      const out = []; let cur = null;
      for (const p of S.items) {
        const d = toDate(p.created);
        const key = d ? fmt.isoDate(d) : 'unknown';
        if (!cur || cur.key !== key) { cur = { key, date: d, items: [] }; out.push(cur); }
        cur.items.push(p);
      }
      return out;
    }

    function layout() {
      if (!S.items.length || !grid.isConnected) return;
      const W = grid.clientWidth;
      if (!W) return;
      let H = ZOOM[S.zoom] || ZOOM.m;
      if (W < 560) H = Math.round(H * 0.7);
      const out = [];
      dayHeads = [];
      for (const sec of sections()) {
        out.push(dayHeader(sec));
        out.push(...justify(sec.items, W, H));
      }
      grid.replaceChildren(...out);
    }

    function justify(items, W, H) {
      const rows = []; let row = []; let sumA = 0;
      const flush = (full) => {
        if (!row.length) return;
        const gaps = GAP * (row.length - 1);
        const rh = full ? (W - gaps) / sumA : Math.min(H, (W - gaps) / sumA);
        const r = h('div', { class: 'ph-row', role: 'row', style: { height: `${Math.round(rh)}px` } });
        let used = 0;
        row.forEach(({ p, a }, i) => {
          const t = tileFor(p);
          let w = Math.floor(a * rh);
          if (full && i === row.length - 1) w = W - gaps - used;
          used += w;
          t.style.width = `${Math.max(1, w)}px`;
          r.append(t);
        });
        rows.push(r); row = []; sumA = 0;
      };
      for (const p of items) {
        const a = aspect(p);
        row.push({ p, a }); sumA += a;
        if (sumA * H + GAP * (row.length - 1) >= W) flush(true);
      }
      flush(false);
      return rows;
    }

    function dayHeader(sec) {
      const n = sec.items.length;
      const selBtn = h('button', {
        type: 'button', class: 'btn plain sm ph-day-sel',
        onclick: () => {
          const all = sec.items.every((p) => S.sel.has(p.id));
          sec.items.forEach((p) => { if (all) S.sel.delete(p.id); else S.sel.add(p.id); syncTile(p); });
          if (!all) S.anchor = sec.items[sec.items.length - 1].id;
          updateSelbar(); refreshDayButtons();
        },
      }, sec.items.every((p) => S.sel.has(p.id)) ? tx('取消选择', 'Deselect') : tx('选择', 'Select'));
      dayHeads.push({ btn: selBtn, items: sec.items });
      return h('div', { class: 'ph-day' },
        h('span', { class: 'ph-day-title' }, dayLabel(sec.date)),
        h('span', { class: 'ph-day-sub' }, [sec.date ? fmt.weekday(sec.date) : null, countText(n, '项', 'item')].filter(Boolean).join(' · ')),
        selBtn);
    }

    function tileFor(p) {
      let t = tiles.get(p.id);
      if (!t) { t = makeTile(p); tiles.set(p.id, t); }
      return t;
    }

    function makeTile(p) {
      const img = h('img', { loading: 'lazy', decoding: 'async', alt: '', draggable: false, src: fileUrl(p) });
      const t = h('div', {
        class: 'ph-tile', tabindex: 0, role: 'gridcell', 'aria-label': `${kindLabel(p)} ${p.filename || ''} ${fmt.datetime(p.created)}`,
        dataset: { id: p.id },
        onclick: (e) => tileClick(e, p),
        oncontextmenu: (e) => tileMenu(e, p),
        onkeydown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); openViewer(p.id); }
          if (e.key === ' ') { e.preventDefault(); toggleSel(p); }
        },
      },
      img,
      h('span', { class: 'ph-shade' }),
      p.type === 'movie' ? h('span', { class: 'ph-badge ph-video' }, icon('play', { size: 11 })) : null,
      p.live ? h('span', { class: 'ph-badge ph-live', title: tx('实况照片', 'Live Photo') }, icon('aperture', { size: 14 })) : null,
      h('span', { class: 'ph-fav', title: tx('个人收藏', 'Favorite') }, icon('heart', { size: 14 })),
      h('button', {
        class: 'ph-check', type: 'button', tabindex: -1, 'aria-label': tx('选择', 'Select'),
        onclick: (e) => { e.stopPropagation(); if (e.shiftKey) selectRange(p); else toggleSel(p); },
      }, icon('check', { size: 12 })));
      img.addEventListener('load', () => t.classList.add('loaded'), { once: true });
      img.addEventListener('error', () => thumbFallback(p, t, img), { once: true });
      syncTile(p, t);
      return t;
    }

    // Real iCloud video "thumbs" may be small video files: try a <video> poster frame, then a placeholder.
    function thumbFallback(p, t, img) {
      const ph = () => { t.classList.add('loaded', 'broken'); t.querySelector('img,video')?.replaceWith(h('span', { class: 'ph-broken' }, icon('image-off', { size: 22 }))); };
      if (p.type !== 'movie') return ph();
      const v = h('video', { muted: true, preload: 'metadata', playsInline: true, src: `${fileUrl(p)}#t=0.1` });
      v.addEventListener('loadeddata', () => t.classList.add('loaded'), { once: true });
      v.addEventListener('error', ph, { once: true });
      img.replaceWith(v);
    }

    function syncTile(p, t = tiles.get(p.id)) {
      if (!t) return;
      t.classList.toggle('fav', !!p.favorite);
      t.classList.toggle('selected', S.sel.has(p.id));
      t.setAttribute('aria-selected', S.sel.has(p.id) ? 'true' : 'false');
    }

    // --------------------------------------------------------- selection
    const selected = () => S.items.filter((p) => S.sel.has(p.id));

    function tileClick(e, p) {
      if (e.shiftKey && S.anchor) selectRange(p);
      else if (e.ctrlKey || e.metaKey || S.sel.size) toggleSel(p);
      else openViewer(p.id);
    }

    function toggleSel(p) {
      if (S.sel.has(p.id)) S.sel.delete(p.id); else S.sel.add(p.id);
      S.anchor = p.id;
      syncTile(p); updateSelbar(); refreshDayButtons();
    }

    function selectRange(p) {
      const a = S.items.findIndex((x) => x.id === S.anchor);
      const b = S.items.findIndex((x) => x.id === p.id);
      if (a < 0 || b < 0) return toggleSel(p);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) { S.sel.add(S.items[i].id); syncTile(S.items[i]); }
      updateSelbar(); refreshDayButtons();
    }

    function clearSel() {
      const ids = [...S.sel]; S.sel.clear();
      ids.forEach((id) => syncTile({ id }));
      updateSelbar(); refreshDayButtons();
    }

    function refreshDayButtons() {
      for (const d of dayHeads) d.btn.textContent = d.items.every((p) => S.sel.has(p.id)) ? tx('取消选择', 'Deselect') : tx('选择', 'Select');
    }

    function updateSelbar() {
      const n = S.sel.size;
      main.classList.toggle('ph-selecting', n > 0);
      selbar.classList.toggle('show', n > 0);
      if (!n) return;
      const items = selected();
      const allFav = items.every((p) => p.favorite);
      clear(selbar,
        h('span', { class: 'ph-sel-count' }, tx(`已选择 ${n} 项`, `${countText(n, '项', 'item')} selected`)),
        iconBtn(allFav ? 'heart-off' : 'heart', allFav ? tx('取消收藏', 'Unfavorite') : tx('收藏', 'Favorite'), () => setFav(items, !allFav)),
        iconBtn('download', tx('下载原件', 'Download Original'), () => downloadMany(items)),
        iconBtn('trash-2', tx('删除', 'Delete'), () => removeItems(items), { cls: 'danger' }),
        h('span', { class: 'ph-sel-sep' }),
        btn(tx('完成', 'Done'), { size: 'sm', kind: 'ghost', onclick: clearSel }));
    }

    // ----------------------------------------------------------- actions
    async function setFav(items, value) {
      const prev = items.map((p) => [p, p.favorite]);
      items.forEach((p) => { p.favorite = value; syncTile(p); });
      updateSelbar(); viewer?.sync();
      try {
        for (const p of items) await post('/api/photos/favorite', { id: p.id, value });
        if (items.length > 1) toast(value ? tx(`已收藏 ${items.length} 项`, `Added ${items.length} items to Favorites`) : tx(`已从个人收藏中移除 ${items.length} 项`, `Removed ${items.length} items from Favorites`), 'success');
      } catch (e) {
        prev.forEach(([p, v]) => { p.favorite = v; syncTile(p); });
        updateSelbar(); viewer?.sync(); toastError(e);
      }
    }

    function downloadMany(items) {
      items.forEach((p, i) => setTimeout(() => download(fileUrl(p, 'original', true)), i * 350));
      if (items.length > 1) toast(tx(`正在下载 ${items.length} 项`, `Downloading ${items.length} items`), 'info');
    }

    async function removeItems(items) {
      const n = items.length;
      const ok = await confirmDialog(
        n === 1 ? tx(`删除“${items[0].filename || '此项目'}”？`, `Delete “${items[0].filename || 'this item'}”?`) : tx(`删除所选的 ${n} 项？`, `Delete ${n} selected items?`),
        {
          title: n === 1 ? tx(`删除${kindLabel(items[0])}`, `Delete ${kindLabel(items[0])}`) : tx('删除项目', 'Delete Items'),
          okLabel: tx('删除', 'Delete'), danger: true, icon: 'trash-2',
          detail: tx('删除的项目会移到 iCloud 照片的“最近删除”，可在 30 天内恢复。', 'Deleted items move to Recently Deleted in iCloud Photos and can be recovered within 30 days.'),
        },
      );
      if (!ok) return [];
      const done = [];
      for (const p of items) {
        try { await del('/api/photos/item', { id: p.id }); done.push(p.id); } catch (e) { toastError(e); break; }
      }
      const gone = new Set(done);
      S.items = S.items.filter((p) => !gone.has(p.id));
      done.forEach((id) => { tiles.delete(id); S.sel.delete(id); });
      render(); updateSelbar();
      if (done.length) toast(done.length === 1 ? tx('已删除 1 项', 'Deleted 1 item') : tx(`已删除 ${done.length} 项`, `Deleted ${done.length} items`), 'success');
      return done;
    }

    function tileMenu(e, p) {
      const items = S.sel.has(p.id) && S.sel.size > 1 ? selected() : [p];
      const many = items.length > 1;
      const allFav = items.every((x) => x.favorite);
      menu(e, [
        !many && { label: tx('打开', 'Open'), icon: 'maximize-2', onClick: () => openViewer(p.id) },
        { label: allFav ? tx('从个人收藏中移除', 'Remove from Favorites') : tx('添加到个人收藏', 'Add to Favorites'), icon: allFav ? 'heart-off' : 'heart', onClick: () => setFav(items, !allFav) },
        { label: many ? tx(`下载 ${items.length} 项`, `Download ${items.length} Items`) : tx('下载原件', 'Download Original'), icon: 'download', onClick: () => downloadMany(items) },
        !many && { label: S.sel.has(p.id) ? tx('取消选择', 'Deselect') : tx('选择', 'Select'), icon: 'circle-check', onClick: () => toggleSel(p) },
        !many && { label: tx('拷贝文件名', 'Copy Filename'), icon: 'copy', onClick: () => copyText(p.filename || '') },
        '-',
        { label: many ? tx(`删除 ${items.length} 项…`, `Delete ${items.length} Items…`) : tx('删除…', 'Delete…'), icon: 'trash-2', danger: true, onClick: () => removeItems(items) },
      ]);
    }

    // ------------------------------------------------------------ upload
    async function pickUpload() {
      const files = await pickFiles({ accept: 'image/*,video/*,.heic,.heif' });
      if (files.length) doUpload(files);
    }

    async function doUpload(list) {
      const files = list.filter((f) => /^(image|video)\//.test(f.type) || PHOTO_EXT.test(f.name));
      if (!files.length) { toast(tx('只能上传照片或视频', 'Only photos and videos can be uploaded'), 'info'); return; }
      if (files.length < list.length) toast(tx(`已跳过 ${list.length - files.length} 个非照片文件`, `Skipped ${list.length - files.length} unsupported file(s)`), 'info');
      const fill = h('div', { style: { width: '0%' } });
      const label = h('span', {}, tx(`正在上传 ${files.length} 项…`, `Uploading ${countText(files.length, '项', 'item')}…`));
      const dismiss = toast(h('div', { class: 'ph-up' }, label, h('div', { class: 'progress ph-up-bar' }, fill)), 'info', 30 * 60 * 1000);
      const form = new FormData();
      form.append('album', albumMeta(curAlbum()).smart ? '' : S.album);
      files.forEach((f) => form.append('files', f, f.name));
      try {
        await upload('/api/photos/upload', form, {
          onProgress: (x) => { fill.style.width = `${Math.round(x * 100)}%`; if (x >= 1) label.textContent = tx('正在存储到 iCloud…', 'Saving to iCloud…'); },
        });
        dismiss();
        toast(tx(`已上传 ${files.length} 项`, `Uploaded ${countText(files.length, '项', 'item')}`), 'success');
        openAlbum(S.album);
      } catch (e) { dismiss(); toastError(e); }
    }

    let dragDepth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    main.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth += 1; dropOv.classList.remove('hidden'); });
    main.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    main.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragDepth -= 1; if (dragDepth <= 0) { dragDepth = 0; dropOv.classList.add('hidden'); } });
    main.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); dragDepth = 0; dropOv.classList.add('hidden');
      doUpload([...e.dataTransfer.files]);
    });

    // ------------------------------------------------------------ viewer
    function openViewer(id) {
      viewer?.close();
      let idx = S.items.findIndex((p) => p.id === id);
      if (idx < 0) return;
      let showInfo = store.get('ph.info', false);
      const cur = () => S.items[idx];
      const stage = h('div', { class: 'ph-v-media' });
      const title = h('div', { class: 'ph-v-title' });
      const favBtn = iconBtn('heart', tx('收藏 (.)', 'Favorite (.)'), () => setFav([cur()], !cur().favorite), { cls: 'ph-v-fav' });
      const infoBtn = iconBtn('info', tx('信息 (I)', 'Info (I)'), () => { showInfo = !showInfo; store.set('ph.info', showInfo); sync(); });
      const info = h('aside', { class: 'ph-v-info', 'aria-label': tx('信息', 'Info') });
      const prev = h('button', { class: 'ph-v-nav prev', type: 'button', 'aria-label': tx('上一项 (←)', 'Previous (←)'), onclick: () => go(-1) }, icon('chevron-left', { size: 26 }));
      const next = h('button', { class: 'ph-v-nav next', type: 'button', 'aria-label': tx('下一项 (→)', 'Next (→)'), onclick: () => go(1) }, icon('chevron-right', { size: 26 }));
      const v = h('div', { class: 'ph-viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': tx('照片查看器', 'Photo viewer'), tabindex: -1 },
        h('div', { class: 'ph-v-top' },
          iconBtn('x', tx('关闭 (Esc)', 'Close (Esc)'), () => close()),
          title,
          h('div', { class: 'ph-v-tools' },
            favBtn, infoBtn,
            iconBtn('download', tx('下载原件', 'Download Original'), () => download(fileUrl(cur(), 'original', true))),
            iconBtn('trash-2', tx('删除 (Delete)', 'Delete (Delete)'), () => removeCur(), { cls: 'danger' }))),
        h('div', { class: 'ph-v-body' }, h('div', { class: 'ph-v-stage' }, stage, prev, next), info));
      document.body.append(v);
      v.focus();

      function show() {
        const p = cur();
        clear(title, h('div', { class: 'ph-v-name' }, p.filename || tx('未命名', 'Untitled')), h('div', { class: 'ph-v-date' }, `${fmt.date(p.created)} ${fmt.time(p.created)}`));
        if (p.type === 'movie') {
          const vid = h('video', { controls: true, autoplay: true, playsInline: true, poster: fileUrl(p), src: fileUrl(p, 'medium') });
          vid.addEventListener('error', () => vid.replaceWith(photoEl(p)), { once: true });
          clear(stage, vid);
        } else clear(stage, photoEl(p));
        prev.disabled = idx === 0;
        next.disabled = idx >= S.items.length - 1 && !S.hasMore;
        if (idx > S.items.length - 6) loadMore();
        [S.items[idx + 1], S.items[idx - 1]].forEach((x) => { if (x && x.type !== 'movie') new Image().src = fileUrl(x, 'medium'); });
        sync();
      }

      function photoEl(p) {
        const img = h('img', { src: fileUrl(p), alt: p.filename || '', draggable: false, class: 'low' });
        const hi = new Image();
        hi.onload = () => { if (cur() === p) { img.src = hi.src; img.classList.remove('low'); } };
        hi.onerror = () => img.classList.remove('low');
        hi.src = fileUrl(p, 'medium');
        img.addEventListener('error', () => img.replaceWith(h('div', { class: 'ph-v-broken' }, icon('image-off', { size: 40 }), tx('无法载入此项目', 'Could not load item'))), { once: true });
        return img;
      }

      function sync() {
        const p = cur();
        if (!p) return;
        favBtn.classList.toggle('on', !!p.favorite);
        favBtn.dataset.tip = p.favorite ? tx('取消收藏 (.)', 'Unfavorite (.)') : tx('收藏 (.)', 'Favorite (.)');
        infoBtn.classList.toggle('on', showInfo);
        v.classList.toggle('with-info', showInfo);
        const d = toDate(p.created);
        const mp = p.width && p.height ? (p.width * p.height / 1e6).toFixed(1) : null;
        const row = (ic, label, value) => h('div', { class: 'ph-i-row' }, icon(ic, { size: 15 }), h('div', {}, h('div', { class: 'ph-i-label' }, label), h('div', { class: 'ph-i-value selectable' }, value)));
        clear(info,
          h('div', { class: 'ph-i-head' }, h('div', { class: 'ph-i-title' }, tx('信息', 'Info')), h('div', { class: 'ph-i-pos' }, `${idx + 1} / ${S.items.length}${S.hasMore ? '+' : ''}`)),
          row('calendar', tx('日期', 'Date'), d ? `${fmt.date(d)} ${fmt.weekday(d)} ${fmt.time(d)}` : '—'),
          row(p.type === 'movie' ? 'video' : p.live ? 'aperture' : 'image', tx('类型', 'Type'), kindLabel(p)),
          row('file', tx('文件名', 'Filename'), p.filename || '—'),
          row('maximize-2', tx('尺寸', 'Dimensions'), p.width && p.height ? `${p.width} × ${p.height}${mp ? ` · ${mp} MP` : ''}` : '—'),
          row('hard-drive', tx('大小', 'Size'), p.size ? fmt.bytes(p.size) : '—'),
          row('heart', tx('个人收藏', 'Favorite'), p.favorite ? tx('是', 'Yes') : tx('否', 'No')));
      }

      async function go(d) {
        let n = idx + d;
        if (n >= S.items.length && S.hasMore) { await loadMore(); }
        n = Math.max(0, Math.min(S.items.length - 1, n));
        if (n !== idx) { idx = n; show(); }
      }

      async function removeCur() {
        const gone = await removeItems([cur()]);
        if (!gone.length) return;
        if (!S.items.length) { close(); return; }
        idx = Math.min(idx, S.items.length - 1);
        show();
      }

      const onKey = (e) => {
        if (document.querySelector('.overlay,.menu')) return;
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); } else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); } else if (e.key === 'Delete') { e.preventDefault(); removeCur(); } else if (e.key === '.' && !isTyping(e)) setFav([cur()], !cur().favorite);
        else if (e.key.toLowerCase() === 'i' && !e.ctrlKey && !isTyping(e)) infoBtn.click();
      };
      document.addEventListener('keydown', onKey, true);

      let sx = null;
      stage.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') sx = e.clientX; });
      stage.addEventListener('pointerup', (e) => {
        if (sx === null) return;
        const dx = e.clientX - sx; sx = null;
        if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
      });

      function close() {
        if (!v.isConnected) return;
        const p = cur();
        v.remove();
        document.removeEventListener('keydown', onKey, true);
        viewer = null;
        const t = p && tiles.get(p.id);
        if (t?.isConnected) { t.scrollIntoView({ block: 'nearest' }); t.focus({ preventScroll: true }); }
      }

      viewer = { close, sync };
      show();
    }

    // ---------------------------------------------------------- keyboard
    function moveFocus(key) {
      const all = [...grid.querySelectorAll('.ph-tile')];
      const curEl = document.activeElement?.closest?.('.ph-tile');
      const i = all.indexOf(curEl);
      if (i < 0) { all[0]?.focus(); return; }
      let target = null;
      if (key === 'ArrowLeft') target = all[i - 1];
      else if (key === 'ArrowRight') target = all[i + 1];
      else {
        const rows = [...grid.querySelectorAll('.ph-row')];
        const ri = rows.indexOf(curEl.parentElement);
        const row = rows[ri + (key === 'ArrowDown' ? 1 : -1)];
        if (row) {
          const r = curEl.getBoundingClientRect(); const cx = r.left + r.width / 2;
          target = [...row.children].reduce((best, c) => {
            const cr = c.getBoundingClientRect(); const dist = Math.abs(cr.left + cr.width / 2 - cx);
            return !best || dist < best.d ? { c, d: dist } : best;
          }, null)?.c;
        }
      }
      if (target) { target.focus(); target.scrollIntoView({ block: 'nearest' }); }
    }

    const onKey = (e) => {
      if (viewer || isTyping(e) || document.querySelector('.overlay,.menu,.popover')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        S.items.forEach((p) => { S.sel.add(p.id); syncTile(p); });
        updateSelbar(); refreshDayButtons();
      } else if (e.key === 'Escape' && S.sel.size) clearSel();
      else if (e.key === 'Delete' && S.sel.size) removeItems(selected());
      else if (e.key.startsWith('Arrow') && el.contains(document.activeElement)) { e.preventDefault(); moveFocus(e.key); }
    };
    document.addEventListener('keydown', onKey);

    // ------------------------------------------------------------- misc
    const io = new IntersectionObserver((entries) => { if (entries.some((x) => x.isIntersecting)) loadMore(); }, { root: body, rootMargin: '900px 0px' });
    io.observe(sentinel);
    let lastW = 0;
    const ro = new ResizeObserver(() => {
      const w = grid.clientWidth;
      if (w && w !== lastW) { lastW = w; requestAnimationFrame(layout); }
    });
    ro.observe(grid);

    function skelSide() {
      return h('div', { class: 'side-list' }, Array.from({ length: 4 }, () => h('div', { class: 'ph-skel-side skeleton' })));
    }
    function skelGrid() {
      return h('div', { class: 'ph-skel' }, h('div', { class: 'ph-skel-day skeleton' }),
        h('div', { class: 'ph-skel-tiles' }, Array.from({ length: 18 }, () => h('div', { class: 'skeleton' }))));
    }

    init();
    return () => {
      io.disconnect(); ro.disconnect();
      document.removeEventListener('keydown', onKey);
      viewer?.close();
    };
  },
};
