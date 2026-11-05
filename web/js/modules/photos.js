// Photos: albums, lazy thumbnail grid, lightbox, favorite / delete / download, upload.
import { get, post, del, api } from '../api.js';
import { h, clear, toast, toastError, confirmDialog, spinner, empty, fmt, store, download } from '../ui.js';

const PAGE = 90;
const fileUrl = (id, version, dl) => `/api/photos/file?id=${encodeURIComponent(id)}&version=${version}${dl ? '&download=true' : ''}`;

export default {
  id: 'photos',
  title: '照片',
  icon: '🌄',
  color: '#ff2d55',
  mount(el) {
    const state = { albums: [], album: store.get('photos.album', '__all__'), items: [], hasMore: false, loading: false };
    const albumBox = h('div', { class: 'list' });
    const title = h('h2', { class: 'toolbar-title' });
    const grid = h('div', { class: 'photo-grid' });
    const more = h('div', { class: 'photo-more' });
    const scroller = h('div', { class: 'pane-scroll' }, grid, more);
    const fileInput = h('input', { type: 'file', multiple: true, accept: 'image/*,video/*', style: { display: 'none' } });
    fileInput.addEventListener('change', () => { upload([...fileInput.files]); fileInput.value = ''; });

    clear(el, h('div', { class: 'split' },
      h('div', { class: 'pane pane-side' }, h('div', { class: 'pane-header' }, h('h3', {}, '相簿')), albumBox),
      h('div', { class: 'pane pane-main' },
        h('div', { class: 'toolbar' }, title, h('div', { class: 'spacer' }),
          h('button', { class: 'btn', onclick: async () => { await post('/api/photos/refresh'); loadAlbums(); } }, '刷新'),
          h('button', { class: 'btn primary', onclick: () => fileInput.click() }, '上传')),
        scroller, fileInput)));

    // Lazy-load thumbnails as they scroll into view.
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const img = e.target;
        img.src = img.dataset.src;
        io.unobserve(img);
      }
    }, { root: scroller, rootMargin: '400px' });
    const moreIo = new IntersectionObserver((entries) => { if (entries[0].isIntersecting && state.hasMore) loadPage(); }, { root: scroller, rootMargin: '600px' });
    moreIo.observe(more);

    function renderAlbums() {
      clear(albumBox, state.albums.map((a) => h('div', {
        class: `list-item ${a.id === state.album ? 'active' : ''}`,
        onclick: () => { state.album = a.id; store.set('photos.album', a.id); renderAlbums(); reset(); },
      }, a.id === '__all__' ? '🖼️' : '📒', ' ', a.name)));
      title.textContent = state.albums.find((a) => a.id === state.album)?.name || '照片';
    }

    function tile(p, idx) {
      const img = h('img', { 'data-src': fileUrl(p.id, 'thumb'), alt: p.filename || '', loading: 'lazy' });
      io.observe(img);
      return h('div', { class: 'photo-tile', title: `${p.filename || ''}\n${fmt.datetime(p.created)}`, onclick: () => lightbox(idx) },
        img,
        p.type === 'movie' ? h('span', { class: 'photo-badge' }, '▶') : null,
        p.live ? h('span', { class: 'photo-badge' }, 'LIVE') : null,
        p.favorite ? h('span', { class: 'photo-fav' }, '♥') : null);
    }

    async function loadPage() {
      if (state.loading) return;
      state.loading = true;
      clear(more, spinner());
      const album = state.album;
      try {
        const res = await get('/api/photos/list', { album, offset: state.items.length, limit: PAGE });
        if (album !== state.album) return;
        const start = state.items.length;
        state.items.push(...res.items);
        state.hasMore = res.has_more;
        grid.append(...res.items.map((p, i) => tile(p, start + i)));
        clear(more, state.hasMore ? '' : (state.items.length ? h('span', { class: 'muted small' }, `共 ${state.items.length} 项`) : empty('没有照片', '🌄')));
      } catch (e) {
        clear(more, h('div', { class: 'error-box' }, e.message));
      } finally {
        state.loading = false;
      }
      // Keep filling if the first pages don't overflow the viewport.
      if (state.hasMore && scroller.scrollHeight <= scroller.clientHeight + 200) loadPage();
    }

    function reset() {
      state.items = []; state.hasMore = false; state.loading = false;
      clear(grid); scroller.scrollTop = 0;
      loadPage();
    }

    async function loadAlbums() {
      clear(albumBox, spinner());
      try {
        state.albums = await get('/api/photos/albums');
        if (!state.albums.some((a) => a.id === state.album)) state.album = '__all__';
        renderAlbums();
        reset();
      } catch (e) { clear(albumBox, h('div', { class: 'error-box' }, e.message)); }
    }

    function lightbox(idx) {
      let i = idx;
      const media = h('div', { class: 'lb-media' });
      const info = h('div', { class: 'lb-info' });
      const favBtn = h('button', { class: 'btn ghost light' });
      const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
      const show = () => {
        const p = state.items[i];
        if (!p) return close();
        if (p.type === 'movie') clear(media, h('video', { src: fileUrl(p.id, 'original'), controls: true, autoplay: true }));
        else clear(media, h('img', { src: fileUrl(p.id, 'medium'), alt: p.filename || '' }));
        clear(info, h('b', {}, p.filename || ''), h('span', {}, fmt.datetime(p.created)),
          p.width ? h('span', {}, `${p.width}×${p.height}`) : null, p.size ? h('span', {}, fmt.bytes(p.size)) : null);
        favBtn.textContent = p.favorite ? '♥ 已收藏' : '♡ 收藏';
      };
      favBtn.onclick = async () => {
        const p = state.items[i];
        try { await post('/api/photos/favorite', { id: p.id, value: !p.favorite }); p.favorite = !p.favorite; show(); } catch (e) { toastError(e); }
      };
      const onKey = (e) => {
        if (e.key === 'Escape') close();
        else if (e.key === 'ArrowLeft' && i > 0) { i--; show(); } else if (e.key === 'ArrowRight' && i < state.items.length - 1) { i++; show(); }
      };
      const overlay = h('div', { class: 'lightbox' },
        h('div', { class: 'lb-bar' }, info, h('div', { class: 'spacer' }),
          favBtn,
          h('button', { class: 'btn ghost light', onclick: () => download(fileUrl(state.items[i].id, 'original', true)) }, '⬇ 下载原件'),
          h('button', { class: 'btn ghost light', onclick: async () => {
            const p = state.items[i];
            if (!await confirmDialog(`删除“${p.filename}”？它会被移到“最近删除”相簿。`, { danger: true, okLabel: '删除' })) return;
            try {
              await del('/api/photos/item', { id: p.id });
              state.items.splice(i, 1);
              grid.children[i]?.remove();
              [...grid.children].forEach((t, k) => { t.onclick = () => lightbox(k); });
              toast('已删除');
              if (i >= state.items.length) i = state.items.length - 1;
              show();
            } catch (e) { toastError(e); }
          } }, '🗑 删除'),
          h('button', { class: 'btn ghost light', onclick: close }, '✕')),
        h('button', { class: 'lb-nav prev', onclick: () => { if (i > 0) { i--; show(); } } }, '‹'),
        media,
        h('button', { class: 'lb-nav next', onclick: () => { if (i < state.items.length - 1) { i++; show(); } } }, '›'));
      document.body.append(overlay);
      document.addEventListener('keydown', onKey);
      show();
    }

    async function upload(files) {
      if (!files.length) return;
      const form = new FormData();
      form.append('album', state.album === '__all__' ? '' : state.album);
      for (const f of files) form.append('files', f, f.name);
      toast(`正在上传 ${files.length} 个文件…`);
      try {
        const res = await api('/api/photos/upload', { method: 'POST', form });
        toast(`已上传 ${res.count ?? files.length} 个文件`, 'success');
        await post('/api/photos/refresh');
        reset();
      } catch (e) { toastError(e); }
    }

    loadAlbums();
    return () => { io.disconnect(); moreIo.disconnect(); };
  },
};
