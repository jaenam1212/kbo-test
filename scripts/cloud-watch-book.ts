/**
 * 클라우드용: 로그인된 프로필로 NOL 감시 → 기아 홈 오픈 시 예매까지 시도.
 */
import { loadConfig } from "../src/config.js";
import { launchContext } from "../src/browser.js";
import {
  fetchPostseasonGoods,
  formatGoods,
  isBookingOpen,
  pickBestGoods,
} from "../src/goods.js";
import { runBookFlow } from "../src/flow.js";
import { log } from "../src/logger.js";

async function main() {
  const config = loadConfig();
  // 클라우드에서는 감시는 헤드리스, 예매 직전 헤디드로 전환할 수 있게 기본 headless 유지
  config.headless = process.env.HEADLESS !== "0";

  const { context, page } = await launchContext(config);

  // auth 확인
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
  if (!auth?.isLoggedIn) {
    log.error("로그인이 안 되어 있습니다. Take Control로 다시 로그인해주세요.");
    await context.close();
    process.exit(1);
  }
  log.ok("NOL 로그인 유지 확인 — 기아 홈(광주) 감시 시작");

  for (;;) {
    const goods = await fetchPostseasonGoods(page, config.postseasonUrl);
    log.info(`상품 ${goods.length}건`);
    for (const g of goods.slice(0, 6)) log.info(" -", formatGoods(g));

    const best = pickBestGoods(goods, config);
    if (best) {
      log.ok("기아 홈 후보:", formatGoods(best));
      if (isBookingOpen(best, config.openEarlyMs)) {
        log.ok(
          `오픈됨 — 예매 플로우 시작 (${config.seatCount}연석 → 결제 직전)`,
        );
        await runBookFlow(context, page, config, best);
        log.ok("결제만 직접 완료하세요. 브라우저 유지.");
        await new Promise(() => {});
        return;
      }
      log.info("상품은 있으나 오픈 전 — 대기");
    }

    await page.waitForTimeout(config.pollIntervalMs);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
