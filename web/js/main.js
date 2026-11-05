// App shell: login / 2FA screen, sidebar navigation and module routing.
import { get, post } from './api.js';
import { h, clear, toast, toastError, confirmDialog, field } from './ui.js';

import calendar from './modules/calendar.js';
import reminders from './modules/reminders.js';
import notes from './modules/notes.js';
import drive from './modules/drive.js';
import photos from './modules/photos.js';
import contacts from './modules/contacts.js';
import findmy from './modules/findmy.js';
import hme from './modules/hme.js';
import account from './modules/account.js';

// Add a new module: create web/js/modules/xxx.js exporting
// { id, title, icon, color, mount(el) } and list it here.
const MODULES = [calendar, reminders, notes, drive, photos, contacts, findmy, hme, account];

const root = document.getElementById('root');
let status = null;
let cleanup = null;

async function boot() {
  try {
    status = await get('/api/auth/status');
  } catch (e) {
    clear(root, h('div', { class: 'center-screen' }, h('div', { class: 'error-box' }, '无法连接本地服务：', e.message)));
    return;
  }
  if (status.state === 'restoring') {
    clear(root, h('div', { class: 'center-screen' }, h('div', { class: 'loading' }, h('div', { class: 'spin' }), '正在恢复登录会话…')));
    setTimeout(boot, 800);
    return;
  }
  if (status.state === 'ready') renderApp();
  else renderLogin();
}

// ------------------------------------------------------------------- login
function renderLogin() {
  const s = status || {};
  const appleId = h('input', { class: 'input', type: 'email', placeholder: 'Apple 账户（邮箱或手机号）', value: s.apple_id || '', autocomplete: 'username' });
  const password = h('input', { class: 'input', type: 'password', placeholder: '密码', autocomplete: 'current-password' });
  const china = h('input', { type: 'checkbox', checked: !!s.china_mainland });
  const remember = h('input', { type: 'checkbox', checked: true });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, '登录');
  const msg = h('div', { class: 'login-msg' }, s.message || '');

  const form = h('form', { class: 'login-form', onsubmit: async (e) => {
    e.preventDefault();
    if (!appleId.value || !password.value) return;
    btn.disabled = true; btn.textContent = '正在登录…'; msg.textContent = '';
    try {
      status = await post('/api/auth/login', {
        apple_id: appleId.value, password: password.value,
        china_mainland: china.checked, remember: remember.checked,
      });
      if (status.state === 'needs_2fa') renderTwoFactor();
      else if (status.state === 'ready') renderApp();
      else msg.textContent = status.message || '登录失败';
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      btn.disabled = false; btn.textContent = '登录';
    }
  } },
    appleId, password,
    h('label', { class: 'check' }, remember, ' 在 Windows 凭据管理器中保存密码（会话过期时自动静默重新登录）'),
    h('label', { class: 'check' }, china, ' 中国大陆 iCloud 账户（icloud.com.cn）'),
    btn, msg,
  );

  clear(root, h('div', { class: 'login-screen' },
    h('div', { class: 'login-card' },
      h('div', { class: 'logo' }, '☁️'),
      h('h1', {}, '登录 iCloud'),
      h('p', { class: 'muted' }, '使用 Apple 账户登录。首次登录需要双重认证，之后会话会被信任并持久保存。'),
      form,
      h('p', { class: 'muted small' }, '提示：Apple 的“App 专用密码”只能用于 CalDAV/IMAP 等协议，无法登录 iCloud 网页服务（备忘录、云盘、照片等），所以这里需要账户密码。密码只保存在本机。'),
    )));
  (s.apple_id ? password : appleId).focus();
}

