"""Topotext <-> markdown-ish text conversion for Apple Notes bodies.

Markdown dialect (both rendered and parsed):

* first line                -> note title (paragraph style 0); rendered as ``# Title``
* ``# x`` / ``## x`` / ``### x`` -> title / heading / subheading styles
* ``- x``                   -> bulleted list (style 100)
* ``* x``                   -> dashed list (style 101)
* ``1. x``                  -> numbered list (style 102)
* ``- [ ] x`` / ``- [x] x`` -> checklist (style 103)
* two leading spaces per indent level on list items, ``> `` block quotes
* fenced code blocks (`````) -> monospaced (style 4)
* inline ``**bold**``, ``*italic*``, ``~~strike~~``, ``<u>underline</u>``, ``[text](url)``
"""

from __future__ import annotations

import re
import uuid as uuidlib
from dataclasses import dataclass, field

from .i18n import tr
from .notes_proto import (
    FONT_BOLD,
    FONT_ITALIC,
    STYLE_BODY,
    STYLE_BULLET,
    STYLE_CHECKLIST,
    STYLE_DASH,
    STYLE_HEADING,
    STYLE_MONOSPACED,
    STYLE_NUMBERED,
    STYLE_SUBHEADING,
    STYLE_TITLE,
    AttachmentInfo,
    AttributeRun,
    ParagraphStyle,
    Todo,
    TTString,
)

OBJ = "\ufffc"  # U+FFFC OBJECT REPLACEMENT CHARACTER marks attachments
LIST_STYLES = (STYLE_BULLET, STYLE_DASH, STYLE_NUMBERED, STYLE_CHECKLIST)


def utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


# -------------------------------------------------------------------- model
@dataclass
class Span:
    text: str
    bold: bool = False
    italic: bool = False
    strike: bool = False
    underline: bool = False
    link: str | None = None
    attachment: AttachmentInfo | None = None

    def same_format(self, other: "Span") -> bool:
        return (self.bold, self.italic, self.strike, self.underline, self.link) == (
            other.bold, other.italic, other.strike, other.underline, other.link
        ) and self.attachment is None and other.attachment is None


@dataclass
class Paragraph:
    spans: list[Span] = field(default_factory=list)
    style: int | None = None  # None == plain body
    indent: int = 0
    done: bool = False
    todo_uuid: bytes | None = None
    quote: int = 0
    starting_number: int | None = None

    @property
    def text(self) -> str:
        return "".join(s.text for s in self.spans)


# ------------------------------------------------------ TTString -> paragraphs
def _slices(doc: TTString) -> list[tuple[str, AttributeRun | None]]:
    units = doc.string.encode("utf-16-le", "surrogatepass")
    total = len(units) // 2
    out: list[tuple[str, AttributeRun | None]] = []
    pos = 0
    for run in doc.runs:
        if pos >= total:
            break
        end = min(total, pos + max(run.length, 0))
        out.append((units[pos * 2 : end * 2].decode("utf-16-le", "surrogatepass"), run))
        pos = end
    if pos < total:
        out.append((units[pos * 2 :].decode("utf-16-le", "surrogatepass"), None))
    return out


def _apply_style(para: Paragraph, run: AttributeRun | None) -> None:
    ps = run.paragraph_style if run else None
    if ps is None:
        return
    para.style = ps.style if ps.style != STYLE_BODY else None
    para.indent = max(ps.indent or 0, 0)
    para.quote = ps.block_quote_level or 0
    para.starting_number = ps.starting_number
    if ps.todo is not None:
        para.done = ps.todo.done
        para.todo_uuid = ps.todo.uuid or None


def paragraphs_from_doc(doc: TTString) -> list[Paragraph]:
    paras: list[Paragraph] = []
    cur = Paragraph()
    styled = False
    for text, run in _slices(doc):
        pieces = text.split("\n")
        for i, piece in enumerate(pieces):
            if piece:
                cur.spans.append(_span(piece, run))
            if not styled and (piece or i < len(pieces) - 1):
                _apply_style(cur, run)
                styled = True
            if i < len(pieces) - 1:  # newline: close paragraph
                paras.append(cur)
                cur = Paragraph()
                styled = False
    if cur.spans:
        paras.append(cur)
    return paras


