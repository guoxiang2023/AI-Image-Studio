export function parseCookies(header) {
  const result = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    const raw = part.slice(index + 1).trim();
    try {
      result[name] = decodeURIComponent(raw);
    } catch {
      result[name] = raw;
    }
  }
  return result;
}