function renderTwoFactor() {
  const info = status.two_fa || {};
  const code = h('input', { class: 'input code-input', inputmode: 'numeric', maxlength: 6, placeholder: '••••••', autocomplete: 'one-time-code' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, '验证');
  const msg = h('div', { class: 'login-msg' });
  const methodText = {
    trusted_device: '验证码已发送到你的受信任 Apple 设备。',
    sms: '验证码已通过短信发送。',
    '2sa': '请输入发送到受信任设备的验证码。',
    security_key: '此账户使用安全密钥。',
  }[info.method] || '请输入 6 位验证码。';

  const form = h('form', { class: 'login-form', onsubmit: async (e) => {
    e.preventDefault();
    if (code.value.trim().length < 6) return;
    btn.disabled = true; msg.textContent = '';
    try {
      status = await post('/api/auth/2fa/verify', { code: code.value });
      toast('登录成功，会话已被信任', 'success');
      renderApp();
    } catch (err) {
      msg.textContent = err.message;
      code.select();
    } finally {
      btn.disabled = false;
    }
  } }, code, btn, msg);
  code.addEventListener('input', () => { if (code.value.trim().length === 6) form.requestSubmit(); });

  clear(root, h('div', { class: 'login-screen' },
    h('div', { class: 'login-card' },
      h('div', { class: 'logo' }, '🔐'),
      h('h1', {}, '双重认证'),
      h('p', { class: 'muted' }, methodText),
      info.notice ? h('p', { class: 'muted small' }, info.notice) : null,
      form,
      h('div', { class: 'row gap center' },
        h('button', { class: 'btn link', onclick: async () => {
          try { status = await post('/api/auth/2fa/request'); toast('已重新请求验证码'); } catch (e) { toastError(e); }
        } }, '重新发送验证码'),
        h('button', { class: 'btn link', onclick: () => { status.two_fa = null; renderLogin(); } }, '返回'),
      ),
    )));
  code.focus();
}

// --------------------------------------------------------------------- app
function renderApp() {
  const nav = h('nav', { class: 'nav' });
  const main = h('main', { class: 'main' });
  const user = status.user || {};

  for (const m of MODULES) {
    nav.append(h('a', { class: 'nav-item', href: `#/${m.id}`, 'data-id': m.id },
      h('span', { class: 'nav-icon', style: { background: m.color } }, m.icon),
      h('span', {}, m.title)));
  }

  const sidebar = h('aside', { class: 'sidebar' },
    h('div', { class: 'brand' }, h('span', { class: 'brand-logo' }, '☁️'), 'iCloud Desk'),
    nav,
    h('div', { class: 'sidebar-footer' },
      h('div', { class: 'user' },
        h('div', { class: 'avatar' }, (user.first_name || user.apple_id || '?').slice(0, 1).toUpperCase()),
        h('div', { class: 'user-info' },
          h('div', { class: 'user-name' }, user.full_name || user.apple_id || ''),
          h('div', { class: 'user-mail' }, user.apple_id || status.apple_id || ''))),
      h('button', { class: 'btn small ghost', onclick: logout }, '退出登录'),
    ),
  );

  clear(root, h('div', { class: 'app' }, sidebar, main));
  window.onhashchange = () => route(main, nav);
  route(main, nav);
}

function route(main, nav) {
  const id = (location.hash.replace(/^#\/?/, '').split('/')[0]) || MODULES[0].id;
  const mod = MODULES.find((m) => m.id === id) || MODULES[0];
  for (const a of nav.children) a.classList.toggle('active', a.dataset.id === mod.id);
  if (typeof cleanup === 'function') { try { cleanup(); } catch { /* ignore */ } }
  cleanup = null;
  const container = h('div', { class: `module module-${mod.id}` });
  clear(main, container);
  document.title = `${mod.title} - iCloud Desk`;
  try {
    cleanup = mod.mount(container);
  } catch (e) {
    toastError(e);
  }
}

async function logout() {
  const forget = h('input', { type: 'checkbox' });
  const ok = await confirmDialog(h('div', {},
    h('p', {}, '确定退出登录吗？'),
    field('', h('label', { class: 'check' }, forget, ' 同时删除保存的密码并取消此设备的信任'))), { okLabel: '退出' });
  if (!ok) return;
  try {
    status = await post('/api/auth/logout', { forget_password: forget.checked });
  } catch (e) { toastError(e); }
  if (typeof cleanup === 'function') cleanup();
  location.hash = '';
  renderLogin();
}

window.addEventListener('auth-required', async () => {
  try { status = await get('/api/auth/status'); } catch { return; }
  if (status.state === 'needs_2fa') renderTwoFactor();
  else if (status.state !== 'ready') { toast(status.message || '登录已失效，请重新登录', 'error'); renderLogin(); }
});

boot();
