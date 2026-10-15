/**
 * 경기일 예매: 오픈 전 NOL 예매하기 → 타이머 화면 유지 →
 * UI 타이머 무시하고 서버시각(bookingOpenTime + Date 헤더 skew) 정각에 스램클릭.
 */
import { loadConfig } from "../src/config.js";
import { launchContext } from "../src/browser.js";
import {
  fetchPostseasonGoods,
  formatGoods,
  isBookingOpen,
  parseNolTime,
  pickBestGoods,
} from "../src/goods.js";
import { clickBookForGoods, runBookFlow } from "../src/flow.js";
import { slamBookButtonsNow } from "../src/seats.js";
import { measureServerSkewMs, waitUntilServerMs } from "../src/time.js";
import { log } from "../src/logger.js";

function kstNow(): Date {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }),
  );
}

function todayKstAt(hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")!.value;
  const mo = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  return new Date(
    `${y}-${mo}-${d}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+09:00`,
  );
}

async function sleepUntil(target: Date, label: string) {
  for (;;) {
    const left = target.getTime() - Date.now();
    if (left <= 0) {
      log.ok(`${label} 도달`);
      return;
    }
    const sec = Math.ceil(left / 1000);
    if (sec % 30 === 0 || sec <= 60) log.info(`${label}까지 ${sec}초`);
    await new Promise((r) => setTimeout(r, Math.min(1000, left)));
  }
}

function isTimerOrGateUrl(url: string): boolean {
  return /tickets\.interpark\.com|\/waiting|gates\/(ticket|partner)/i.test(url);
}

function pickTicketPage(
  context: import("playwright").BrowserContext,
  fallback: import("playwright").Page,
) {
  const pages = context.pages();
  return (
    pages.find((p) => /onestop\/seat/i.test(p.url())) ||
    pages.find((p) => /\/waiting/i.test(p.url())) ||
    pages.find((p) => isTimerOrGateUrl(p.url())) ||
    fallback
  );
}