def _span(text: str, run: AttributeRun | None) -> Span:
    if run is None:
        return Span(text)
    hints = run.font_hints or 0
    return Span(
        text,
        bold=bool(hints & FONT_BOLD),
        italic=bool(hints & FONT_ITALIC),
        strike=bool(run.strikethrough),
        underline=bool(run.underline),
        link=run.link,
        attachment=run.attachment_info if OBJ in text else None,
    )


# ------------------------------------------------------------- markdown out
_ATTACHMENT_LABELS = {
    "com.apple.notes.table": ("表格", "Table"),
    "com.apple.notes.gallery": ("扫描文稿", "Scanned Document"),
    "com.apple.notes.inlinetextattachment.hashtag": ("标签", "Tag"),
    "com.apple.notes.inlinetextattachment.mention": ("提及", "Mention"),
    "com.apple.notes.inlinetextattachment.link": ("备忘录链接", "Note Link"),
}


def attachment_label(uti: str | None) -> str:
    u = (uti or "").lower()
    if u in _ATTACHMENT_LABELS:
        return tr(*_ATTACHMENT_LABELS[u])
    if "drawing" in u or "paper" in u or "sketch" in u:
        return tr("绘图", "Drawing")
    if u.startswith("public.") and any(k in u for k in ("jpeg", "png", "heic", "image", "tiff", "gif")):
        return tr("图片", "Image")
    if "url" in u:
        return tr("链接", "Link")
    return tr("附件", "Attachment")


def _wrap(text: str, open_: str, close: str) -> str:
    stripped = text.strip()
    if not stripped:
        return text
    lead = text[: len(text) - len(text.lstrip())]
    trail = text[len(text.rstrip()) :]
    return f"{lead}{open_}{stripped}{close}{trail}"


def _inline_md(span: Span) -> str:
    if span.attachment is not None or OBJ in span.text:
        label = attachment_label(span.attachment.type_uti if span.attachment else None)
        return span.text.replace(OBJ, f"[{label}]")
    t = span.text
    if span.bold and span.italic:
        t = _wrap(t, "***", "***")
    elif span.bold:
        t = _wrap(t, "**", "**")
    elif span.italic:
        t = _wrap(t, "*", "*")
    if span.strike:
        t = _wrap(t, "~~", "~~")
    if span.underline:
        t = _wrap(t, "<u>", "</u>")
    if span.link:
        t = f"[{t}]({span.link})"
    return t


def render_markdown(doc: TTString) -> str:
    paras = paragraphs_from_doc(doc)
    lines: list[str] = []
    in_code = False
    numbers: dict[int, int] = {}
    for p in paras:
        if p.style == STYLE_MONOSPACED:
            if not in_code:
                lines.append("```")
                in_code = True
            lines.append(p.text)
            continue
        if in_code:
            lines.append("```")
            in_code = False
        body = "".join(_inline_md(s) for s in p.spans)
        pad = "  " * p.indent
        if p.style == STYLE_NUMBERED:
            numbers = {k: v for k, v in numbers.items() if k <= p.indent}
        elif p.style in LIST_STYLES:
            numbers = {k: v for k, v in numbers.items() if k < p.indent}
        else:
            numbers = {}
        if p.style == STYLE_TITLE:
            line = f"# {body}" if body else ""
        elif p.style == STYLE_HEADING:
            line = f"## {body}" if body else ""
        elif p.style == STYLE_SUBHEADING:
            line = f"### {body}" if body else ""
        elif p.style == STYLE_BULLET:
            line = f"{pad}- {body}"
        elif p.style == STYLE_DASH:
            line = f"{pad}* {body}"
        elif p.style == STYLE_NUMBERED:
            n = p.starting_number if p.starting_number else numbers.get(p.indent, 0) + 1
            numbers[p.indent] = n
            line = f"{pad}{n}. {body}"
        elif p.style == STYLE_CHECKLIST:
            line = f"{pad}- [{'x' if p.done else ' '}] {body}"
        else:
            line = body
        if p.quote:
            line = "> " * p.quote + line
        lines.append(line)
    if in_code:
        lines.append("```")
    return "\n".join(lines)


