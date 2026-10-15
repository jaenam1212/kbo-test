/**
 * 경기일 예매: 오픈 전 NOL 예매하기 → 타이머/게이트에서 대기 → 정각에 이어서 3연석.
 *
 * 환경변수:
 *   PREP_AT=13:40          준비 시작 (KST HH:mm)
 *   TARGET_OPEN=15:00      노릴 오픈 시각(참고 로그용)
 *   SEAT_COUNT=3
 *   HEADLESS=0
 *   GOODS_CODE=26014419
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
import { log } from "../src/logger.js";

function kstNow(): Date {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }),
  );
}

/** 오늘 KST 기준 HH:mm → Date */
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
    if (sec % 30 === 0 || sec <= 60) {
      log.info(`${label}까지 ${sec}초`);
    }
    await new Promise((r) => setTimeout(r, Math.min(1000, left)));
  }
}

function isTimerOrGateUrl(url: string): boolean {
  return /tickets\.interpark\.com|\/waiting|gates\/(ticket|partner)/i.test(url);
}

async function holdOnTimerHint(
  page: import("playwright").Page,
): Promise<string> {
  const url = page.url();
  const text = (await page.locator("body").innerText().catch(() => "")).slice(
    0,
    1200,
  );
  if (/정상적인\s*접근이\s*아닙니다|비정상\s*접근/.test(text)) return "ABNORMAL";
  if (/\/waiting/i.test(url) || /접속 인원이 많아 대기|나의 대기순서/.test(text))
    return "QUEUE";
  if (/확인하고\s*예매하기|예매 준비가 완료/.test(text)) return "CONFIRM";
  if (/onestop\/seat/i.test(url)) return "SEAT";
  if (
    /\d{1,2}\s*:\s*\d{2}\s*:\s*\d{2}/.test(text) ||
    /예매\s*시작|오픈\s*까지|남았습니다|카운트|타이머|곧 예매|판매\s*시작/.test(
      text,
    )
  ) {
    return "TIMER";
  }
  if (isTimerOrGateUrl(url)) return "GATE";
  return "OTHER";
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
  config.openEarlyMs = Number(
    process.env.OPEN_EARLY_MS || config.openEarlyMs || 1500,
  );

  log.info("=== 경기일 예매 준비 (타이머 대기) ===");
  log.info(
    `매수: ${config.seatCount}연석 | ①중앙테이블≈3루테이블 → ②테이블3연석 → ③아무3연석`,
  );
  log.info(
    `준비 ${prepAt} KST | 오픈 ${targetOpen} KST | 조기 ${config.openEarlyMs}ms | 예매하기→타이머홀드`,
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
  await page.waitForTimeout(1500);

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
    log.error(
      "로그인/본인인증 필요 — Take Control로 NOL 로그인·본인인증 후 이 스크립트를 다시 실행하세요.",
    );
    await context.close();
    process.exit(1);
  }
  log.ok("로그인·본인인증 OK");

  // 상품 목록 1회만 조회 (이후 postseason goto 금지 — Take Control/타이머 튕김 원인)
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

  const openMs = parseNolTime(best.bookingOpenTime) ?? 0;
  const fireAt = openMs - config.openEarlyMs;

  // 오픈 전이면 예매하기 1회 → 타이머/게이트에서 대기 (페이지 새로고침·재goto 없음)
  let onTimer = context.pages().some((p) => isTimerOrGateUrl(p.url()));
  if (!isBookingOpen(best, config.openEarlyMs) && !onTimer) {
    log.ok("오픈 전 — NOL 예매하기 1회 클릭 후 타이머에서 대기");
    await clickBookForGoods(page, best, config, { preferGate: false });
    await page.waitForTimeout(2000);
    onTimer = true;
  }

  let lastHintLog = 0;
  for (;;) {
    const pages = context.pages();
    const active =
      pages.find((p) => /onestop\/seat/i.test(p.url())) ||
      pages.find((p) => /\/waiting/i.test(p.url())) ||
      pages.find((p) => isTimerOrGateUrl(p.url())) ||
      page;

    const hint = await holdOnTimerHint(active);
    const left = fireAt - Date.now();

    if (hint === "ABNORMAL") {
      log.error(
        "비정상 접근 — 중단. 브라우저 유지. Take Control로 NOL에서 예매하기 한 번만.",
      );
      await new Promise(() => {});
      return;
    }

    if (Date.now() - lastHintLog > 15000) {
      log.info(
        `타이머홀드 ${hint} | 오픈까지 ${Math.max(0, Math.ceil(left / 1000))}초 | ${active.url().slice(0, 100)}`,
      );
      lastHintLog = Date.now();
    } else if (left > 0 && left < 120000) {
      const sec = Math.ceil(left / 1000);
      if (sec <= 30 || sec % 5 === 0) {
        log.info(`돌입까지 ${sec}초 (정각 ${targetOpen}) · ${hint}`);
      }
    }

    // 정각(조기창) 또는 이미 대기열/좌석으로 넘어간 경우
    const opened =
      isBookingOpen(best, config.openEarlyMs) ||
      hint === "QUEUE" ||
      hint === "CONFIRM" ||
      hint === "SEAT";

    if (opened && left <= 0) {
      if (fireAt > 0) {
        while (Date.now() < fireAt) {
          /* spin */
        }
      }
      const skew = Date.now() - openMs;
      log.ok(
        `오픈 돌입 now=${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} (정각대비 ${skew}ms) → 타이머에서 이어서`,
      );
      await runBookFlow(context, active, config, best, { fromTimer: true });
      log.ok("결제만 직접 하세요. 브라우저 유지.");
      await new Promise(() => {});
      return;
    }

    // 오픈 전에 대기열로 들어가면 그대로 통과 대기 (runBookFlow가 처리)
    if (hint === "QUEUE" || hint === "CONFIRM" || hint === "SEAT") {
      log.ok(`오픈 전 신호 ${hint} — 타이머/대기열 유지하다 이어서 진행`);
      await runBookFlow(context, active, config, best, { fromTimer: true });
      log.ok("결제만 직접 하세요. 브라우저 유지.");
      await new Promise(() => {});
      return;
    }

    // 절대 postseason으로 돌아가지 않음. Take Control과 충돌 방지.
    const tick = left <= 3000 ? 50 : left <= 90000 ? 200 : 1000;
    await new Promise((r) => setTimeout(r, tick));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