async function main() {
  const prepAt = process.env.PREP_AT || "13:30";
  const targetOpen = process.env.TARGET_OPEN || "15:00";
  const pinGoodsCode = process.env.GOODS_CODE || "26014419";
  const config = loadConfig();
  config.headless = process.env.HEADLESS === "1";
  config.seatCount = Number(process.env.SEAT_COUNT || config.seatCount || 3);
  config.pollIntervalMs = Number(
    process.env.POLL_MS || config.pollIntervalMs || 500,
  );
  // UI 타이머 무시 — 서버 오픈 시각에 맞춤 (조기는 기본 0)
  config.openEarlyMs = Number(process.env.OPEN_EARLY_MS ?? "0");

  log.info("=== 경기일 예매 준비 (서버타임 정각 스램) ===");
  log.info(
    `매수: ${config.seatCount}연석 | ①중앙테이블≈3루테이블 → ②테이블3연석 → ③아무3연석`,
  );
  log.info(
    `준비 ${prepAt} KST | 오픈 ${targetOpen} KST | early ${config.openEarlyMs}ms | UI타이머무시·서버시각클릭`,
  );
  log.info(
    `핀 goodsCode=${pinGoodsCode} | 지금(KST): ${kstNow().toLocaleString("ko-KR")}`,
  );

  const prepTime = todayKstAt(prepAt);
  if (Date.now() < prepTime.getTime()) {
    await sleepUntil(prepTime, `준비 시각 ${prepAt}`);
  } else {
    log.ok(`준비 시각 ${prepAt} 지남 — 바로 시작`);
  }

  const { context, page } = await launchContext(config);
  await page.goto(config.postseasonUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(1200);

  const auth = await page.evaluate(async () => {
    try {
      const r = await fetch("/ticket/genre/sports/api/auth", {
        credentials: "include",
      });
      return await r.json();
    } catch {
      return { isLoggedIn: false };
    }
  });
  log.info("auth", auth);
  if (!auth?.isLoggedIn || !auth?.isIdentityValid) {
    log.error("로그인/본인인증 필요");
    await context.close();
    process.exit(1);
  }
  log.ok("로그인·본인인증 OK");

  const goods = await fetchPostseasonGoods(page, config.postseasonUrl);
  for (const g of goods) log.info(" -", formatGoods(g));
  const best =
    goods.find((g) => g.goodsCode === pinGoodsCode) ||
    pickBestGoods(goods, config);
  if (!best) {
    log.error("타깃 상품 없음");
    process.exit(1);
  }
  log.ok("타깃:", formatGoods(best));

  const openServerMs = parseNolTime(best.bookingOpenTime);
  if (openServerMs == null) {
    log.error("bookingOpenTime 파싱 실패");
    process.exit(1);
  }
  const fireServerMs = openServerMs - config.openEarlyMs;

  // 예매하기 1회 → 타이머/게이트 유지 (숫자는 안 읽음, postseason 재goto 금지)
  if (
    !isBookingOpen(best, config.openEarlyMs) &&
    !context.pages().some((p) => isTimerOrGateUrl(p.url()))
  ) {
    log.ok("오픈 전 — NOL 예매하기 1회 후 홀드 (화면 타이머 무시)");
    await clickBookForGoods(page, best, config, { preferGate: false });
    await page.waitForTimeout(1500);
  }

  let active = pickTicketPage(context, page);
  // 티켓 서버(Interpark) Date 우선 — 화면 타이머가 아니라 HTTP Date
  let skew = await measureServerSkewMs("https://tickets.interpark.com/");
  if (skew === 0) {
    skew = await measureServerSkewMs("https://nol.yanolja.com/");
  }
  log.ok(
    `서버오픈 ${new Date(openServerMs).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} | fire early=${config.openEarlyMs}ms | skew=${skew}ms`,
  );

  // 홀드: DOM으로 타이머 파싱하지 않음. 로그만 + 비정상접근만 가끔.
  let remMeasured = false;
  let lastLog = 0;
  for (;;) {
    active = pickTicketPage(context, page);
    const leftLocal = fireServerMs + skew - Date.now();

    if (leftLocal <= 120000) break; // 2분 전 → 정밀 대기로

    if (Date.now() - lastLog > 20000) {
      log.info(
        `홀드(서버타임) ~${Math.ceil(leftLocal / 1000)}초 | ${active.url().slice(0, 90)}`,
      );
      lastLog = Date.now();
      const snip = await active
        .locator("body")
        .innerText({ timeout: 600 })
        .catch(() => "");
      if (/정상적인\s*접근이\s*아닙니다|비정상\s*접근/.test(snip.slice(0, 300))) {
        log.error("비정상 접근 — 중단");
        await new Promise(() => {});
        return;
      }
    }

    // 오픈 90초 전 skew 재측정 1회
    if (!remMeasured && leftLocal < 90000) {
      skew = await measureServerSkewMs("https://nol.yanolja.com/");
      remMeasured = true;
      log.ok(`skew 재측정=${skew}ms`);
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!remMeasured) {
    skew = await measureServerSkewMs("https://nol.yanolja.com/");
    remMeasured = true;
    log.ok(`skew 최종=${skew}ms`);
  }

  active = pickTicketPage(context, page);
  log.ok(
    `서버타임 busy-wait 시작 — UI 카운트다운 읽지 않음 (fire KST ${new Date(fireServerMs).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })})`,
  );
  await waitUntilServerMs(fireServerMs, skew, { spinFromMs: 3000 });

  active = pickTicketPage(context, page);
  log.ok(
    `정각 스램 NOW ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} — 버튼 연타`,
  );
  const hit = await slamBookButtonsNow(active, 80);
  if (!hit) {
    log.warn("미히트 — 셀렉터만 재연타 (텍스트 판단 없음)");
    await slamBookButtonsNow(pickTicketPage(context, page), 40);
  }

  await runBookFlow(context, pickTicketPage(context, page), config, best, {
    fromTimer: true,
  });
  log.ok("결제만 직접 하세요. 브라우저 유지.");
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
