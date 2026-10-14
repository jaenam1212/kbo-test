/**
 * 임시 좌석 테스트: 라이브 퀘스트 뮤지컬 〈코드네임X〉
 * 결제 직전에서 멈춤 (카드 입력 안 함)
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
  stopBeforePayment,
  waitForSeatUi,
  waitOutQueue,
} from "../src/seats.js";
import { pageHasCaptcha } from "../src/captcha.js";
import { assignGeneralPriceAndBook } from "../src/price.js";
import { log } from "../src/logger.js";
import type { AppConfig } from "../src/types.js";

const PRODUCT =
  process.env.PRODUCT_URL ||
  "https://nol.yanolja.com/ticket/products/26008690";

async function dump(page: Page, tag: string) {
  const info = await page.evaluate(() => {
    const text = (document.body?.innerText || "").slice(0, 6000);
    const buttons = [...document.querySelectorAll("button, a, [role=button]")]
      .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
      .filter((t) => t && t.length < 60)
      .slice(0, 120);
    return {
      text,
      buttons,
      title: document.title,
      url: location.href,
      svg: {
        rect: document.querySelectorAll("svg rect").length,
        circle: document.querySelectorAll("svg circle").length,
      },
    };
  });
  fs.writeFileSync(`/tmp/musical-${tag}.json`, JSON.stringify(info, null, 2));
  await page
    .screenshot({ path: `/tmp/musical-${tag}.png`, fullPage: true })
    .catch(() => null);
  log.info("dump", tag, info.url);
  log.info("text head:\n", info.text.slice(0, 900));
  return info;
}

async function clickFirstVisible(
  page: Page,
  names: RegExp[],
): Promise<boolean> {
  for (const re of names) {
    const btn = page.getByRole("button", { name: re }).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 8000 }).catch(() => null);
      return true;
    }
    const fallback = page
      .locator("button, a, [role='button']")
      .filter({ hasText: re })
      .first();
    if (await fallback.isVisible().catch(() => false)) {
      await fallback.click({ timeout: 8000 }).catch(() => null);
      return true;
    }
  }
  return false;
}

/** 날짜/회차 선택 후 예매하기 */
async function pickScheduleAndBook(page: Page): Promise<void> {
  await page.waitForTimeout(1500);
  // 예매 가능 날짜(비활성 아닌 것) 클릭
  const dayClicked = await page.evaluate(() => {
    const cands = [
      ...document.querySelectorAll(
        "button, [role='button'], td, [class*='date' i], [class*='Calendar'] button",
      ),
    ] as HTMLElement[];
    for (const el of cands) {
      const t = (el.textContent || "").trim();
      const dis =
        el.getAttribute("disabled") != null ||
        el.getAttribute("aria-disabled") === "true" ||
        /disabled|sold|마감|불가/i.test(el.className);
      if (!dis && /^\d{1,2}$/.test(t) && el.offsetParent) {
        el.click();
        return t;
      }
    }
    return null;
  });
  if (dayClicked) log.info("날짜 클릭:", dayClicked);
  await page.waitForTimeout(800);

  // 회차/시간
  const timeClicked = await page.evaluate(() => {
    const cands = [
      ...document.querySelectorAll("button, [role='button'], li, a"),
    ] as HTMLElement[];
    for (const el of cands) {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (
        /\d{1,2}\s*:\s*\d{2}|회차|공연/.test(t) &&
        !/마감|매진|불가/.test(t) &&
        t.length < 40 &&
        el.offsetParent
      ) {
        el.click();
        return t;
      }
    }
    return null;
  });
  if (timeClicked) log.info("회차 클릭:", timeClicked);
  await page.waitForTimeout(600);

  const booked = await clickFirstVisible(page, [
    /^예매하기$/,
    /예매하기/,
    /좌석선택/,
    /예매$/,
  ]);
  if (!booked) {
    // 상단/하단 예매 CTA
    const any = page.locator("button", { hasText: "예매하기" }).first();
    if (await any.isVisible().catch(() => false)) {
      await any.click();
      log.info("예매하기 클릭 (fallback)");
    } else {
      throw new Error("예매하기 버튼을 찾지 못했습니다");
    }
  } else {
    log.info("예매하기/좌석선택 클릭");
  }
}

async function main() {
  const base = loadConfig();
  // 뮤지컬용 선호 등급 (임시)
  const config: AppConfig = {
    ...base,
    preferredGrades: [
      "VIP",
      "VIP석",
      "R석",
      "R",
      "S석",
      "중앙",
      "1층",
      "테이블",
    ],
    avoidGrades: ["휠체어", "시야방해", "스탠딩"],
    preferHomeSide: "중앙",
    seatCount: 2,
  };

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
  log.info("상품 페이지:", PRODUCT);
  await page.goto(PRODUCT, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2000);
  await dump(page, "product");

  // 차단 페이지면 재시도
  const blocked = await page.locator("body").innerText().catch(() => "");
  if (/일시적으로 서비스를 이용/.test(blocked)) {
    log.warn("차단 감지 — 홈 경유 후 재진입");
    await page.goto("https://nol.yanolja.com/ticket", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(1500);
    await page.goto(PRODUCT, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2000);
    await dump(page, "product-retry");
  }

  await pickScheduleAndBook(page);
  await page.waitForTimeout(2500);

  let active =
    context.pages().find((p) =>
      /gates|waiting|ticket|onestop|booking|seat|Book/i.test(p.url()),
    ) || page;
  log.info("after book click", active.url());

  if (await isWaitingRoom(active)) {
    log.info("대기열 진입 — 통과 대기");
  }
  active = await waitOutQueue(active, 45 * 60 * 1000);
  log.ok("대기열/로딩 통과", active.url());
  await dump(active, "after-queue");

  await clickConfirmAndBookAfterQueue(active);
  active = await waitOutQueue(active, 45 * 60 * 1000);
  await clickConfirmAndBookAfterQueue(active);
  await dump(active, "after-confirm");

  await dismissBookingNotices(active);
  if (await pageHasCaptcha(active)) {
    log.info("보안문자 — OCR 최대 2회");
    await solveCaptchaIfPresent(active, {
      ocrAttempts: 2,
      waitManualMs: 180000,
    });
  }

  const seatRoot = await waitForSeatUi(active, 180000);
  if (!seatRoot) {
    log.error("좌석 UI 미검출");
    await dump(active, "no-seat");
  } else {
    log.ok("좌석 UI — 2연석(뮤지컬 등급) 시도");
    await dump(active, "seat-ui");
    try {
      const selected = await selectGoodConsecutiveSeats(active, config);
      log.ok("선택 성공:", selected);
      fs.writeFileSync(
        "/tmp/musical-select-ok.json",
        JSON.stringify(selected, null, 2),
      );
      await active.screenshot({
        path: "/tmp/musical-select-ok.png",
        fullPage: true,
      });
      // 가격 선택(일반 N매) → 예매하기 → 결제 직전
      await assignGeneralPriceAndBook(active, config.seatCount);
      await active
        .screenshot({ path: "/tmp/musical-after-price.png", fullPage: true })
        .catch(() => null);
      await stopBeforePayment(active);
      await active
        .screenshot({ path: "/tmp/musical-payment-stop.png", fullPage: true })
        .catch(() => null);
      log.ok("결제 직전 정지 — Take Control로 확인");
    } catch (e) {
      log.warn("자동 선택 실패:", e);
      await dump(active, "select-fail");
      await active
        .screenshot({ path: "/tmp/musical-select-fail.png", fullPage: true })
        .catch(() => null);
    }
  }

  log.info("브라우저 유지");
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
