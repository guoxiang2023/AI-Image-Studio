export function formatDuration(ms, { allowZero = false } = {}) {
  const rounded = Math.max(0, Math.round(Number(ms) / 1000));
  const total = allowZero ? rounded : Math.max(1, rounded);
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${String(minutes % 60).padStart(2, '0')} 分 ${String(seconds).padStart(2, '0')} 秒`;
}
