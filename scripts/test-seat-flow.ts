/**
 * 로그인된 프로필로 NOL 예매 → 좌석 UI까지 들어가 2연석 선택 가능 여부만 검증.
 * 결제는 하지 않고, 가능하면 뒤로/닫기로 빠져나온다.
 */
import { loadConfig } from "../src/config.js";
import { chromium } from "playwright";
import path from "node:path";
import { selectGoodConsecutiveSeats, waitForSeatUi } from "../src/seats.js";
import { log } from "../src/logger.js";

async function main() {
  const config = loadConfig();
  const profile = path.join(process.cwd(), ".browser-profile");

  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1280, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(config.postseasonUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForSelector("button:has-text('예매하기')", { timeout: 30000 });

  const auth = await page.evaluate(async () => {
    const r = await fetch("/ticket/genre/sports/api/auth", {
      credentials: "include",
    });
    return r.json();
  });
  log.info("auth", auth);
  if (!auth?.isLoggedIn) throw new Error("로그인 필요");

  log.info("와일드카드 1차전 예매하기 클릭 (좌석 UI 테스트용)");
  const btn = page.locator("button", { hasText: "예매하기" }).first();
  await btn.click();

  // 새 탭/리다이렉트 대기
  await page.waitForTimeout(3000);
  if (page.url().includes("accounts.yanolja.com")) {
    throw new Error("로그인 페이지로 떨어짐");
  }

  // 페이지/팝업 수집
  let active = page;
  for (const p of context.pages()) {
    log.info("tab:", p.url());
    if (/gates|ticket|seat|book|partner/i.test(p.url()) && p !== page) {
      active = p;
    }
  }

  // URL이 그대로 postseason이면 게이트 이동 대기
  for (let i = 0; i < 30; i++) {
    const urls = context.pages().map((p) => p.url());
    log.info("urls", urls.join(" | "));
    const hit = context
      .pages()
      .find((p) => /gates|Seat|Book|booking|partner|onestop/i.test(p.url()));
    if (hit) {
      active = hit;
      break;
    }
    // 본인인증 팝업 등
    const text = await page.locator("body").innerText().catch(() => "");
    if (/본인인증|인증/.test(text)) {
      log.warn("본인인증 UI 감지 — 수동 필요 가능");
    }
    await page.waitForTimeout(1000);
  }

  log.info("active url", active.url());
  const seatRoot = await waitForSeatUi(active, 90000);
  if (!seatRoot) {
    const snip = await active.locator("body").innerText().catch(() => "");
    log.error("좌석 UI 미발견");
    console.log(snip.slice(0, 1500));
    await active.screenshot({ path: "/tmp/seat-test-fail.png", fullPage: true });
    throw new Error("좌석 화면을 못 찾음");
  }

  log.ok("좌석 UI 발견 — 2연석 자동 선택 시도");
  try {
    const selected = await selectGoodConsecutiveSeats(active, config);
    log.ok("선택 결과:", selected);
    await active.screenshot({ path: "/tmp/seat-test-ok.png", fullPage: true });
  } catch (e) {
    log.warn("자동 선택 실패:", e);
    await active.screenshot({ path: "/tmp/seat-test-partial.png", fullPage: true });
  }

  log.info(
    "결제 안 함. 브라우저에서 취소/뒤로 가능. 테스트 종료 — 브라우저는 10분 유지",
  );
  await page.waitForTimeout(10 * 60 * 1000);
  await context.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
