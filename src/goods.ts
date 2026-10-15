import type { Page } from "playwright";
import type { AppConfig, SportsGoods } from "./types.js";

function unescapeFlight(s: string): string {
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16)),
    )
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function extractGoodsFromText(blob: string): SportsGoods[] {
  const goods: SportsGoods[] = [];
  const seen = new Set<string>();

  // script / RSC 에 escaped 로 들어있는 경우 포함
  const normalized = unescapeFlight(blob);

  const re =
    /"goodsCode":"(\d+)","goodsName":"([^"]+)","bizCode":"[^"]*","relationCode":"[^"]*","relationSortSeq":"[^"]*","placeCode":"(\d+)","placeName":"([^"]+)"[\s\S]*?"bookingOpenTime":"([^"]+)","bookingEndTime":"([^"]+)"/g;

  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized))) {
    const slice = normalized.slice(m.index, m.index + 900);
    const playDate = slice.match(/"playDate":"([^"]+)"/)?.[1];
    const playTime = slice.match(/"playTime":"([^"]+)"/)?.[1];
    const item: SportsGoods = {
      goodsCode: m[1],
      goodsName: m[2],
      placeCode: m[3],
      placeName: m[4],
      bookingOpenTime: m[5],
      bookingEndTime: m[6],
      playDate,
      playTime,
    };
    if (!seen.has(item.goodsCode)) {
      seen.add(item.goodsCode);
      goods.push(item);
    }
  }

  if (goods.length === 0) {
    for (const code of new Set(
      [...normalized.matchAll(/"goodsCode":"(\d+)"/g)].map((x) => x[1]),
    )) {
      const idx = normalized.indexOf(`"goodsCode":"${code}"`);
      const slice = normalized.slice(idx, idx + 1200);
      const name = slice.match(/"goodsName":"([^"]+)"/)?.[1];
      const placeCode = slice.match(/"placeCode":"(\d+)"/)?.[1];
      const placeName = slice.match(/"placeName":"([^"]+)"/)?.[1];
      const bookingOpenTime = slice.match(/"bookingOpenTime":"([^"]+)"/)?.[1];
      const bookingEndTime = slice.match(/"bookingEndTime":"([^"]+)"/)?.[1];
      const playDate = slice.match(/"playDate":"([^"]+)"/)?.[1];
      const playTime = slice.match(/"playTime":"([^"]+)"/)?.[1];
      if (name && placeCode && placeName) {
        goods.push({
          goodsCode: code,
          goodsName: name,
          placeCode,
          placeName,
          bookingOpenTime,
          bookingEndTime,
          playDate,
          playTime,
        });
      }
    }
  }

  return goods;
}

export function isKiaHomeCandidate(g: SportsGoods, config: AppConfig): boolean {
  const hay = `${g.goodsName} ${g.placeName}`;
  const hasVenue = config.homeVenueKeywords.some((k) => hay.includes(k));
  const hasKia = /기아|KIA/i.test(hay);
  const hasPostseason = /준플|플레이오프|한국시리즈|포스트|와일드/i.test(hay);
  if (hasVenue && (hasKia || hasPostseason)) return true;
  if (hasVenue && hasKia) return true;
  return (
    hasVenue &&
    config.matchKeywords.some((k) => hay.toLowerCase().includes(k.toLowerCase()))
  );
}

/**
 * NOL bookingOpenTime은 보통 timezone 없는 KST 시각(예: 2026-10-15T14:00:00).
 * timezone 없으면 +09:00으로 해석. Z/+offset 있으면 그대로.
 */
export function parseNolTime(raw?: string | null): number | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const t = new Date(s).getTime();
    return Number.isFinite(t) ? t : null;
  }
  // date-only
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const t = new Date(`${s}T00:00:00+09:00`).getTime();
    return Number.isFinite(t) ? t : null;
  }
  // datetime without tz → KST
  const normalized = s.includes("T") ? s : s.replace(" ", "T");
  const t = new Date(`${normalized}+09:00`).getTime();
  return Number.isFinite(t) ? t : null;
}

export function isBookingOpen(g: SportsGoods, earlyMs = 0): boolean {
  if (!g.bookingOpenTime) return true;
  const openMs = parseNolTime(g.bookingOpenTime);
  if (openMs == null) return true;
  const openAt = openMs - earlyMs;
  const endAt = parseNolTime(g.bookingEndTime ?? null) ?? Infinity;
  const now = Date.now();
  return now >= openAt && now <= endAt;
}

export async function fetchPostseasonGoods(
  page: Page,
  postseasonUrl = "https://nol.yanolja.com/ticket/genre/sports/postseason",
): Promise<SportsGoods[]> {
  await page.goto(postseasonUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  // Cloudflare / hydration 대기
  await page
    .waitForSelector("button:has-text('예매하기'), text=경기 예매", {
      timeout: 45000,
    })
    .catch(() => null);
  await page.waitForTimeout(400);

  const html = await page.content();
  let goods = extractGoodsFromText(html);

  if (goods.length === 0) {
    // script 텍스트만 따로
    const scripts = await page.evaluate(() =>
      [...document.querySelectorAll("script")]
        .map((s) => s.textContent || "")
        .filter((t) => t.includes("goodsCode"))
        .join("\n"),
    );
    goods = extractGoodsFromText(scripts);
  }

  return goods;
}

export async function listVisibleBookButtons(page: Page): Promise<
  { index: number; label: string }[]
> {
  return page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")].filter(
      (b) => (b.textContent || "").trim() === "예매하기",
    );
    return buttons.map((b, index) => {
      // 각 카드 단위로 좁히기
      let root: HTMLElement | null = b.parentElement;
      for (let i = 0; i < 6 && root; i++) {
        const t = (root.textContent || "").replace(/\s+/g, " ");
        if (/(차전|월\s*\d+일|야구장|챔피언스)/.test(t) && t.length < 220) break;
        root = root.parentElement;
      }
      const label = (root?.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);
      return { index, label };
    });
  });
}

export function pickBestGoods(
  goods: SportsGoods[],
  config: AppConfig,
): SportsGoods | null {
  const candidates = goods.filter((g) => isKiaHomeCandidate(g, config));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const aOpen = isBookingOpen(a, config.openEarlyMs) ? 0 : 1;
    const bOpen = isBookingOpen(b, config.openEarlyMs) ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;
    return (a.playDate || a.bookingOpenTime || "").localeCompare(
      b.playDate || b.bookingOpenTime || "",
    );
  });
  return candidates[0] ?? null;
}

export function formatGoods(g: SportsGoods): string {
  return [
    g.goodsName,
    g.placeName,
    g.playDate ? `경기 ${g.playDate}${g.playTime ? ` ${g.playTime}` : ""}` : null,
    g.bookingOpenTime ? `오픈 ${g.bookingOpenTime}` : null,
    `gc=${g.goodsCode}`,
  ]
    .filter(Boolean)
    .join(" | ");
}
