/* Agent Chat: restricted Markdown for chat messages.
 *
 * Supported blocks: ATX headings (the # needs a following space, so "#tag" stays text),
 * paragraphs with hard line breaks, fenced code (``` or ~~~; an unclosed fence runs to the end),
 * block quotes, ordered and unordered lists (nested by indentation), GFM tables, thematic breaks.
 * Supported inline: `code`, **strong** / __strong__, *em* / _em_, ~~del~~, [text](https://…),
 * bare and <angle> http(s) URLs, backslash escapes. Images become links ("图片：alt", or "Image: alt"
 * when the window runs in English; labels go through window.AgentChatI18n when it is loaded).
 * Not supported: raw HTML (always shown as text), setext headings, reference links, footnotes.
 *
 * parse() returns plain objects; render() turns them into nodes through the caller's h(tag,
 * attrs, ...kids), with strings as text. Nothing here writes HTML, so text is never markup.
 * Only http: and https: URLs become links. Depth and inline length are capped, so malformed
 * or huge input degrades to plain text instead of stalling the page.
 */
(function (root) {
  'use strict';

  // UI labels follow the window language (ui/i18n.js); without it (tests) they stay Chinese.
  const t = (zh, ...args) => {
    const i18n = typeof window !== 'undefined' && window.AgentChatI18n;
    if (i18n) return i18n.t(zh, ...args);
    return zh.replace(/\{(\d+)\}/g, (m, k) => (args[k] == null ? '' : String(args[k])));
  };

  const MAX_DEPTH = 12;
  const MAX_INLINE = 20000;
  const MAX_CANDIDATES = 64;
  const PUNCT = /[!-/:-@[-`{-~]/;
  const ALNUM = /[A-Za-z0-9]/;
  const SPACE = /\s/;

  const RE = {
    fence: /^( {0,3})(`{3,}|~{3,})(.*)$/,
    heading: /^ {0,3}(#{1,6})(?:[ ]+(.*?))?(?:[ ]+#+)?[ ]*$/,
    hr: /^ {0,3}([-*_])(?:[ ]*\1){2,}[ ]*$/,
    quote: /^ {0,3}> ?(.*)$/,
    bullet: /^( *)([-*+])( +|$)(.*)$/,
    ordered: /^( *)(\d{1,9})([.)])( +|$)(.*)$/,
    tableSep: /^ *\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/,
    url: /^https?:\/\/[^\s<>"'）】」』，。；！？、]+/i,
  };

  const leading = (s) => s.length - s.replace(/^ +/, '').length;

  function safeHref(raw) {
    try {
      const url = new URL(String(raw).trim());
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch (err) {
      return null;
    }
  }

  // ---- Blocks ------------------------------------------------------------------------

  function fenceOpen(line) {
    const m = RE.fence.exec(line);
    if (!m) return null;
    if (m[2][0] === '`' && m[3].includes('`')) return null; // ```x` is inline code, not a fence
    return { indent: m[1].length, marker: m[2], info: m[3].trim().split(/\s+/)[0] || '' };
  }

  function listMarker(line) {
    let m = RE.bullet.exec(line);
    if (m) {
      const spaces = m[3].length ? Math.min(m[3].length, 4) : 1;
      return { ordered: false, indent: m[1].length, contentIndent: m[1].length + 1 + spaces, content: m[4] };
    }
    m = RE.ordered.exec(line);
    if (m) {
      const spaces = m[4].length ? Math.min(m[4].length, 4) : 1;
      return {
        ordered: true, number: Number(m[2]), indent: m[1].length,
        contentIndent: m[1].length + m[2].length + 1 + spaces, content: m[5],
      };
    }
    return null;
  }

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const cells = [];
    let cell = '';
    let inCode = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\' && s[i + 1] === '|') { cell += '|'; i++; continue; }
      if (c === '`') inCode = !inCode;
      if (c === '|' && !inCode) { cells.push(cell.trim()); cell = ''; continue; }
      cell += c;
    }
    cells.push(cell.trim());
    return cells;
  }

  function isTableStart(lines, i) {
    if (i + 1 >= lines.length) return false;
    const head = lines[i];
    const sep = lines[i + 1];
    if (!head.includes('|') || !RE.tableSep.test(sep) || !sep.includes('-')) return false;
    if (!sep.includes('|') && !head.trim().startsWith('|')) return false;
    return splitRow(head).length === splitRow(sep).length;
  }

  function startsBlock(lines, j) {
    const line = lines[j];
    const heading = RE.heading.exec(line);
    return Boolean(fenceOpen(line) || (heading && heading[2]) || RE.hr.test(line) || RE.quote.test(line)
      || isTableStart(lines, j) || listMarker(line));
  }

  function parseTable(lines, i, depth) {
    const header = splitRow(lines[i]);
    const align = splitRow(lines[i + 1]).map((cell) => {
      const left = cell.startsWith(':');
      const right = cell.endsWith(':');
      return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
    });
    const rows = [];
    let j = i + 2;
    while (j < lines.length && lines[j].trim() && lines[j].includes('|')) {
      const cells = splitRow(lines[j]);
      rows.push(header.map((_, k) => parseInline(cells[k] || '', depth + 1)));
      j++;
    }
    return {
      block: { type: 'table', align, header: header.map((cell) => parseInline(cell, depth + 1)), rows },
      next: j,
    };
  }

  function parseList(lines, start, depth) {
    const first = listMarker(lines[start]);
    const list = { type: 'list', ordered: first.ordered, start: first.ordered ? first.number : null, tight: true, items: [] };
    let i = start;
    let siblingLimit = first.contentIndent;
    while (i < lines.length) {
      const mk = listMarker(lines[i]);
      if (!mk || mk.ordered !== list.ordered || mk.indent >= siblingLimit || RE.hr.test(lines[i])) break;
      const itemLines = [mk.content];
      let j = i + 1;
      let blanks = 0;
      while (j < lines.length) {
        const line = lines[j];
        if (!line.trim()) { itemLines.push(''); blanks++; j++; continue; }
        const ind = leading(line);
        const nested = listMarker(line);
        if (ind >= mk.contentIndent || (nested && ind > mk.indent + 1)) {
          itemLines.push(line.slice(Math.min(ind, mk.contentIndent)));
          blanks = 0; j++; continue;
        }
        if (nested || blanks || startsBlock(lines, j)) break;
        itemLines.push(line.trim()); // lazy continuation of the item's paragraph
        j++;
      }
      while (itemLines.length > 1 && !itemLines[itemLines.length - 1].trim()) itemLines.pop();
      if (itemLines.slice(1).some((s) => !s.trim())) list.tight = false;
      list.items.push({ children: parseBlocks(itemLines, depth + 1) });
      siblingLimit = mk.contentIndent;
      // Blank lines between two items make the list loose; blank lines before anything else end it.
      let k = j;
      while (k < lines.length && !lines[k].trim()) k++;
      if (k > j || blanks) {
        const next = k < lines.length ? listMarker(lines[k]) : null;
        if (!next || next.ordered !== list.ordered || next.indent >= siblingLimit) { i = j; break; }
        list.tight = false;
      }
      i = k;
    }
    return { block: list, next: i };
  }

  function parseBlocks(lines, depth) {
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      if (depth >= MAX_DEPTH) {
        blocks.push({ type: 'paragraph', inline: [{ type: 'text', text: lines.slice(i).join('\n').trim() }] });
        break;
      }
      const fence = fenceOpen(line);
      if (fence) {
        const close = new RegExp(`^ {0,3}\\${fence.marker[0]}{${fence.marker.length},}[ ]*$`);
        const body = [];
        let j = i + 1;
        let closed = false;
        while (j < lines.length) {
          if (close.test(lines[j])) { closed = true; break; }
          body.push(lines[j].slice(Math.min(leading(lines[j]), fence.indent)));
          j++;
        }
        blocks.push({ type: 'code', lang: fence.info, text: body.join('\n'), closed });
        i = closed ? j + 1 : j;
        continue;
      }
      const m = RE.heading.exec(line);
      if (m && m[2]) {
        blocks.push({ type: 'heading', level: m[1].length, inline: parseInline(m[2] || '', depth) });
        i++;
        continue;
      }
      if (RE.hr.test(line)) { blocks.push({ type: 'hr' }); i++; continue; }
      if (RE.quote.test(line)) {
        const inner = [];
        let j = i;
        while (j < lines.length) {
          const q = RE.quote.exec(lines[j]);
          if (q) { inner.push(q[1]); j++; continue; }
          const lazy = lines[j].trim() && inner.length && inner[inner.length - 1].trim() && !startsBlock(lines, j);
          if (!lazy) break;
          inner.push(lines[j]);
          j++;
        }
        blocks.push({ type: 'quote', children: parseBlocks(inner, depth + 1) });
        i = j;
        continue;
      }
      if (isTableStart(lines, i)) {
        const t = parseTable(lines, i, depth);
        blocks.push(t.block);
        i = t.next;
        continue;
      }
      if (listMarker(line)) {
        const l = parseList(lines, i, depth);
        blocks.push(l.block);
        i = l.next;
        continue;
      }
      const para = [line.trim()];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() && !startsBlock(lines, j)) { para.push(lines[j].trim()); j++; }
      blocks.push({ type: 'paragraph', inline: parseInline(para.join('\n'), depth) });
      i = j;
    }
    return blocks;
  }

  function parse(text) {
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
    return parseBlocks(lines, 0);
  }

  // ---- Inline ------------------------------------------------------------------------

  function matchLink(s, i) {
    // s[i] === '['. Find the matching ']' then '(' url ')'. Bounded so it can't scan forever.
    let depthB = 0;
    let j = i;
    const limit = Math.min(s.length, i + 1000);
    for (; j < limit; j++) {
      const c = s[j];
      if (c === '\\') { j++; continue; }
      if (c === '[') depthB++;
      else if (c === ']') { depthB--; if (depthB === 0) break; }
      else if (c === '\n' && s[j + 1] === '\n') return null;
    }
    if (depthB !== 0 || s[j] !== ']' || s[j + 1] !== '(') return null;
    let depthP = 0;
    let k = j + 1;
    const plimit = Math.min(s.length, j + 2048);
    for (; k < plimit; k++) {
      const c = s[k];
      if (c === '\\') { k++; continue; }
      if (c === '(') depthP++;
      else if (c === ')') { depthP--; if (depthP === 0) break; }
      else if (c === '\n') return null;
    }
    if (depthP !== 0 || s[k] !== ')') return null;
    const target = s.slice(j + 2, k).trim().replace(/^<(.*)>$/, '$1').replace(/\s+("[^"]*"|'[^']*')$/, '');
    const href = safeHref(target);
    if (!href) return null;
    return { label: s.slice(i + 1, j), href, end: k + 1 };
  }

  function trimUrl(url) {
    let u = url.replace(/[.,;:!?'"]+$/, '');
    // Drop unbalanced closing parentheses, e.g. "(see https://x.y/z)".
    while (u.endsWith(')') && (u.match(/\(/g) || []).length < (u.match(/\)/g) || []).length) u = u.slice(0, -1);
    return u;
  }

  function matchEmphasis(s, i, depth, memo) {
    const c = s[i];
    if (c === '~') {
      if (s[i + 1] !== '~' || memo.has('~~')) return null;
      if (!s[i + 2] || SPACE.test(s[i + 2])) return null;
      let k = s.indexOf('~~', i + 2);
      if (k === -1) { memo.add('~~'); return null; }
      for (let n = 0; k !== -1 && n < MAX_CANDIDATES; n++) {
        if (k > i + 2 && !SPACE.test(s[k - 1])) {
          return { node: { type: 'del', children: scan(s.slice(i + 2, k), depth + 1) }, end: k + 2 };
        }
        k = s.indexOf('~~', k + 1);
      }
      return null;
    }
    const double = s[i + 1] === c;
    const d = double ? c + c : c;
    const open = i + d.length;
    const next = s[open];
    if (!next || SPACE.test(next) || (!double && next === c)) return null;
    if (c === '_' && i > 0 && ALNUM.test(s[i - 1])) return null; // snake_case stays text
    if (memo.has(d)) return null;
    let k = s.indexOf(d, open);
    if (k === -1) { memo.add(d); return null; }
    for (let n = 0; k !== -1 && n < MAX_CANDIDATES; n++) {
      const before = s[k - 1];
      const after = s[k + d.length];
      const ok = k > open && !SPACE.test(before)
        && (double || (before !== c && after !== c))
        && !(c === '_' && after && ALNUM.test(after));
      if (ok) {
        const inner = scan(s.slice(open, k), depth + 1);
        return { node: { type: double ? 'strong' : 'em', children: inner }, end: k + d.length };
      }
      k = s.indexOf(d, k + 1);
    }
    return null;
  }

  function scan(s, depth) {
    const out = [];
    const memo = new Set();
    let buf = '';
    const flush = () => { if (buf) { out.push({ type: 'text', text: buf }); buf = ''; } };
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
      if (c === '`') {
        let n = 1;
        while (s[i + n] === '`') n++;
        const run = '`'.repeat(n);
        let k = s.indexOf(run, i + n);
        while (k !== -1 && s[k + n] === '`') {
          let e = k;
          while (s[e] === '`') e++;
          k = s.indexOf(run, e);
        }
        if (k !== -1) {
          flush();
          let code = s.slice(i + n, k).replace(/\n/g, ' ');
          if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
          out.push({ type: 'code', text: code });
          i = k + n;
          continue;
        }
        buf += run;
        i += n;
        continue;
      }
      if (depth < MAX_DEPTH) {
        if (c === '!' && s[i + 1] === '[') {
          const l = matchLink(s, i + 1);
          if (l) { flush(); out.push({ type: 'link', href: l.href, children: [{ type: 'text', text: t('图片：{0}', l.label || l.href) }] }); i = l.end; continue; }
        }
        if (c === '[') {
          const l = matchLink(s, i);
          if (l) { flush(); out.push({ type: 'link', href: l.href, children: scan(l.label, depth + 1) }); i = l.end; continue; }
        }
        if (c === '<') {
          const m = /^<(https?:\/\/[^\s<>]+)>/i.exec(s.slice(i, i + 2048));
          const href = m && safeHref(m[1]);
          if (href) { flush(); out.push({ type: 'link', href, children: [{ type: 'text', text: m[1] }] }); i += m[0].length; continue; }
        }
        if ((c === 'h' || c === 'H') && (i === 0 || !ALNUM.test(s[i - 1]))) {
          const m = RE.url.exec(s.slice(i, i + 2048));
          const raw = m && trimUrl(m[0]);
          const href = raw && /^https?:\/\/[^/]/i.test(raw) && safeHref(raw);
          if (href) { flush(); out.push({ type: 'link', href, children: [{ type: 'text', text: raw }] }); i += raw.length; continue; }
        }
        if (c === '*' || c === '_' || c === '~') {
          const e = matchEmphasis(s, i, depth, memo);
          if (e) { flush(); out.push(e.node); i = e.end; continue; }
        }
      }
      buf += c;
      i++;
    }
    flush();
    return out;
  }

  function parseInline(text, depth = 0) {
    if (text.length > MAX_INLINE) return [{ type: 'text', text }];
    return scan(text, depth);
  }

  // ---- Rendering ---------------------------------------------------------------------

  const HEADING_TAG = { 1: 'h3', 2: 'h3', 3: 'h4', 4: 'h5', 5: 'h5', 6: 'h5' };

  function renderInline(nodes, h) {
    const out = [];
    for (const n of nodes) {
      switch (n.type) {
        case 'text': {
          const parts = n.text.split('\n');
          parts.forEach((part, k) => { if (k) out.push(h('br', null)); if (part) out.push(part); });
          break;
        }
        case 'code': out.push(h('code', { class: 'md-inline-code' }, n.text)); break;
        case 'strong': out.push(h('strong', null, renderInline(n.children, h))); break;
        case 'em': out.push(h('em', null, renderInline(n.children, h))); break;
        case 'del': out.push(h('del', null, renderInline(n.children, h))); break;
        case 'link':
          out.push(h('a', { href: n.href, target: '_blank', rel: 'noopener noreferrer nofollow' }, renderInline(n.children, h)));
          break;
        default: break;
      }
    }
    return out;
  }

  function renderBlocks(blocks, h, opts, tight) {
    const out = [];
    for (const b of blocks) {
      switch (b.type) {
        case 'paragraph':
          out.push(tight ? h('span', { class: 'md-tight' }, renderInline(b.inline, h)) : h('p', null, renderInline(b.inline, h)));
          break;
        case 'heading': out.push(h(HEADING_TAG[b.level], { class: 'md-h' }, renderInline(b.inline, h))); break;
        case 'hr': out.push(h('hr', null)); break;
        case 'quote': out.push(h('blockquote', null, renderBlocks(b.children, h, opts, false))); break;
        case 'code':
          out.push(h('div', { class: 'md-code' },
            h('div', { class: 'md-code-bar' },
              h('span', null, b.lang || t('代码')),
              opts.onCopyCode ? h('button', { class: 'md-copy', type: 'button', onclick: () => opts.onCopyCode(b.text) }, t('复制')) : null),
            h('pre', null, h('code', null, b.text))));
          break;
        case 'list': {
          const items = b.items.map((item) => h('li', null, renderBlocks(item.children, h, opts, b.tight)));
          out.push(b.ordered ? h('ol', b.start !== 1 ? { start: String(b.start) } : null, items) : h('ul', null, items));
          break;
        }
        case 'table': {
          const cell = (tag, content, k) => h(tag, b.align[k] ? { class: `align-${b.align[k]}` } : null, renderInline(content, h));
          out.push(h('div', { class: 'md-table-wrap' }, h('table', null,
            h('thead', null, h('tr', null, b.header.map((c, k) => cell('th', c, k)))),
            b.rows.length ? h('tbody', null, b.rows.map((row) => h('tr', null, row.map((c, k) => cell('td', c, k))))) : null)));
          break;
        }
        default: break;
      }
    }
    return out;
  }

  function render(blocks, h, opts = {}) {
    return renderBlocks(blocks, h, opts, false);
  }

  root.AgentChatMarkdown = { parse, parseInline, render, safeHref };
})(typeof window !== 'undefined' ? window : globalThis);
