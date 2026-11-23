// sitegen-fast: an original, dependency-free drop-in for makefun-site 1.0.0,
// written from scratch for the make.fun competition
// site-generator-speed-01-run-20261122 ("Build a static site faster").
//
// It returns exactly makefun-site 1.0.0's answer for every input (the same output
// tree, byte for byte), but builds it in a single pass: front matter, Markdown
// and templates are each scanned once, with no token trees, no per-character
// escaping and no plugin pipeline. Templates are compiled to plain JavaScript
// functions at parse time, so rendering a page is straight-line code.
//
// Nothing is read from the clock, the environment, randomness or the disk, and
// nothing is kept from one run() call to the next.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `text` with & < > " and ' escaped: one scan, plain runs copied whole. */
function esc(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    else continue;
    out += s.slice(start, i) + rep;
    start = i + 1;
  }
  return start === 0 ? s : out + s.slice(start);
}

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), "untitled" when nothing is left.
 * Pure ASCII text takes a fast path: NFKD is the identity on ASCII and ASCII
 * holds no combining marks, so normalising changes nothing there.
 */
function slugify(text) {
  // One scan for the common ASCII case (NFKD is the identity on ASCII and
  // ASCII holds no combining marks); any non-ASCII character restarts on the
  // slow path, which normalises and strips marks first.
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 127) return slugifySlow(text);
    const ch = text[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function slugifySlow(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return Number(date.slice(8, 10)) + ' ' + MONTHS[Number(date.slice(5, 7)) - 1] + ' ' + date.slice(0, 4);
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: 'key "' + key + '": ' + s.error } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) if (t === '' || !FM_TAG.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: 'unknown key "' + key + '"' };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. The body is a slice of `text`, never a copy.
 */
function parseFM(text) {
  let pos = 0;
  let idx = 0;
  let closeIdx = -1;
  let closeStart = -1;
  let closeEnd = -1;
  while (true) {
    const e = text.indexOf('\n', pos);
    const lineEnd = e === -1 ? text.length : e;
    const line = text.slice(pos, lineEnd);
    if (idx === 0) {
      if (line !== '---') return { error: 'no front matter' };
    } else if (line === '---') {
      closeIdx = idx;
      closeStart = pos;
      closeEnd = e === -1 ? text.length : e + 1;
      break;
    }
    if (e === -1) break;
    pos = e + 1;
    idx++;
  }
  if (closeIdx === -1) return { error: 'the front matter is not closed' };
  const regionStart = text.indexOf('\n') + 1;
  let fmLines;
  if (closeIdx === 1) fmLines = [];
  else fmLines = text.slice(regionStart, closeStart).slice(0, -1).split('\n');
  const data = {};
  for (let j = 0; j < fmLines.length; j++) {
    const line = fmLines[j];
    if (/^[ \t]*$/.test(line) || line.charCodeAt(0) === 35) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: 'line ' + (j + 2) + ' is not "key: value"' };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: 'unknown key "' + key + '"' };
    if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
    if (raw === '') return { error: 'key "' + key + '" has no value' };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ------------------------------------------------------------------- Markdown

const BLANK_RE = /^[ \t]*$/;
const FENCE_OPEN_RE = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE_RE = /^```[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR_RE = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET_RE = /^[-*] (.*)$/;
const ORDERED_RE = /^(\d{1,9})\. (.*)$/;
const CONTINUED_RE = /^ {2,}\S/;
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The characters inline rendering stops at: escapes, code, strong, emphasis, links, and HTML specials. */
const INLINE_RE = /[\\`*[&<>"']/g;

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING_RE.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a break. */
function endsParagraph(line) {
  const c0 = line.charCodeAt(0);
  if (line === '' || c0 === 32 || c0 === 9) return BLANK_RE.test(line);
  if (c0 === 96) return FENCE_OPEN_RE.test(line);
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return HR_RE.test(line);
  return false;
}

/** A line as it is rendered: spaces and tabs at either end dropped. */
const trimLine = (line) => {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
};

/** The words of one line: its runs of characters other than whitespace. */
function countLine(line) {
  let words = 0;
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c > 127) {
      const m = line.match(/\S+/g);
      return m === null ? 0 : m.length;
    }
    if (c === 32 || c === 9 || c === 11 || c === 12 || c === 13) inWord = false;
    else if (!inWord) {
      inWord = true;
      words++;
    }
  }
  return words;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline, its pieces pushed to `out`. The scan is one regular
 * expression finding the next character that matters (irregexp, in C++); plain
 * runs between them are pushed raw, since the scan itself stops at every
 * character that needs escaping. `link(target)` is a link's href. The shared
 * expression is safe under recursion: lastIndex is set before every exec.
 */
