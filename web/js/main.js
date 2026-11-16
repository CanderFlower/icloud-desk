// App shell: boot, login / 2FA, sidebar navigation, routing, global shortcuts.
import { get, post, responseCache } from './api.js';
import { lang, tx } from './i18n.js';
import {
  h, clear, icon, appIcon, btn, iconBtn, toast, toastError, confirmDialog, modal, menu,
  loadIcons, theme, shell, store, isTyping, copyText,
} from './ui.js';

import calendar from './modules/calendar.js';
import reminders from './modules/reminders.js';
import notes from './modules/notes.js';
import drive from './modules/drive.js';
import photos from './modules/photos.js';
import contacts from './modules/contacts.js';
import findmy from './modules/findmy.js';
import hme from './modules/hme.js';
import account from './modules/account.js';

// A module is { id, title, app, mount(el, ctx) -> cleanup? }. `app` names the
// icon in assets/apps (calendar is drawn live). Sections group the sidebar.
const SECTIONS = [
  { title: null, modules: [calendar, reminders, notes] },
  { get title() { return tx('文件', 'Files'); }, modules: [drive, photos] },
  { get title() { return tx('更多', 'More'); }, modules: [contacts, findmy, hme, account] },
];
const MODULES = SECTIONS.flatMap((s) => s.modules);

const root = document.getElementById('root');
let status = null;
let current = null; // { mod, cleanup }
const cacheBar = h('div', { class: 'reconnect-bar', role: 'status', hidden: true });
document.body.append(cacheBar);
let cacheWarningShown = false;
window.addEventListener('cache-state', ({ detail }) => {
  if (detail.error) {
    if (detail.storage) {
      console.warn('Local response cache is unavailable', detail.error);
      if (!cacheWarningShown) {
        cacheWarningShown = true;
        toast(tx('无法保存本地缓存，本次仍可使用内存缓存', 'Local cache storage is unavailable; using in-memory cache for this session'), 'error');
      }
    } else if (detail.background) {
      toast(tx(`显示的是本地缓存，同步失败：${detail.error.message}`, `Showing cached data; sync failed: ${detail.error.message}`), 'error');
    }
    return;
  }
  const restoring = detail.state === 'restoring';
  cacheBar.hidden = !restoring && !detail.pending;
  clear(cacheBar, h('div', { class: 'spin' }), h('span', {},
    restoring
      ? tx('正在恢复会话 · 已缓存的内容可先查看', 'Restoring session · Cached content is available')
      : tx('正在同步最新内容…', 'Syncing latest changes…')));
});

// ------------------------------------------------------------------ boot
async function boot() {
  theme.apply();
  lang.apply();
  try {
    await loadIcons();
  } catch { /* icons are cosmetic */ }
  await refreshStatus();
  shell.post({ type: 'ready' });
}

async function refreshStatus() {
  try {
    status = await get('/api/auth/status');
  } catch (e) {
    clear(root, h('div', { class: 'center-screen' },
      h('div', { class: 'empty-icon big' }, icon('circle-alert', { size: 'xl' })),
      h('h2', {}, tx('无法连接本地服务', 'Cannot connect to local service')),
      h('p', { class: 'muted' }, e.message),
      btn(tx('重试', 'Retry'), { kind: 'primary', icon: 'refresh-cw', onclick: refreshStatus })));
    return;
  }
  responseCache.setSession(status);
  if (status.state === 'restoring') {
    if (responseCache.profile && responseCache.entries.size) {
      status.user = responseCache.profile.user;
      status.services = responseCache.profile.services;
      if (!mainEl) renderApp();
    } else {
      clear(root, h('div', { class: 'center-screen boot' },
        h('img', { class: 'boot-logo', src: '/assets/apps/icloud.png', alt: '' }),
        h('div', { class: 'row gap muted' }, h('div', { class: 'spin' }), tx('正在恢复登录会话…', 'Restoring session…'))));
    }
    setTimeout(refreshStatus, 700);
    return;
  }
  if (status.state === 'ready') { if (!mainEl) renderApp(); }
  else {
    if (typeof current?.cleanup === 'function') current.cleanup();
    current = null; mainEl = null;
    if (status.state === 'needs_2fa') renderTwoFactor();
    else renderLogin();
  }
}

