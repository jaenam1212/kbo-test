import type { BrowserContext, Page } from "playwright";
import type { AppConfig, SportsGoods } from "./types.js";
import {
  fetchPostseasonGoods,
  formatGoods,
  isBookingOpen,
  listVisibleBookButtons,
  pickBestGoods,
} from "./goods.js";
import { log } from "./logger.js";
import {
  clickConfirmAndBookAfterQueue,
  selectGoodConsecutiveSeats,
  stopBeforePayment,
  waitOutQueue,
} from "./seats.js";

const NOL_LOGIN_HOST = "accounts.yanolja.com";
const POSTSEASON = "https://nol.yanolja.com/ticket/genre/sports/postseason";

/** NOL 티켓 '예매하기'가 넘기는 게이트 URL (실측: /gates/ticket/{goodsCode}). */
function nolTicketGateUrl(g: SportsGoods): string {
  const u = new URL(
    `https://tickets.interpark.com/gates/ticket/${g.goodsCode}`,
  );
  u.searchParams.set("bc", "61776");
  u.searchParams.set("pc", g.placeCode);
  return u.toString();
}

export async function waitForLogin(page: Page, timeoutMs = 10 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = page.url();
    const onLogin = url.includes(NOL_LOGIN_HOST) || /login|signin/i.test(url);
    const auth = await page
      .evaluate(async () => {
        try {
          const r = await fetch("/ticket/genre/sports/api/auth", {
            credentials: "include",
          });
          return await r.json();
        } catch {
          return null;
        }
      })
      .catch(() => null);

    if (!onLogin && auth?.isLoggedIn) {
      log.ok("NOL 로그인 확인");
      return;
    }
    if (onLogin) {
      log.info("NOL 로그인/본인인증을 브라우저에서 완료해 주세요...");
    }
    await page.waitForTimeout(2000);
  }
  throw new Error("로그인 대기 시간 초과");
}

