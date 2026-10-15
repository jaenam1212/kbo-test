/**
 * 경기일 예매: 지정 시각(기본 13:40 KST)부터 준비 → 기아 홈 오픈 시 3연석 → 결제 직전.
 *
 * 환경변수:
 *   PREP_AT=13:40          준비 시작 (KST HH:mm)
 *   TARGET_OPEN=14:00      노릴 오픈 시각(참고 로그용, 실제는 상품 bookingOpenTime)
 *   SEAT_COUNT=3
 *   HEADLESS=0
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
import { runBookFlow } from "../src/flow.js";
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
  // Asia/Seoul offset +09:00
  return new Date(`${y}-${mo}-${d}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+09:00`);
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

async function main() {
  const prepAt = process.env.PREP_AT || "13:30";
  const targetOpen = process.env.TARGET_OPEN || "14:00";
  /** 1차전 고정 (속도전: 탐색 생략) */
  const pinGoodsCode = process.env.GOODS_CODE || "26014417";
  const config = loadConfig();
  config.headless = process.env.HEADLESS === "1";
  config.seatCount = Number(process.env.SEAT_COUNT || config.seatCount || 3);
  config.pollIntervalMs = Number(process.env.POLL_MS || config.pollIntervalMs || 500);
  config.openEarlyMs = Number(process.env.OPEN_EARLY_MS || config.openEarlyMs || 12000);

  log.info("=== 경기일 예매 준비 (속도전) ===");
  log.info(
    `매수: ${config.seatCount}연석 | ①중앙테이블≈3루테이블 → ②테이블3연석 → ③아무3연석`,
  );
  log.info(
    `준비 ${prepAt} KST | 오픈 ${targetOpen} KST | 조기진입 ${config.openEarlyMs}ms | NOL예매하기`,
  );
  log.info(`핀 goodsCode=${pinGoodsCode} | 지금(KST): ${kstNow().toLocaleString("ko-KR")}`);

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
  log.ok("로그인·본인인증 OK — 오픈 감시 시작");

  // 워밍업: 상품 목록 + 1차전 핀
  let goods = await fetchPostseasonGoods(page, config.postseasonUrl);
  for (const g of goods) log.info(" -", formatGoods(g));
  let best =
    goods.find((g) => g.goodsCode === pinGoodsCode) ||
    pickBestGoods(goods, config);
  if (!best) {
    log.warn("기아 홈 후보 없음 — 폴링");
  } else {
    log.ok("타깃:", formatGoods(best));
  }

  // 오픈 직전: 무거운 목록 폴링 중단 → 정밀 대기 → 정각 게이트 직행
  let lastKeepLog = 0;
  let precision = false;
  for (;;) {
    const openMs = parseNolTime(best?.bookingOpenTime) ?? 0;
    const fireAt = openMs ? openMs - config.openEarlyMs : 0;
    const leftToFire = fireAt ? fireAt - Date.now() : Infinity;

    // 마지막 90초: 포스트시즌 재조회 금지 (goto가 타이밍을 밀음)
    if (leftToFire > 90000) {
      if (!best || Date.now() - lastKeepLog > 15000) {
        goods = await fetchPostseasonGoods(page, config.postseasonUrl);
        best =
          goods.find((g) => g.goodsCode === pinGoodsCode) ||
          pickBestGoods(goods, config) ||
          best;
        if (best) log.info("타깃 유지:", formatGoods(best));
        lastKeepLog = Date.now();
      }
    } else if (!precision && best) {
      precision = true;
      log.ok(
        `정밀모드 ON — ${Math.ceil(leftToFire / 1000)}초 후 게이트직행 (조기 ${config.openEarlyMs}ms)`,
      );
      // DNS/TLS 워밍: 게이트 호스트만 한 번 터치 (본 진입은 정각)
      if (best.goodsCode && best.placeCode) {
        const warm = `https://tickets.interpark.com/gates/ticket/${best.goodsCode}`;
        await page
          .evaluate(async (u) => {
            try {
              await fetch(u, { mode: "no-cors", credentials: "include" });
            } catch {
              /* ignore */
            }
          }, warm)
          .catch(() => null);
      }
    }

    if (best && isBookingOpen(best, config.openEarlyMs)) {
      // 정각(또는 조기창) 도달 — busy-wait로 밀리초 맞춤 후 즉시 돌입
      if (fireAt > 0) {
        while (Date.now() < fireAt) {
          /* spin */
        }
      }
      const skew = Date.now() - openMs;
      log.ok(
        `오픈 돌입 now=${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} (정각대비 ${skew}ms) → ${config.seatCount}연석`,
      );
      await runBookFlow(context, page, config, best);
      log.ok("결제만 직접 하세요. 브라우저 유지.");
      await new Promise(() => {});
      return;
    }

    if (leftToFire > 0 && leftToFire < 120000) {
      const sec = Math.ceil(leftToFire / 1000);
      if (sec <= 30 || sec % 5 === 0) {
        log.info(`돌입까지 ${sec}초 (정각 ${targetOpen})`);
      }
    }

    // 마지막 3초는 50ms, 그 전 90초는 100ms, 평소는 pollInterval
    const tick =
      leftToFire <= 3000 ? 50 : leftToFire <= 90000 ? 100 : config.pollIntervalMs;
    await new Promise((r) => setTimeout(r, tick));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
