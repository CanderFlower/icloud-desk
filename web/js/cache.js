// Account-scoped snapshots: render immediately, then revalidate in the background.
const STORAGE_KEY = 'icd.responses.v1';
const MAX_AGE = 7 * 86400000;
const FRESH_FOR = 60000;
const MAX_ENTRIES = 80;
const MAX_BYTES = 2 * 1024 * 1024;

class CacheInvalidatedError extends Error {
  constructor() {
    super(globalThis.document?.documentElement?.lang === 'en'
      ? 'Data changed during the request, please try again'
      : '请求期间数据已改变，请重试');
  }
}

export class ResponseCache {
  constructor({ storage, now = Date.now, notify = () => {} } = {}) {
    this.storage = storage;
    this.now = now;
    this.notify = notify;
    this.scope = null;
    this.profile = null;
    this.entries = new Map();
    this.pending = new Map();
    this.revision = 0;
    this.versions = new Map();
    this.state = 'unknown';
    this.waiters = [];
    try {
      const saved = JSON.parse(storage?.getItem(STORAGE_KEY) || 'null');
      if (saved?.scope && Array.isArray(saved.entries)) {
        this.scope = saved.scope;
        this.profile = saved.profile;
        this.entries = new Map(saved.entries.filter(([, e]) => this.valid(e)));
      }
    } catch (error) {
      this.notify({ error, storage: true });
    }
  }

  valid(entry) {
    const age = this.now() - entry?.time;
    return Number.isFinite(age) && age >= 0 && age <= MAX_AGE && entry.data !== undefined;
  }

  setSession(status) {
    const scope = status.apple_id ? `${!!status.china_mainland}:${status.apple_id.trim().toLowerCase()}` : null;
    if (scope !== this.scope || !['ready', 'restoring'].includes(status.state)) this.clear();
    this.scope = ['ready', 'restoring'].includes(status.state) ? scope : null;
    this.state = status.state;
    if (status.state === 'ready') {
      this.profile = { user: status.user, services: status.services };
      this.persist();
    }
    if (status.state !== 'restoring') {
      for (const resolve of this.waiters.splice(0)) resolve();
    }
    this.changed();
  }

  async waitForSession() {
    if (this.state === 'restoring') await new Promise((resolve) => this.waiters.push(resolve));
  }

  peek(key) {
    const entry = this.entries.get(key);
    if (!this.scope || !this.valid(entry)) return undefined;
    return structuredClone(entry.data);
  }

  async read(key, fetcher, { force = false, onUpdate, onError } = {}) {
    if (!this.scope) return fetcher();
    const cached = this.peek(key);
    const entry = this.entries.get(key);
    if (!force && cached !== undefined) {
      if (this.now() - entry.time >= FRESH_FOR || this.state === 'restoring') {
        this.refresh(key, fetcher).then((data) => {
          if (data !== undefined) onUpdate?.(structuredClone(data));
        }).catch((error) => {
          if (error instanceof CacheInvalidatedError) return;
          if (onError) onError(error);
          else this.notify({ error, background: true });
        });
      }
      return cached;
    }
    const scope = this.scope;
    try { return await this.refresh(key, fetcher); }
    catch (error) {
      if (error instanceof CacheInvalidatedError && scope === this.scope && this.state === 'ready') return this.refresh(key, fetcher);
      throw error;
    }
  }

  refresh(key, fetcher) {
    if (this.pending.has(key)) return this.pending.get(key);
    const revision = this.revision;
    const scope = this.scope;
    const family = key.split('/').slice(0, 3).join('/');
    const version = this.versions.get(family) || 0;
    const request = Promise.resolve().then(fetcher).then((data) => {
      // A logout or write must not resurrect an older response.
      if (revision !== this.revision || scope !== this.scope || version !== (this.versions.get(family) || 0)) throw new CacheInvalidatedError();
      this.entries.delete(key);
      this.entries.set(key, { time: this.now(), data: structuredClone(data) });
      while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value);
      this.persist();
      return structuredClone(data);
    }).finally(() => {
      if (this.pending.get(key) === request) this.pending.delete(key);
      this.changed();
    });
    this.pending.set(key, request);
    this.changed();
    return request;
  }

  invalidate(prefix) {
    this.versions.set(prefix, (this.versions.get(prefix) || 0) + 1);
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key);
    // In-flight readers may finish, but cannot write or update UI with stale data.
    for (const key of this.pending.keys()) if (key.startsWith(prefix)) this.pending.delete(key);
    this.persist();
    this.changed();
  }

  clear() {
    this.revision++;
    this.entries.clear();
    this.pending.clear();
    this.versions.clear();
    this.profile = null;
    try { this.storage?.removeItem(STORAGE_KEY); }
    catch (error) { this.notify({ error, storage: true }); }
    this.changed();
  }

  persist() {
    if (!this.scope) return;
    let json = JSON.stringify({ scope: this.scope, profile: this.profile, entries: [...this.entries] });
    while (json.length * 2 > MAX_BYTES && this.entries.size) {
      this.entries.delete(this.entries.keys().next().value);
      json = JSON.stringify({ scope: this.scope, profile: this.profile, entries: [...this.entries] });
    }
    try { this.storage?.setItem(STORAGE_KEY, json); }
    catch (error) { this.notify({ error, storage: true }); }
  }

  changed() {
    this.notify({ pending: this.pending.size, state: this.state });
  }
}
