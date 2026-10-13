/**
 * 대기열 통과 → 실제 좌석맵 DOM 덤프 → 2연석 선택 시도 (결제 안 함)
 */
import { chromium, type Page } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import {
  isWaitingRoom,
  selectGoodConsecutiveSeats,
  waitForSeatUi,
  waitOutQueue,
} from "../src/seats.js";
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
    const seatLike = [
      ...document.querySelectorAll(
        "[class*='seat' i], [class*='Seat'], [data-seat], [id*='seat' i], [class*='grade' i], [class*='Grade'], [class*='block' i]",
      ),
    ]
      .slice(0, 50)
      .map((el) => ({
        tag: el.tagName,
        cls: el.className?.toString?.().slice(0, 140),
        id: el.id,
        text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
        aria: el.getAttribute("aria-label"),
      }));
    return { text, buttons, iframes, svg, seatLike, title: document.title, url: location.href };
  });
  const out = `/tmp/seat-dump-${tag}.json`;
  fs.writeFileSync(out, JSON.stringify(info, null, 2));
  await page.screenshot({ path: `/tmp/seat-dump-${tag}.png`, fullPage: true }).catch(() => null);
  log.info("dump", out, "svg", info.svg, "iframes", info.iframes.length);
  log.info("buttons sample:", info.buttons.slice(0, 30).join(" | "));
  log.info("text head:\n", info.text.slice(0, 1200));

  for (const frame of page.frames()) {
    if (!frame.url() || frame.url() === page.url() || frame.url() === "about:blank") continue;
    try {
      const f = await frame.evaluate(() => {
        const text = (document.body?.innerText || "").slice(0, 3000);
        const svg = {
          rect: document.querySelectorAll("svg rect").length,
          circle: document.querySelectorAll("svg circle").length,
        };
        const buttons = [...document.querySelectorAll("button, a, li")]
          .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
          .filter((t) => t && t.length < 50)
          .slice(0, 80);
        const seatLike = [
          ...document.querySelectorAll(
            "[class*='seat' i], [class*='Seat'], [data-seat], svg rect, svg circle",
          ),
        ].length;
        return { text, svg, buttons, seatLike, url: location.href };
      });
      fs.writeFileSync(
        `/tmp/seat-dump-${tag}-frame.json`,
        JSON.stringify(f, null, 2),
      );
      log.info("frame", f.url, "svg", f.svg, "seatLike", f.seatLike);
      log.info("frame buttons", f.buttons.slice(0, 25).join(" | "));
      log.info("frame text", f.text.slice(0, 800));
    } catch (e) {
      log.warn("frame dump fail", frame.url(), e);
    }
  }
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
  if (!auth?.isLoggedIn) throw new Error("로그인 필요");

  log.info("예매하기 클릭 → 대기열/좌석 테스트");
  await page.locator("button", { hasText: "예매하기" }).first().click();
  await page.waitForTimeout(3000);

  let active =
    context.pages().find((p) => /gates|waiting|ticket/i.test(p.url())) || page;
  log.info("after click", active.url());

  if (await isWaitingRoom(active)) {
    log.info("대기열 진입 — 통과할 때까지 대기 (새로고침 안 함)");
  }

  active = await waitOutQueue(active, 45 * 60 * 1000);
  log.ok("대기열 통과(또는 비대기 화면). url=", active.url());
  await dumpSeatDom(active, "after-queue");

  const seatRoot = await waitForSeatUi(active, 120000);
  if (!seatRoot) {
    log.error("좌석 UI 미검출 — DOM만 남기고 종료 대기");
    await dumpSeatDom(active, "no-seat-ui");
  } else {
    log.ok("좌석 UI 검출 — 2연석 시도");
    await dumpSeatDom(active, "seat-ui");
    try {
      const selected = await selectGoodConsecutiveSeats(active, config);
      log.ok("선택 성공:", selected);
      await active.screenshot({ path: "/tmp/seat-select-ok.png", fullPage: true });
      fs.writeFileSync("/tmp/seat-select-ok.json", JSON.stringify(selected, null, 2));
    } catch (e) {
      log.warn("자동 선택 실패:", e);
      await active.screenshot({
        path: "/tmp/seat-select-fail.png",
        fullPage: true,
      });
    }
  }

  log.info("결제 안 함. 브라우저 유지 — Take Control로 확인 가능");
  // keep open
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
