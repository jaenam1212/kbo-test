import type { Page } from "playwright";
import { log } from "./logger.js";

/**
 * HTTP Date 헤더로 서버시각 대비 로컬 시계 오차(ms) 측정.
 * 반환값: localNow - serverNow  (양수면 로컬이 빠름)
 * fireAt_local = serverOpenMs + skew
 */
export async function measureServerSkewMs(
  page: Page,
  url = "https://tickets.interpark.com/",
): Promise<number> {
  try {
    const result = await page.evaluate(async (u) => {
      const t0 = Date.now();
      const r = await fetch(u, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
      });
      const t1 = Date.now();
      const dateHdr = r.headers.get("date");
      return { dateHdr, mid: (t0 + t1) / 2 };
    }, url);
    if (!result?.dateHdr) return 0;
    const serverMs = new Date(result.dateHdr).getTime();
    if (!Number.isFinite(serverMs)) return 0;
    const skew = Math.round(result.mid - serverMs);
    log.info(
      `서버시각 보정 skew=${skew}ms (로컬−서버, Date: ${result.dateHdr})`,
    );
    return skew;
  } catch (e) {
    log.warn("서버시각 측정 실패 — 로컬 시계 사용", String(e));
    return 0;
  }
}

/** 서버시각 기준으로 targetServerMs 까지 busy-wait (DOM 읽기 없음). */
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
      // busy-wait — 타이머 UI 인식 없이 시계만
      while (Date.now() < targetLocal) {
        /* spin */
      }
      return;
    }
  }
}
