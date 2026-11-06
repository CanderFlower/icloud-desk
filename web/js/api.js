// Thin fetch wrapper. Every module talks to the local daemon through api().
// Auth: the daemon sets an HttpOnly cookie when the shell opens /?token=…, so
// same-origin fetches are authenticated automatically.

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function api(path, { method = 'GET', body, form, query, signal } = {}) {
  let url = path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, v);
    }
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }
  const opts = { method, headers: {}, signal, credentials: 'same-origin' };
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
    throw new ApiError('无法连接本地服务', 0, null);
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
  return data;
}

export const get = (path, query) => api(path, { query });
export const post = (path, body) => api(path, { method: 'POST', body: body ?? {} });
export const put = (path, body) => api(path, { method: 'PUT', body });
export const patch = (path, body) => api(path, { method: 'PATCH', body });
export const del = (path, query) => api(path, { method: 'DELETE', query });

/** Upload with progress. onProgress(0..1). Resolves parsed JSON. */
export function upload(path, form, { onProgress, query } = {}) {
  return new Promise((resolve, reject) => {
    const qs = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null))}` : '';
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path + qs);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let data = null; try { data = JSON.parse(xhr.responseText); } catch { data = xhr.responseText; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError((data && (data.error || data.detail)) || `${xhr.status}`, xhr.status, data));
    };
    xhr.onerror = () => { connection.lost(); reject(new ApiError('无法连接本地服务', 0, null)); };
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
    bar.innerHTML = '<div class="spin"></div><span>正在重新连接本地服务…</span>';
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