function inlineTo(s, link, out) {
  let i = 0;
  const n = s.length;
  let plain = 0;
  while (i < n) {
    INLINE_RE.lastIndex = i;
    const m = INLINE_RE.exec(s);
    if (m === null) break;
    const j = m.index;
    const c = m[0];
    if (c === '\\') {
      const nx = j + 1 < n ? s[j + 1] : '';
      if (nx !== '' && ESCAPABLE.has(nx)) {
        if (j > plain) out.push(s.slice(plain, j));
        out.push(esc(nx));
        i = j + 2;
        plain = i;
      } else {
        i = j + 1; // a backslash that escapes nothing stays plain
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > plain) out.push(s.slice(plain, j));
        out.push('<code>', esc(s.slice(j + 1, k)), '</code>');
        i = k + 1;
        plain = i;
      } else {
        i = j + 1; // an empty span, or no closer: the backtick stays plain
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (j > plain) out.push(s.slice(plain, j));
          out.push('<strong>');
          inlineTo(s.slice(j + 2, k), link, out);
          out.push('</strong>');
          i = k + 2;
          plain = i;
        } else {
          i = j + 2; // no closer: both stars stay plain
        }
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        if (j > plain) out.push(s.slice(plain, j));
        out.push('<em>');
        inlineTo(s.slice(j + 1, k), link, out);
        out.push('</em>');
        i = k + 1;
        plain = i;
      } else {
        i = j + 1; // no closer: the star stays plain
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', j + 1);
      const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !/\s/.test(target)) {
        if (j > plain) out.push(s.slice(plain, j));
        out.push('<a href="', esc(link(target)), '">');
        inlineTo(s.slice(j + 1, k), link, out);
        out.push('</a>');
        i = mm + 1;
        plain = i;
      } else {
        i = j + 1; // not a link: the bracket stays plain
      }
      continue;
    }
    if (j > plain) out.push(s.slice(plain, j));
    out.push(c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;');
    i = j + 1;
    plain = i;
  }
  if (n > plain) out.push(s.slice(plain, n));
}

/** `s` rendered inline, as one string. */
function inlineStr(s, link) {
  const out = [];
  inlineTo(s, link, out);
  return out.join('');
}

/**
 * `src` rendered in one pass over its lines: its HTML (each block on its own
 * lines, a "\n" after the last), its table of contents (every level 2 and 3
 * heading: level, id and its inline HTML) and its excerpt (the first
 * paragraph's inline HTML, or "").
 */
