export function createRateLimiter({ max, windowMs }) {
  const buckets = new Map();

  function prune(now) {
    if (buckets.size < 5000) return;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }

  return {
    hit(key, weight = 1) {
      const now = Date.now();
      prune(now);
      const bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        buckets.set(key, { count: weight, resetAt: now + windowMs });
        return { ok: true, retryAfter: 0 };
      }
      bucket.count += weight;
      if (bucket.count > max) {
        return { ok: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
      }
      return { ok: true, retryAfter: 0 };
    },
    reset(key) {
      buckets.delete(key);
    },
  };
}