// ----------------------------------------------------------------- login
function loginShell(...content) {
  clear(root, h('div', { class: 'login-screen' },
    h('div', { class: 'login-top' },
      h('div', { class: 'row gap-8' }, h('img', { src: '/assets/apps/icloud-logo.png', alt: '', class: 'login-brand' }), h('span', { class: 'strong' }, 'iCloud Desk')),
      h('div', { class: 'row gap-4' }, langButton(), themeButton())),
    h('div', { class: 'login-card' }, ...content)));
}

function themeButton() {
  return iconBtn(theme.dark ? 'moon' : 'sun', tx('外观', 'Appearance'), (e) => menu(e.currentTarget, themeItems(), { align: 'end' }), { cls: 'theme-btn' });
}

function langButton() {
  return iconBtn('globe', tx('语言', 'Language'), (e) => menu(e.currentTarget, langItems(), { align: 'end' }));
}

function themeItems() {
  const p = theme.pref;
  return [
    { section: tx('外观', 'Appearance') },
    { label: tx('跟随系统', 'System'), icon: 'monitor', checked: p === 'system', onClick: () => theme.set('system') },
    { label: tx('浅色', 'Light'), icon: 'sun', checked: p === 'light', onClick: () => theme.set('light') },
    { label: tx('深色', 'Dark'), icon: 'moon', checked: p === 'dark', onClick: () => theme.set('dark') },
  ];
}

function langItems() {
  const p = lang.pref;
  return [
    { section: tx('语言', 'Language') },
    { label: tx('跟随系统', 'System'), icon: 'globe', checked: p === 'system', onClick: () => lang.set('system') },
    { label: '简体中文', checked: p === 'zh-CN', onClick: () => lang.set('zh-CN') },
    { label: 'English', checked: p === 'en', onClick: () => lang.set('en') },
  ];
}

function renderLogin() {
  const s = status || {};
  const appleId = h('input', { class: 'input', type: 'email', placeholder: tx('电子邮件或电话号码', 'Email or Phone Number'), value: s.apple_id || '', autocomplete: 'username', spellcheck: false });
  const password = h('input', { class: 'input', type: 'password', placeholder: tx('密码', 'Password'), autocomplete: 'current-password' });
  const china = h('input', { type: 'checkbox', checked: !!s.china_mainland });
  const remember = h('input', { type: 'checkbox', checked: true });
  const submit = h('button', { class: 'btn primary lg block', type: 'submit' }, tx('登录', 'Sign In'));
  const msg = h('div', { class: 'login-msg', role: 'alert' }, s.state === 'error' || s.state === 'logged_out' ? (s.message || '') : '');

  const form = h('form', {
    class: 'login-form',
    onsubmit: async (e) => {
      e.preventDefault();
      if (!appleId.value.trim()) return appleId.focus();
      if (!password.value) return password.focus();
      submit.disabled = true; submit.replaceChildren(h('div', { class: 'spin on-accent' }), tx('正在登录…', 'Signing in…')); msg.textContent = '';
      try {
        status = await post('/api/auth/login', {
          apple_id: appleId.value.trim(), password: password.value, china_mainland: china.checked, remember: remember.checked,
        });
        responseCache.setSession(status);
        if (status.state === 'needs_2fa') renderTwoFactor();
        else if (status.state === 'ready') renderApp();
        else msg.textContent = status.message || tx('登录失败', 'Sign-in failed');
      } catch (err) {
        msg.textContent = err.message;
        password.select();
      } finally {
        submit.disabled = false; submit.textContent = tx('登录', 'Sign In');
      }
    },
  },
  h('div', { class: 'stack' }, appleId, password),
  h('div', { class: 'options' },
    h('label', { class: 'check' }, remember, tx('保持登录（密码保存在 Windows 凭据管理器）', 'Keep me signed in (stored in Windows Credential Manager)')),
    h('label', { class: 'check' }, china, tx('中国大陆 iCloud 账户（icloud.com.cn）', 'China mainland iCloud account (icloud.com.cn)'))),
  submit, msg);

  loginShell(
    h('img', { class: 'logo', src: '/assets/apps/icloud-256.png', alt: '' }),
    h('h1', {}, tx('登录 iCloud', 'Sign in to iCloud')),
    h('p', { class: 'lead' }, tx('使用你的 Apple 账户访问日历、提醒事项、备忘录、云盘与照片。', 'Use your Apple Account to access Calendar, Reminders, Notes, Drive, and Photos.')),
    form,
    h('div', { class: 'login-note' },
      h('b', {}, tx('为什么不能用 App 专用密码？', 'Why not an app-specific password?')), h('br'),
      tx(
        'App 专用密码只适用于 CalDAV / IMAP 等标准协议，无法访问备忘录、云盘、照片等 iCloud 网页服务。首次登录完成双重认证后，会话会被信任并长期保存，之后无需重复登录。密码仅保存在本机。',
        'App-specific passwords only work for protocols like CalDAV and IMAP, not iCloud web services such as Notes, Drive, or Photos. Once trusted with 2FA, your session stays active locally.',
      )));
  setTimeout(() => (s.apple_id ? password : appleId).focus(), 30);
}

