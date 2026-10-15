/**
 * 1회만 게이트/예매 진입 테스트. 실패·비정상접근 시 재시도 없음.
 * GOODS_CODE 기본: 1차전 26014417 (이미 오픈된 상품)
 */
import { loadConfig } from "../src/config.js";
import { launchContext } from "../src/browser.js";
import {
  fetchPostseasonGoods,
  formatGoods,
  listVisibleBookButtons,
} from "../src/goods.js";
import {
  clickConfirmAndBookAfterQueue,
  waitOutQueue,
} from "../src/seats.js";
import { log } from "../src/logger.js";

function gateUrl(goodsCode: string, placeCode: string) {
  const u = new URL(
    `https://tickets.interpark.com/gates/ticket/${goodsCode}`,
  );
  u.searchParams.set("bc", "61776");
  u.searchParams.set("pc", placeCode);
  return u.toString();
}

async function pageHint(page: import("playwright").Page): Promise<string> {
  const url = page.url();
  const text = (await page.locator("body").innerText().catch(() => "")).slice(
    0,
    800,
  );
  if (/정상적인\s*접근이\s*아닙니다|비정상\s*접근|잘못된\s*접근/.test(text)) {
    return "ABNORMAL";
  }
  if (/대기|waiting|순번|앞에|대기열/i.test(text) || /\/waiting/i.test(url)) {
    return "QUEUE";
  }
  if (/확인하고\s*예매하기|예매 준비가 완료/.test(text)) {
    return "CONFIRM";
  }
  if (/onestop\/seat|좌석선택|좌석을 선택/i.test(url + text)) {
    return "SEAT";
  }
  if (/CAPTCHA|보안문자|자동입력 방지/i.test(text)) {
    return "CAPTCHA";
  }
  return "OTHER";
}

async function main() {
  const pin = process.env.GOODS_CODE || "26014417";
  const viaNol = process.env.VIA_NOL === "1";
  const config = loadConfig();
  config.headless = false;

  const { context, page } = await launchContext(config);
  log.info("=== 1회 진입 테스트 ===", { pin, viaNol });

  await page.goto(config.postseasonUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(1200);

  const goods = await fetchPostseasonGoods(page, config.postseasonUrl);
  const target = goods.find((g) => g.goodsCode === pin);
  if (!target) {
    log.error("상품 없음:", pin);
    for (const g of goods) log.info(" -", formatGoods(g));
    await new Promise(() => {});
    return;
  }
  log.ok("타깃:", formatGoods(target));

  if (viaNol) {
    const buttons = await listVisibleBookButtons(page);
    const idx = buttons.findIndex((b) => {
      if (b.label.includes("1차전")) return true;
      if (b.label.includes(target.goodsName.slice(0, 12))) return true;
      if (
        target.playDate &&
        b.label.includes(target.playDate.replaceAll("-", "."))
      ) {
        return true;
      }
      return false;
    });
    log.info(
      "NOL 예매하기 후보:",
      buttons.slice(0, 6).map((b) => b.label).join(" | "),
    );
    if (idx >= 0) {
      log.info(`NOL 예매하기 클릭 #${idx}`);
      await page.locator("button", { hasText: "예매하기" }).nth(idx).click({
        timeout: 5000,
      });
    } else {
      log.warn("버튼 매칭 실패 — 게이트 1회");
      await page.goto(gateUrl(target.goodsCode, target.placeCode), {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
    }
  } else {
    const url = gateUrl(target.goodsCode, target.placeCode);
    log.info("게이트 1회:", url);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  }

  await page.waitForTimeout(1500);
  let active =
    context.pages().find((p) => /tickets\.interpark|waiting|onestop/i.test(p.url())) ||
    page;

  for (let i = 0; i < 90; i++) {
    const pages = context.pages();
    active =
      pages.find((p) => /onestop\/seat/i.test(p.url())) ||
      pages.find((p) => /\/waiting/i.test(p.url())) ||
      pages.find((p) => /gates\/ticket|tickets\.interpark/i.test(p.url())) ||
      active;

    const hint = await pageHint(active);
    log.info(`[${i}] ${hint} url=${active.url().slice(0, 120)}`);

    if (hint === "ABNORMAL") {
      log.error("정상적인 접근이 아닙니다 — 재시도 안 함. 브라우저 유지.");
      await new Promise(() => {});
      return;
    }
    if (hint === "QUEUE") {
      log.ok("대기열 진입 확인 — 통과 대기 (재진입 없음)");
      active = await waitOutQueue(active, 10 * 60 * 1000);
      const after = await pageHint(active);
      log.ok("대기열 이후:", after, active.url());
      if (after === "ABNORMAL") {
        log.error("대기열 후 비정상접근 — 중단");
        await new Promise(() => {});
        return;
      }
      if (after === "CONFIRM" || after === "OTHER" || after === "SEAT") {
        await clickConfirmAndBookAfterQueue(active);
        active = await waitOutQueue(active, 120000);
        await clickConfirmAndBookAfterQueue(active);
        log.ok("확인하고 예매하기 처리 후:", await pageHint(active), active.url());
      }
      log.ok("테스트 종료 — 브라우저 유지 (결제/추가진입 없음)");
      await new Promise(() => {});
      return;
    }
    if (hint === "CONFIRM") {
      log.ok("확인 모달 — 클릭");
      await clickConfirmAndBookAfterQueue(active);
      continue;
    }
    if (hint === "SEAT" || hint === "CAPTCHA") {
      log.ok(`진입 성공: ${hint} — 여기까지 테스트. 브라우저 유지`);
      await new Promise(() => {});
      return;
    }
    await page.waitForTimeout(2000);
  }

  log.warn("타임아웃 — 현재:", await pageHint(active), active.url());
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
