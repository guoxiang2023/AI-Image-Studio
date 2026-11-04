function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(text) {
  const codes = [];
  let value = escapeHtml(text);
  value = value.replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  value = value.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  value = value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  value = value.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  value = value.replace(/\u0000(\d+)\u0000/g, (_, index) => `<code>${codes[index]}</code>`);
  return value;
}

function splitTableRow(line) {
  let value = String(line || '').trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1);

  const cells = [];
  let current = '';
  let inCode = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '\\' && value[index + 1] === '|') {
      current += '|';
      index += 1;
      continue;
    }
    if (char === '`') inCode = !inCode;
    if (char === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function tableAlignments(line) {
  if (!String(line || '').includes('|')) return null;
  return splitTableRow(line).map((cell) => {
    if (!/^:?-+:?$/.test(cell)) return null;
    if (cell.startsWith(':') && cell.endsWith(':')) return 'center';
    if (cell.endsWith(':')) return 'right';
    return 'left';
  });
}

function parseTable(lines, index) {
  const header = splitTableRow(lines[index]);
  if (header.length < 2) return null;
  const aligns = tableAlignments(lines[index + 1]);
  if (!aligns || aligns.some((align) => !align) || aligns.length !== header.length) return null;

  const rows = [];
  let cursor = index + 2;
  while (cursor < lines.length) {
    const row = lines[cursor];
    if (!row.trim() || !row.includes('|')) break;
    const cells = splitTableRow(row);
    if (cells.length !== header.length) break;
    rows.push(cells);
    cursor += 1;
  }
  return { header, aligns, rows, end: cursor };
}

function renderTable(table) {
  const cell = (tag, text, align) =>
    `<${tag} class="align-${align}">${inline(text)}</${tag}>`;
  const head = table.header
    .map((text, index) => cell('th', text, table.aligns[index]))
    .join('');
  const body = table.rows
    .map(
      (row) =>
        `<tr>${row
          .map((text, index) => cell('td', text, table.aligns[index]))
          .join('')}</tr>`,
    )
    .join('');
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/**
 * Convert the small Markdown subset used by chat answers into safe HTML.
 * Raw model text is escaped first; only the tags created here can reach the DOM.
 */
export function markdownToHtml(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let paragraph = [];
  let list = null;
  let quote = [];
  let code = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const tag = list.type === 'ol' ? 'ol' : 'ul';
    out.push(`<${tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join('')}</${tag}>`);
    list = null;
  };
  const flushQuote = () => {
    if (!quote.length) return;
    out.push(`<blockquote>${quote.map(inline).join('<br>')}</blockquote>`);
    quote = [];
  };
  const flush = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (code) {
      if (/^\s*```/.test(line)) {
        out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }

    if (/^\s*```/.test(line)) {
      flush();
      code = [];
      continue;
    }

    if (!line.trim()) {
      flush();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    const quoted = /^\s*>\s?(.*)$/.exec(line);
    if (quoted) {
      flushParagraph();
      flushList();
      quote.push(quoted[1]);
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      flushQuote();
      const type = bullet ? 'ul' : 'ol';
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push((bullet || ordered)[1]);
      continue;
    }

    const table = parseTable(lines, index);
    if (table) {
      flush();
      out.push(renderTable(table));
      index = table.end - 1;
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(line);
  }

  if (code) out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  flush();
  return out.join('\n');
}

export function renderMarkdown(node, text) {
  node.innerHTML = markdownToHtml(text);
}
