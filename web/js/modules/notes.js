// Notes — folder tree, date-grouped list and a block editor that round-trips the
// backend's markdown dialect (see app/notes_text.py): one block per paragraph.
import { get, cachedGet, peekCache, post, patch, del, enc } from '../api.js';
import {
  h, clear, icon, iconBtn, btn, toolbar, searchBox, menu, toast, toastError, confirmDialog, promptDialog,
  empty, skeleton, errorBox, toDate, store, copyText, download, shell,
} from '../ui.js';

const TRASH = 'TrashFolder-CloudKit';
const ALL = '__all__';
const LISTS = new Set(['ul', 'dash', 'ol', 'check']);
const HEADINGS = new Set(['title', 'h2', 'h3']);
const MAX_INDENT = 6;
const FORMATS = [
  { k: 'title', label: '标题', shortcut: 'Ctrl+Shift+T', cls: 'fm-title' },
  { k: 'h2', label: '小标题', shortcut: 'Ctrl+Shift+H', cls: 'fm-h2' },
  { k: 'h3', label: '副标题', shortcut: 'Ctrl+Shift+J', cls: 'fm-h3' },
  { k: 'p', label: '正文', shortcut: 'Ctrl+Shift+B' },
  { k: 'code', label: '等宽', cls: 'fm-code' },
  '-',
  { k: 'ul', label: '• 项目符号列表' },
  { k: 'dash', label: '– 短横线列表' },
  { k: 'ol', label: '1. 编号列表' },
  { k: 'check', label: '清单', shortcut: 'Ctrl+Shift+L' },
];
const KEY_FORMATS = { t: 'title', h: 'h2', j: 'h3', b: 'p', l: 'check' };
const isSpecial = (id) => /^(DefaultFolder|TrashFolder)-CloudKit$/.test(id || '');
const pad2 = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  .replace(/\uFFFC/g, '<span class="nt-obj" contenteditable="false">附件</span>');

// ------------------------------------------------------------- markdown <-> blocks
const INLINE = String.raw`\*\*\*(\S(?:.*?\S)?)\*\*\*|\*\*(\S(?:.*?\S)?)\*\*|(?<![\p{L}\p{N}_*])\*([^\s*](?:[^*]*?[^\s*])?)\*(?![\p{L}\p{N}_*])|~~(\S(?:.*?\S)?)~~|<u>(.+?)</u>|\[([^\]\n]+)\]\(([a-zA-Z][\w+.\-]*:[^)\s]+)\)`;

function inlineHtml(text) {
  const re = new RegExp(INLINE, 'gu');
  let out = '';
  let pos = 0;
  for (const m of text.matchAll(re)) {
    out += esc(text.slice(pos, m.index));
    if (m[1] != null) out += `<b><i>${inlineHtml(m[1])}</i></b>`;
    else if (m[2] != null) out += `<b>${inlineHtml(m[2])}</b>`;
    else if (m[3] != null) out += `<i>${inlineHtml(m[3])}</i>`;
    else if (m[4] != null) out += `<s>${inlineHtml(m[4])}</s>`;
    else if (m[5] != null) out += `<u>${inlineHtml(m[5])}</u>`;
    else out += `<a href="${esc(m[7])}">${inlineHtml(m[6])}</a>`;
    pos = m.index + m[0].length;
  }
  return out + esc(text.slice(pos));
}

const indentOf = (ws) => (ws.match(/\t/g) || []).length + Math.floor(ws.replace(/\t/g, '').length / 2);