def plain_text(doc: TTString) -> str:
    return doc.string.replace(OBJ, "")


# -------------------------------------------------------------- markdown in
_INLINE = re.compile(
    r"\*\*\*(?P<bi>\S(?:.*?\S)?)\*\*\*"
    r"|\*\*(?P<b>\S(?:.*?\S)?)\*\*"
    r"|(?<![\w*])\*(?P<i>[^\s*](?:[^*]*?[^\s*])?)\*(?![\w*])"
    r"|~~(?P<s>\S(?:.*?\S)?)~~"
    r"|<u>(?P<u>.+?)</u>"
    r"|\[(?P<lt>[^\]\n]+)\]\((?P<lu>[a-zA-Z][\w+.-]*:[^)\s]+)\)"
)


def parse_inline(text: str, base: Span | None = None) -> list[Span]:
    base = base or Span("")
    spans: list[Span] = []
    pos = 0
    for m in _INLINE.finditer(text):
        if m.start() > pos:
            spans.append(_derive(base, text[pos : m.start()]))
        if m.group("bi") is not None:
            spans.extend(parse_inline(m.group("bi"), _derive(base, "", bold=True, italic=True)))
        elif m.group("b") is not None:
            spans.extend(parse_inline(m.group("b"), _derive(base, "", bold=True)))
        elif m.group("i") is not None:
            spans.extend(parse_inline(m.group("i"), _derive(base, "", italic=True)))
        elif m.group("s") is not None:
            spans.extend(parse_inline(m.group("s"), _derive(base, "", strike=True)))
        elif m.group("u") is not None:
            spans.extend(parse_inline(m.group("u"), _derive(base, "", underline=True)))
        else:
            spans.extend(parse_inline(m.group("lt"), _derive(base, "", link=m.group("lu"))))
        pos = m.end()
    if pos < len(text):
        spans.append(_derive(base, text[pos:]))
    return [s for s in spans if s.text]


def _derive(base: Span, text: str, **kw: object) -> Span:
    s = Span(text, base.bold, base.italic, base.strike, base.underline, base.link)
    for k, v in kw.items():
        setattr(s, k, v)
    return s


_RE_CHECK = re.compile(r"^(?P<ws>[ \t]*)[-*+] \[(?P<c>[ xX])\](?: (?P<t>.*))?$")
_RE_BULLET = re.compile(r"^(?P<ws>[ \t]*)(?P<m>[-*+•])[ \t]+(?P<t>.*)$")
_RE_NUM = re.compile(r"^(?P<ws>[ \t]*)(?P<n>\d{1,9})[.)][ \t]+(?P<t>.*)$")
_RE_HEAD = re.compile(r"^(?P<h>#{1,6})[ \t]+(?P<t>.*)$")
_RE_QUOTE = re.compile(r"^(?P<q>(?:>[ \t]?)+)(?P<t>.*)$")
_RE_FENCE = re.compile(r"^[ \t]*```")


def _indent(ws: str) -> int:
    return ws.count("\t") + len(ws.replace("\t", "")) // 2


def parse_markdown(text: str) -> list[Paragraph]:
    """Parse the markdown-ish dialect above.  The first line always becomes the title."""
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    paras: list[Paragraph] = []
    in_code = False
    prev_num_indent: int | None = None
    for line in lines:
        if _RE_FENCE.match(line) and (in_code or paras):
            in_code = not in_code
            continue
        if in_code:
            paras.append(Paragraph([Span(line)] if line else [], STYLE_MONOSPACED))
            continue
        if not paras:
            m = _RE_HEAD.match(line)
            title = m.group("t") if m else line
            paras.append(Paragraph(parse_inline(title), STYLE_TITLE))
            continue
        quote = 0
        mq = _RE_QUOTE.match(line)
        if mq:
            quote = mq.group("q").count(">")
            line = mq.group("t")
        p = _parse_line(line)
        p.quote = quote
        if p.style == STYLE_NUMBERED:
            if prev_num_indent is None or prev_num_indent < p.indent:
                if p.starting_number == 1:
                    p.starting_number = None
            else:
                p.starting_number = None
            prev_num_indent = p.indent
        elif p.style not in LIST_STYLES:
            prev_num_indent = None
        paras.append(p)
    return paras


