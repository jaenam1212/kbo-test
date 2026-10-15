import { log } from "./logger.js";

/**
 * HTTP Date 헤더로 서버시각 대비 로컬 시계 오차(ms) 측정.
 * Node 쪽 fetch 사용 (페이지 CORS 회피).
 * 반환값: localNow - serverNow  (양수면 로컬이 빠름)
 * localFire = serverOpenMs + skew
 */
export async function measureServerSkewMs(
  url = "https://nol.yanolja.com/",
): Promise<number> {
  try {
    const t0 = Date.now();
    const r = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { "cache-control": "no-store" },
    });
    const t1 = Date.now();
    const dateHdr = r.headers.get("date");
    if (!dateHdr) {
      log.warn("Date 헤더 없음 — skew=0");
      return 0;
    }
    const serverMs = new Date(dateHdr).getTime();
    if (!Number.isFinite(serverMs)) return 0;
    const mid = (t0 + t1) / 2;
    const skew = Math.round(mid - serverMs);
    log.info(
      `서버시각 보정 skew=${skew}ms (로컬−서버, ${url} Date: ${dateHdr})`,
    );
    return skew;
  } catch (e) {
    log.warn("서버시각 측정 실패 — 로컬 시계 사용", String(e));
    return 0;
  }
}

/** 서버시각 기준으로 targetServerMs 까지 대기 (DOM 읽기 없음). */
export async function waitUntilServerMs(
  targetServerMs: number,
  skewMs: number,
  opts?: { spinFromMs?: number },
): Promise<void> {
  const spinFrom = opts?.spinFromMs ?? 3000;
  const targetLocal = targetServerMs + skewMs;
  for (;;) {
    const left = targetLocal - Date.now();
    if (left <= 0) return;
    if (left > spinFrom) {
      await new Promise((r) => setTimeout(r, Math.min(left - spinFrom, 500)));
    } else {
      while (Date.now() < targetLocal) {
        /* spin */
      }
      return;
    }
  }
}