function parseLine(s) {
  let m;
  if ((m = s.match(/^([ \t]*)[-*+] \[([ xX])\](?: (.*))?$/))) return { k: 'check', i: indentOf(m[1]), done: m[2] !== ' ', html: inlineHtml(m[3] || '') };
  if ((m = s.match(/^([ \t]*)([-*+•])[ \t]+(.*)$/))) return { k: m[2] === '*' ? 'dash' : 'ul', i: indentOf(m[1]), html: inlineHtml(m[3]) };
  if ((m = s.match(/^([ \t]*)(\d{1,9})[.)][ \t]+(.*)$/))) return { k: 'ol', i: indentOf(m[1]), html: inlineHtml(m[3]) };
  if ((m = s.match(/^(#{1,6})[ \t]+(.*)$/))) return { k: m[1].length === 1 ? 'title' : m[1].length === 2 ? 'h2' : 'h3', html: inlineHtml(m[2]) };
  return { k: 'p', html: inlineHtml(s) };
}

function parseMd(md, { titleFirst = true } = {}) {
  const out = [];
  let code = false;
  for (const line of String(md ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (/^[ \t]*```/.test(line) && (code || out.length || !titleFirst)) { code = !code; continue; }
    if (code) { out.push({ k: 'code', html: esc(line) }); continue; }
    if (titleFirst && !out.length) {
      const m = line.match(/^#{1,6}[ \t]+(.*)$/);
      out.push({ k: 'title', html: inlineHtml(m ? m[1] : line) });
      continue;
    }
    let s = line;
    let q = 0;
    const mq = s.match(/^((?:>[ \t]?)+)(.*)$/);
    if (mq) { q = 1; s = mq[2]; }
    out.push({ ...parseLine(s), q });
  }
  if (!out.length) out.push({ k: titleFirst ? 'title' : 'p', html: '' });
  return out;
}

function wrapMd(t, open, close) {
  const s = t.trim();
  if (!s) return t;
  return t.slice(0, t.length - t.trimStart().length) + open + s + close + t.slice(t.trimEnd().length);
}

const cleanText = (s) => s.replace(/\u00a0/g, ' ').replace(/[\u200b\n]/g, '');

function inlineMd(block) {
  const runs = [];
  const push = (t, f) => {
    const last = runs[runs.length - 1];
    if (last && last.b === f.b && last.i === f.i && last.u === f.u && last.s === f.s && last.a === f.a) last.t += t;
    else runs.push({ ...f, t });
  };
  const walk = (node, f) => {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) { const t = cleanText(c.data); if (t) push(t, f); continue; }
      if (c.nodeType !== 1 || c.tagName === 'BR' || c.classList.contains('nt-obj')) continue;
      const g = { ...f };
      const tag = c.tagName;
      const st = c.style || {};
      const deco = `${st.textDecoration || ''} ${st.textDecorationLine || ''}`;
      if (tag === 'B' || tag === 'STRONG' || /^(bold|bolder|[6-9]00)$/.test(st.fontWeight || '')) g.b = true;
      if (/^(normal|[1-5]00)$/.test(st.fontWeight || '')) g.b = false;
      if (tag === 'I' || tag === 'EM' || st.fontStyle === 'italic') g.i = true;
      if (tag === 'U' || deco.includes('underline')) g.u = true;
      if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL' || deco.includes('line-through')) g.s = true;
      if (tag === 'A' && c.getAttribute('href')) g.a = c.getAttribute('href');
      walk(c, g);
    }
  };
  walk(block, { b: false, i: false, u: false, s: false, a: '' });
  return runs.map((r) => {
    let t = r.t;
    if (r.b && r.i) t = wrapMd(t, '***', '***');
    else if (r.b) t = wrapMd(t, '**', '**');
    else if (r.i) t = wrapMd(t, '*', '*');
    if (r.s) t = wrapMd(t, '~~', '~~');
    if (r.u) t = wrapMd(t, '<u>', '</u>');
    if (r.a) t = `[${t}](${r.a})`;
    return t;
  }).join('');
}

function blockEl({ k = 'p', i = 0, q = 0, done = false, html = '' } = {}) {
  const b = document.createElement('div');
  b.className = 'nb';
  b.dataset.k = k;
  if (i) b.dataset.i = Math.min(i, MAX_INDENT);
  if (q) b.dataset.q = '1';
  if (done) b.dataset.done = '1';
  b.innerHTML = html || '<br>';
  return b;
}

// ------------------------------------------------------------------ block editor
function createEditor({ onChange, onSelection } = {}) {
  const ed = h('div', { class: 'ne', role: 'textbox', 'aria-multiline': 'true', spellcheck: 'false' });
  let readOnly = false;
  const hist = { stack: [], i: -1, timer: 0 };

  const blocks = () => [...ed.children];
  const sel = () => { const s = getSelection(); return s.rangeCount ? s.getRangeAt(0) : null; };
  const setRange = (r) => { const s = getSelection(); s.removeAllRanges(); s.addRange(r); };
  const textLen = (b) => cleanLen(b.textContent);
  function cleanLen(s) { return s.replace(/\u200b/g, '').length; }

  function blockOf(node) {
    while (node && node !== ed) {
      if (node.parentNode === ed) return node;
      node = node.parentNode;
    }
    return null;
  }
  function edge(container, offset, end) {
    if (container !== ed) return blockOf(container);
    const kids = ed.children;
    if (!kids.length) return null;
    return end ? kids[Math.max(0, offset - 1)] || kids[kids.length - 1] : kids[Math.min(offset, kids.length - 1)];
  }
  function offsetIn(b, node, off) {
    const r = document.createRange();
    r.setStart(b, 0);
    r.setEnd(node, off);
    return cleanLen(r.toString());
  }
  function pointAt(b, o) {
    const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    let n;
    let last = null;
    while ((n = w.nextNode())) {
      if (o <= n.data.length) return [n, o];
      o -= n.data.length;
      last = n;
    }
    if (last) return [last, last.data.length];
    return [b, 0];
  }
  function setCaret(b, o = 0) {
    if (!b) return;
    const [n, off] = pointAt(b, o);
    const r = document.createRange();
    r.setStart(n, off);
    r.collapse(true);
    setRange(r);
  }
  function caret() {
    const r = sel();
    if (!r || !ed.contains(r.startContainer)) return null;
    const b = edge(r.startContainer, r.startOffset, false);
    if (!b) return null;
    const o = r.startContainer === ed ? 0 : offsetIn(b, r.startContainer, r.startOffset);
    return { b, o, collapsed: r.collapsed };
  }
  function stripBr(b) { b.querySelectorAll('br').forEach((x) => x.remove()); }
  function fix(b) {
    if (!b) return;
    b.querySelectorAll('b,i,u,s,a,span,strong,em,strike,del,font').forEach((x) => { if (!x.textContent) x.remove(); });
    if (!b.textContent) b.innerHTML = '<br>';
    else stripBr(b);
  }

  function normalize() {
    for (const n of [...ed.childNodes]) {
      if (n.nodeType === 1 && n.tagName === 'DIV' && n.classList.contains('nb')) continue;
      if (n.nodeType === 3 && !n.data.trim() && !n.previousSibling) { n.remove(); continue; }
      const prev = n.previousElementSibling;
      if (n.nodeType === 1 && n.tagName === 'DIV') {
        const b = blockEl({ k: 'p' });
        b.innerHTML = '';
        while (n.firstChild) b.append(n.firstChild);
        n.replaceWith(b);
        fix(b);
      } else if (prev && prev.classList.contains('nb')) {
        stripBr(prev);
        prev.append(n);
      } else {
        const b = blockEl({ k: 'p' });
        b.innerHTML = '';
        ed.insertBefore(b, n);
        b.append(n);
      }
    }
    if (!ed.firstElementChild) ed.append(blockEl({ k: 'title' }));
    const first = ed.firstElementChild;
    if (first.dataset.k !== 'title') { first.dataset.k = 'title'; delete first.dataset.i; delete first.dataset.q; delete first.dataset.done; }
    for (const b of blocks()) if (!b.firstChild) b.innerHTML = '<br>';
  }

  function renumber() {
    const counters = [];
    for (const b of blocks()) {
      const k = b.dataset.k;
      const i = +b.dataset.i || 0;
      if (k === 'ol') {
        counters.length = i + 1;
        counters[i] = (counters[i] || 0) + 1;
        b.dataset.n = counters[i];
      } else {
        delete b.dataset.n;
        if (LISTS.has(k)) counters.length = Math.min(counters.length, i);
        else counters.length = 0;
      }
    }
    const one = ed.children.length === 1 && !textLen(ed.firstElementChild);
    ed.classList.toggle('is-empty', one);
  }

  // --- history (snapshot based; native undo can't follow our DOM surgery)
  function snapshot() {
    const c = caret();
    return { html: ed.innerHTML, b: c ? blocks().indexOf(c.b) : 0, o: c ? c.o : 0 };
  }
  function snap() {
    clearTimeout(hist.timer);
    const s = snapshot();
    const cur = hist.stack[hist.i];
    if (cur && cur.html === s.html) { cur.b = s.b; cur.o = s.o; return; }
    hist.stack.length = hist.i + 1;
    hist.stack.push(s);
    if (hist.stack.length > 300) hist.stack.shift();
    hist.i = hist.stack.length - 1;
  }
  function restore(s) {
    ed.innerHTML = s.html;
    renumber();
    setCaret(ed.children[s.b] || ed.lastElementChild, s.o);
    onChange?.();
  }
  function undo() { snap(); if (hist.i > 0) restore(hist.stack[--hist.i]); }
  function redo() { if (hist.i < hist.stack.length - 1) restore(hist.stack[++hist.i]); }

  function op(fn) {
    if (readOnly) return;
    snap();
    fn();
    normalize();
    renumber();
    snap();
    onChange?.();
    emitSelection();
  }

  // --- structural edits
  function deleteSelection() {
    const r = sel();
    if (!r || r.collapsed) return;
    let sc = r.startContainer, so = r.startOffset, ec = r.endContainer, eo = r.endOffset;
    const b1 = edge(sc, so, false);
    const b2 = edge(ec, eo, true);
    if (!b1 || !b2) return;
    if (sc === ed) { sc = b1; so = 0; }
    if (ec === ed) { ec = b2; eo = b2.childNodes.length; }
    const o1 = offsetIn(b1, sc, so);
    if (b1 === b2) {
      const x = document.createRange();
      x.setStart(sc, so);
      x.setEnd(ec, eo);
      x.deleteContents();
      fix(b1);
      setCaret(b1, o1);
      return;
    }
    const tail = document.createRange();
    tail.setStart(sc, so);
    tail.setEnd(b1, b1.childNodes.length);
    tail.deleteContents();
    const head = document.createRange();
    head.setStart(b2, 0);
    head.setEnd(ec, eo);
    head.deleteContents();
    let n = b1.nextSibling;
    while (n && n !== b2) { const nx = n.nextSibling; n.remove(); n = nx; }
    stripBr(b1);
    stripBr(b2);
    while (b2.firstChild) b1.append(b2.firstChild);
    b2.remove();
    fix(b1);
    setCaret(b1, o1);
  }

  function insertText(t) {
    const r = sel();
    if (!r) return;
    r.deleteContents();
    const n = document.createTextNode(t);
    r.insertNode(n);
    const b = blockOf(n);
    if (b && b.textContent) stripBr(b);
    const after = document.createRange();
    after.setStartAfter(n);
    after.collapse(true);
    setRange(after);
  }

  function splitBlock() {
    deleteSelection();
    const r = sel();
    const c = caret();
    if (!r || !c) return;
    const b = c.b;
    const k = b.dataset.k;
    const i = +b.dataset.i || 0;
    if (!textLen(b) && LISTS.has(k)) {
      if (i > 1) b.dataset.i = i - 1;
      else if (i === 1) delete b.dataset.i;
      else { b.dataset.k = 'p'; delete b.dataset.done; }
      setCaret(b, 0);
      return;
    }
    if (!textLen(b) && b.dataset.q && k === 'p') { delete b.dataset.q; setCaret(b, 0); return; }
    const tail = document.createRange();
    if (r.startContainer === ed) tail.setStart(b, 0);
    else tail.setStart(r.startContainer, r.startOffset);
    tail.setEnd(b, b.childNodes.length);
    const frag = tail.extractContents();
    const n = blockEl({ k: HEADINGS.has(k) ? 'p' : k, i, q: b.dataset.q ? 1 : 0 });
    n.innerHTML = '';
    n.append(frag);
    fix(n);
    fix(b);
    b.after(n);
    setCaret(n, 0);
  }

  function backAtStart(b) {
    const k = b.dataset.k;
    const prev = b.previousElementSibling;
    if (LISTS.has(k) || k === 'code') { b.dataset.k = 'p'; delete b.dataset.done; delete b.dataset.i; setCaret(b, 0); return; }
    if (b.dataset.q) { delete b.dataset.q; setCaret(b, 0); return; }
    if (!prev) return;
    if (!textLen(prev)) { prev.remove(); setCaret(b, 0); return; }
    const o = textLen(prev);
    stripBr(prev);
    stripBr(b);
    while (b.firstChild) prev.append(b.firstChild);
    b.remove();
    fix(prev);
    setCaret(prev, o);
  }

  function forwardAtEnd(b) {
    const next = b.nextElementSibling;
    if (!next) return;
    if (!textLen(b) && b !== ed.firstElementChild) { b.remove(); setCaret(next, 0); return; }
    const o = textLen(b);
    stripBr(b);
    stripBr(next);
    while (next.firstChild) b.append(next.firstChild);
    next.remove();
    fix(b);
    setCaret(b, o);
  }

  function selectedBlocks() {
    const r = sel();
    if (!r || !ed.contains(r.commonAncestorContainer)) return [];
    const a = edge(r.startContainer, r.startOffset, false);
    const z = edge(r.endContainer, r.endOffset, true) || a;
    const out = [];
    for (let b = a; b; b = b.nextElementSibling) { out.push(b); if (b === z) break; }
    return out;
  }

  function setKind(k) {
    const bs = selectedBlocks();
    if (!bs.length) return;
    const toggleOff = LISTS.has(k) && bs.every((b) => b.dataset.k === k);
    op(() => {
      for (const b of bs) {
        b.dataset.k = toggleOff ? 'p' : k;
        if (!LISTS.has(b.dataset.k)) { delete b.dataset.i; delete b.dataset.done; }
        if (b.dataset.k !== 'check') delete b.dataset.done;
      }
    });
  }
  function toggleQuote() {
    const bs = selectedBlocks();
    const on = !bs.every((b) => b.dataset.q);
    op(() => bs.forEach((b) => { if (b === ed.firstElementChild) return; if (on) b.dataset.q = '1'; else delete b.dataset.q; }));
  }
  function indent(d) {
    const bs = selectedBlocks().filter((b) => LISTS.has(b.dataset.k));
    if (!bs.length) return false;
    op(() => bs.forEach((b) => {
      const v = Math.max(0, Math.min(MAX_INDENT, (+b.dataset.i || 0) + d));
      if (v) b.dataset.i = v; else delete b.dataset.i;
    }));
    return true;
  }
  function inline(cmd) {
    if (readOnly) return;
    ed.focus();
    snap();
    document.execCommand(cmd);
  }
  function toggleCheck(b) {
    op(() => { if (b.dataset.done) delete b.dataset.done; else b.dataset.done = '1'; });
  }

  async function insertLink() {
    if (readOnly) return;
    const r = sel();
    const saved = r && ed.contains(r.startContainer) ? r.cloneRange() : null;
    const a = saved && (saved.startContainer.parentElement?.closest('a'));
    let url = await promptDialog(a ? '编辑链接' : '添加链接', a?.getAttribute('href') || 'https://', { placeholder: 'https://example.com', okLabel: '好' });
    if (url == null) return;
    url = url.trim();
    ed.focus();
    if (saved) setRange(saved);
    snap();
    if (!url) { document.execCommand('unlink'); return; }
    if (!/^[a-z][\w+.-]*:/i.test(url)) url = `https://${url}`;
    if (saved && !saved.collapsed) document.execCommand('createLink', false, url);
    else document.execCommand('insertHTML', false, `<a href="${esc(url)}">${esc(url)}</a>`);
  }

  // --- events
  ed.addEventListener('beforeinput', (e) => {
    if (readOnly) { e.preventDefault(); return; }
    const t = e.inputType;
    if (t === 'historyUndo') { e.preventDefault(); undo(); return; }
    if (t === 'historyRedo') { e.preventDefault(); redo(); return; }
    if (t === 'insertParagraph' || t === 'insertLineBreak') { e.preventDefault(); op(splitBlock); return; }
    if (t === 'insertFromDrop' || t === 'deleteByDrag') { e.preventDefault(); return; }
    if (t === 'insertFromPaste') return;
    const r = sel();
    if (!r) return;
    const multi = !r.collapsed && edge(r.startContainer, r.startOffset, false) !== edge(r.endContainer, r.endOffset, true);
    if (multi || (!r.collapsed && r.startContainer === ed)) {
      if (t.startsWith('delete')) { e.preventDefault(); op(deleteSelection); return; }
      if (t === 'insertText' || t === 'insertReplacementText') {
        e.preventDefault();
        const data = e.data ?? e.dataTransfer?.getData('text/plain') ?? '';
        op(() => { deleteSelection(); if (data) insertText(data); });
        return;
      }
    }
    if (!r.collapsed) return;
    if (/^delete.*Backward$/.test(t)) {
      const c = caret();
      if (c && c.o === 0) { e.preventDefault(); op(() => backAtStart(c.b)); }
    } else if (/^delete.*Forward$/.test(t)) {
      const c = caret();
      if (c && c.o >= textLen(c.b)) { e.preventDefault(); op(() => forwardAtEnd(c.b)); }
    }
  });

  ed.addEventListener('input', (e) => {
    if (readOnly) return;
    normalize();
    if (e.inputType === 'insertText' && e.data === ' ') autoFormat();
    renumber();
    clearTimeout(hist.timer);
    hist.timer = setTimeout(snap, 600);
    onChange?.();
  });

  function autoFormat() {
    const c = caret();
    if (!c || !c.collapsed || c.b === ed.firstElementChild) return;
    const b = c.b;
    const t = b.textContent.slice(0, c.o).replace(/\u00a0/g, ' ');
    const rules = [
      [/^\[ ?\] $|^- \[ ?\] $/, 'check', ['p', 'ul']], [/^[-•] $/, 'ul', ['p']], [/^\* $/, 'dash', ['p']],
      [/^1[.)] $/, 'ol', ['p']], [/^# $/, 'title', ['p']], [/^## $/, 'h2', ['p']], [/^### $/, 'h3', ['p']], [/^> $/, 'quote', ['p']],
    ];
    const hit = rules.find(([re, , from]) => re.test(t) && from.includes(b.dataset.k));
    if (!hit) return;
    snap();
    const [n1, o1] = pointAt(b, 0);
    const [n2, o2] = pointAt(b, t.length);
    const r = document.createRange();
    r.setStart(n1, o1);
    r.setEnd(n2, o2);
    r.deleteContents();
    if (hit[1] === 'quote') b.dataset.q = '1';
    else b.dataset.k = hit[1];
    fix(b);
    setCaret(b, 0);
  }

  ed.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229 || readOnly) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (mod && !e.altKey) {
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); return; }
      if (e.shiftKey && KEY_FORMATS[k]) { e.preventDefault(); setKind(KEY_FORMATS[k]); return; }
      if (e.shiftKey && k === 'x') { e.preventDefault(); inline('strikeThrough'); return; }
      if (k === ']') { e.preventDefault(); indent(1); return; }
      if (k === '[') { e.preventDefault(); indent(-1); return; }
      if (k === 'k') { e.preventDefault(); insertLink(); return; }
      if (k === 'b' || k === 'i' || k === 'u') snap();
    }
    if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      if (!indent(e.shiftKey ? -1 : 1) && !e.shiftKey) document.execCommand('insertText', false, '\t');
    }
  });

  ed.addEventListener('paste', (e) => {
    if (readOnly) return;
    e.preventDefault();
    const text = (e.clipboardData?.getData('text/plain') || '').replace(/\r\n?/g, '\n');
    if (!text) return;
    op(() => {
      deleteSelection();
      const lines = text.split('\n');
      if (lines.length === 1) { insertText(lines[0]); return; }
      const r = sel();
      const c = caret();
      if (!r || !c) return;
      const b = c.b;
      const tail = document.createRange();
      tail.setStart(r.startContainer === ed ? b : r.startContainer, r.startContainer === ed ? 0 : r.startOffset);
      tail.setEnd(b, b.childNodes.length);
      const frag = tail.extractContents();
      stripBr(b);
      if (lines[0]) b.append(document.createTextNode(lines[0]));
      fix(b);
      let last = b;
      for (const d of parseMd(lines.slice(1).join('\n'), { titleFirst: false })) {
        const n = blockEl(d);
        last.after(n);
        last = n;
      }
      const o = textLen(last);
      if (frag.textContent) { stripBr(last); last.append(frag); }
      fix(last);
      setCaret(last, o);
    });
  });

  ed.addEventListener('drop', (e) => e.preventDefault());

  ed.addEventListener('mousedown', (e) => {
    const b = e.target.closest?.('.nb[data-k="check"]');
    if (!b || b.parentNode !== ed || readOnly) return;
    const x = e.clientX - b.getBoundingClientRect().left;
    const start = (+b.dataset.i || 0) * 24 + (b.dataset.q ? 18 : 0);
    if (x >= start - 4 && x <= start + 26) { e.preventDefault(); toggleCheck(b); }
  });

  ed.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href]');
    if (!a) return;
    if (readOnly || e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const u = a.getAttribute('href');
      if (/^(https?|mailto|tel):/i.test(u)) shell.openExternal(u);
    }
  });

  function emitSelection() {
    if (!onSelection) return;
    const c = caret();
    if (!c) return;
    const sel = getSelection();
    const has = (tags) => {
      for (let n = sel.anchorNode; n && n !== c.b; n = n.parentNode) if (n.nodeType === 1 && tags.includes(n.tagName)) return true;
      return false;
    };
    onSelection({ kind: c.b.dataset.k, quote: !!c.b.dataset.q, bold: has(['B', 'STRONG']), italic: has(['I', 'EM']), underline: has(['U']), strike: has(['S', 'STRIKE', 'DEL']) });
  }
  const onSelChange = () => { if (ed.contains(getSelection().anchorNode)) emitSelection(); };
  document.addEventListener('selectionchange', onSelChange);

  return {
    el: ed,
    load(md, { editable = true } = {}) {
      ed.innerHTML = '';
      for (const d of parseMd(md)) ed.append(blockEl(d));
      normalize();
      renumber();
      this.setReadOnly(!editable);
      hist.stack = [];
      hist.i = -1;
      snap();
    },
    setReadOnly(v) {
      readOnly = v;
      ed.contentEditable = v ? 'false' : 'true';
      ed.classList.toggle('readonly', v);
    },
    toMarkdown() {
      const lines = [];
      let code = false;
      for (const b of blocks()) {
        const k = b.dataset.k;
        if (k === 'code') {
          if (!code) { lines.push('```'); code = true; }
          lines.push(cleanText(b.textContent));
          continue;
        }
        if (code) { lines.push('```'); code = false; }
        const body = inlineMd(b);
        const pad = '  '.repeat(+b.dataset.i || 0);
        let line;
        switch (k) {
          case 'title': line = body ? `# ${body}` : ''; break;
          case 'h2': line = body ? `## ${body}` : ''; break;
          case 'h3': line = body ? `### ${body}` : ''; break;
          case 'ul': line = `${pad}- ${body}`; break;
          case 'dash': line = `${pad}* ${body}`; break;
          case 'ol': line = `${pad}${b.dataset.n || 1}. ${body}`; break;
          case 'check': line = `${pad}- [${b.dataset.done ? 'x' : ' '}] ${body}`; break;
          default: line = body;
        }
        if (b.dataset.q) line = `> ${line}`;
        lines.push(line);
      }
      if (code) lines.push('```');
      return lines.join('\n');
    },
    title() { return cleanText(ed.firstElementChild?.textContent || '').trim(); },
    snippet() {
      for (const b of blocks().slice(1)) { const t = cleanText(b.textContent).trim(); if (t) return t; }
      return '';
    },
    focus(atEnd = false) {
      ed.focus();
      const b = atEnd ? ed.lastElementChild : ed.firstElementChild;
      setCaret(b, textLen(b));
    },
    setKind, toggleQuote, indent, inline, insertLink, undo, redo,
    currentKind() { return caret()?.b.dataset.k || 'p'; },
    destroy() { document.removeEventListener('selectionchange', onSelChange); clearTimeout(hist.timer); },
  };
}