def _parse_line(line: str) -> Paragraph:
    m = _RE_CHECK.match(line)
    if m:
        return Paragraph(
            parse_inline(m.group("t") or ""), STYLE_CHECKLIST, _indent(m.group("ws")),
            done=m.group("c") in "xX",
        )
    m = _RE_BULLET.match(line)
    if m:
        style = STYLE_DASH if m.group("m") == "*" else STYLE_BULLET
        return Paragraph(parse_inline(m.group("t")), style, _indent(m.group("ws")))
    m = _RE_NUM.match(line)
    if m:
        return Paragraph(
            parse_inline(m.group("t")), STYLE_NUMBERED, _indent(m.group("ws")),
            starting_number=int(m.group("n")),
        )
    m = _RE_HEAD.match(line)
    if m:
        level = len(m.group("h"))
        style = {1: STYLE_TITLE, 2: STYLE_HEADING}.get(level, STYLE_SUBHEADING)
        return Paragraph(parse_inline(m.group("t")), style)
    return Paragraph(parse_inline(line))


# ----------------------------------------------------- paragraphs -> runs
def _paragraph_style(p: Paragraph) -> ParagraphStyle | None:
    if p.style is None and not p.quote and not p.indent:
        return None
    ps = ParagraphStyle(style=p.style if p.style is not None else STYLE_BODY)
    if p.indent:
        ps.indent = p.indent
    if p.style == STYLE_CHECKLIST:
        ps.todo = Todo(p.todo_uuid or uuidlib.uuid4().bytes, p.done)
    if p.style == STYLE_NUMBERED and p.starting_number:
        ps.starting_number = p.starting_number
    if p.quote:
        ps.block_quote_level = p.quote
    return ps


def _run_for(span: Span, ps: ParagraphStyle | None, length: int) -> AttributeRun:
    hints = (FONT_BOLD if span.bold else 0) | (FONT_ITALIC if span.italic else 0)
    return AttributeRun(
        length=length,
        paragraph_style=ps,
        font_hints=hints or None,
        strikethrough=1 if span.strike else None,
        underline=1 if span.underline else None,
        link=span.link,
        attachment_info=span.attachment,
    )


def build_text_and_runs(paras: list[Paragraph]) -> tuple[str, list[AttributeRun]]:
    text_parts: list[str] = []
    runs: list[AttributeRun] = []
    for idx, p in enumerate(paras):
        ps = _paragraph_style(p)
        for span in p.spans:
            if span.text:
                runs.append(_run_for(span, ps, utf16_len(span.text)))
                text_parts.append(span.text)
        if idx < len(paras) - 1:
            runs.append(AttributeRun(length=1, paragraph_style=ps))
            text_parts.append("\n")
    return "".join(text_parts), _merge_runs(runs)


def _merge_runs(runs: list[AttributeRun]) -> list[AttributeRun]:
    out: list[AttributeRun] = []
    for run in runs:
        if run.length <= 0:
            continue
        if out and run.attachment_info is None and out[-1].attachment_info is None:
            prev = out[-1]
            a = AttributeRun(**{**prev.__dict__, "length": 0}).encode()
            b = AttributeRun(**{**run.__dict__, "length": 0}).encode()
            if a == b:
                prev.length += run.length
                continue
        out.append(run)
    return out


def reuse_todo_uuids(new: list[Paragraph], old: list[Paragraph]) -> None:
    """Keep checklist item identities stable for items whose text did not change."""
    pool: dict[str, list[bytes]] = {}
    for p in old:
        if p.style == STYLE_CHECKLIST and p.todo_uuid:
            pool.setdefault(p.text, []).append(p.todo_uuid)
    for p in new:
        if p.style == STYLE_CHECKLIST and not p.todo_uuid and pool.get(p.text):
            p.todo_uuid = pool[p.text].pop(0)


