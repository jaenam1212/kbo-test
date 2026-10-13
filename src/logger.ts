const ts = () =>
  new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false });

export const log = {
  info: (...args: unknown[]) => console.log(`[${ts()}]`, ...args),
  warn: (...args: unknown[]) => console.warn(`[${ts()}] ⚠`, ...args),
  error: (...args: unknown[]) => console.error(`[${ts()}] ✖`, ...args),
  ok: (...args: unknown[]) => console.log(`[${ts()}] ✓`, ...args),
};
