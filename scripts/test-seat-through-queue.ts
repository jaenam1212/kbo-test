/**
 * 대기열 통과 → 안내모달 → 보안문자 OCR(최대2) → 2연석 시도 (결제 안 함)
 */
import { chromium, type Page } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import {
  clickConfirmAndBookAfterQueue,
  dismissBookingNotices,
  isWaitingRoom,
  selectGoodConsecutiveSeats,
  solveCaptchaIfPresent,
  waitForSeatUi,
  waitOutQueue,
} from "../src/seats.js";
import { pageHasCaptcha } from "../src/captcha.js";
import { log } from "../src/logger.js";

async function dumpSeatDom(page: Page, tag: string) {
  const info = await page.evaluate(() => {
    const text = (document.body?.innerText || "").slice(0, 5000);
    const buttons = [...document.querySelectorAll("button, a, [role=button], li")]
      .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
      .filter((t) => t && t.length < 50)
      .slice(0, 100);
    const iframes = [...document.querySelectorAll("iframe")].map((f) => ({
      src: f.src,
      id: f.id,
      name: f.name,
    }));
    const svg = {
      rect: document.querySelectorAll("svg rect").length,
      circle: document.querySelectorAll("svg circle").length,
      path: document.querySelectorAll("svg path").length,
    };
    return { text, buttons, iframes, svg, title: document.title, url: location.href };
  });
  fs.writeFileSync(`/tmp/seat-dump-${tag}.json`, JSON.stringify(info, null, 2));
  await page
    .screenshot({ path: `/tmp/seat-dump-${tag}.png`, fullPage: true })
    .catch(() => null);
  log.info("dump", tag, "url", info.url, "svg", info.svg);
  log.info("text head:\n", info.text.slice(0, 1000));
  return info;
}

async function main() {
  const config = loadConfig();
  const profile = path.join(process.cwd(), ".browser-profile");
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1400, height: 1000 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(config.postseasonUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForSelector("button:has-text('예매하기')", { timeout: 45000 });

  const auth = await page.evaluate(async () => {
    const r = await fetch("/ticket/genre/sports/api/auth", {
      credentials: "include",
    });
    return r.json();
  });
  log.info("auth", auth);
  if (!auth?.isLoggedIn) throw new Error("로그인 필요 — Take Control로 NOL 로그인 후 재실행");

  log.info("예매하기 클릭 → 대기열/좌석/OCR 테스트");
  await page.locator("button", { hasText: "예매하기" }).first().click();
  await page.waitForTimeout(3000);

  let active =
    context.pages().find((p) => /gates|waiting|ticket|onestop/i.test(p.url())) ||
    page;
  log.info("after click", active.url());

  if (await isWaitingRoom(active)) {
    log.info("대기열 진입 — 통과까지 대기 (새로고침 금지)");
  }

  active = await waitOutQueue(active, 45 * 60 * 1000);
  log.ok("대기열/로딩 통과. url=", active.url());
  await dumpSeatDom(active, "after-queue");

  await clickConfirmAndBookAfterQueue(active);
  await dumpSeatDom(active, "after-confirm-book");

  await dismissBookingNotices(active);
  await page.waitForTimeout(500);

  if (await pageHasCaptcha(active)) {
    log.info("보안문자 감지 — OCR 최대 2회");
    const ok = await solveCaptchaIfPresent(active, {
      ocrAttempts: 2,
      waitManualMs: 120000,
    });
    log.info("captcha result", ok);
    await active.screenshot({ path: "/tmp/seat-captcha-after.png" }).catch(() => null);
  } else {
    log.info("보안문자 없음 (이 시점)");
  }

  // 안내 모달 다시 뜰 수 있음
  await dismissBookingNotices(active);

  const seatRoot = await waitForSeatUi(active, 180000);
  if (!seatRoot) {
    log.error("좌석 UI 미검출");
    await dumpSeatDom(active, "no-seat-ui");
  } else {
    log.ok("좌석 UI 검출 — 2연석 시도");
    await dumpSeatDom(active, "seat-ui");
    // captcha가 좌석 선택 중에 또 뜰 수 있음
    try {
      const selected = await selectGoodConsecutiveSeats(active, config);
      log.ok("선택 성공:", selected);
      fs.writeFileSync(
        "/tmp/seat-select-ok.json",
        JSON.stringify(selected, null, 2),
      );
      await active.screenshot({
        path: "/tmp/seat-select-ok.png",
        fullPage: true,
      });
    } catch (e) {
      log.warn("자동 선택 실패:", e);
      if (await pageHasCaptcha(active)) {
        log.info("선택 중 보안문자 — OCR 재시도");
        await solveCaptchaIfPresent(active, { ocrAttempts: 2, waitManualMs: 90000 });
      }
      await active.screenshot({
        path: "/tmp/seat-select-fail.png",
        fullPage: true,
      });
      await dumpSeatDom(active, "select-fail");
    }
  }

  log.info("결제 안 함. 브라우저 유지 — Take Control로 확인 가능");
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