export async function ensureOnPostseason(page: Page, config: AppConfig) {
  if (!page.url().includes("/sports/postseason")) {
    await page.goto(config.postseasonUrl || POSTSEASON, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(1500);
  }
}

export async function watchForKiaHome(
  page: Page,
  config: AppConfig,
  opts: { once?: boolean } = {},
): Promise<SportsGoods | null> {
  log.info("NOL 티켓 포스트시즌 페이지 감시 중 (기아 홈/광주)...");
  for (;;) {
    const goods = await fetchPostseasonGoods(page);
    log.info(`상품 ${goods.length}건 확인`);
    for (const g of goods.slice(0, 8)) {
      log.info(" -", formatGoods(g));
    }
    const best = pickBestGoods(goods, config);
    if (best) {
      log.ok("기아 홈 후보:", formatGoods(best));
      if (isBookingOpen(best, config.openEarlyMs)) {
        log.ok("예매 오픈됨");
        return best;
      }
      log.info("상품은 있으나 아직 오픈 전 — 대기");
    } else if (opts.once) {
      log.warn("아직 기아 홈(광주) 상품이 없습니다.");
      return null;
    }
    if (opts.once) return best;
    await page.waitForTimeout(config.pollIntervalMs);
  }
}

async function clickBookForGoods(
  page: Page,
  g: SportsGoods,
  config: AppConfig,
): Promise<void> {
  await ensureOnPostseason(page, config);

  const buttons = await listVisibleBookButtons(page);
  const keys = [g.goodsName, g.playDate || "", "광주", "기아", "챔피언스", "준플"].filter(
    Boolean,
  );
  let idx = buttons.findIndex((b) =>
    keys.some((k) => k && b.label.includes(k)),
  );
  if (idx < 0 && buttons.length === 1) idx = 0;
  if (idx < 0) {
    // 날짜로 재시도
    idx = buttons.findIndex((b) =>
      (g.playDate || "").replaceAll("-", "").slice(4)
        ? b.label.includes(String(Number((g.playDate || "").split("-")[1]))) &&
          b.label.includes(String(Number((g.playDate || "").split("-")[2])))
        : false,
    );
  }

  if (idx >= 0) {
    log.info(`NOL '예매하기' 클릭 (#${idx}) — ${buttons[idx]?.label}`);
    const btn = page.locator("button", { hasText: "예매하기" }).nth(idx);
    await btn.click({ timeout: 10000 });
    return;
  }

  // DOM 매칭 실패 시 NOL 티켓 게이트로 직접 진입
  const gate = nolTicketGateUrl(g);
  log.warn("예매 버튼을 못 찾아 NOL 티켓 게이트로 이동합니다.");
  await page.goto(gate, { waitUntil: "domcontentloaded", timeout: 60000 });
}

export async function runBookFlow(
  context: BrowserContext,
  page: Page,
  config: AppConfig,
  target?: SportsGoods | null,
): Promise<void> {
  await page.goto(config.postseasonUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  // 먼저 로그인 유도
  log.info("브라우저에서 NOL(야놀자) 로그인을 먼저 해주세요.");
  await page.goto("https://accounts.yanolja.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  }).catch(() => null);
  await ensureOnPostseason(page, config);

  // auth 체크 — 안 되어 있으면 예매 클릭 시 로그인으로 떨어지므로 안내
  const auth = await page
    .evaluate(async () => {
      try {
        const r = await fetch("/ticket/genre/sports/api/auth", {
          credentials: "include",
        });
        return await r.json();
      } catch {
        return { isLoggedIn: false };
      }
    })
    .catch(() => ({ isLoggedIn: false }));

  if (!auth?.isLoggedIn) {
    log.info("NOL 로그인 페이지를 엽니다. 로그인·본인인증은 직접 해주세요.");
    const redirect = `b64.${Buffer.from(config.postseasonUrl).toString("base64")}`;
    await page
      .goto(
        `https://accounts.yanolja.com/v3/login?service=yanolja&redirect=${redirect}`,
        { waitUntil: "domcontentloaded" },
      )
      .catch(async () => {
        await page.goto("https://accounts.yanolja.com/v3/login", {
          waitUntil: "domcontentloaded",
        });
      });
    await waitForLogin(page);
    await ensureOnPostseason(page, config);
  } else {
    log.ok("이미 NOL 로그인된 상태입니다.");
  }

  let goods = target ?? null;
  if (!goods) {
    goods = await watchForKiaHome(page, config);
  }
  if (!goods) throw new Error("예매할 기아 홈 상품이 없습니다.");

  // 오픈 시각까지 정밀 대기
  if (goods.bookingOpenTime) {
    const openAt = new Date(goods.bookingOpenTime).getTime() - config.openEarlyMs;
    while (Date.now() < openAt) {
      const left = openAt - Date.now();
      log.info(`오픈까지 ${Math.ceil(left / 1000)}초`);
      await page.waitForTimeout(Math.min(1000, left));
    }
  }

  let attempts = 0;
  while (attempts < config.maxSaleAttempts) {
    attempts += 1;
    log.info(`예매 시도 ${attempts}/${config.maxSaleAttempts}`);
    try {
      await ensureOnPostseason(page, config);
      await clickBookForGoods(page, goods, config);

      // 로그인 리다이렉트 처리
      await page.waitForTimeout(1500);
      if (page.url().includes(NOL_LOGIN_HOST)) {
        await waitForLogin(page);
        await ensureOnPostseason(page, config);
        await clickBookForGoods(page, goods, config);
      }

      // 새 탭으로 게이트가 열릴 수 있음
      await page.waitForTimeout(2000);
      const pages = context.pages();
      let active =
        pages.find((p) =>
          /gates\/ticket|gates\/partner|waiting|Seat|Book|tickets\./i.test(
            p.url(),
          ),
        ) ||
        pages[pages.length - 1] ||
        page;

      // 대기열 통과 대기 (새로고침 금지)
      active = await waitOutQueue(active);
      log.ok("대기열 통과 — 예매 확인(확인하고 예매하기) 처리");

      await clickConfirmAndBookAfterQueue(active);

      const selected = await selectGoodConsecutiveSeats(active, config);
      log.ok(
        "좌석 선택 완료:",
        selected.map((s) => s.label).join(", "),
      );
      await stopBeforePayment(active);
      log.ok("끝. 결제만 직접 하면 됩니다. (브라우저 유지)");
      return;
    } catch (e) {
      log.warn(String(e));
      await page.waitForTimeout(800);
    }
  }
  throw new Error("예매 시도 횟수를 초과했습니다.");
}
