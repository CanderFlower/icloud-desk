// Thin fetch wrapper. Every module talks to the local daemon through api().
// Auth: the daemon sets an HttpOnly cookie when the shell opens /?token=…, so
// same-origin fetches are authenticated automatically.
import { ResponseCache } from './cache.js';
import { lang, tx } from './i18n.js';

export const responseCache = new ResponseCache({
  storage: {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
    removeItem: (key) => window.localStorage.removeItem(key),
  },
  notify: (detail) => window.dispatchEvent(new CustomEvent('cache-state', { detail })),
});

const cacheKey = (path, query) => {
  const pairs = Object.entries(query || {}).filter(([, v]) => v !== undefined && v !== null && v !== '').sort(([a], [b]) => a.localeCompare(b));
  return path + (pairs.length ? `?${new URLSearchParams(pairs)}` : '');
};

export const cachedGet = (path, query, options) => responseCache.read(cacheKey(path, query), () => get(path, query), options);
export const peekCache = (path, query) => responseCache.peek(cacheKey(path, query));

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function api(path, { method = 'GET', body, form, query, signal } = {}) {
  if (!path.startsWith('/api/auth/') && responseCache.state === 'restoring') {
    if (method !== 'GET') throw new ApiError(tx('登录会话正在恢复，请稍后再修改', 'Session is being restored, please try again shortly'), 409, null);
    await responseCache.waitForSession();
  }
  const writing = method !== 'GET' && !path.startsWith('/api/auth/');
  const family = path.split('/').slice(0, 3).join('/');
  if (writing) responseCache.invalidate(family);
  let url = path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, v);
    }
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }
  const opts = { method, headers: { 'Accept-Language': lang.code }, signal, credentials: 'same-origin' };
  if (form) {
    opts.body = form;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    if (e.name !== 'AbortError') connection.lost();
    throw new ApiError(tx('无法连接本地服务', 'Cannot connect to local service'), 0, null);
  }
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && (data.error || data.detail || data.message)) || `${res.status} ${res.statusText}`;
    if (res.status === 401) window.dispatchEvent(new CustomEvent('auth-required', { detail: data }));
    if (res.status === 403 && data?.code === 'bad_token') connection.lost();
    throw new ApiError(typeof msg === 'string' ? msg : JSON.stringify(msg), res.status, data);
  }
  if (writing) responseCache.invalidate(family);
  return data;
}

export const get = (path, query) => api(path, { query });
export const post = (path, body) => api(path, { method: 'POST', body: body ?? {} });
export const put = (path, body) => api(path, { method: 'PUT', body });
export const patch = (path, body) => api(path, { method: 'PATCH', body });
export const del = (path, query) => api(path, { method: 'DELETE', query });

/** Upload with progress. onProgress(0..1). Resolves parsed JSON. */
export function upload(path, form, { onProgress, query } = {}) {
  if (responseCache.state === 'restoring') return Promise.reject(new ApiError(tx('登录会话正在恢复，请稍后再上传', 'Session is being restored, please upload shortly'), 409, null));
  const family = path.split('/').slice(0, 3).join('/');
  responseCache.invalidate(family);
  return new Promise((resolve, reject) => {
    const qs = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null))}` : '';
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path + qs);
    xhr.setRequestHeader('Accept-Language', lang.code);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let data = null; try { data = JSON.parse(xhr.responseText); } catch { data = xhr.responseText; }
      if (xhr.status >= 200 && xhr.status < 300) { responseCache.invalidate(family); resolve(data); }
      else reject(new ApiError((data && (data.error || data.detail)) || `${xhr.status}`, xhr.status, data));
    };
    xhr.onerror = () => { connection.lost(); reject(new ApiError(tx('无法连接本地服务', 'Cannot connect to local service'), 0, null)); };
    xhr.send(form);
  });
}

// Encode an ID that may contain '/' (CloudKit record names) for path params.
export const enc = (id) => String(id).split('/').map(encodeURIComponent).join('/');

// ---------------------------------------------------------- connection
// When the daemon goes away (idle exit, crash, upgrade) ask the native shell to
// restart it (it re-navigates with a fresh URL); in a plain browser poll /api/ping.
export const connection = {
  down: false,
  lost() {
    if (this.down) return;
    this.down = true;
    window.chrome?.webview?.postMessage({ type: 'daemon-lost' });
    const bar = document.createElement('div');
    bar.className = 'reconnect-bar';
    bar.innerHTML = `<div class="spin"></div><span>${tx('正在重新连接本地服务…', 'Reconnecting to local service…')}</span>`;
    document.body.append(bar);
    const tick = async () => {
      try {
        const r = await fetch('/api/ping', { credentials: 'same-origin' });
        if (r.ok) { location.reload(); return; }
      } catch { /* still down */ }
      setTimeout(tick, 2000);
    };
    setTimeout(tick, 1500);
  },
};

// Keep the daemon's idle timer alive while a window is open.
setInterval(() => { if (!connection.down && document.visibilityState === 'visible') fetch('/api/ping').catch(() => connection.lost()); }, 5 * 60 * 1000);
