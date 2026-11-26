/**
 * Column widths shared by the DOCX and PDF renderers. Both formats show the
 * same tables, and a column that reads well in one must not collapse in the
 * other, so the weights live here instead of in either renderer.
 *
 * Weighting by header text rather than by equal division: a "#" column needs a
 * single character while a "说明" column needs a paragraph, and splitting a
 * four-column table evenly turned the explanatory column into a narrow strip
 * of three-character lines.
 */
export function tableColumnWidths(headers, totalWidth, rows = []) {
  const weights = (headers || []).map((header) => {
    const value = String(header || '');
    if (/^#|序号/.test(value)) return 0.5;
    if (/说明|描述|备注|作用|内容|风险|description|note/i.test(value)) return 3.4;
    if (/证据|字段|名称|表名|依据|工作项|field|name/i.test(value)) return 1.9;
    if (/数值|数量|人月|金额|类型|长度|必填|默认|type|length|required|default/i.test(value)) {
      return 0.9;
    }
    return 1.25;
  });
  // Header text alone cannot size a column whose cells hold long payloads: a
  // "数值" column of one-line counts and a "数值" column of SQL fragments look
  // identical until the table is laid out. Widening by the longest cell (capped,
  // so one pasted log line cannot take the page) keeps both readable.
  const longest = headers.map((_, index) => {
    let max = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
      const cell = String((Array.isArray(row) ? row[index] : '') || '');
      if (cell.length > max) max = cell.length;
    }
    return max;
  });
  const scaled = weights.map((weight, index) => {
    const extra = Math.min(2.5, longest[index] / 50);
    return weight * (1 + extra);
  });
  // A "#" column must not shrink to where its number touches the next cell.
  // The floor is a share of the total weight, not of the page: clamping by
  // width instead flattened every unequal table back to equal columns.
  const total = scaled.reduce((sum, value) => sum + value, 0) || 1;
  const floor = total * 0.06;
  const widened = scaled.map((weight) => Math.max(weight, floor));
  const sum = widened.reduce((name, value) => name + value, 0) || 1;
  return widened.map((weight) => (totalWidth * weight) / sum);
}

/**
 * Integer column widths in twips that sum to exactly `totalWidth`, because
 * Word lays a fixed-width table out from the grid and leftover twips show up as
 * a crooked right edge on the last column.
 */
export function integerColumnWidths(headers, totalWidth, count, rows = []) {
  const columns = Math.max(1, count || (headers || []).length || 1);
  const raw = tableColumnWidths(
    Array.from({ length: columns }, (_, index) => headers?.[index] || ''),
    totalWidth,
    rows,
  );
  const total = raw.reduce((sum, value) => sum + value, 0) || 1;
  const widths = raw.map((value) => Math.floor((totalWidth * value) / total));
  const empty = totalWidth - widths.reduce((sum, value) => sum + value, 0);
  if (empty > 0) {
    const widest = widths.indexOf(Math.max(...widths));
    widths[widest] += empty;
  }
  return widths;
}
