let unauthorizedHandler = null;

export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = handler;
}

export function notifyUnauthorized() {
  unauthorizedHandler?.();
}

export async function api(path, options = {}) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    unauthorizedHandler?.();
    const error = new Error(data.error || '请先登录');
    error.status = 401;
    throw error;
  }
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}