# ------------------------------------------------------------ edit checks
@dataclass
class EditCheck:
    editable: bool
    code: str | None = None  # "attachments"
    blocker: str | None = None
    kinds: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def check_editable(doc: TTString) -> EditCheck:
    att_word = tr("附件", "Attachment")
    kinds: list[str] = []
    for run in doc.runs:
        if run.attachment_info is not None:
            kinds.append(attachment_label(run.attachment_info.type_uti))
        elif run.has_field(15):
            kinds.append(att_word)
    if OBJ in doc.string and not kinds:
        kinds.append(att_word)
    if doc.attachments and not kinds:
        kinds.append(att_word)
    warnings: list[str] = []
    names = {
        3: tr("字体", "custom font"),
        10: tr("文字颜色", "text color"),
        11: tr("书写方向", "writing direction"),
        14: tr("高亮", "highlight"),
    }
    sup_label = tr("上标/下标", "superscript/subscript")
    align_label = tr("对齐方式", "text alignment")
    seen: set[str] = set()
    for run in doc.runs:
        for num, label in names.items():
            if run.has_field(num) and label not in seen:
                seen.add(label)
                warnings.append(label)
        if run.superscript and sup_label not in seen:
            seen.add(sup_label)
            warnings.append(sup_label)
        ps = run.paragraph_style
        if ps and (ps.alignment not in (None, 0, 4)) and align_label not in seen:
            seen.add(align_label)
            warnings.append(align_label)
    uniq = list(dict.fromkeys(kinds))
    if uniq:
        blocker = tr(
            f"这条备忘录包含{'、'.join(uniq)}，网页接口无法保留，保存后这些内容会丢失",
            f"This note contains {', '.join(uniq)}, which the web API cannot preserve and would lose on save",
        )
        return EditCheck(False, "attachments", blocker, uniq, warnings)
    return EditCheck(True, warnings=warnings)


# -------------------------------------------------------- title / snippet
_END = -1
_TRUNC = -2
_NEWLINES = (10, 13, 0x2029)
ELLIPSIS = "…"


class _Lexer:
    def __init__(self, text: str) -> None:
        self.cps = [ord(c) for c in text]
        self.pos = 0

    def peek(self) -> int | None:
        if self.pos >= len(self.cps):
            return None
        cp = self.cps[self.pos]
        return 32 if cp == 0xFFFC else cp

    def read(self) -> None:
        self.pos += 1


def _ws(cp: int) -> bool:
    return chr(cp).isspace()


def _parse_snippet(lx: _Lexer, soft: int, hard: int) -> str:
    """Port of the icloud.com ``parseSnippet``: one line, word-truncated."""
    out: list[int] = []

    def done(ell: bool) -> str:
        return "".join(chr(c) for c in out) + (ELLIPSIS if ell else "")

    count = 0
    while True:  # skip leading whitespace (newlines reset the count)
        cp = lx.peek()
        if cp is None:
            return ""
        if not _ws(cp):
            break
        count += 1
        if cp in _NEWLINES:
            count = 0
        lx.read()
        if count >= hard:
            return done(True)
    while True:
        while True:  # word
            cp = lx.peek()
            if cp is None or cp in _NEWLINES:
                return done(False)
            if _ws(cp):
                break
            lx.read()
            if cp != 0x200B:
                count += 1
                out.append(cp)
            if count == hard:
                nxt = lx.peek()
                return done(not (nxt is None or _ws(nxt)))
        if count >= soft:
            return done(False)
        while True:  # whitespace run -> one space
            cp = lx.peek()
            if cp is None or cp in _NEWLINES:
                return done(False)
            if not _ws(cp):
                out.append(32)
                break
            count += 1
            lx.read()
            if count >= hard:
                return done(False)


def title_and_snippet(text: str) -> tuple[str, str]:
    lx = _Lexer(text)
    title = _parse_snippet(lx, 64, 100)
    snippet = _parse_snippet(lx, 255, 255)
    return title, snippet
