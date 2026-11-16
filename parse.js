// parse.js — a fast Markdown renderer whose parse(markdown) returns exactly the
// HTML that marked 18.1.3 renders with its default options (gfm on, breaks off,
// pedantic off, async off). Dependency-free, stateless per call: no caching of
// blocks or lines across calls, nothing written anywhere, no lookup keyed on
// the input text. Written from scratch as an independent implementation of the
// CommonMark 0.31.2 + GFM 0.29 rules as marked applies them.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_REPLACE = /[&<>"']/g;
const ESCAPE_TEST_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESCAPE_REPLACE_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Escape HTML special characters. With encode, every & < > " ' is escaped.
// Without it, an & that already starts a valid entity reference is left alone.
function escapeHtml(html, encode) {
  if (encode) {
    return ESCAPE_TEST.test(html) ? html.replace(ESCAPE_REPLACE, (c) => ESCAPES[c]) : html;
  }
  return ESCAPE_TEST_NO_ENCODE.test(html)
    ? html.replace(ESCAPE_REPLACE_NO_ENCODE, (c) => ESCAPES[c])
    : html;
}

// Decode numeric character references (&#169; &#xA9;) in text, and turn a bare &
// that does not start a valid entity into &amp;. Named entities other than the
// numeric ones are left untouched. Invalid code points (0, surrogates, above
// the Unicode range) become U+FFFD; &#38; / &#x26; become &amp; so the & is
// not decoded twice.
function decodeRefs(html) {
  if (!NUMERIC_REF.test(html)) return html;
  return html.replace(NUMERIC_REF_OR_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const n = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (n === 0 || n > 0x10FFFF || (n >= 0xD800 && n <= 0xDFFF)) return '\uFFFD';
    if (n === 38) return '&amp;';
    return String.fromCodePoint(n);
  });
}

// Percent-encode a link destination the way a browser address bar would, and
// turn a literal %25 back into %. Returns null when the destination cannot be
// encoded (a lone surrogate), which makes the link render as plain text.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Split one table row on unescaped pipes. A pipe preceded by an odd number of
// backslashes is an escaped pipe and stays literal.
function splitCells(row, count) {
  let t = '';
  for (let i = 0; i < row.length; i++) {
    if (row[i] === '|') {
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && row[j] === '\\'; j--) backslashes++;
      t += backslashes % 2 === 1 ? '|' : ' |';
    } else {
      t += row[i];
    }
  }
  const cells = t.split(' |');
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.length = count;
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// Normalize a link reference label: trim, collapse inner whitespace to single
// spaces, and case-fold through upper then lower (so Turkish-free folding).
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Expand tabs to spaces on tab stops of four, starting at column `col`.
function expandTabs(str, col) {
  let out = '';
  let c = col;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\t') {
      const n = 4 - (c % 4);
      out += '    '.slice(0, n);
      c += n;
    } else {
      out += str[i];
      c++;
    }
  }
  return out;
}

// Find the index of the closing character matching the opener at the start of
// the scan, counting nested pairs and skipping backslash escapes. Returns -1
// when no closer exists and -2 when an opener is left unclosed.
function findParen(str, open, close) {
  if (str.indexOf(open) === -1 && str.indexOf(close) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') { i++; continue; }
    if (str[i] === open) depth++;
    else if (str[i] === close) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Remove at most two trailing blank lines from a block of raw HTML, and drop
// a single trailing newline from the end of a line.
function trimBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && /^[ \t]*$/.test(lines[end])) end--;
  return lines.length - end <= 2 ? str : lines.slice(0, end + 1).join('\n');
}

function stripTrailingNewline(str) {
  let n = str.length;
  while (n > 0 && str.charAt(n - 1) === '\n') n--;
  return str.slice(0, n);
}

// ---------------------------------------------------------------------------
// Character classification for emphasis flanking rules.
// A punctuation character is a Unicode punctuation or symbol character.
// Whitespace is a Unicode whitespace character (line start/end count as such).
// ---------------------------------------------------------------------------

const ASCII_PUNCT = new Set(
  ('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~').split('')
);
const PUNCT_RE = /[\p{P}\p{S}]/u;

function isPunctChar(ch) {
  if (ch === undefined) return false;
  const code = ch.charCodeAt(0);
  if (code < 128) return ASCII_PUNCT.has(ch);
  return PUNCT_RE.test(ch);
}

function isSpaceChar(ch) {
  if (ch === undefined) return true; // start/end of line counts as whitespace
  const code = ch.charCodeAt(0);
  if (code < 128) {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
  }
  return /\s/.test(ch);
}

function isAlnumChar(ch) {
  if (ch === undefined) return false;
  const code = ch.charCodeAt(0);
  if (code < 128) {
    return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  }
  return /[\p{L}\p{N}]/u.test(ch);
}

