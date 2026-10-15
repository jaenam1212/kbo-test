import { loadConfig } from "./config.js";
import { launchContext } from "./browser.js";
import { fetchPostseasonGoods, formatGoods, pickBestGoods } from "./goods.js";
import { runBookFlow, watchForKiaHome } from "./flow.js";
import { log } from "./logger.js";

function usage() {
  console.log(`
NOL(야놀자) 티켓 · KBO 가을야구 기아 홈 예매 도우미

사용법:
  npm start                 감시 → 오픈 시 연석 선택 → 결제 직전에서 정지
  npm run watch             기아 홈 상품이 뜰 때까지 감시
  npm run dry-run           상품 목록만 한 번 조회
  npm run book              로그인부터 예매 플로우 실행
  npm run game-day          1:40 준비 → 2시 오픈 3연석 (경기일)

환경변수:
  HEADLESS=1                브라우저 숨김 (기본: 표시)
  SEAT_COUNT=3              매수 (연석)
  POLL_MS=1000              감시 주기(ms)
  PREP_AT=13:40             game-day 준비 시각(KST)
`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || "start";
  if (cmd === "-h" || cmd === "--help" || cmd === "help") {
    usage();
    return;
  }

  const config = loadConfig();
  const { context, page } = await launchContext(config);

  try {
    if (cmd === "dry-run" || cmd === "list" || (cmd === "watch" && args.includes("--once"))) {
      const all = await fetchPostseasonGoods(page, config.postseasonUrl);
      log.info(`NOL 포스트시즌 상품 ${all.length}건`);
      for (const item of all) log.info(" -", formatGoods(item));
      const best = pickBestGoods(all, config);
      if (best) log.ok("기아 홈 후보:", formatGoods(best));
      else
        log.warn(
          "기아 홈(광주) 상품 없음 — 준PO 예매가 NOL에 뜨면 npm start",
        );
      await context.close();
      return;
    }

    if (cmd === "watch") {
      await watchForKiaHome(page, config, { once: false });
      await context.close();
      return;
    }

    if (cmd === "book" || cmd === "start") {
      log.info(
        `NOL 티켓 기준 — 로그인·결제는 직접, 좋은 ${config.seatCount}연석까지 자동`,
      );
      await runBookFlow(context, page, config);
      log.info("결제 후 종료하려면 Ctrl+C");
      await new Promise(() => {});
      return;
    }

    usage();
    await context.close();
  } catch (e) {
    log.error(e);
    await context.close().catch(() => null);
    process.exitCode = 1;
  }
}

main();