// ---------------------------------------------------------------- date helpers
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function dayDiff(d) { return Math.round((startOfDay(new Date()) - startOfDay(d)) / 864e5); }
const WD = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
function rowDate(d) {
  if (!d) return '';
  const n = dayDiff(d);
  if (n <= 0) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (n === 1) return '昨天';
  if (n < 7) return WD[d.getDay()];
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
function sectionOf(d) {
  if (!d) return '更早';
  const n = dayDiff(d);
  if (n <= 0) return '今天';
  if (n === 1) return '昨天';
  if (n < 7) return '过去 7 天';
  if (n < 30) return '过去 30 天';
  return d.getFullYear() === new Date().getFullYear() ? `${d.getMonth() + 1}月` : `${d.getFullYear()}年`;
}
function longDate(d) {
  if (!d) return '';
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// ------------------------------------------------------------------------ module
export default {
  id: 'notes',
  title: '备忘录',
  app: 'notes',
  mount(el) {
    const S = {
      folders: peekCache('/api/notes/folders') || [],
      notes: [],
      sel: store.get('notes.sel', ALL),
      curId: null,
      query: '',
      collapsed: new Set(store.get('notes.collapsed', [])),
      listError: null,
      loadingList: true,
    };
    let ED = null; // { id, folder_id, change_tag, md, force, readonly, editor, timer, saving, again, conflict }
    let openSeq = 0;
    let alive = true;

    // ---- layout
    const sideBody = h('div', { class: 'side-list nt-folders' });
    const listBody = h('div', { class: 'pane-body nt-list' });
    const listCount = h('div', { class: 'nt-count' });
    const detail = h('div', { class: 'pane detail nt-detail' });
    const listTb = toolbar({
      title: '备忘录',
      cls: 'nt-list-tb',
      right: [
        iconBtn('folder', '文件夹', (e) => folderMenu(e.currentTarget), { cls: 'when-side-hidden' }),
        iconBtn('refresh-cw', '刷新 (F5)', () => refresh(), { cls: 'refresh hide-narrow' }),
        h('button', { class: 'icon-btn nt-compose', type: 'button', 'data-tip': '新建备忘录 (Ctrl+N)', 'aria-label': '新建备忘录', dataset: { new: '' }, onclick: () => newNote() }, icon('square-pen')),
      ],
    });
    listTb.querySelector('.refresh').dataset.refresh = '';
    const search = searchBox({ placeholder: '搜索', oninput: (q) => { S.query = q.toLowerCase(); renderList(); } });
    const panes = h('div', { class: 'panes collapse-side stack nt' },
      h('div', { class: 'pane side nt-side' },
        h('div', { class: 'pane-body' }, sideBody),
        h('div', { class: 'pane-foot' }, btn('新建文件夹', { kind: 'ghost', size: 'sm', icon: 'folder-plus', onclick: () => newFolder() }))),
      h('div', { class: 'pane list nt-listpane' }, listTb, h('div', { class: 'nt-search' }, search), listBody, h('div', { class: 'pane-foot nt-foot' }, listCount)),
      detail);
    el.append(panes);

    // ---- folders
    const folderById = (id) => S.folders.find((f) => f.id === id);
    const trash = () => folderById(TRASH);
    const defaultFolder = () => S.folders.find((f) => f.id.startsWith('DefaultFolder')) || S.folders.find((f) => f.id !== TRASH && !f.parent_id) || S.folders[0];
    const folderName = (id) => (id === ALL ? '所有 iCloud 备忘录' : folderById(id)?.name || '备忘录');

    function tree() {
      const fs = S.folders.filter((f) => f.id !== TRASH);
      const ids = new Set(fs.map((f) => f.id));
      const kids = new Map();
      for (const f of fs) {
        const p = f.parent_id && ids.has(f.parent_id) ? f.parent_id : null;
        if (!kids.has(p)) kids.set(p, []);
        kids.get(p).push(f);
      }
      const order = (a, b) => (b.id.startsWith('DefaultFolder') - a.id.startsWith('DefaultFolder')) || a.name.localeCompare(b.name, 'zh');
      const out = [];
      const walk = (p, depth) => {
        for (const f of (kids.get(p) || []).sort(order)) {
          const has = kids.has(f.id);
          out.push({ f, depth, has });
          if (has && !S.collapsed.has(f.id)) walk(f.id, depth + 1);
        }
      };
      walk(null, 0);
      return out;
    }

    function sideItem({ id, name, ic, count, depth = 0, has = false, special = false }) {
      const active = S.sel === id;
      const item = h('div', {
        class: `side-item nt-fi ${active ? 'active' : ''}`, tabindex: 0, dataset: { id },
        style: { paddingLeft: `${8 + depth * 16}px` },
        onclick: () => selectFolder(id),
        onkeydown: (e) => { if (e.key === 'Enter') selectFolder(id); },
        oncontextmenu: (e) => { if (!special || id === TRASH) { e.preventDefault(); folderCtx(e, id); } },
        ondragover: (e) => {
          if (id === ALL || !e.dataTransfer.types.includes('application/x-icd-note')) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          item.classList.add('drop-target');
        },
        ondragleave: () => item.classList.remove('drop-target'),
        ondrop: (e) => {
          e.preventDefault();
          item.classList.remove('drop-target');
          const nid = e.dataTransfer.getData('application/x-icd-note');
          if (nid) moveNote(nid, id);
        },
      },
      has ? h('button', {
        class: `nt-twisty ${S.collapsed.has(id) ? '' : 'open'}`, type: 'button', 'aria-label': '展开',
        onclick: (e) => { e.stopPropagation(); toggleCollapse(id); },
      }, icon('chevron-right')) : (depth ? h('span', { class: 'nt-twisty-sp' }) : null),
      icon(ic), h('span', { class: 'label' }, name), h('span', { class: 'count' }, count ?? ''),
      !special ? iconBtn('ellipsis', '更多', (e) => { e.stopPropagation(); folderCtx(e.currentTarget, id); }, { cls: 'more', size: 'sm' }) : null);
      return item;
    }

    function renderSide() {
      clear(sideBody);
      const total = S.folders.filter((f) => f.id !== TRASH).reduce((n, f) => n + (f.count || 0), 0);
      sideBody.append(
        h('div', { class: 'side-title' }, 'iCloud', iconBtn('folder-plus', '新建文件夹', () => newFolder(), { size: 'sm' })),
        sideItem({ id: ALL, name: '所有 iCloud 备忘录', ic: 'notebook-pen', count: total, special: true }),
        ...tree().map(({ f, depth, has }) => sideItem({ id: f.id, name: f.name, ic: 'folder', count: f.count, depth, has, special: isSpecial(f.id) })),
      );
      if (trash()) sideBody.append(sideItem({ id: TRASH, name: trash().name || '最近删除', ic: 'trash-2', count: trash().count, special: true }));
    }

    function toggleCollapse(id) {
      if (S.collapsed.has(id)) S.collapsed.delete(id); else S.collapsed.add(id);
      store.set('notes.collapsed', [...S.collapsed]);
      renderSide();
    }

    function folderMenu(at) {
      const items = [{ label: '所有 iCloud 备忘录', icon: 'notebook-pen', checked: S.sel === ALL, onClick: () => selectFolder(ALL) }, '-'];
      for (const { f, depth } of tree()) items.push({ label: `${'\u2003'.repeat(depth)}${f.name}`, icon: 'folder', checked: S.sel === f.id, onClick: () => selectFolder(f.id) });
      if (trash()) items.push('-', { label: trash().name || '最近删除', icon: 'trash-2', checked: S.sel === TRASH, onClick: () => selectFolder(TRASH) });
      items.push('-', { label: '新建文件夹…', icon: 'folder-plus', onClick: () => newFolder() });
      menu(at, items, { align: 'end' });
    }

    function folderCtx(at, id) {
      if (id === TRASH) {
        menu(at, [{ label: '清空“最近删除”…', icon: 'trash-2', danger: true, disabled: !S.notes.length || S.sel !== TRASH, onClick: () => emptyTrash() }]);
        return;
      }
      const f = folderById(id);
      if (!f) return;
      menu(at, [
        { label: '新建子文件夹…', icon: 'folder-plus', onClick: () => newFolder(id) },
        { label: '重命名…', icon: 'pencil', onClick: () => renameFolder(f) },
        '-',
        { label: '删除文件夹…', icon: 'trash-2', danger: true, onClick: () => deleteFolder(f) },
      ]);
    }

    async function loadFolders(force = false) {
      const apply = (folders) => {
        if (!alive) return;
        S.folders = folders;
        if (S.sel !== ALL && !folderById(S.sel)) S.sel = ALL;
        renderSide();
      };
      try {
        apply(await cachedGet('/api/notes/folders', undefined, { force, onUpdate: apply }));
      } catch (e) {
        if (!S.folders.length) { clear(sideBody); sideBody.append(errorBox(e)); }
        throw e;
      }
      if (S.sel !== ALL && !folderById(S.sel)) S.sel = ALL;
      renderSide();
    }

    async function newFolder(parentId = null) {
      const title = await promptDialog(parentId ? '新建子文件夹' : '新建文件夹', '', { placeholder: '文件夹名称', okLabel: '创建' });
      if (!title?.trim()) return;
      try {
        const res = await post('/api/notes/folders', { title: title.trim(), parent_id: parentId || undefined });
        if (parentId) S.collapsed.delete(parentId);
        await loadFolders();
        const id = res?.id || S.folders.find((f) => f.name === title.trim())?.id;
        if (id) selectFolder(id);
        toast('已创建文件夹', 'success', 1600);
      } catch (e) { toastError(e); }
    }

    async function renameFolder(f) {
      const title = await promptDialog('重命名文件夹', f.name, { okLabel: '重命名' });
      if (!title?.trim() || title.trim() === f.name) return;
      try {
        await patch(`/api/notes/folders/${enc(f.id)}`, { title: title.trim() });
        f.name = title.trim();
        renderSide();
        if (S.sel === f.id) listTb.setTitle(f.name);
      } catch (e) { toastError(e); }
    }

    async function deleteFolder(f) {
      const ok = await confirmDialog(`删除文件夹“${f.name}”？`, {
        title: '删除文件夹', okLabel: '删除', danger: true, icon: 'trash-2',
        detail: '文件夹及其子文件夹会被删除，其中的备忘录会移到“最近删除”。',
      });
      if (!ok) return;
      try {
        const res = await del(`/api/notes/folders/${enc(f.id)}`);
        const gone = new Set(res?.deleted_folders || [f.id]);
        if (gone.has(S.sel)) S.sel = ALL;
        await loadFolders();
        await loadList();
        toast(`已删除“${f.name}”`, 'success');
      } catch (e) { toastError(e); }
    }

    async function emptyTrash() {
      const ok = await confirmDialog(`永久删除“最近删除”中的 ${S.notes.length} 条备忘录？`, { title: '清空最近删除', okLabel: '全部删除', danger: true, detail: '此操作无法撤销。' });
      if (!ok) return;
      let n = 0;
      for (const note of [...S.notes]) {
        try { await del(`/api/notes/item/${enc(note.id)}`, { permanent: true }); n++; } catch (e) { toastError(e); break; }
      }
      toast(`已永久删除 ${n} 条备忘录`, 'success');
      closeEditor();
      refreshCounts();
      loadList();
    }

    async function selectFolder(id) {
      if (S.sel === id && S.notes.length) { panes.classList.remove('show-detail'); return; }
      S.sel = id;
      store.set('notes.sel', id);
      renderSide();
      await loadList({ openFirst: true });
    }

    async function refreshCounts() {
      try { S.folders = await get('/api/notes/folders'); renderSide(); } catch { /* ignore */ }
    }

    // ---- list
    async function loadList({ openFirst = false, keep = false, force = false } = {}) {
      const seq = ++listSeq;
      const query = S.sel === ALL ? { limit: 1000 } : { folder_id: S.sel, limit: 1000 };
      const apply = (rows) => {
        if (seq !== listSeq || !alive) return;
        S.notes = rows.filter((n) => (S.sel === TRASH ? true : !n.is_deleted && n.folder_id !== TRASH));
        S.notes.sort((a, b) => (toDate(b.modified_at)?.getTime() || 0) - (toDate(a.modified_at)?.getTime() || 0));
        S.listError = null; S.loadingList = false;
        renderList();
      };
      listTb.setTitle(folderName(S.sel));
      const snapshot = !force && peekCache('/api/notes', query);
      if (snapshot) apply(snapshot);
      else if (!keep) { S.loadingList = true; clear(listBody); listBody.append(skeleton(6, { avatar: false })); }
      try {
        apply(await cachedGet('/api/notes', query, { force, onUpdate: apply }));
      } catch (e) {
        if (seq !== listSeq || !alive) return;
        if (S.notes.length) toastError(e); else S.listError = e;
      }
      if (seq !== listSeq || !alive) return;
      S.loadingList = false;
      renderList();
      if (openFirst || (!ED && !S.curId)) {
        const wanted = store.get('notes.cur', null);
        const target = S.notes.find((n) => n.id === wanted) || S.notes[0];
        if (target && !matchMedia('(max-width: 640px)').matches) openNote(target.id, { fromList: false });
        else if (!target) closeEditor();
      }
    }
    let listSeq = 0;

    function filtered() {
      if (!S.query) return S.notes;
      return S.notes.filter((n) => `${n.title || ''}\n${n.snippet || ''}`.toLowerCase().includes(S.query));
    }

    function renderList() {
      const top = listBody.scrollTop;
      clear(listBody);
      if (S.listError) { listBody.append(errorBox(S.listError)); listCount.textContent = ''; return; }
      const rows = filtered();
      const draft = ED && !ED.id ? ED : null;
      listCount.textContent = S.notes.length ? `${S.notes.length} 个备忘录` : '';
      if (S.sel === TRASH && S.notes.length) listBody.append(h('div', { class: 'nt-trash-hint' }, '“最近删除”中的备忘录会在一段时间后被永久删除。'));
      if (!rows.length && !draft) {
        listBody.append(S.query
          ? empty({ icon: 'search', title: '无结果', text: `没有与“${S.query}”匹配的备忘录`, compact: true })
          : empty({ icon: S.sel === TRASH ? 'trash-2' : 'sticky-note', title: S.sel === TRASH ? '没有最近删除的备忘录' : '没有备忘录', text: S.sel === TRASH ? '' : '点按右上角的新建按钮写下第一条备忘录。', compact: true }));
        return;
      }
      if (draft) listBody.append(h('div', { class: 'nt-sec' }, '今天'), noteRow({ id: null, title: draft.editor.title() || '新备忘录', snippet: draft.editor.snippet() || '无附加文本', modified_at: Date.now() }, true));
      let sec = draft ? '今天' : null;
      for (const n of rows) {
        const d = toDate(n.modified_at);
        const s = S.query ? '搜索结果' : sectionOf(d);
        if (s !== sec) { listBody.append(h('div', { class: 'nt-sec' }, s)); sec = s; }
        listBody.append(noteRow(n, n.id === S.curId && !draft));
      }
      listBody.scrollTop = top;
    }

    function noteRow(n, active) {
      const d = toDate(n.modified_at);
      const row = h('div', {
        class: `nt-row ${active ? 'active' : ''}`, tabindex: -1, draggable: !!n.id, dataset: { id: n.id || '' },
        onclick: () => { if (n.id && n.id !== S.curId) openNote(n.id); else panes.classList.add('show-detail'); },
        oncontextmenu: (e) => { if (n.id) noteCtx(e, n); },
        ondragstart: (e) => { e.dataTransfer.setData('application/x-icd-note', n.id); e.dataTransfer.effectAllowed = 'move'; row.classList.add('dragging'); },
        ondragend: () => row.classList.remove('dragging'),
      },
      h('div', { class: 'nt-row-title' }, n.is_locked ? icon('lock') : null, h('span', {}, n.title || '新备忘录')),
      h('div', { class: 'nt-row-sub' }, h('span', { class: 'nt-row-date' }, rowDate(d)), h('span', { class: 'nt-row-snip' }, n.is_locked ? '已锁定' : (n.snippet || '无附加文本'))),
      S.sel === ALL && n.folder_name ? h('div', { class: 'nt-row-folder' }, icon('folder'), n.folder_name) : null);
      return row;
    }

    function markActive() {
      listBody.querySelectorAll('.nt-row').forEach((r) => r.classList.toggle('active', !!S.curId && r.dataset.id === S.curId));
    }

    function noteCtx(e, n) {
      const inTrash = n.folder_id === TRASH || S.sel === TRASH;
      const targets = tree().filter(({ f }) => f.id !== n.folder_id);
      menu(e, [
        inTrash
          ? { label: '恢复到“' + (defaultFolder()?.name || '备忘录') + '”', icon: 'archive-restore', onClick: () => moveNote(n.id, defaultFolder()?.id) }
          : { label: '移到…', icon: 'folder-input', disabled: !targets.length, onClick: () => moveMenu(e, n) },
        { label: '复制文本', icon: 'copy', disabled: n.is_locked, onClick: () => copyNote(n.id) },
        { label: '导出为 Markdown', icon: 'file-down', disabled: n.is_locked, onClick: () => exportNote(n.id) },
        '-',
        { label: inTrash ? '永久删除' : '删除', icon: 'trash-2', danger: true, onClick: () => deleteNote(n.id) },
      ]);
    }

    function moveMenu(at, n) {
      const items = tree().map(({ f, depth }) => ({
        label: `${'\u2003'.repeat(depth)}${f.name}`, icon: 'folder', checked: f.id === n.folder_id, disabled: f.id === n.folder_id,
        onClick: () => moveNote(n.id, f.id),
      }));
      setTimeout(() => menu(at, [{ section: '移到文件夹' }, ...items]), 0);
    }

    // ---- notes CRUD
    async function noteText(id) {
      if (ED?.id === id && ED.editor) return ED.editor.toMarkdown();
      const n = await get(`/api/notes/item/${enc(id)}`);
      return n.markdown ?? n.text ?? '';
    }
    async function copyNote(id) { try { copyText(await noteText(id), '已复制备忘录文本'); } catch (e) { toastError(e); } }
    async function exportNote(id) {
      try {
        const md = await noteText(id);
        const name = (S.notes.find((n) => n.id === id)?.title || '备忘录').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
        const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }));
        const a = h('a', { href: url, download: `${name}.md` });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } catch (e) { toastError(e); }
    }

    async function moveNote(id, folderId) {
      if (!folderId) return;
      const n = S.notes.find((x) => x.id === id);
      const from = n?.folder_id;
      if (from === folderId) return;
      if (ED?.id === id) await flush();
      try {
        await post('/api/notes/move', { id, folder_id: folderId });
        const name = folderById(folderId)?.name || '';
        if (n) { n.folder_id = folderId; n.folder_name = name; }
        if (S.sel !== ALL && S.sel !== folderId) {
          S.notes = S.notes.filter((x) => x.id !== id);
          if (S.curId === id) closeEditor();
        } else if (ED?.id === id) { ED.folder_id = folderId; renderNoteChrome(); }
        renderList();
        refreshCounts();
        toast(folderId === TRASH ? '已移到“最近删除”' : `已移到“${name}”`, 'success', from && from !== TRASH ? {
          ms: 4200, action: { label: '撤销', onClick: () => moveNote(id, from).then(() => loadList({ keep: true })) },
        } : 1800);
      } catch (e) { toastError(e); }
    }

    async function deleteNote(id) {
      if (!id) { // unsaved draft
        if (ED && !ED.id) { clearTimeout(ED.timer); ED.readonly = true; }
        closeEditor();
        renderList();
        return;
      }
      const n = S.notes.find((x) => x.id === id);
      const inTrash = n?.folder_id === TRASH || S.sel === TRASH;
      if (inTrash) {
        const ok = await confirmDialog(`永久删除“${n?.title || '这条备忘录'}”？`, { title: '永久删除', okLabel: '删除', danger: true, detail: '此操作无法撤销。' });
        if (!ok) return;
      }
      const from = n?.folder_id;
      const idx = filtered().findIndex((x) => x.id === id);
      if (ED?.id === id) { clearTimeout(ED.timer); ED.readonly = true; }
      try {
        await del(`/api/notes/item/${enc(id)}`, inTrash ? { permanent: true } : undefined);
      } catch (e) { if (ED?.id === id) ED.readonly = false; toastError(e); return; }
      S.notes = S.notes.filter((x) => x.id !== id);
      if (S.curId === id) {
        const list = filtered();
        const next = list[Math.min(idx, list.length - 1)];
        S.curId = null;
        if (next && !matchMedia('(max-width: 640px)').matches) openNote(next.id); else closeEditor();
      }
      renderList();
      refreshCounts();
      if (inTrash) toast('已永久删除', 'success', 1600);
      else toast('已移到“最近删除”', 'success', from ? { ms: 4200, action: { label: '撤销', onClick: () => restoreTo(id, from) } } : 1800);
    }

    async function restoreTo(id, folderId) {
      try {
        await post('/api/notes/move', { id, folder_id: folderId });
        await loadList({ keep: true });
        refreshCounts();
        openNote(id);
      } catch (e) { toastError(e); }
    }

    // ---- editor pane
    const tbRefs = {};
    function edToolbar() {
      const b = (key, ic, tip, fn) => { const x = iconBtn(ic, tip, fn); tbRefs[key] = x; return x; };
      return h('div', { class: 'toolbar nt-ed-tb' },
        iconBtn('chevron-left', '返回', () => { flush(); panes.classList.remove('show-detail'); }, { cls: 'only-narrow nt-back' }),
        tbRefs.status = h('div', { class: 'nt-status' }),
        h('div', { class: 'tools' },
          h('div', { class: 'nt-fmt' },
            tbRefs.aa = h('button', { class: 'icon-btn nt-aa', type: 'button', 'data-tip': '格式', onclick: (e) => formatMenu(e.currentTarget) }, h('span', {}, 'Aa')),
            b('check', 'list-checks', '清单 (Ctrl+Shift+L)', () => ED?.editor.setKind('check')),
            h('span', { class: 'nt-tb-sep hide-narrow' }),
            h('span', { class: 'nt-inline hide-narrow' },
              b('bold', 'bold', '粗体 (Ctrl+B)', () => ED?.editor.inline('bold')),
              b('italic', 'italic', '斜体 (Ctrl+I)', () => ED?.editor.inline('italic')),
              b('underline', 'underline', '下划线 (Ctrl+U)', () => ED?.editor.inline('underline')),
              b('strike', 'strikethrough', '删除线 (Ctrl+Shift+X)', () => ED?.editor.inline('strikeThrough'))),
            b('link', 'link', '链接 (Ctrl+K)', () => ED?.editor.insertLink()),
            h('span', { class: 'nt-tb-sep' })),
          b('more', 'ellipsis', '更多', (e) => moreMenu(e.currentTarget)),
          b('del', 'trash-2', '删除', () => deleteNote(ED?.id ?? null))));
    }

    function formatMenu(at) {
      if (!ED?.editor) return;
      const cur = ED.editor.currentKind();
      menu(at, [
        ...FORMATS.map((f) => (f === '-' ? '-' : { label: f.label, checked: cur === f.k, shortcut: f.shortcut, onClick: () => ED.editor.setKind(f.k) })),
        '-',
        { label: '引用', icon: 'message-square-text', onClick: () => ED.editor.toggleQuote() },
        { label: '增加缩进', shortcut: 'Tab', onClick: () => ED.editor.indent(1) },
        { label: '减少缩进', shortcut: 'Shift+Tab', onClick: () => ED.editor.indent(-1) },
      ]);
    }

    function moreMenu(at) {
      if (!ED) return;
      const n = S.notes.find((x) => x.id === ED.id);
      const inTrash = ED.folder_id === TRASH;
      menu(at, [
        { label: '移到…', icon: 'folder-input', disabled: !ED.id || inTrash, onClick: () => moveMenu(at, n || { id: ED.id, folder_id: ED.folder_id }) },
        inTrash ? { label: '恢复', icon: 'archive-restore', onClick: () => moveNote(ED.id, defaultFolder()?.id) } : null,
        '-',
        { label: '复制文本', icon: 'copy', disabled: !ED.editor, onClick: () => copyText(ED.editor.toMarkdown(), '已复制备忘录文本') },
        { label: '导出为 Markdown', icon: 'file-down', disabled: !ED.id || !ED.editor, onClick: () => exportNote(ED.id) },
        '-',
        { label: '撤销', icon: 'undo-2', shortcut: 'Ctrl+Z', disabled: ED.readonly || !ED.editor, onClick: () => ED.editor.undo() },
        { label: '重做', icon: 'redo-2', shortcut: 'Ctrl+Y', disabled: ED.readonly || !ED.editor, onClick: () => ED.editor.redo() },
        '-',
        { label: '重新载入', icon: 'refresh-cw', disabled: !ED.id, onClick: async () => { await flush(); openNote(ED.id, { force: true }); } },
      ]);
    }

    function setStatus(kind, msg) {
      if (!tbRefs.status) return;
      const map = {
        saved: ['circle-check', '已保存', ''],
        saving: ['loader', '正在保存…', 'busy'],
        edit: ['pencil', '未保存', 'dim'],
        error: ['circle-alert', '保存失败，点按重试', 'err'],
        readonly: ['lock', '只读', 'dim'],
        new: ['square-pen', '新备忘录', 'dim'],
        none: [null, '', ''],
      };
      const [ic, label, cls] = map[kind] || map.none;
      clear(tbRefs.status);
      tbRefs.status.className = `nt-status ${cls}`;
      tbRefs.status.title = msg || '';
      tbRefs.status.onclick = kind === 'error' ? () => save(ED) : null;
      if (ic) tbRefs.status.append(icon(ic), h('span', {}, label));
    }

    function closeEditor() {
      if (ED) { ED.editor?.destroy(); clearTimeout(ED.timer); }
      ED = null;
      S.curId = null;
      openSeq++;
      markActive();
      clear(detail);
      detail.append(edToolbar(), h('div', { class: 'pane-body nt-blank' },
        empty({ app: 'notes', title: S.notes.length ? '未选择备忘录' : '备忘录', text: '从列表中选择一条备忘录，或新建一条。' }),
        h('div', { class: 'nt-blank-act' }, btn('新建备忘录', { kind: 'tinted', icon: 'square-pen', onclick: () => newNote() }))));
      setStatus('none');
      setToolsEnabled(false);
      panes.classList.remove('show-detail');
    }

    function setToolsEnabled(on, { canDelete = on } = {}) {
      for (const k of ['aa', 'check', 'bold', 'italic', 'underline', 'strike', 'link']) if (tbRefs[k]) tbRefs[k].disabled = !on;
      if (tbRefs.more) tbRefs.more.disabled = !ED;
      if (tbRefs.del) tbRefs.del.disabled = !canDelete;
    }

    function banner(kind, ic, text, actions = []) {
      return h('div', { class: `nt-banner ${kind}` }, icon(ic), h('div', { class: 'nt-banner-text' }, text),
        actions.length ? h('div', { class: 'nt-banner-act' }, actions) : null);
    }

    let bannerBox = null;
    let dateLine = null;
    function renderNoteChrome() {
      if (!ED || !bannerBox) return;
      clear(bannerBox);
      const n = ED.note || {};
      if (ED.folder_id === TRASH) {
        bannerBox.append(banner('info', 'trash-2', '这条备忘录在“最近删除”中。要编辑，请先恢复。', [
          btn('恢复', { kind: 'tinted', size: 'sm', onclick: () => moveNote(ED.id, defaultFolder()?.id).then(() => ED && openNote(ED.id, { force: true })) }),
        ]));
      } else if (ED.conflict) {
        bannerBox.append(banner('warn', 'triangle-alert', '这条备忘录已在其他设备上修改。', [
          btn('重新载入', { size: 'sm', onclick: () => { ED.dirty = false; ED.readonly = true; openNote(ED.id, { force: true }); } }),
          btn('保留我的版本', { kind: 'tinted', size: 'sm', onclick: () => { ED.conflict = false; ED.change_tag = null; renderNoteChrome(); save(ED); } }),
        ]));
      } else if (ED.blocked && !ED.force) {
        const att = n.edit_blocker_code === 'attachments';
        bannerBox.append(banner(att ? 'warn' : 'info', att ? 'paperclip' : 'lock',
          att ? '这条备忘录包含附件（图片、扫描件、表格等）。网页接口编辑后会覆盖正文，附件可能丢失。' : (n.edit_blocker || '这条备忘录包含无法在此编辑的内容，暂时只读。'),
          att ? [btn('仍然编辑', { size: 'sm', onclick: () => enableForce() })] : []));
      } else if (ED.force) {
        bannerBox.append(banner('warn', 'triangle-alert', '正在编辑含附件的备忘录：保存后附件可能会丢失。'));
      }
      for (const w of (!ED.blocked && n.edit_warnings) || []) bannerBox.append(banner('info', 'info', w));
      if (dateLine) dateLine.textContent = ED.id ? longDate(toDate(ED.note?.modified_at) || new Date()) : longDate(new Date());
    }

    async function enableForce() {
      const ok = await confirmDialog('仍要编辑这条含附件的备忘录？', {
        title: '编辑含附件的备忘录', okLabel: '仍然编辑', danger: true,
        detail: '通过网页接口保存时会重写正文，图片、扫描件、绘图等附件可能会被移除。建议先在 Apple 设备上备份。',
      });
      if (!ok || !ED) return;
      ED.force = true;
      ED.readonly = false;
      ED.editor.setReadOnly(false);
      renderNoteChrome();
      setToolsEnabled(true);
      setStatus('saved');
      ED.editor.focus(true);
    }

    function mountEditor(note, { markdown, editable, isNew = false }) {
      clear(detail);
      const editor = createEditor({
        onChange: () => changed(),
        onSelection: (s) => {
          tbRefs.bold?.classList.toggle('on', s.bold);
          tbRefs.italic?.classList.toggle('on', s.italic);
          tbRefs.underline?.classList.toggle('on', s.underline);
          tbRefs.strike?.classList.toggle('on', s.strike);
          tbRefs.check?.classList.toggle('on', s.kind === 'check');
        },
      });
      ED.editor = editor;
      bannerBox = h('div', { class: 'nt-banners' });
      dateLine = h('div', { class: 'nt-date' });
      const atts = (note.attachments || []).length ? h('div', { class: 'nt-atts' },
        h('div', { class: 'nt-atts-title' }, icon('paperclip'), `附件 · ${note.attachments.length}`),
        h('div', { class: 'nt-atts-grid' }, note.attachments.map((a) => h('button', {
          class: 'nt-att', type: 'button', title: '下载',
          onclick: () => download(`/api/notes/attachment/${enc(note.id)}?att_id=${encodeURIComponent(a.id)}`),
        }, h('span', { class: 'nt-att-ic' }, icon(attIcon(a))), h('span', { class: 'nt-att-name' }, a.filename || a.uti || '附件'),
        a.size ? h('span', { class: 'nt-att-size' }, fmtBytes(a.size)) : null, icon('download'))))) : null;
      const page = h('div', { class: 'nt-page' }, dateLine, editor.el, atts);
      const scroller = h('div', { class: 'pane-body nt-scroll', onmousedown: (e) => {
        if (e.target === scroller || e.target === page) { e.preventDefault(); if (!ED?.readonly) editor.focus(true); }
      } }, page);
      detail.append(edToolbar(), bannerBox, scroller);
      editor.load(markdown, { editable });
      renderNoteChrome();
      setToolsEnabled(editable, { canDelete: true });
      setStatus(isNew ? 'new' : editable ? 'saved' : 'readonly');
      if (isNew || ED.focusOnOpen) editor.focus(!isNew);
    }

    function attIcon(a) {
      const u = `${a.uti || ''} ${a.filename || ''}`.toLowerCase();
      if (/image|jpeg|png|heic|gif/.test(u)) return 'file-image';
      if (/movie|video|mp4|mov/.test(u)) return 'file-video';
      if (/audio|m4a|mp3/.test(u)) return 'file-audio';
      if (/pdf|scan/.test(u)) return 'file-text';
      if (/table|sheet/.test(u)) return 'table';
      return 'file';
    }
    function fmtBytes(n) {
      if (n < 1024) return `${n} B`;
      if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
      return `${(n / 1048576).toFixed(1)} MB`;
    }

    async function openNote(id, { force = false, fromList = true } = {}) {
      if (!force && ED?.id === id) { panes.classList.add('show-detail'); return; }
      await flush();
      const seq = ++openSeq;
      if (ED) ED.editor?.destroy();
      ED = null;
      S.curId = id;
      store.set('notes.cur', id);
      markActive();
      if (fromList) panes.classList.add('show-detail');
      const row = S.notes.find((n) => n.id === id);
      clear(detail);
      detail.append(edToolbar(), h('div', { class: 'pane-body' }, h('div', { class: 'nt-page' }, skeleton(4, { avatar: false }))));
      setToolsEnabled(false, { canDelete: false });
      if (row?.is_locked) { renderLocked(row); return; }
      let note;
      try {
        note = await get(`/api/notes/item/${enc(id)}`);
      } catch (e) {
        if (seq !== openSeq) return;
        if (e.status === 423) { renderLocked(row || { id }); return; }
        clear(detail);
        detail.append(edToolbar(), h('div', { class: 'pane-body' }, h('div', { class: 'nt-page' }, errorBox(e))));
        setToolsEnabled(false, { canDelete: true });
        return;
      }
      if (seq !== openSeq || !alive) return;
      if (row) { row.title = note.title ?? row.title; row.snippet = note.snippet ?? row.snippet; }
      const inTrash = note.folder_id === TRASH || S.sel === TRASH;
      const md = note.markdown ?? (note.text != null ? note.text : null);
      const blocked = note.editable === false;
      ED = {
        id, note, folder_id: inTrash ? TRASH : note.folder_id, change_tag: note.change_tag ?? null,
        md: md ?? '', force: false, blocked, conflict: false, dirty: false,
        readonly: inTrash || blocked || md == null,
      };
      if (md == null) { renderHtmlFallback(note); return; }
      mountEditor(note, { markdown: md, editable: !ED.readonly });
    }

    function renderHtmlFallback(note) {
      clear(detail);
      const frame = h('iframe', { class: 'nt-frame', sandbox: 'allow-popups allow-popups-to-escape-sandbox' });
      frame.srcdoc = `<!doctype html><meta charset="utf-8"><base target="_blank"><style>body{font:15px/1.55 system-ui,"Microsoft YaHei UI",sans-serif;margin:0;padding:8px 2px;color:${getComputedStyle(document.body).color}}img{max-width:100%}</style>${note.html || ''}`;
      detail.append(edToolbar(), h('div', { class: 'pane-body nt-scroll' }, h('div', { class: 'nt-page' }, h('div', { class: 'nt-date' }, longDate(toDate(note.modified_at))), frame)));
      frame.onload = () => { try { frame.style.height = `${frame.contentDocument.documentElement.scrollHeight + 20}px`; } catch { /* sandboxed */ } };
      setToolsEnabled(false, { canDelete: true });
      setStatus('readonly');
    }

    function renderLocked(row) {
      ED = { id: row.id, note: row, folder_id: row.folder_id, readonly: true };
      clear(detail);
      detail.append(edToolbar(), h('div', { class: 'pane-body nt-locked' },
        h('div', { class: 'nt-lock-ic' }, icon('lock')),
        h('div', { class: 'nt-lock-title' }, '此备忘录已锁定'),
        h('div', { class: 'nt-lock-text' }, 'iCloud 网页接口无法解锁加密备忘录。请在 iPhone、iPad 或 Mac 上用备忘录密码打开。')));
      setToolsEnabled(false, { canDelete: true });
      setStatus('readonly');
    }

    async function newNote() {
      await flush();
      let folder = S.sel === ALL || S.sel === TRASH ? defaultFolder()?.id : S.sel;
      if (!folder) folder = S.folders[0]?.id;
      if (S.query) { search.input.value = ''; S.query = ''; }
      openSeq++;
      if (ED) ED.editor?.destroy();
      ED = { id: null, note: { folder_id: folder }, folder_id: folder, change_tag: null, md: '', force: false, blocked: false, conflict: false, readonly: false };
      S.curId = null;
      panes.classList.add('show-detail');
      mountEditor({}, { markdown: '', editable: true, isNew: true });
      renderList();
    }

    // ---- saving
    function changed() {
      if (!ED || ED.readonly) return;
      ED.dirty = true;
      setStatus('edit');
      clearTimeout(ED.timer);
      const target = ED;
      ED.timer = setTimeout(() => save(target), 900);
      const row = listBody.querySelector(ED.id ? `.nt-row[data-id="${CSS.escape(ED.id)}"]` : '.nt-row[data-id=""]');
      if (row) {
        row.querySelector('.nt-row-title span').textContent = ED.editor.title() || '新备忘录';
        row.querySelector('.nt-row-snip').textContent = ED.editor.snippet() || '无附加文本';
      }
    }

    async function save(ed = ED) {
      if (!ed || ed.readonly || !ed.editor || ed.conflict) return;
      clearTimeout(ed.timer);
      if (ed.saving) { ed.again = true; return ed.saving; }
      const md = ed.editor.toMarkdown();
      if (md === ed.md) { ed.dirty = false; if (ed === ED) setStatus(ed.id ? 'saved' : 'new'); return; }
      if (!ed.id && !md.replace(/^#\s*/, '').trim()) return;
      ed.saving = (async () => {
        if (ed === ED) setStatus('saving');
        try {
          const isNew = !ed.id;
          const res = isNew
            ? await post('/api/notes/notes', { folder_id: ed.folder_id, text: md })
            : await patch(`/api/notes/item/${enc(ed.id)}`, { text: md, force: ed.force || undefined, change_tag: ed.change_tag ?? undefined });
          ed.id = res?.id || ed.id;
          ed.change_tag = res?.change_tag ?? ed.change_tag;
          ed.md = md;
          ed.note = { ...ed.note, ...res };
          ed.dirty = ed.editor.toMarkdown() !== md;
          upsertRow(ed, res, isNew);
          if (ed === ED) {
            if (isNew) { S.curId = ed.id; store.set('notes.cur', ed.id); refreshCounts(); }
            setStatus(ed.dirty ? 'edit' : 'saved');
            if (dateLine) dateLine.textContent = longDate(new Date());
          }
        } catch (e) {
          if (e.status === 409 && /其他设备/.test(e.message)) { ed.conflict = true; if (ed === ED) { renderNoteChrome(); setStatus('edit'); } }
          else if (ed === ED) { setStatus('error', e.message); toastError(e); }
          else toastError(e);
          ed.again = false;
        } finally {
          ed.saving = null;
          if (ed.again) { ed.again = false; save(ed); }
        }
      })();
      return ed.saving;
    }

    async function flush() {
      const ed = ED;
      if (!ed || ed.readonly) return;
      clearTimeout(ed.timer);
      await save(ed);
      while (ed.saving) await ed.saving;
    }

    function upsertRow(ed, res, isNew) {
      const patchRow = {
        id: ed.id, title: res?.title ?? ed.editor.title(), snippet: res?.snippet ?? ed.editor.snippet(),
        modified_at: res?.modified_at ?? Date.now(), folder_id: ed.folder_id, folder_name: folderById(ed.folder_id)?.name,
      };
      const row = S.notes.find((n) => n.id === ed.id);
      if (row) Object.assign(row, patchRow);
      else if (isNew && (S.sel === ALL || S.sel === ed.folder_id)) S.notes.unshift(patchRow);
      if (row && S.notes[0] !== row) { S.notes = [row, ...S.notes.filter((n) => n !== row)]; }
      renderList();
    }

    // ---- refresh / keyboard
    async function refresh() {
      await flush();
      try { await loadFolders(true); } catch (e) { toastError(e); return; }
      await loadList({ keep: true, force: true });
      if (ED?.id && !ED.dirty) openNote(ED.id, { force: true, fromList: false });
    }

    function onKey(e) {
      if (!alive || !el.isConnected) return;
      const typing = e.target.closest?.('input, textarea, [contenteditable="true"], .modal, .overlay');
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const list = filtered();
        if (!list.length) return;
        e.preventDefault();
        const i = list.findIndex((n) => n.id === S.curId);
        const next = list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (next && next.id !== S.curId) {
          openNote(next.id, { fromList: false });
          listBody.querySelector(`.nt-row[data-id="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: 'nearest' });
        }
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && S.curId) {
        e.preventDefault();
        deleteNote(S.curId);
      } else if (e.key === 'Enter' && ED && !ED.readonly) {
        e.preventDefault();
        ED.editor.focus(true);
      }
    }
    document.addEventListener('keydown', onKey);
    const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', onHide);

    // ---- boot
    closeEditor();
    clear(sideBody);
    sideBody.append(skeleton(4, { avatar: false }));
    listBody.append(skeleton(6, { avatar: false }));
    loadFolders().then(() => loadList()).catch((e) => { clear(listBody); listBody.append(errorBox(e)); });

    return () => {
      alive = false;
      if (ED && !ED.readonly) { clearTimeout(ED.timer); save(ED); }
      ED?.editor?.destroy();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onHide);
    };
  },
};