// ---------------------------------------------------------------------------
// Block lexer.
// Works on the normalized source with a cursor. Rules are tried in the same
// order marked tries them: blank lines, indented code, fences, ATX heading,
// thematic break, blockquote, list, raw HTML, link definition, table, setext
// heading, paragraph, then plain text. Link definitions are collected in
// `links` and are consulted only once the whole document has been block-lexed,
// which is why inline parsing happens at render time, not here.
// ---------------------------------------------------------------------------

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const RE_NEWLINE = /(?:[ \t]*(?:\n|$))+/y;
const RE_CODE = /((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/y;
const RE_FENCES =
  / {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/y;
const RE_HEADING = / {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/y;
const RE_HR = / {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/y;
const RE_HTML_BLOCK = new RegExp(
  ' {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)' +
    '|<!--(?:-?>|[\\s\\S]*?(?:-->|$))[^\\n]*(\\n+|$)' +
    '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)' +
    '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)' +
    '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)' +
    '|</?(?:' + BLOCK_TAGS + ')(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)' +
    '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)' +
    '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$))',
  'iy'
);
const RE_DEF = / {0,3}\[(?!\s*\])((?:\\[\s\S]|[^\[\]\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\)))? *(?:\n+|$)/y;
const RE_TABLE =
  / *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)?\n*|$)/y;
const RE_LHEADING =
  /((?:.|\n(?!\s*?\n| {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/y;
const RE_LIST_START = /( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/y;
const RE_BULLET = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))/;

function execAt(re, src, pos) {
  re.lastIndex = pos;
  return re.exec(src);
}

// The paragraph pattern: a first line, then further lines that are neither
// blank nor the start of another block construct.
const INTERRUPT =
  '(?:' +
  ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)' +
  '| {0,3}#{1,6}(?:\\s|$)' +
  '| {0,3}>' +
  '| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)' +
  '| {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]' +
  '| {0,3}(?:<\\/?(?:' + BLOCK_TAGS + ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|![A-Za-z]|<!\\[CDATA\\[)' +
  ')';
const RE_PARAGRAPH = new RegExp(
  '([^\\n]+(?:\\n(?!' + INTERRUPT + '|[ \\t]+\\n)[^\\n]+)*)',
  'y'
);

const RE_TABLE_DELIM = /[:|]/;
const RE_TABLE_ALIGN_CHARS = /^\||\| *$/g;
const RE_TABLE_ALIGN_RIGHT = /^ *-+: *$/;
const RE_TABLE_ALIGN_CENTER = /^ *:-+: *$/;
const RE_TABLE_ALIGN_LEFT = /^ *:-+ *$/;
const RE_TABLE_ROW_BLANK = /\n[ \t]*$/;
const RE_CODE_REMOVE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const RE_INDENT_CODE_COMP = /^(\s+)(?:```)/;
const RE_BEGINNING_SPACE = /^\s+/;
const RE_ENDING_HASH = /#$/;
const RE_ENDING_SPACE_TAB = /[ \t]$/;
const RE_NON_SPACE = /[^ ]/;
const RE_BLANK_LINE = /^[ \t]*$/;
const RE_DOUBLE_BLANK = /\n[ \t]*\n[ \t]*$/;
const RE_BLOCKQUOTE_START = /^ {0,3}>/;
const RE_BLOCKQUOTE_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const RE_BLOCKQUOTE_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const RE_BLOCKQUOTE_SETEXT2 = /^ {0,3}>[ \t]?/gm;
const RE_LIST_NESTING = /^ {1,4}(?=( {4})*[^ ])/g;
const RE_LIST_IS_TASK = /^\[[ xX]\][ \t]+\S/;
const RE_LIST_REPLACE_TASK = /^\[[ xX]\][ \t]+/;
const RE_LIST_TASK_CHECKBOX = /\[[ xX]\]/;
const RE_ANY_LINE = /\n.*\n/;
const RE_HREF_BRACKETS = /^<(.*)>$/;
const RE_LEADING_SPACE_TAB = /^[ \t]+/;
const RE_TAB_GLOBAL = /\t/g;
const RE_SPACE_LINE = /^ +$/gm;
// The next-block checks take the content indent minus one, clamped to
// [0, 3]: a line indented up to the content level is part of the item, not
// a new sibling, so a sublist aligns with the item's content.
const clampIndent = (n) => Math.max(0, Math.min(3, n - 1));
const RE_LIST_ITEM = (bullet) =>
  new RegExp(`^( {0,3}${bullet})((?:[\\t ][^\\n]*)?(?:\\n|$))`);
const RE_NEXT_BULLET = (indent) =>
  new RegExp(`^ {0,${clampIndent(indent)}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`);
const RE_NEXT_HR = (indent) =>
  new RegExp(`^ {0,${clampIndent(indent)}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`);
const RE_NEXT_FENCES = (indent) =>
  new RegExp(`^ {0,${clampIndent(indent)}}(?:\`\`\`|~~~)`);
const RE_NEXT_HEADING = (indent) =>
  new RegExp(`^ {0,${clampIndent(indent)}}#{1,6}(?:\\s|$)`);
const RE_NEXT_HTML = (indent) =>
  new RegExp(
    `^ {0,${clampIndent(indent)}}(?:<\\/?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
    'i'
  );
const RE_NEXT_BLOCKQUOTE = (indent) => new RegExp(`^ {0,${clampIndent(indent)}}>`);

// Blockquote span: lines starting with > plus lazy continuation lines.
const RE_BLOCKQUOTE_SPAN = new RegExp(
  '( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))' +
    '(?:[^\\n]+(?:\\n(?!' + INTERRUPT + '|[ \\t]+\\n)[^\\n]+)*)' +
    '|[^\\n]*)(?:\\n|$))+',
  'y'
);

function lexBlocks(src, top, tokens, merge, links) {
  if (tokens === undefined) tokens = [];
  if (links === undefined) links = Object.create(null);
  tokens.links = links;
  // `merge` lets a paragraph at the start of this call merge into a
  // paragraph that an earlier chunk (of a blockquote) already produced.
  // It only applies to the first paragraph lexed here.
  let pos = 0;
  let guard = Infinity;
  while (pos < src.length) {
    if (src.length - pos >= guard) break; // infinite-loop guard
    guard = src.length - pos;
    let m;

    // Blank lines.
    if ((m = execAt(RE_NEWLINE, src, pos))) {
      const raw = m[0];
      pos += raw.length;
      const prev = tokens[tokens.length - 1];
      if (raw.length === 1 && prev !== undefined) prev.raw += '\n';
      else tokens.push({ type: 'space', raw });
      continue;
    }

    // Indented code block.
    if ((m = execAt(RE_CODE, src, pos))) {
      let raw = m[0];
      // Drop trailing blank lines (at most two lines of slack are kept).
      raw = trimBlankLines(raw);
      const text = raw.replace(RE_CODE_REMOVE_INDENT, '');
      pos += m[0].length;
      const tok = { type: 'code', raw, codeBlockStyle: 'indented', text };
      const prev = tokens[tokens.length - 1];
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + raw;
        prev.text += '\n' + text;
        if (prev.inlineSrc !== undefined) prev.inlineSrc = prev.text;
      } else {
        tokens.push(tok);
      }
      continue;
    }

    // Fenced code block.
    if ((m = execAt(RE_FENCES, src, pos))) {
      const raw = m[0];
      let text = m[3] || '';
      // Compensate the fence indent inside the content.
      const indentMatch = raw.match(RE_INDENT_CODE_COMP);
      if (indentMatch !== null) {
        const indent = indentMatch[1];
        text = text
          .split('\n')
          .map((line) => {
            const lead = line.match(RE_BEGINNING_SPACE);
            if (lead === null) return line;
            return line.slice(Math.min(lead[0].length, indent.length));
          })
          .join('\n');
      }
      const lang = m[2] ? m[2].trim().replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g, '$1') : m[2];
      pos += raw.length;
      tokens.push({ type: 'code', raw, codeBlockStyle: 'fenced', lang, text });
      continue;
    }

    // ATX heading.
    if ((m = execAt(RE_HEADING, src, pos))) {
      let text = m[2].trim();
      if (RE_ENDING_HASH.test(text)) {
        const stripped = stripTrailingChars(text, '#');
        if (!stripped || RE_ENDING_SPACE_TAB.test(stripped)) text = stripped.trim();
      }
      const raw = stripTrailingNewline(m[0]);
      pos += m[0].length;
      tokens.push({ type: 'heading', raw, depth: m[1].length, text });
      continue;
    }

    // Thematic break.
    if ((m = execAt(RE_HR, src, pos))) {
      const raw = stripTrailingNewline(m[0]);
      pos += m[0].length;
      tokens.push({ type: 'hr', raw });
      continue;
    }

    // Blockquote.
    if ((m = execAt(RE_BLOCKQUOTE_SPAN, src, pos))) {
      const raw0 = stripTrailingNewline(m[0]);
      const tok = lexBlockquote(src, pos, raw0, tokens);
      // Advance only past what the blockquote actually consumed: when its
      // chunk loop stops early (a code block, heading, hr, table or html
      // block ends it), the remaining lines are lexed again at this level.
      pos += tok.raw.length;
      tokens.push(tok);
      continue;
    }

    // List.
    if ((m = execAt(RE_LIST_START, src, pos))) {
      const tok = lexList(src, pos, tokens);
      if (tok) {
        pos += tok.raw.length;
        tokens.push(tok);
        continue;
      }
    }

    // Raw HTML block.
    if ((m = execAt(RE_HTML_BLOCK, src, pos))) {
      const raw = trimBlankLines(m[0]);
      pos += m[0].length;
      tokens.push({
        type: 'html',
        raw,
        pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style',
        text: raw,
      });
      continue;
    }

    // Link reference definition.
    if ((m = execAt(RE_DEF, src, pos))) {
      const raw = stripTrailingNewline(m[0]);
      pos += m[0].length;
      const label = m[1];
      const hrefPart = m[2];
      const titlePart = m[3];
      if (!hrefPart.startsWith('<') && findParen(hrefPart, '(', ')') !== -1) {
        // A destination with unbalanced parentheses is not a definition.
        continue;
      }
      const tag = normalizeLabel(label);
      let href = hrefPart
        ? hrefPart.replace(RE_HREF_BRACKETS, '$1').replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g, '$1')
        : '';
      let title;
      if (titlePart) {
        title = titlePart.substring(1, titlePart.length - 1).replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g, '$1');
      }
      const tok = { type: 'def', tag, raw, href, title };
      const prev = tokens[tokens.length - 1];
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + raw;
        prev.text += '\n' + raw;
        if (prev.inlineSrc !== undefined) prev.inlineSrc = prev.text;
      } else {
        if (!links[tag]) links[tag] = { href, title };
        tokens.push(tok);
      }
      continue;
    }

    // Table.
    if ((m = execAt(RE_TABLE, src, pos))) {
      if (RE_TABLE_DELIM.test(m[2])) {
        const tok = lexTable(m);
        if (tok) {
          pos += m[0].length;
          tokens.push(tok);
          continue;
        }
      }
    }

    // Setext heading.
    if ((m = execAt(RE_LHEADING, src, pos))) {
      const text = m[1].trim();
      const raw = stripTrailingNewline(m[0]);
      pos += m[0].length;
      tokens.push({ type: 'heading', raw, depth: m[2].charAt(0) === '=' ? 1 : 2, text });
      continue;
    }

    // Paragraph (top level only).
    if (top) {
      if ((m = execAt(RE_PARAGRAPH, src, pos))) {
        let text = m[1];
        if (text.charAt(text.length - 1) === '\n') text = text.slice(0, -1);
        const raw = m[0];
        pos += raw.length;
        const prev = tokens[tokens.length - 1];
        // A blockquote chunk's first paragraph merges into the paragraph
        // the previous chunk left behind; otherwise it is its own token.
        if (merge && prev && prev.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + raw;
          prev.text += '\n' + text;
          if (prev.inlineSrc !== undefined) prev.inlineSrc = prev.text;
        } else {
          tokens.push({ type: 'paragraph', raw, text });
        }
        merge = false;
        continue;
      }
    }

    // Plain text (one line, merged with a previous text token).
    if ((m = execAt(/([^\n]+)/y, src, pos))) {
      const raw = m[0];
      pos += raw.length;
      const prev = tokens[tokens.length - 1];
      if (prev && prev.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + raw;
        prev.text += '\n' + raw;
        if (prev.inlineSrc !== undefined) prev.inlineSrc = prev.text;
      } else {
        tokens.push({ type: 'text', raw, text: raw });
      }
      continue;
    }

    // Nothing matched: give up rather than loop forever.
    break;
  }
  return tokens;
}

function stripTrailingChars(str, ch) {
  let n = str.length;
  while (n > 0 && str.charAt(n - 1) === ch) n--;
  return str.slice(0, n);
}

// Blockquote: split the matched span into chunks of consecutive `>` lines
// and lazy continuation lines, strip the markers, and lex each chunk into
// the shared token array (so a lazy continuation merges into the paragraph
// the previous chunk left behind).
function lexBlockquote(src, pos, raw, tokens) {
  const lines = raw.split('\n');
  let out = '';
  let body = '';
  const outTokens = [];
  const links = tokens.links;
  let i = 0;
  while (i < lines.length) {
    let isMarker = false;
    const chunk = [];
    let j;
    for (j = i; j < lines.length; j++) {
      if (RE_BLOCKQUOTE_START.test(lines[j])) {
        chunk.push(lines[j]);
        isMarker = true;
      } else if (!isMarker) {
        chunk.push(lines[j]);
      } else {
        break;
      }
    }
    const rest = lines.slice(j);
    const joined = chunk.join('\n');
    const stripped = joined
      .replace(RE_BLOCKQUOTE_MARKER_WS, (all, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(RE_BLOCKQUOTE_SETEXT, '\n    $1')
      .replace(RE_BLOCKQUOTE_SETEXT2, '');
    out = out ? out + '\n' + joined : joined;
    body = body ? body + '\n' + stripped : stripped;
    lexBlocks(stripped, true, outTokens, true, links);
    if (rest.length === 0) break;
    const last = outTokens[outTokens.length - 1];
    if (last && (last.type === 'code' || last.type === 'heading' || last.type === 'hr' || last.type === 'html' || last.type === 'table')) {
      break;
    }
    if (last && last.type === 'blockquote') {
      const nested = last;
      const tail = rest.join('\n');
      const relex = nested.raw + '\n' + tail.replace(RE_BLOCKQUOTE_SETEXT2, '');
      const again = lexBlockquote(src, pos, relex, tokens);
      outTokens[outTokens.length - 1] = again;
      const used = relex.substring(again.raw.length).replace(/^\n/, '');
      const usedLines = used ? used.split('\n').length : 0;
      const left = usedLines ? rest.slice(0, -usedLines) : rest;
      if (left.length > 0) out = out + '\n' + left.join('\n');
      body = body.substring(0, body.length - nested.text.length) + again.text;
      // The nested re-lex may stop early (e.g. a fenced code block ends its
      // chunk loop): any lines it did not consume are still part of THIS
      // blockquote, so keep lexing them as further chunks instead of
      // dropping them (they would otherwise be re-lexed at the outer level
      // as a brand-new blockquote).
      i = j + left.length;
      continue;
    }
    if (last && last.type === 'list') {
      const nested = last;
      const tail = nested.raw + '\n' + rest.join('\n');
      const again = lexListFrom(tail, tokens);
      outTokens[outTokens.length - 1] = again;
      const extra = again.raw.length > nested.raw.length
        ? tail.slice(nested.raw.length + 1, again.raw.length).split('\n').length
        : 0;
      if (extra > 0) {
        const usedLines = rest.slice(0, extra).join('\n');
        out = out + '\n' + usedLines;
        body = body + '\n' + usedLines;
      }
      i = lines.length - rest.length + extra;
      continue;
    }
    i = j;
    if (i >= lines.length) break;
  }
  return { type: 'blockquote', raw: out, tokens: outTokens, text: body };
}

// List: match the first bullet, then collect items one by one.
function lexList(src, pos, tokens) {
  return lexListFrom(src.slice(pos), tokens);
}

function lexListFrom(text, tokens) {
  RE_LIST_START.lastIndex = 0;
  const m = RE_LIST_START.exec(text);
  if (!m) return null;
  const src = text;
  let rest = src;
  const startLen = src.length;
  const bullet = m[1].trim();
  const ordered = bullet.length > 1;
  const list = {
    type: 'list',
    raw: '',
    ordered,
    start: ordered ? +bullet.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  const bulletRe = ordered
    ? `\\d{1,9}\\${bullet.slice(-1)}`
    : `\\${bullet}`;
  const itemRe = RE_LIST_ITEM(bulletRe);
  let pendingLoose = false;
  let guard = Infinity;
  while (rest.length > 0) {
    if (rest.length >= guard) break;
    guard = rest.length;
    let t;
    let isHr = false;
    RE_HR.lastIndex = 0;
    if (!(t = itemRe.exec(rest)) || RE_HR.test(rest)) break;
    const consumed = startLen - rest.length;
    rest = rest.substring(t[0].length);
    const firstLine = t[2].split('\n', 1)[0];
    const bulletLen = t[1].length;
    let content = firstLine;
    let contentIndent;
    if (content.trim() === '') {
      // The bullet's line is empty: the item's content starts on the next
      // line, indented one past the bullet.
      contentIndent = bulletLen + 1;
      content = '';
    } else {
      const expanded = content.replace(RE_LEADING_SPACE_TAB, (v) => expandTabs(v, bulletLen));
      const idx = expanded.search(RE_NON_SPACE);
      contentIndent = idx > 4 ? 1 : idx;
      content = expanded.slice(contentIndent);
      contentIndent += bulletLen;
    }
    let blankAfter = false;
    if (content === '' && RE_BLANK_LINE.test(rest.split('\n', 1)[0] || '')) {
      rest = rest.substring((rest.split('\n', 1)[0] || '').length + 1);
      blankAfter = true;
    }
    if (!blankAfter) {
      const nextBullet = RE_NEXT_BULLET(contentIndent);
      const nextHr = RE_NEXT_HR(contentIndent);
      const nextFences = RE_NEXT_FENCES(contentIndent);
      const nextHeading = RE_NEXT_HEADING(contentIndent);
      const nextHtml = RE_NEXT_HTML(contentIndent);
      const nextBlockquote = RE_NEXT_BLOCKQUOTE(contentIndent);
      let cur = content;
      // Whether the previous line processed was blank: a lazy continuation
      // line after a blank line does not belong to this item.
      let prevBlank = content.trim() === '';
      while (rest.length > 0) {
        const line = rest.split('\n', 1)[0];
        if (
          nextFences.test(line) || nextHeading.test(line) || nextHtml.test(line) ||
          nextBlockquote.test(line) || nextBullet.test(line) || nextHr.test(line)
        ) {
          break;
        }
        const dedented = line.replace(RE_LEADING_SPACE_TAB, (v) => expandTabs(v, 0));
        if (dedented.search(RE_NON_SPACE) >= contentIndent || !line.trim()) {
          content += '\n' + dedented.slice(contentIndent);
        } else {
          if (
            prevBlank ||
            cur.replace(RE_TAB_GLOBAL, '    ').search(RE_NON_SPACE) >= 4 ||
            nextFences.test(cur) || nextHeading.test(cur) || nextHtml.test(cur) || nextHr.test(cur)
          ) {
            break;
          }
          let extra = line;
          if (
            /^ {0,3}(?:=+|-+) *$/.test(line) &&
            lexBlocks(cur + '\n' + line, false).some((tok) => tok.type === 'heading')
          ) {
            extra = '    ' + dedented.replace(/^ {0,3}/, '');
          }
          content += '\n' + extra;
        }
        const lineLen = line.length;
        rest = rest.substring(lineLen + 1);
        cur = dedented.slice(contentIndent);
        prevBlank = line.trim() === '';
        if (rest.length === 0) break;
      }
    }
    const itemRaw = src.slice(consumed, startLen - rest.length);
    if (!list.loose) {
      if (pendingLoose) list.loose = true;
      else if (RE_DOUBLE_BLANK.test(itemRaw)) pendingLoose = true;
    }
    list.items.push({
      type: 'list_item',
      raw: itemRaw,
      task: !!RE_LIST_IS_TASK.test(content),
      loose: false,
      text: content,
      tokens: [],
    });
    if (rest.length === 0) break;
  }
  const last = list.items[list.items.length - 1];
  if (!last) return null;
  last.raw = last.raw.trimEnd();
  last.text = last.text.trimEnd();
  list.raw = src.slice(0, startLen - rest.length).trimEnd();
  for (const item of list.items) {
    item.tokens = lexBlocks(item.text, false, undefined, false, tokens.links);
    if (!list.loose) {
      const spaces = item.tokens.filter((t) => t.type === 'space');
      if (spaces.length > 0 && spaces.some((t) => RE_ANY_LINE.test(t.raw))) list.loose = true;
    }
  }
  for (const item of list.items) {
    const first = item.tokens[0];
    if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
      item.text = item.text.replace(RE_LIST_REPLACE_TASK, '');
      first.raw = first.raw.replace(RE_LIST_REPLACE_TASK, '');
      first.text = first.text.replace(RE_LIST_REPLACE_TASK, '');
      const cb = RE_LIST_TASK_CHECKBOX.exec(item.raw);
      if (cb) {
        const checkbox = { type: 'checkbox', raw: cb[0] + ' ', checked: cb[0] !== '[ ]' };
        item.checked = checkbox.checked;
        // Loose list: the checkbox is the first inline token of the first
        // paragraph (rendered inside the <p>). Tight list: it is a block
        // token of the item (rendered directly under the <li>).
        if (list.loose) {
          first.checkbox = checkbox;
        } else {
          item.tokens.unshift(checkbox);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
    }
  }
  return list;
}

// Table: header cells, alignment row, body rows.
function lexTable(m) {
  const header = splitCells(m[1]);
  const aligns = m[2].replace(RE_TABLE_ALIGN_CHARS, '').split('|');
  const rows = m[3] && m[3].trim() ? m[3].replace(RE_TABLE_ROW_BLANK, '').split('\n') : [];
  const table = { type: 'table', raw: stripTrailingNewline(m[0]), header: [], align: [], rows: [] };
  if (header.length !== aligns.length) return null;
  for (const a of aligns) {
    if (RE_TABLE_ALIGN_RIGHT.test(a)) table.align.push('right');
    else if (RE_TABLE_ALIGN_CENTER.test(a)) table.align.push('center');
    else if (RE_TABLE_ALIGN_LEFT.test(a)) table.align.push('left');
    else table.align.push(null);
  }
  for (let i = 0; i < header.length; i++) {
    table.header.push({ text: header[i], tokens: null, header: true, align: table.align[i] });
  }
  for (const row of rows) {
    table.rows.push(
      splitCells(row, header.length).map((cell, i) => ({
        text: cell,
        tokens: null,
        header: false,
        align: table.align[i],
      }))
    );
  }
  return table;
}

// ---------------------------------------------------------------------------
// Inline parser. Scans the source left to right and builds a flat node list,
// then resolves emphasis / strikethrough delimiter runs with a stack, then
// renders the nodes to HTML. Link labels are parsed recursively with a fresh
// scan; a link whose label itself contains a link is abandoned, exactly as
// the reference does.
// ---------------------------------------------------------------------------

const RE_INLINE_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const RE_INLINE_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const RE_INLINE_BR = /^( {2,}|\\\\)\n(?!\s*$)[ \t]*/;
const RE_AUTOLINK =
  /^<((?:[a-zA-Z][a-zA-Z0-9+.\-]{1,31}:[^<>\s]*)|(?:[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+))>/;
const RE_TAG =
  /^<!--(?:-?>|[\s\S]*?(?:-->|$))|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/;
const RE_START_A = /^<a /i;
const RE_END_A = /^<\/a>/i;
const RE_START_PRE = /^<(pre|code|kbd|script)(\s|>)/i;
const RE_END_PRE = /^<\/(pre|code|kbd|script)(\s|>)/i;
const RE_EMAIL = /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
// Same email pattern without the trailing lookahead: used when the lookahead
// was defeated by a trailing _ that is an emphasis closer (marked parses the
// emphasis content separately, so its lookahead never sees the closer).
const RE_EMAIL_NOLOOK = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+/;
// The email pattern used by marked's extended-autolink rule: local part,
// @, domain labels ending in an alphanumeric, and a lookahead that refuses
// a trailing word character or hyphen (so a.b- and a.b_ do not linkify).
const EMAIL_SRC = '[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
// Extended autolinks: mailto:/xmpp: + email (xmpp may carry one /path
// segment), scheme:// or www. + domain, or a bare email (group 2).
const RE_URL = new RegExp(
  '^(?:mailto:' + EMAIL_SRC +
  '|xmpp:' + EMAIL_SRC + '(?:\\/[A-Za-z0-9@.]+)?' +
  '|((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*' +
  '|([A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])))'
);
const RE_URL_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const RE_LABEL = /(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/;
const RE_LINK = new RegExp(
  '^!?\\[(' + RE_LABEL.source + ')\\]\\([ \\t\\n]*(href)(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(title))?[ \\t\\n]*\\)'
    .replace('href', '<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\))')
    .replace('title', '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)')
);
const RE_REFLINK = new RegExp(
  '^!?\\[(' + RE_LABEL.source + ')\\]\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+)\\]'
);
const RE_NOLINK = /^!?\[(?!\s*\])(?:\\[\s\S]|[^\[\]\\])+\](?:\[\])?/;
const RE_LABEL_SIMPLE = /^(?:\\[\s\S]|[^\[\]\\])+/;

// Finds the next position where a text run must stop: a special character,
// a hard-break sequence, or the start of an extended autolink / email.
const RE_TEXT_STOP = new RegExp(
  '[\\\\<\\[`*!_~]|!(?=\\[)| {2,}\\n|\\\\\\n' +
    '|(?<![^\\s*_~(])www\\.|[hH][tT][tT][pP][sS]?://|[fF][tT][pP]://|mailto:|xmpp:' +
    '|(?=' + RE_EMAIL.source + ')',
  'g'
);

function inlineNodes(src, links, state) {
  if (src === '') return [];
  // Index of the last non-whitespace character: a hard break is only a break
  // when it is not followed by whitespace alone to the end of the source.
  let lastNonWs = src.length - 1;
  while (lastNonWs >= 0 && /\s/.test(src[lastNonWs])) lastNonWs--;

  const nodes = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const ch = src[i];

    // Backslash escape.
    if (ch === '\\') {
      const m = RE_INLINE_ESCAPE.exec(src.slice(i));
      if (m) {
        nodes.push({ k: 'text', s: m[1], raw: false });
        i += m[0].length;
        continue;
      }
      if (src[i + 1] === '\n') {
        if (i + 1 < lastNonWs) {
          nodes.push({ k: 'br' });
          i += 2;
          while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
          continue;
        }
      }
      // A lone backslash is literal text.
      nodes.push({ k: 'text', s: '\\', raw: false });
      i++;
      continue;
    }

    // Inline HTML tag or autolink.
    if (ch === '<') {
      const tag = RE_TAG.exec(src.slice(i));
      if (tag) {
        const html = tag[0];
        if (!state.inLink && RE_START_A.test(html)) state.inLink = true;
        else if (state.inLink && RE_END_A.test(html)) state.inLink = false;
        if (!state.inRawBlock && RE_START_PRE.test(html)) state.inRawBlock = true;
        else if (state.inRawBlock && RE_END_PRE.test(html)) state.inRawBlock = false;
        nodes.push({ k: 'html', s: html });
        i += html.length;
        continue;
      }
      const auto = RE_AUTOLINK.exec(src.slice(i));
      if (auto) {
        const text = auto[1];
        const href = auto[2] === '@' ? 'mailto:' + text : text;
        nodes.push({ k: 'link', href, text, autolink: true });
        i += auto[0].length;
        continue;
      }
    }

    // Link or image: [label](dest "title"), [label][ref], [label][] / [label].
    if (ch === '[' || (ch === '!' && src[i + 1] === '[')) {
      const link = tryLink(src, i, links, state);
      if (link) {
        nodes.push(link.node);
        i += link.len;
        continue;
      }
    }

    // GFM strikethrough: a unitary ~ / ~~ token, not an emphasis
    // delimiter. When it does not match, a single ~ is literal text so a
    // later ~ in the run can still open a del.
    if (ch === '~') {
      const del = tryDel(src, i, links, state);
      if (del) {
        nodes.push(del.node);
        i += del.len;
        continue;
      }
      nodes.push({ k: 'text', s: '~', raw: state.inRawBlock });
      i += 1;
      continue;
    }

    // Delimiter run: emphasis. Collected and resolved after the pass by
    // resolveDelimiters (the CommonMark delimiter stack).
    if (ch === '*' || ch === '_') {
      let j = i + 1;
      while (j < n && src[j] === ch) j++;
      const len = j - i;
      const prev = i > 0 ? src[i - 1] : undefined;
      const next = j < n ? src[j] : undefined;
      const f = flanking(ch, prev, next);
      // pos/y let the marked-faithful delimiter resolver (resolveDelimiters)
      // find the run in the source and in the emphasis mask. y is the run
      // length the rule of three uses; it equals len for a lexed run, and a
      // remainder left by an earlier match keeps the original run's y.
      nodes.push({ k: 'delim', ch, len, y: len, pos: i, canOpen: f.canOpen, canClose: f.canClose });
      i = j;
      continue;
    }

    // Code span.
    if (ch === '`') {
      const m = RE_INLINE_CODE.exec(src.slice(i));
      if (m) {
        let text = m[2].replace(/\n/g, ' ');
        if (/[^ ]/.test(text) && text.startsWith(' ') && text.endsWith(' ')) {
          text = text.substring(1, text.length - 1);
        }
        nodes.push({ k: 'code', s: text });
        i += m[0].length;
        continue;
      }
      // Not a code span: the whole backtick run is literal text, and it is
      // never re-tried as a span from inside the run.
      let j = i + 1;
      while (j < n && src[j] === '`') j++;
      nodes.push({ k: 'text', s: src.slice(i, j), raw: false });
      i = j;
      continue;
    }

    // Extended autolink (GFM): www., scheme://, bare email. Not inside links.
    if (!state.inLink && (ch === 'w' || ch === 'h' || ch === 'f' || ch === 'm' || ch === 'x' || isAlnumChar(ch))) {
      const url = tryUrl(src, i, nodes);
      if (url) {
        nodes.push(url.node);
        i += url.len;
        continue;
      }
    }

    // Plain text run.
    let end = scanTextEnd(src, i, lastNonWs);
    if (end === i) {
      // No text here: either a hard break (two spaces + newline) right
      // after a token, or a single character the stop pattern caught.
      let j = i;
      while (j < n && src[j] === ' ') j++;
      if (j > i + 1 && src[j] === '\n' && j < lastNonWs) {
        nodes.push({ k: 'br' });
        i = j + 1;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        continue;
      }
      end = i + 1; // never stall
    }
    let text = src.slice(i, end);
    // A hard break of two spaces: handled by the stop pattern, but the run
    // may end right at one; emit it as a break when it is one.
    nodes.push({ k: 'text', s: state.inRawBlock ? text : decodeRefs(text), raw: state.inRawBlock });
    i = end;
    // Hard break after the text run (two spaces + newline, or backslash +
    // newline handled above).
    if (i < n && src[i] === ' ' && src[i + 1] === ' ') {
      let j = i;
      while (j < n && src[j] === ' ') j++;
      if (src[j] === '\n' && j < lastNonWs) {
        nodes.push({ k: 'br' });
        i = j + 1;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
      }
    }
  }

  // Resolve emphasis with marked's forward scan (delimiter pool, rule of
  // three, and the emphasis mask that hides runs inside links/code spans).
  // The mask is only built when a delimiter run is present at all.
  let hasDelim = false;
  for (let d = 0; d < nodes.length; d++) {
    if (nodes[d].k === 'delim') { hasDelim = true; break; }
  }
  if (hasDelim) resolveDelimiters(nodes, src, computeEmMask(src));
  return nodes;
}

function inlineHtml(src, links, state) {
  if (src === '') return '';
  return renderInlineNodes(inlineNodes(src, links, state), state);
}

// Scan forward from `start` to the end of the current text run.
function scanTextEnd(src, start, lastNonWs) {
  RE_TEXT_STOP.lastIndex = start;
  const m = RE_TEXT_STOP.exec(src);
  if (!m) return src.length;
  const pos = m.index;
  // A hard-break candidate that is followed by whitespace alone is not a
  // break: fold it back into the text run and keep scanning.
  if (m[0] === '\\\n' || /^ {2,}\n$/.test(m[0])) {
    const nl = m.index + m[0].length - 1;
    if (nl >= lastNonWs) {
      RE_TEXT_STOP.lastIndex = m.index + m[0].length;
      const m2 = RE_TEXT_STOP.exec(src);
      return m2 ? m2.index : src.length;
    }
  }
  return pos;
}

// Flanking (canOpen / canClose) for a * or _ delimiter run, given the
// characters before (prev) and after (next) the run.
function flanking(ch, prev, next) {
  const leftFlanking = next !== undefined && !isSpaceChar(next) &&
    (!isPunctChar(next) || prev === undefined || isSpaceChar(prev) || isPunctChar(prev));
  const rightFlanking = prev !== undefined && !isSpaceChar(prev) &&
    (!isPunctChar(prev) || next === undefined || isSpaceChar(next) || isPunctChar(next));
  let canOpen, canClose;
  if (ch === '_') {
    canOpen = leftFlanking && (!rightFlanking || isPunctChar(prev));
    canClose = rightFlanking && (!leftFlanking || isPunctChar(next));
  } else {
    canOpen = leftFlanking;
    canClose = rightFlanking;
  }
  if (ch === '_' && isAlnumChar(prev) && isAlnumChar(next)) {
    canOpen = false;
    canClose = false;
  }
  return { canOpen, canClose };
}

// GFM strikethrough: an opening run of 1-2 tildes, closed by a run of the
// same length. A nested opener of the same length must be closed first (a
// pool), so ~~a ~~b~~ c~~ is one outer del with an inner del. Runs that can
// both open and close, or neither, are ignored by the scan.
function tryDel(src, i, links, state) {
  const n = src.length;
  let j = i;
  while (j < n && src[j] === '~') j++;
  const o = j - i;
  if (o < 1 || o > 2) return null;
  const next = j < n ? src[j] : undefined;
  const prev = i > 0 ? src[i - 1] : undefined;
  // The opener must be left-flanking: a following non-space character, and
  // when it is punctuation the preceding character must be space/punctuation.
  if (next === undefined || isSpaceChar(next)) return null;
  if (isPunctChar(next) && prev !== undefined && !isSpaceChar(prev) && !isPunctChar(prev)) return null;
  let p = o;
  let k = j;
  while (k < n) {
    // A backslash escapes the next character: an escaped ~ is literal
    // text, never a delimiter.
    if (src[k] === '\\' && k + 1 < n) { k += 2; continue; }
    if (src[k] !== '~') { k++; continue; }
    let m = k;
    while (m < n && src[m] === '~') m++;
    if (m - k === o) {
      const runPrev = k > 0 ? src[k - 1] : undefined;
      const runNext = m < n ? src[m] : undefined;
      const canOpen = runNext !== undefined && !isSpaceChar(runNext) &&
        (!isPunctChar(runNext) || runPrev === undefined || isSpaceChar(runPrev) || isPunctChar(runPrev));
      const canClose = runPrev !== undefined && !isSpaceChar(runPrev) &&
        (!isPunctChar(runPrev) || runNext === undefined || isSpaceChar(runNext) || isPunctChar(runNext));
      // A run that can close is a closer even when it can also open
      // (delRDelim groups 5/6); a pure opener adds to the pool.
      if (canClose) {
        p -= o;
        if (p <= 0) {
          const children = inlineNodes(src.slice(j, k), links, state);
          return { node: { k: 'del', children }, len: (k + o) - i };
        }
      } else if (canOpen) {
        p += o;
      }
    }
    k = m;
  }
  return null;
}

// Extended autolink at position i, or null. `nodes` is the inline nodes
// collected so far in this parse, used to tell a trailing _ that closes an
// open _ emphasis apart from a _ that is just part of the word.
function tryUrl(src, i, nodes) {
  const rest = src.slice(i);
  const m = RE_URL.exec(rest);
  if (!m) return null;
  // A bare email (group 2) is not backpedalled; its href gets mailto:.
  if (m[2] !== undefined) {
    let text = m[0];
    // The (?![\w-]) lookahead truncates the email when it is followed by a
    // _ that is an emphasis closer (inside _..._ / __...__). Re-match
    // without the lookahead; if the email extends further and the char after
    // the full address is a _ that closes a pending _ opener, the _ is a
    // closer and the email takes its full length.
    const full = RE_EMAIL_NOLOOK.exec(rest);
    if (full && full[0].length > text.length && nodes) {
      const after = i + full[0].length;
      if (src[after] === '_') {
        let hasOpener = false;
        for (let q = 0; q < nodes.length; q++) {
          const nd = nodes[q];
          if (nd.k === 'delim' && nd.ch === '_' && nd.canOpen) { hasOpener = true; break; }
        }
        if (hasOpener) {
          let u = after;
          while (u < src.length && src[u] === '_') u++;
          const f = flanking('_', src[after - 1], u < src.length ? src[u] : undefined);
          if (f.canClose) text = full[0];
        }
      }
    }
    return { node: { k: 'link', href: 'mailto:' + text, text, autolink: true }, len: text.length };
  }
  let raw = m[0];
  // Backpedal: trim trailing punctuation, keeping balanced parentheses.
  let trimmed = raw;
  let prev = trimmed;
  do {
    prev = trimmed;
    RE_URL_BACKPEDAL.lastIndex = 0;
    const b = RE_URL_BACKPEDAL.exec(trimmed);
    trimmed = b ? b[0] : '';
  } while (trimmed !== prev);
  if (trimmed === '') return null;
  const text = trimmed;
  const href = m[1] === 'www.' ? 'http://' + text : text;
  return { node: { k: 'link', href, text, autolink: true }, len: trimmed.length };
}

// Inline link / image / reference link at position i, or null.
function tryLink(src, i, links, state) {
  const isImage = src[i] === '!';
  const start = isImage ? i + 1 : i;
  if (src[start] !== '[') return null;
  const offset = isImage ? 2 : 1;
  const rest = src.slice(start);

  // Inline link: [label](dest "title").
  const m = RE_LINK.exec(rest);
  if (m) {
    const label = m[1];
    if (!labelHasTag(rest, label, offset)) {
      let href = m[2].trim();
      let title = m[3] ? m[3].slice(1, -1) : '';
      let rawLen = (isImage ? 1 : 0) + m[0].length;
      if (href.startsWith('<')) {
        if (!href.endsWith('>')) return null;
        const inner = stripTrailingChars(href.slice(0, -1), '\\');
        if ((href.length - inner.length) % 2 === 0) return null;
        href = href.slice(1, -1);
      } else {
        // Truncate the destination at the first unbalanced closing paren:
        // the regex matches greedily, so a `)` that belongs to the text
        // after the link is cut off here, and the title is dropped.
        const close = findParen(href, '(', ')');
        if (close === -2) return null;
        if (close > -1) {
          rawLen = (isImage ? 1 : 0) + label.length + close + 4;
          href = href.substring(0, close);
          title = '';
        }
      }
      const raw = src.slice(i, i + rawLen);
      if (rawEndsEscaped(raw)) return null;
      href = href.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g, '$1');
      title = title.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g, '$1');
      return makeLink(isImage, label, href, title || null, rawLen, links, state);
    }
  }

  // Reference link: [label][ref].
  const r = RE_REFLINK.exec(rest);
  if (r) {
    const label = r[1];
    const ref = r[2];
    const rawLen = (isImage ? 1 : 0) + r[0].length;
    if (!labelHasTag(rest, label, offset)) {
      const def = links[normalizeLabel(ref)];
      if (def) return makeLink(isImage, label, def.href, def.title || null, rawLen, links, state);
      return { node: { k: 'text', s: src[i], raw: false }, len: 1 };
    }
  }

  // Collapsed / shortcut reference link: [label][] or [label].
  const n = RE_NOLINK.exec(rest);
  if (n) {
    // The match never includes a leading `!` (the regex runs on the text
    // after it), so the label is always the first bracket pair.
    const label = n[0].replace(/\[\]$/, '').slice(1, -1);
    const rawLen = (isImage ? 1 : 0) + n[0].length;
    if (!labelHasTag(rest, label, offset)) {
      const def = links[normalizeLabel(label)];
      if (def) return makeLink(isImage, label, def.href, def.title || null, rawLen, links, state);
      return { node: { k: 'text', s: src[i], raw: false }, len: 1 };
    }
  }
  return null;
}

// True when the raw link text ends with a `)` escaped by an odd number of
// preceding backslashes.
function rawEndsEscaped(raw) {
  const stripped = stripTrailingChars(raw.slice(0, -1), '\\');
  return (raw.length - 1 - stripped.length) % 2 === 1;
}

// True when the label contains a `<` that starts an inline tag or autolink
// which runs past the end of the label: such a label can never be a link.
// A tag or autolink fully inside the label is fine.
function labelHasTag(src, label, offset) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = RE_INLINE_CODE.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const rest = src.slice(offset + i);
    const tag = RE_TAG.exec(rest) || RE_AUTOLINK.exec(rest);
    if (tag) {
      if (tag[0].length > label.length - i) return true;
      i += tag[0].length - 1;
    }
  }
  return false;
}

// Build a link/image node: parse the label inline, abandoning the link when
// the label itself contains a link (unless this is an image). The label's
// plain text is kept as `alt` for image alt attributes.
function makeLink(isImage, label, href, title, rawLen, links, state) {
  const cleanLabel = label.replace(/\\([\[\]])/g, '$1');
  const savedInLink = state.inLink;
  const savedEmitted = state.linkEmitted;
  const savedRawBlock = state.inRawBlock;
  state.inLink = true;
  state.linkEmitted = false;
  const labelNodes = inlineNodes(cleanLabel, links, state);
  const innerHtml = renderInlineNodes(labelNodes, state);
  const altText = renderTextNodes(labelNodes);
  const containedLink = state.linkEmitted;
  state.linkEmitted = savedEmitted;
  state.inLink = savedInLink;
  if (!isImage) {
    if (containedLink) {
      state.inRawBlock = savedRawBlock;
      return null;
    }
    state.linkEmitted = true;
  }
  return {
    node: { k: isImage ? 'image' : 'link', href, title, text: cleanLabel, html: innerHtml, alt: altText },
    len: rawLen,
  };
}

// Plain-text rendering of inline nodes (used for image alt text): tags are
// dropped, links contribute their text, images contribute their alt text.
function renderTextNodes(nodes) {
  let out = '';
  for (const node of nodes) {
    switch (node.k) {
      case 'text':
        out += node.s;
        break;
      case 'delim':
        out += node.ch.repeat(node.len);
        break;
      case 'code':
        out += node.s;
        break;
      case 'br':
        break;
      case 'html':
        out += node.s;
        break;
      case 'link':
        out += node.autolink ? node.text : node.alt;
        break;
      case 'image':
        out += node.alt;
        break;
      case 'em':
      case 'strong':
      case 'del':
        out += renderTextNodes(node.children);
        break;
    }
  }
  return out;
}

// The emphasis mask: a same-length copy of the inline source in which
// delimiter runs that marked's emphasis scan must not see are hidden.
// It mirrors, in our own scanner, the two passes marked applies per
// inline token stream:
//   (a) punctuation outside code: a code span keeps its outer backticks
//       but any backtick inside its content becomes '+', and an escaped
//       punctuation character (backslash + punct) becomes '++';
//   (b) block spans: a `[...](...)` link, a code span, or an `<...>` tag
//       becomes '[' + 'a' * (len - 2) + ']'.
// A run is visible to the scan only where the mask still shows its own
// character. The mask is what hides, for example, the `__issuesmost__`
// in `[issue``small`](...)__issuesmost__`__init__`: the stray backtick
// after `small` pairs with the one before `__init__`, so the whole span
// between them is masked and the `__` run inside it never closes.
function computeEmMask(src) {
  const n = src.length;
  const chars = src.split('');
  // Pass (a): code spans and escapes, scanned left to right like the
  // reference's single replace pass: at a backtick run the first later
  // run of the same length closes the span; at a backslash the escape
  // consumes its punctuation; anything inside a matched span is skipped.
  let i = 0;
  while (i < n) {
    const c = chars[i];
    if (c === '`') {
      let j = i + 1;
      while (j < n && chars[j] === '`') j++;
      const runLen = j - i;
      let closer = -1;
      let k = j;
      while (k < n) {
        if (chars[k] === '`') {
          let m = k + 1;
          while (m < n && chars[m] === '`') m++;
          if (m - k === runLen) { closer = k; break; }
          k = m;
        } else {
          k++;
        }
      }
      if (closer !== -1) {
        for (let p = j; p < closer; p++) {
          if (chars[p] === '`') chars[p] = '+';
        }
        i = closer + runLen;
      } else {
        i = j;
      }
      continue;
    }
    if (c === '\\' && i + 1 < n && isPunctChar(chars[i + 1])) {
      chars[i] = '+';
      chars[i + 1] = '+';
      i += 2;
      continue;
    }
    i++;
  }
  // Pass (b): link / code-span / html spans, left to right; a span that
  // matches is replaced in place and skipped, otherwise advance one char.
  i = 0;
  while (i < n) {
    const c = chars[i];
    let end = -1;
    if (c === '[') {
      end = matchMaskLink(chars, i);
    } else if (c === '`') {
      end = matchMaskCode(chars, i);
    } else if (c === '<') {
      end = matchMaskHtml(chars, i);
    }
    if (end !== -1 && end - i >= 2) {
      chars[i] = '[';
      for (let p = i + 1; p < end - 1; p++) chars[p] = 'a';
      chars[end - 1] = ']';
      i = end;
    } else if (c === '`') {
      // A failed code span consumes the whole backtick run: the
      // reference's anyPunctuationOutsideCode has a `+ fallback that
      // swallows the run, and its blockSkip code pattern cannot start
      // right after a backtick. Re-trying the next backtick as a shorter
      // opener would pair it with a later run and swallow delimiters
      // the real lexer leaves visible (e.g. `` ``string`_ `` followed by
      // `*not emphasis*`).
      let j = i + 1;
      while (j < n && chars[j] === '`') j++;
      i = j;
    } else {
      i++;
    }
  }
  return chars.join('');
}

// A `[...](...)` span starting at i (chars[i] === '['), or -1. The label
// holds plain characters or code spans (a backtick run, non-backtick
// content, the same run); the destination holds escapes, plain characters,
// and one level of balanced parentheses.
function matchMaskLink(chars, i) {
  const n = chars.length;
  let p = i + 1;
  while (p < n) {
    const c = chars[p];
    if (c === ']') break;
    if (c === '[') return -1;
    if (c === '`') {
      let j = p + 1;
      while (j < n && chars[j] === '`') j++;
      const runLen = j - p;
      let k = j;
      let closer = -1;
      let closerLen = 0;
      while (k < n) {
        if (chars[k] === '`') {
          let m = k + 1;
          while (m < n && chars[m] === '`') m++;
          closer = k;
          closerLen = m - k;
          break;
        }
        k++;
      }
      if (closer === -1 || closerLen !== runLen) return -1;
      p = closer + closerLen;
      continue;
    }
    p++;
  }
  if (p >= n || chars[p] !== ']' || p + 1 >= n || chars[p + 1] !== '(') return -1;
  let q = p + 2;
  while (q < n) {
    const c = chars[q];
    if (c === ')') return q + 1;
    if (c === '\\' && q + 1 < n) { q += 2; continue; }
    if (c === '(') {
      let r = q + 1;
      let ok = false;
      while (r < n) {
        if (chars[r] === '\\' && r + 1 < n) { r += 2; continue; }
        if (chars[r] === ')') { ok = true; break; }
        if (chars[r] === '(') break;
        r++;
      }
      if (!ok) return -1;
      q = r + 1;
      continue;
    }
    q++;
  }
  return -1;
}

// A code span starting at i (chars[i] === '`'), or -1. The content holds
// no backticks, so the closer is the first later backtick run and must
// have the same length.
function matchMaskCode(chars, i) {
  const n = chars.length;
  // The reference's blockSkip code pattern carries a (?<!`) lookbehind:
  // a run that directly follows a backtick cannot open a span.
  if (i > 0 && chars[i - 1] === '`') return -1;
  let j = i + 1;
  while (j < n && chars[j] === '`') j++;
  const runLen = j - i;
  let k = j;
  while (k < n) {
    if (chars[k] === '`') {
      let m = k + 1;
      while (m < n && chars[m] === '`') m++;
      if (m - k === runLen) return m;
      return -1;
    }
    k++;
  }
  return -1;
}

// An `<...>` span starting at i (chars[i] === '<'), or -1. The character
// after '<' must not be a space, and the span holds no '<' before '>'.
function matchMaskHtml(chars, i) {
  const n = chars.length;
  if (i + 1 >= n || chars[i + 1] === ' ') return -1;
  let k = i + 1;
  while (k < n) {
    if (chars[k] === '<') return -1;
    if (chars[k] === '>') return k + 1;
    k++;
  }
  return -1;
}

// Resolve delimiter runs into em / strong nodes with marked's forward
// scan, not the CommonMark stack. For each opener, in source order, the
// scan walks the later runs of the same character keeping a pool: pure
// openers add to it, a closer drains it, and the opener only matches when
// the pool reaches zero. That is what leaves `*first **code**request*`
// literal on the outside (the inner `**` closer is skipped by the rule
// of three, so the final `*` never drains the pool) while the inner
// `**code**` still forms a strong. The scan reads the emphasis mask, so
// runs hidden inside a link, a code span, or an html span are never
// candidates. Remainders of the opener and the closer land inside the
// emphasis content and are resolved again with the same scan; the
// closer's tail stays after the emphasis as its own run.
// (~ strikethrough is a unitary token, handled before this stage.)
function resolveDelimiters(nodes, src, mask) {
  let i = 0;
  while (i < nodes.length) {
    const opener = nodes[i];
    if (opener.k !== 'delim' || !opener.canOpen) { i++; continue; }
    if (mask[opener.pos] !== opener.ch) { i++; continue; }
    const r = opener.ch;
    const ast = r === '*';
    const k = opener.len;
    const y = opener.y;
    const ctx = delimContext(nodes, i, src, mask);
    // The intraword `_` rule uses the previous token's last character,
    // not the character right before the run.
    const afterCh = ctx.after;
    if (r === '_' && afterCh !== undefined && !isSpaceChar(afterCh) && afterCh !== '_' &&
        isAlnumChar(ctx.n)) {
      i++;
      continue;
    }
    // The opener gate: a run followed by punctuation and preceded by a
    // non-punctuation, non-space character cannot open.
    if (ctx.d !== '' && ctx.n !== '' && !isPunctChar(ctx.n) && !isSpaceChar(ctx.n)) {
      i++;
      continue;
    }
    const n = ctx.n;
    const o = n === r;
    const R = ctx.R;
    let m = k;
    let f = 0;
    let matchJ = -1;
    let matchB = 0;
    // The RDelim skip: at the start of the scan, a run nested inside a
    // `__...*...__` span (asterisk scan) or a `**..._...**` span
    // (underscore scan) is not a candidate at all.
    const skipEnd = rdelimSkipEnd(mask, opener.pos + opener.len, ast);
    for (let j = i + 1; j < nodes.length; j++) {
      const cand = nodes[j];
      if (cand.k !== 'delim' || cand.ch !== r) continue;
      if (skipEnd !== -1 && cand.pos < skipEnd) continue;
      if (mask[cand.pos] !== r) continue;
      const b = cand.len;
      const group = rdelimGroup(r, delimBefore(cand, mask), delimAfter(cand, src, mask));
      if (group === 0) continue;
      if (group === 3 || group === 4) {
        m += b;
        continue;
      }
      if (group === 5 || group === 6 || R) {
        if (o && (group === 5 || group === 6)) break;
        if (y % 3 !== 0 && (y + b) % 3 === 0) {
          f += b;
          continue;
        }
      }
      m -= b;
      if (m > 0) continue;
      matchJ = j;
      matchB = Math.min(b, b + m + f);
      break;
    }
    if (matchJ === -1) {
      if (opener.len > 1) {
        // The run failed as a whole: one delimiter becomes literal text
        // and the rest is retried as a shorter opener (the reference
        // consumes the run one delimiter at a time). The rule-of-three
        // length y stays the original run's length.
        const nextAfter = opener.pos + opener.len < src.length
          ? src[opener.pos + opener.len] : undefined;
        const rf = flanking(r, r, nextAfter);
        nodes.splice(i, 1,
          { k: 'text', s: r, raw: false },
          {
            k: 'delim', ch: r, len: opener.len - 1, y: opener.y,
            pos: opener.pos + 1, canOpen: rf.canOpen, canClose: rf.canClose,
          });
        i++;
        continue;
      }
      i++;
      continue;
    }
    const closer = nodes[matchJ];
    const use = Math.min(k, matchB) % 2 === 1 ? 1 : 2;
    const tag = use === 1 ? 'em' : 'strong';
    const middle = nodes.slice(i + 1, matchJ);
    // The opener remainder and the closer remainder sit inside the
    // emphasis content; the closer tail stays after it. Their flanking
    // is read from the content, not from the outer source: the opener
    // remainder starts the content, the closer remainder ends it.
    const hasOpRem = k - use > 0;
    const hasClRem = matchB - use > 0;
    const children = [];
    if (middle.length === 0 && hasOpRem && hasClRem) {
      // Both remainders and nothing between them: one literal run in
      // the re-lexed content.
      children.push({
        k: 'delim', ch: r, len: (k - use) + (matchB - use),
        y: (k - use) + (matchB - use), pos: opener.pos + use,
        canOpen: false, canClose: false,
      });
    } else {
      if (hasOpRem) {
        const opRem = {
          k: 'delim', ch: r, len: k - use, y: k - use, pos: opener.pos + use,
          pb: '', canOpen: false, canClose: false,
        };
        const nextInU = middle.length > 0 ? src[opener.pos + k]
          : (hasClRem ? r : undefined);
        opRem.canOpen = nextInU !== undefined && !isSpaceChar(nextInU);
        if (middle.length === 0 && !hasClRem) opRem.pa = '';
        children.push(opRem);
      }
      for (let c = 0; c < middle.length; c++) children.push(middle[c]);
      if (hasClRem) {
        const clRem = {
          k: 'delim', ch: r, len: matchB - use, y: matchB - use,
          pos: closer.pos + use, pa: '', canOpen: false, canClose: false,
        };
        const prevInU = middle.length > 0 ? src[closer.pos - 1]
          : (hasOpRem ? r : undefined);
        clRem.canClose = prevInU !== undefined && !isSpaceChar(prevInU);
        if (middle.length > 0) clRem.pb = mask[closer.pos - 1];
        else if (!hasOpRem) clRem.pb = '';
        children.push(clRem);
      }
    }
    if (children.length > 0) resolveDelimiters(children, src, mask);
    const wrapped = { k: tag, children };
    const tailLen = closer.len - matchB;
    const replacement = [wrapped];
    if (tailLen > 0) {
      const tailPos = closer.pos + matchB;
      const runStart = closer.pos - (closer.y - closer.len);
      const beforeRun = runStart > 0 ? src[runStart - 1] : undefined;
      const afterTail = tailPos + tailLen < src.length ? src[tailPos + tailLen] : undefined;
      const tf = flanking(r, beforeRun, afterTail);
      replacement.push({
        k: 'delim', ch: r, len: tailLen, y: closer.y, pos: tailPos,
        canOpen: tf.canOpen, canClose: tf.canClose,
      });
    }
    nodes.splice(i, matchJ - i + 1, ...replacement);
    i++;
  }
}

// The character before (pb) and after (pa) a delimiter run for the
// RDelim group classification. A remainder node carries overrides for
// the side that faces the edge of the re-lexed emphasis content.
function delimBefore(node, mask) {
  if (node.pb !== undefined) return node.pb;
  const runStart = node.pos - (node.y - node.len);
  return runStart > 0 ? mask[runStart - 1] : '';
}

function delimAfter(node, src, mask) {
  if (node.pa !== undefined) return node.pa === '' ? undefined : node.pa;
  const end = node.pos + node.len;
  return end < src.length ? mask[end] : undefined;
}

// The context marked's scan uses for an opener: n (the previous token's
// last character), d (the punctuation character after the run, or ''),
// R (whether the opener can also close), and after (the character after
// the run). A tail left by an earlier match reads n from the character
// before the whole run, because the mask walk-back counts the delimiters
// the earlier match already consumed.
function delimContext(nodes, idx, src, mask) {
  const node = nodes[idx];
  const r = node.ch;
  const runStart = node.pos - (node.y - node.len);
  const p = node.pb !== undefined ? node.pb
    : (runStart > 0 ? mask[runStart - 1] : '');
  const isTail = node.y > node.len;
  let n;
  let u;
  if (isTail) {
    n = p;
    u = p === '*' || p === '_' || isPunctChar(p);
  } else {
    n = prevChar(nodes, idx);
    u = isPunctChar(n) || isSpaceChar(n);
  }
  const after = node.pa !== undefined
    ? (node.pa === '' ? undefined : node.pa)
    : (node.pos + node.len < src.length ? src[node.pos + node.len] : undefined);
  const d = after !== undefined && isPunctChar(after) ? after : '';
  const h = p === '*' || p === '_' || isPunctChar(p);
  const R = p !== '' && !isSpaceChar(p) && (d !== '' || (r === '*' && !h));
  return { n, d, R, after, u };
}

// The previous token's last character, as the inline token loop tracks
// it: a text token that ends with '_' does not update it, so walk back
// through the text run; a non-text token resets it to ''. An unmatched
// delimiter run is literal text, so its character counts, except that a
// '_' run ends the text with '_' and is skipped the same way.
function prevChar(nodes, idx) {
  for (let j = idx - 1; j >= 0; j--) {
    const nd = nodes[j];
    if (nd.k === 'text') {
      const c = nd.s[nd.s.length - 1];
      if (c !== undefined && c !== '_') return c;
      continue;
    }
    if (nd.k === 'delim') {
      if (nd.ch !== '_') return nd.ch;
      continue;
    }
    return '';
  }
  return '';
}

// The RDelim skip: at the start of the scan, a run nested inside a
// `__...*...__` span (asterisk scan) or a `**..._...**` span (underscore
// scan) is not a candidate. Returns the source position the skip ends at
// (the start of the closing run), or -1 when the pattern is absent.
function rdelimSkipEnd(mask, from, ast) {
  const sub = mask.slice(from);
  const re = ast
    ? /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)/
    : /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)/;
  const m = re.exec(sub);
  return m ? from + m[0].length : -1;
}

// RDelim group of a candidate run from the mask characters around it
// (pb before, pa after). Groups 1/2 close only, 3/4 open only, 5/6 open
// and close; 0 means the run is no candidate at all. The GFM asterisk
// rules count '~' as a non-punctuation character; the underscore rules
// do not, and underscore has no group 6.
function rdelimGroup(ch, pb, pa) {
  const ast = ch === '*';
  const punctB = isPunctChar(pb) && !(ast && pb === '~');
  const punctA = isPunctChar(pa) && !(ast && pa === '~');
  const psB = isSpaceChar(pb) || punctB;
  const psA = isSpaceChar(pa) || punctA;
  const npsB = !isSpaceChar(pb) && (!isPunctChar(pb) || (ast && pb === '~'));
  const npsA = !isSpaceChar(pa) && (!isPunctChar(pa) || (ast && pa === '~'));
  const spB = isSpaceChar(pb);
  if (punctB && isSpaceChar(pa)) return 1;
  if (npsB && psA) return 2;
  if (psB && npsA) return 3;
  if (spB && punctA) return 4;
  if (punctB && punctA) return 5;
  if (ast && npsB && npsA) return 6;
  return 0;
}

function renderInlineNodes(nodes, state) {
  let out = '';
  for (const node of nodes) {
    switch (node.k) {
      case 'text':
        out += node.raw ? node.s : escapeHtml(node.s, false);
        break;
      case 'delim':
        out += node.ch.repeat(node.len);
        break;
      case 'code':
        out += '<code>' + escapeHtml(node.s, true) + '</code>';
        break;
      case 'br':
        out += '<br>';
        break;
      case 'html':
        out += node.s;
        break;
      case 'link': {
        if (node.autolink) {
          const href = cleanUrl(node.href);
          if (href === null) { out += escapeHtml(node.text, true); break; }
          out += '<a href="' + escapeHtml(href, true) + '">' + escapeHtml(node.text, true) + '</a>';
        } else {
          const href = cleanUrl(node.href);
          if (href === null) { out += node.html; break; }
          let a = '<a href="' + escapeHtml(href, false) + '"';
          if (node.title) a += ' title="' + escapeHtml(node.title, false) + '"';
          out += a + '>' + node.html + '</a>';
        }
        break;
      }
      case 'image': {
        const href = cleanUrl(node.href);
        if (href === null) { out += escapeHtml(node.alt, false); break; }
        let img = '<img src="' + escapeHtml(href, false) + '" alt="' + escapeHtml(node.alt, false) + '"';
        if (node.title) img += ' title="' + escapeHtml(node.title, false) + '"';
        out += img + '>';
        break;
      }
      case 'em':
        out += '<em>' + renderInlineNodes(node.children, state) + '</em>';
        break;
      case 'strong':
        out += '<strong>' + renderInlineNodes(node.children, state) + '</strong>';
        break;
      case 'del':
        out += '<del>' + renderInlineNodes(node.children, state) + '</del>';
        break;
    }
  }
  return out;
}

// Task-list checkbox: an <input> tag followed by a space.
function renderCheckbox(tok) {
  return '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

// ---------------------------------------------------------------------------
// Block renderer.
// ---------------------------------------------------------------------------

function renderBlocks(tokens, links, state) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space':
        break;
      case 'code': {
        const lang = (tok.lang || '').match(/^\S*/)?.[0] || '';
        let text = tok.text ? tok.text.replace(/\n$/, '') + '\n' : '';
        if (lang) {
          out += '<pre><code class="language-' + escapeHtml(lang, false) + '">' + escapeHtml(text, true) + '</code></pre>\n';
        } else {
          out += '<pre><code>' + escapeHtml(text, true) + '</code></pre>\n';
        }
        break;
      }
      case 'heading': {
        out += '<h' + tok.depth + '>' + inlineHtml(tok.text, links, state) + '</h' + tok.depth + '>\n';
        break;
      }
      case 'hr':
        out += '<hr>\n';
        break;
      case 'blockquote': {
        out += '<blockquote>\n' + renderBlocks(tok.tokens, links, state) + '</blockquote>\n';
        break;
      }
      case 'list': {
        const tag = tok.ordered ? 'ol' : 'ul';
        const start = tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '';
        let body = '';
        for (const item of tok.items) body += renderListItem(item, links, state);
        out += '<' + tag + start + '>\n' + body + '</' + tag + '>\n';
        break;
      }
      case 'html':
        out += tok.text;
        break;
      case 'def':
        break;
      case 'table': {
        let head = '';
        for (const cell of tok.header) head += renderTableCell(cell, links, state);
        let rows = '';
        for (const row of tok.rows) {
          let cells = '';
          for (const cell of row) cells += renderTableCell(cell, links, state);
          rows += '<tr>\n' + cells + '</tr>\n';
        }
        out += '<table>\n<thead>\n<tr>\n' + head + '</tr>\n</thead>\n';
        if (rows) out += '<tbody>' + rows + '</tbody>';
        out += '</table>\n';
        break;
      }
      case 'paragraph': {
        const cb = tok.checkbox ? renderCheckbox(tok.checkbox) : '';
        out += '<p>' + cb + inlineHtml(tok.text, links, state) + '</p>\n';
        break;
      }
      case 'text': {
        const cb = tok.checkbox ? renderCheckbox(tok.checkbox) : '';
        out += cb + inlineHtml(tok.text, links, state);
        break;
      }
      case 'checkbox': {
        out += renderCheckbox(tok);
        break;
      }
    }
  }
  return out;
}

function renderListItem(item, links, state) {
  let body = renderBlocks(item.tokens, links, state);
  return '<li>' + body + '</li>\n';
}

function renderTableCell(cell, links, state) {
  const tag = cell.header ? 'th' : 'td';
  const inner = inlineHtml(cell.text, links, state);
  return '<' + tag + (cell.align ? ' align="' + cell.align + '"' : '') + '>' + inner + '</' + tag + '>\n';
}

function freshState() {
  return { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true };
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const src = markdown.replace(/\r\n|\r/g, '\n');
  const tokens = lexBlocks(src, true);
  const links = tokens.links;
  // One inline state for the whole document: inLink / inRawBlock persist
  // across blocks, as in marked's lexer.
  const state = freshState();
  return renderBlocks(tokens, links, state);
}