function renderTwoFactor() {
  const info = status.two_fa || {};
  const boxes = Array.from({ length: 6 }, () => h('input', { inputmode: 'numeric', maxlength: 1, autocomplete: 'one-time-code', 'aria-label': tx('验证码', 'Verification code') }));
  const msg = h('div', { class: 'login-msg', role: 'alert' });
  const verifyBtn = h('button', { class: 'btn primary lg block', type: 'submit' }, tx('验证', 'Verify'));
  const code = () => boxes.map((b) => b.value).join('');
  const methodText = {
    trusted_device: tx('验证码已发送到你的受信任 Apple 设备。', 'A verification code has been sent to your trusted Apple devices.'),
    sms: tx('验证码已通过短信发送到你的受信任电话号码。', 'A verification code has been sent via SMS to your trusted phone number.'),
    '2sa': tx('请输入发送到受信任设备的验证码。', 'Enter the verification code sent to your trusted device.'),
    security_key: tx('此账户使用安全密钥，请按设备提示操作。', 'This account uses a Security Key. Follow the prompts on your device.'),
  }[info.method] || tx('请输入 6 位验证码。', 'Enter your 6-digit verification code.');

  let busy = false;
  async function verify() {
    if (busy || code().length < 6) return;
    busy = true; verifyBtn.disabled = true; msg.textContent = '';
    try {
      status = await post('/api/auth/2fa/verify', { code: code() });
      responseCache.setSession(status);
      toast(tx('登录成功，此设备已被信任', 'Signed in — this device is now trusted'), 'success');
      renderApp();
    } catch (err) {
      msg.textContent = err.message;
      root.querySelector('.code-boxes')?.classList.add('shake');
      setTimeout(() => root.querySelector('.code-boxes')?.classList.remove('shake'), 500);
      boxes.forEach((b) => { b.value = ''; });
      boxes[0].focus();
    } finally {
      busy = false; verifyBtn.disabled = false;
    }
  }

  boxes.forEach((b, i) => {
    b.addEventListener('input', () => {
      b.value = b.value.replace(/\D/g, '').slice(-1);
      if (b.value && i < 5) boxes[i + 1].focus();
      if (code().length === 6) verify();
    });
    b.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !b.value && i > 0) { boxes[i - 1].value = ''; boxes[i - 1].focus(); e.preventDefault(); }
      if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus();
      if (e.key === 'ArrowRight' && i < 5) boxes[i + 1].focus();
    });
    b.addEventListener('focus', () => b.select());
    b.addEventListener('paste', (e) => {
      const digits = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
      if (!digits) return;
      e.preventDefault();
      digits.split('').forEach((d, k) => { if (boxes[k]) boxes[k].value = d; });
      boxes[Math.min(digits.length, 5)].focus();
      if (digits.length === 6) verify();
    });
  });

  loginShell(
    h('div', { class: 'logo-badge' }, icon('shield-check', { size: 34 })),
    h('h1', {}, tx('双重认证', 'Two-Factor Authentication')),
    h('p', { class: 'lead' }, methodText),
    info.notice ? h('p', { class: 'small faint' }, info.notice) : null,
    h('form', { class: 'login-form', onsubmit: (e) => { e.preventDefault(); verify(); } },
      h('div', { class: 'code-boxes' }, boxes.slice(0, 3), h('span', { class: 'gap' }), boxes.slice(3)),
      verifyBtn, msg),
    h('div', { class: 'row center gap-8 login-links' },
      btn(tx('重新发送验证码', 'Resend Code'), {
        kind: 'plain', onclick: async () => {
          try { status = await post('/api/auth/2fa/request'); toast(tx('已重新发送验证码', 'Verification code resent'), 'success'); } catch (e) { toastError(e); }
        },
      }),
      h('span', { class: 'faint' }, '·'),
      btn(tx('使用其他账户', 'Use Another Account'), { kind: 'plain', onclick: () => { status = { ...status, state: 'logged_out', message: '' }; renderLogin(); } })));
  setTimeout(() => boxes[0].focus(), 30);
}