function renderMD(src, link) {
  const lines = src.split('\n');
  const n = lines.length;
  const out = [];
  const toc = [];
  let excerpt = null;
  let words = 0;
  const ids = new Set();
  let i = 0;
  // A block's kind is read off its first character; only the matching test runs.
  const doList = (isOrdered, first) => {
    const marker = isOrdered ? ORDERED_RE : BULLET_RE;
    const start = isOrdered ? Number(first[1]) : 1;
    const items = [];
    while (i < n) {
      const m = marker.exec(lines[i]);
      if (m !== null) {
        words += countLine(lines[i]);
        items.push([trimLine(isOrdered ? m[2] : m[1])]);
        i++;
      } else if (CONTINUED_RE.test(lines[i])) {
        words += countLine(lines[i]);
        items[items.length - 1].push(trimLine(lines[i]));
        i++;
      } else break;
    }
    const tag = isOrdered ? 'ol' : 'ul';
    const parts = [(isOrdered && start !== 1 ? '<ol start="' + start + '">' : '<' + tag + '>') + '\n'];
    for (const item of items) {
      parts.push('<li>');
      inlineTo(item.join('\n'), link, parts);
      parts.push('</li>\n');
    }
    parts.push('</' + tag + '>\n');
    out.push(parts.join(''));
  };
  while (i < n) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    if (line === '' || ((c0 === 32 || c0 === 9) && BLANK_RE.test(line))) {
      i++;
      continue;
    }
    if (c0 === 96) {
      const fence = FENCE_OPEN_RE.exec(line);
      if (fence === null) {
        // a line opening on ` that is no fence is a paragraph line
      } else {
      words += countLine(line);
      const body = [];
      i++;
      while (i < n && !FENCE_CLOSE_RE.test(lines[i])) {
        words += countLine(lines[i]);
        body.push(lines[i++]);
      }
      if (i < n) words += countLine(lines[i]);
      i++;
      let code = '';
      for (const l of body) code += esc(l) + '\n';
      out.push('<pre><code' + (fence[1] === '' ? '' : ' class="language-' + esc(fence[1]) + '"') + '>' + code + '</code></pre>\n');
        i++;
        continue;
      }
    }
    if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        words += countLine(line);
        const id = uniqueSlug(slugify(h.text), ids);
        const html = inlineStr(h.text, link);
        out.push('<h' + h.depth + ' id="' + id + '">' + html + '</h' + h.depth + '>\n');
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
    }
    if (c0 === 45 || c0 === 42) {
      if (HR_RE.test(line)) {
        words += countLine(line);
        out.push('<hr>\n');
        i++;
        continue;
      }
      const bullet = BULLET_RE.exec(line);
      if (bullet !== null) {
        doList(false, bullet);
        continue;
      }
    }
    if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        words += countLine(lines[i]);
        body.push(lines[i++].replace(/^> ?/, ''));
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      out.push(kept.length === 0 ? '<blockquote>\n</blockquote>\n' : '<blockquote>\n<p>' + inlineStr(kept.join('\n'), link) + '</p>\n</blockquote>\n');
      continue;
    }
    if (c0 >= 48 && c0 <= 57) {
      const ordered = ORDERED_RE.exec(line);
      if (ordered !== null) {
        doList(true, ordered);
        continue;
      }
    }
    const body = [trimLine(line)];
    words += countLine(line);
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      words += countLine(lines[i]);
      body.push(trimLine(lines[i++]));
    }
    const text = body.join('\n');
    if (excerpt === null) {
      const html = inlineStr(text, link);
      excerpt = html;
      out.push('<p>' + html + '</p>\n');
    } else {
      out.push('<p>');
      inlineTo(text, link, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '', words };
}

// ------------------------------------------------------------------ Templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError('template "' + name + '": an else outside an if');
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
    }
  }
  if (stack.length > 1) throw new TemplateError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  return root.body;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `v` walked down `path` from index `k`: each next name an own property, or undefined. */
