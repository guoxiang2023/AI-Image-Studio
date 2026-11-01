export function isSameOrigin(req, trustProxy) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const forwarded = trustProxy ? req.headers['x-forwarded-host'] : '';
    const host = String(forwarded || req.headers.host || '')
      .split(',')[0]
      .trim();
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