// ------------------------------------------------------------------- app
let appEl = null;
let mainEl = null;
let navEl = null;

function renderApp() {
  const user = status.user || {};
  const name = user.full_name || [user.last_name, user.first_name].filter(Boolean).join('') || status.apple_id || 'iCloud';
  const mail = user.apple_id || status.apple_id || '';

  navEl = h('nav', { class: 'nav', 'aria-label': tx('应用', 'Apps') });
  let n = 0;
  for (const sec of SECTIONS) {
    if (sec.title) navEl.append(h('div', { class: 'nav-section' }, sec.title));
    for (const m of sec.modules) {
      n += 1;
      navEl.append(h('a', { class: 'nav-item', href: `#/${m.id}`, dataset: { id: m.id }, 'data-tip': appEl?.classList.contains('collapsed') ? m.title : undefined },
        appIcon(m.app || m.id, 22),
        h('span', { class: 'label' }, m.title),
        n <= 9 ? h('span', { class: 'kbd' }, `Ctrl ${n}`) : null));
    }
  }

  const userChip = h('button', { class: 'user-chip', type: 'button', onclick: (e) => userMenu(e.currentTarget) },
    h('span', { class: 'avatar' }, initials(name)),
    h('span', { class: 'who' }, h('div', { class: 'name' }, name), h('div', { class: 'mail' }, mail)),
    icon('chevrons-up-down', { size: 'sm' }));

  const sidebar = h('aside', { class: 'sidebar' },
    h('div', { class: 'sidebar-head' },
      h('div', { class: 'brand', 'data-tip': tx('展开侧边栏', 'Expand sidebar'), onclick: () => { if (appEl.classList.contains('collapsed')) setCollapsed(false); } },
        h('span', { class: 'app-icon', style: { width: '26px', height: '26px' } },
          h('img', { class: 'light', src: '/assets/apps/icloud.png', alt: '' }),
          h('img', { class: 'dark', src: '/assets/apps/icloud-dark.png', alt: '' })),
        h('span', {}, 'iCloud')),
      h('div', { class: 'spacer' }),
      iconBtn('panel-left-close', tx('收起侧边栏 (Ctrl+\\)', 'Collapse sidebar (Ctrl+\\)'), () => setCollapsed(true), { cls: 'collapse-btn' })),
    navEl,
    h('div', { class: 'sidebar-foot' }, userChip));

  mainEl = h('main', { class: 'main' });
  appEl = h('div', { class: 'app' }, sidebar, h('div', { class: 'drawer-scrim', onclick: closeDrawer }), mainEl);
  if (store.get('sidebar.collapsed', false)) appEl.classList.add('collapsed');
  updateNavTips();
  clear(root, appEl);
  route();
}