function ownWalk(v, path, k) {
  for (; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function chainLookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  return ownWalk(s.vars[path[0]], path, 1);
}

const HELPERS = { e: esc, p: ownWalk, l: chainLookup, v: textOf, t: truthy };

/**
 * A template's nodes compiled to a plain function ($C, $T, $D, $H) -> string:
 * $C is the scope chain's head, $T the compiled templates by name, $D the
 * include depth, $H the helpers above. A for loop's element and its `loop`
 * record become plain locals, so a variable inside a loop body is a direct
 * read; anything else is one chain lookup. Includes pass the current scope
 * head, so an included template sees the same bindings. All generated
 * identifiers start with $, which no template name can hold, so generated code
 * can never collide with a template's own names.
 */
function compileTemplate(nodes) {
  const paths = [];
  const pathId = new Map();
  const pid = (path) => {
    const key = path.join('\x00');
    let id = pathId.get(key);
    if (id === undefined) {
      id = paths.length;
      paths.push(path);
      pathId.set(key, id);
    }
    return id;
  };
  let uid = 0;
  const frames = []; // each: Map of template name -> generated identifier, innermost last
  const src = [];
  src.push('let $o=[];');
  const exprFor = (path) => {
    const first = path[0];
    for (let f = frames.length - 1; f >= 0; f--) {
      const g = frames[f].get(first);
      if (g !== undefined) {
        if (path.length === 1) return g;
        return '$H.p(' + g + ',$p' + pid(path) + ',1)';
      }
    }
    return '$H.l($C,$p' + pid(path) + ')';
  };
  const emitNodes = (list) => {
    for (const n of list) emit(n);
  };
  const emit = (n) => {
    switch (n.kind) {
      case 'text':
        src.push('$o.push(' + JSON.stringify(n.text) + ');');
        break;
      case 'var':
        src.push('$o.push($H.e($H.v(' + exprFor(n.path) + ')));');
        break;
      case 'raw':
        src.push('$o.push($H.v(' + exprFor(n.path) + '));');
        break;
      case 'if': {
        src.push('if($H.t(' + exprFor(n.path) + ')!==' + (n.not ? 'true' : 'false') + '){');
        emitNodes(n.then);
        if (n.else !== null) {
          src.push('}else{');
          emitNodes(n.else);
        }
        src.push('}');
        break;
      }
      case 'for': {
        const u = uid++;
        const vId = '$v' + u;
        const lId = '$l' + u;
        src.push('{const $a' + u + '=' + exprFor(n.path) + ';if(Array.isArray($a' + u + ')){const $n' + u + '=$a' + u + '.length;for(let $k' + u + '=0;$k' + u + '<$n' + u + ';$k' + u + '++){');
        if (n.name !== 'loop') src.push('const ' + vId + '=$a' + u + '[$k' + u + '];');
        src.push('const ' + lId + '={index:$k' + u + '+1,first:$k' + u + '===0,last:$k' + u + '===$n' + u + '-1,length:$n' + u + '};');
        src.push('const $s' + u + '=$C;$C={vars:{');
        if (n.name !== 'loop') src.push('[' + JSON.stringify(n.name) + ']:' + vId + ',');
        src.push('loop:' + lId + '},parent:$C};');
        const frame = new Map();
        if (n.name !== 'loop') frame.set(n.name, vId);
        frame.set('loop', lId);
        frames.push(frame);
        emitNodes(n.body);
        frames.pop();
        src.push('$C=$s' + u + ';}}}');
        break;
      }
      case 'include': {
        const u = uid++;
        src.push('if($D<' + INCLUDE_DEPTH + '){const $f' + u + '=$T.get(' + JSON.stringify(n.name) + ');if($f' + u + '!==undefined)$o.push($f' + u + '($C,$T,$D+1,$H));}');
        break;
      }
    }
  };
  emitNodes(nodes);
  src.push('return $o.join("");');
  let decls = '';
  for (let i = 0; i < paths.length; i++) decls += 'const $p' + i + '=' + JSON.stringify(paths[i]) + ';';
  return new Function('$C', '$T', '$D', '$H', decls + src.join('\n'));
}

// ---------------------------------------------------------------------- build

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

/** One site's output tree: path -> text. */
export function run(input) {
  const base = input.site.base_url.replace(/\/+$/, '');
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileTemplate(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  const kept = [];
  for (const s of sources) {
    const fm = parseFM(s.text);
    if ('error' in fm) {
      report.push('refused ' + s.path + ': ' + fm.error);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
      report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own');
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push('refused ' + s.path + ': a post needs a date');
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push('draft ' + s.path);
      continue;
    }
    kept.push(s);
  }

  const bySource = new Map();
  const taken = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? ['posts', 'tags', 'page'] : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return bySource.get(path).url + frag;
      if (path !== null && staticPaths.has(path)) return base + '/' + path + frag;
      broken.add('broken-link ' + s.path + ' -> ' + target);
      return target;
    };
    const md = renderMD(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push({ name, slug });
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTags(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    return fn({ vars: { site, tags: allTags, recent, ...vars }, parent: null }, templates, 0, HELPERS);
  };
  for (const s of kept) {
    const page = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[s.outDir + '/index.html'] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }

  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push('built ' + pageCount + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + statics.length + ' static files');
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