function initials(name) {
  const s = String(name || '?').trim();
  if (/^[\u4e00-\u9fff]/.test(s)) return s.replace(/\s/g, '').slice(-2);
  return s.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

function setCollapsed(v) {
  appEl.classList.toggle('collapsed', v);
  store.set('sidebar.collapsed', v);
  updateNavTips();
}
function updateNavTips() {
  const collapsed = appEl.classList.contains('collapsed');
  for (const a of navEl.querySelectorAll('.nav-item')) {
    const m = MODULES.find((x) => x.id === a.dataset.id);
    if (collapsed) a.dataset.tip = m.title; else delete a.dataset.tip;
  }
  appEl.querySelector('.brand').dataset.tip = collapsed ? tx('展开侧边栏', 'Expand sidebar') : '';
}
function closeDrawer() { appEl?.classList.remove('drawer-open'); }
window.addEventListener('toggle-drawer', () => appEl?.classList.toggle('drawer-open'));

function userMenu(anchor) {
  menu(anchor, [
    ...themeItems(),
    '-',
    ...langItems(),
    '-',
    { label: tx('命令行与 Agent 接入…', 'CLI & Agent Integration…'), icon: 'terminal', onClick: cliDialog },
    { label: tx('键盘快捷键', 'Keyboard Shortcuts'), icon: 'keyboard', onClick: shortcutsDialog },
    { label: tx('关于 iCloud Desk', 'About iCloud Desk'), icon: 'info', onClick: aboutDialog },
    '-',
    { label: tx('退出登录…', 'Sign Out…'), icon: 'log-out', danger: true, onClick: logout },
  ]);
}

// --------------------------------------------------------------- routing
function route() {
  if (!mainEl) return;
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const mod = MODULES.find((m) => m.id === parts[0]) || MODULES[0];
  for (const a of navEl.children) a.classList?.toggle('active', a.dataset?.id === mod.id);
  closeDrawer();
  if (current?.mod === mod) return;
  if (typeof current?.cleanup === 'function') { try { current.cleanup(); } catch (e) { console.error(e); } }
  const el = h('div', { class: `module module-${mod.id}` });
  clear(mainEl, el);
  document.title = `${mod.title} — iCloud`;
  current = { mod, cleanup: null };
  try {
    current.cleanup = mod.mount(el, { params: parts.slice(1).map(decodeURIComponent) });
  } catch (e) {
    toastError(e);
  }
}
window.addEventListener('hashchange', route);

// -------------------------------------------------------------- dialogs
function cliExamples() {
  return [
    [tx('查看登录状态', 'Sign-in status'), 'icd status'],
    [tx('未来 7 天的日程', 'Events in next 7 days'), 'icd calendar events --start today --days 7'],
    [tx('新建日程', 'Create event'), tx('icd calendar add --title "周会" --start 2026-11-06T10:00 --duration 60 --calendar 工作', 'icd calendar add --title "Sync" --start 2026-11-06T10:00 --duration 60 --calendar Work')],
    [tx('列出提醒事项', 'List reminders'), tx('icd reminders list --list 提醒', 'icd reminders list --list Reminders')],
    [tx('添加提醒', 'Add reminder'), tx('icd reminders add --title "交房租" --due tomorrow --flag', 'icd reminders add --title "Pay rent" --due tomorrow --flag')],
    [tx('搜索备忘录', 'Search notes'), tx('icd notes list --search 会议', 'icd notes list --search meeting')],
    [tx('新建备忘录', 'Create note'), tx('icd notes add --folder 备忘录 --text "标题\\n- [ ] 待办"', 'icd notes add --folder Notes --text "Title\\n- [ ] Todo"')],
    [tx('浏览云盘', 'Browse Drive'), 'icd drive ls /'],
    [tx('上传文件', 'Upload file'), 'icd drive upload report.pdf --to /Documents'],
    [tx('给 Agent 的完整说明', 'Full guide for AI Agents'), 'icd guide'],
  ];
}

function cliDialog() {
  const rows = cliExamples().map(([label, cmd]) => h('div', { class: 'cli-row' },
    h('div', { class: 'cli-label' }, label),
    h('code', { class: 'cli-cmd selectable' }, cmd),
    iconBtn('copy', tx('复制', 'Copy'), () => copyText(cmd), { size: 'sm' })));
  modal({
    title: tx('命令行与 Agent 接入', 'CLI & Agent Integration'),
    subtitle: tx('其他程序和 AI Agent 可以通过 icd 命令读写你的 iCloud', 'Scripts and AI Agents can read and write your iCloud data via `icd`'),
    size: 'lg',
    body: h('div', { class: 'cli-dialog' },
      h('div', { class: 'cli-intro' },
        h('div', { class: 'cli-badge' }, icon('terminal', { size: 22 })),
        h('div', {},
          h('p', {}, h('code', {}, 'icd'), tx(
            ' 已随应用安装并加入 PATH。它与桌面应用共享同一个登录会话和后台服务，所有命令都输出 JSON，便于脚本和 Agent 解析。',
            ' is installed with the app and added to PATH. It shares the desktop app’s session and background daemon, and outputs JSON for scripts and AI Agents.',
          )),
          h('p', { class: 'small faint' }, tx(
            '退出码：0 成功 · 1 错误 · 2 用法错误 · 3 未登录 · 4 不存在 · 5 冲突/加锁。日期支持 today、tomorrow、+3d、2026-11-05T14:30。',
            'Exit codes: 0 ok · 1 error · 2 usage · 3 not signed in · 4 not found · 5 conflict/locked. Dates accept today, tomorrow, +3d, 2026-11-05T14:30.',
          )))),
      h('div', { class: 'cli-list' }, rows),
      h('div', { class: 'cli-tip' }, icon('sparkles', { size: 'sm' }),
        h('span', {}, tx('让 Agent 先运行 ', 'Have your Agent run '), h('code', {}, 'icd guide'), tx('，它会得到全部命令的说明。', ' first to get the full command reference.')))),
    actions: [
      {
        label: tx('复制给 Agent 的提示词', 'Copy Agent Prompt'),
        left: true, kind: 'ghost', icon: 'clipboard',
        onClick: () => {
          copyText(tx(
            '你可以使用命令行工具 icd 读写我的 iCloud（日历、提醒事项、备忘录、云盘、照片等）。先运行 `icd guide` 查看用法，所有输出为 JSON。',
            'You can read and write my iCloud (Calendar, Reminders, Notes, Drive, Photos, etc.) with the `icd` CLI. Run `icd guide` first for usage; all output is JSON.',
          ));
          return false;
        },
      },
      { label: tx('完成', 'Done'), primary: true },
    ],
  });
}

function shortcutsDialog() {
  const k = (...keys) => h('span', { class: 'row gap-4' }, keys.map((x) => h('span', { class: 'kbd' }, x)));
  const rows = [
    [tx('切换应用', 'Switch app'), k('Ctrl', '1 … 9')],
    [tx('搜索', 'Search'), k('Ctrl', 'F')],
    [tx('新建（当前应用）', 'New item (current app)'), k('Ctrl', 'N')],
    [tx('刷新', 'Refresh'), k('F5')],
    [tx('收起 / 展开侧边栏', 'Toggle sidebar'), k('Ctrl', '\\')],
    [tx('确认对话框', 'Confirm dialog'), k('Ctrl', 'Enter')],
    [tx('关闭菜单 / 对话框', 'Close menu / dialog'), k('Esc')],
  ];
  modal({
    title: tx('键盘快捷键', 'Keyboard Shortcuts'), size: 'sm',
    body: h('div', { class: 'group' }, rows.map(([l, keys]) => h('div', { class: 'group-row' }, h('span', { class: 'label' }, l), keys))),
    actions: [{ label: tx('好', 'OK'), primary: true }],
  });
}

async function aboutDialog() {
  let v = {};
  try { v = await get('/api/version'); } catch { /* ignore */ }
  modal({
    size: 'sm', cls: 'about', closeButton: false,
    body: h('div', { class: 'about-body' },
      h('img', { src: '/assets/apps/icloud-256.png', alt: '' }),
      h('h2', {}, 'iCloud Desk'),
      h('div', { class: 'muted' }, tx(
        `版本 ${v.version || '—'}${v.demo ? ' · 演示模式' : ''}`,
        `Version ${v.version || '—'}${v.demo ? ' · Demo Mode' : ''}`,
      )),
      h('p', { class: 'small faint' }, tx(
        '非 Apple 官方应用。通过 iCloud 网页服务接口访问你的数据，所有数据仅在本机与 Apple 服务器之间传输。',
        'Unofficial client not affiliated with Apple Inc. Communicates directly between your device and Apple’s iCloud web services.',
      )),
      h('p', { class: 'small faint' }, tx(
        '图标：iCloud.com 应用图标 © Apple；界面图标 Lucide (ISC)。',
        'Icons: iCloud.com app icons © Apple; UI icons by Lucide (ISC).',
      ))),
    actions: [{ label: tx('好', 'OK'), primary: true }],
  });
}

async function logout() {
  const forget = h('input', { type: 'checkbox' });
  const ok = await confirmDialog(h('div', {},
    h('p', {}, tx('退出后需要重新输入密码并完成双重认证。', 'You will need to enter your password and complete 2FA next time.')),
    h('label', { class: 'check top small', style: { textAlign: 'left', marginTop: '8px' } }, forget,
      h('span', {}, tx('同时删除保存的密码，并取消此设备的信任', 'Also delete saved password and untrust this device')))),
  { title: tx('退出 iCloud？', 'Sign out of iCloud?'), okLabel: tx('退出登录', 'Sign Out'), danger: true, icon: 'log-out' });
  if (!ok) return;
  try {
    status = await post('/api/auth/logout', { forget_password: forget.checked });
    responseCache.setSession(status);
  } catch (e) { toastError(e); return; }
  if (typeof current?.cleanup === 'function') current.cleanup();
  current = null; mainEl = null;
  history.replaceState(null, '', location.pathname);
  renderLogin();
}

// ------------------------------------------------------------- shortcuts
document.addEventListener('keydown', (e) => {
  if (!mainEl || document.querySelector('.overlay')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
    const m = MODULES[Number(e.key) - 1];
    if (m) { e.preventDefault(); location.hash = `#/${m.id}`; }
  } else if (ctrl && e.key === '\\') {
    e.preventDefault(); setCollapsed(!appEl.classList.contains('collapsed'));
  } else if (ctrl && e.key.toLowerCase() === 'f') {
    const s = mainEl.querySelector('.search input');
    if (s) { e.preventDefault(); s.focus(); s.select(); }
  } else if (ctrl && e.key.toLowerCase() === 'n' && !e.shiftKey) {
    e.preventDefault(); mainEl.querySelector('[data-new]')?.click();
  } else if (e.key === 'F5' || (ctrl && e.key.toLowerCase() === 'r')) {
    const r = mainEl.querySelector('[data-refresh]');
    if (r) { e.preventDefault(); r.click(); }
  } else if (e.key === 'Escape' && appEl?.classList.contains('drawer-open')) {
    closeDrawer();
  } else if (e.key === '/' && !isTyping(e)) {
    const s = mainEl.querySelector('.search input');
    if (s) { e.preventDefault(); s.focus(); }
  }
});

window.addEventListener('themechange', () => {
  for (const b of document.querySelectorAll('.login-top .theme-btn use')) b.setAttribute('href', `#i-${theme.dark ? 'moon' : 'sun'}`);
});

window.addEventListener('langchange', async () => {
  if (!status) return;
  for (const o of document.querySelectorAll('.overlay')) o.remove();
  if (status.apple_id === 'demo@icloud.com') {
    responseCache.clear();
    try {
      status = await get('/api/auth/status');
      responseCache.setSession(status);
    } catch { /* ignore */ }
  }
  if (status.state === 'ready' || (status.state === 'restoring' && mainEl)) {
    if (typeof current?.cleanup === 'function') { try { current.cleanup(); } catch (e) { console.error(e); } }
    current = null; mainEl = null;
    renderApp();
  } else if (status.state === 'needs_2fa') {
    renderTwoFactor();
  } else {
    renderLogin();
  }
});

window.addEventListener('auth-required', async () => {
  try { status = await get('/api/auth/status'); } catch { return; }
  responseCache.setSession(status);
  if (status.state === 'restoring') return;
  if (status.state === 'ready') return;
  if (typeof current?.cleanup === 'function') current.cleanup();
  current = null; mainEl = null;
  if (status.state === 'needs_2fa') renderTwoFactor();
  else { toast(status.message || tx('登录已失效，请重新登录', 'Session expired, please sign in again'), 'error'); renderLogin(); }
});

// expose for debugging from devtools
window.icd = { status: () => status, modules: MODULES.map((m) => m.id), lang };

boot();
