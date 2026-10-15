import type { BrowserContext, Page } from "playwright";
import type { AppConfig, SportsGoods } from "./types.js";
import {
  fetchPostseasonGoods,
  formatGoods,
  isBookingOpen,
  parseNolTime,
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
  opts: { preferGate?: boolean } = {},
): Promise<void> {
  // 속도전: goodsCode 알면 게이트 URL 직행 (DOM 탐색보다 빠름)
  if (opts.preferGate !== false && g.goodsCode && g.placeCode) {
    const gate = nolTicketGateUrl(g);
    log.info("게이트 직행:", gate);
    await page.goto(gate, { waitUntil: "domcontentloaded", timeout: 30000 });
    return;
  }

  await ensureOnPostseason(page, config);

  const buttons = await listVisibleBookButtons(page);
  const round = g.goodsName.match(/(\d+)\s*차전/)?.[1];
  const [, mo, day] = (g.playDate || "").split("-");
  let idx = -1;
  // 1) N차전 + 월/일 동시 매칭
  if (round && mo && day) {
    idx = buttons.findIndex(
      (b) =>
        b.label.includes(`${round}차전`) &&
        (b.label.includes(`${Number(mo)}월`) ||
          b.label.includes(`${mo}.`)) &&
        (b.label.includes(`${Number(day)}일`) ||
          b.label.includes(`.${Number(day)}`) ||
          b.label.includes(`${day}`)),
    );
  }
  // 2) N차전만
  if (idx < 0 && round) {
    idx = buttons.findIndex((b) => b.label.includes(`${round}차전`));
  }
  // 3) 월/일
  if (idx < 0 && mo && day) {
    idx = buttons.findIndex(
      (b) =>
        b.label.includes(`${Number(mo)}월`) &&
        b.label.includes(`${Number(day)}일`),
    );
  }
  if (idx < 0 && buttons.length === 1) idx = 0;

  if (idx >= 0) {
    log.info(`NOL '예매하기' 클릭 (#${idx}) — ${buttons[idx]?.label}`);
    const btn = page.locator("button", { hasText: "예매하기" }).nth(idx);
    await btn.click({ timeout: 5000 });
    return;
  }

  const gate = nolTicketGateUrl(g);
  log.warn("예매 버튼 없음 — 게이트 직행");
  await page.goto(gate, { waitUntil: "domcontentloaded", timeout: 30000 });
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

  // game-day가 이미 정각 맞춰 호출함 — 추가 대기는 최소만 (중복 sleep 금지)
  if (goods.bookingOpenTime) {
    const openMs = parseNolTime(goods.bookingOpenTime);
    if (openMs != null) {
      const openAt = openMs - config.openEarlyMs;
      while (Date.now() < openAt) {
        const left = openAt - Date.now();
        if (left > 200)
          await new Promise((r) => setTimeout(r, Math.min(50, left)));
      }
    }
  }

  const isAbnormalAccess = async (p: Page): Promise<boolean> => {
    const text = await p.locator("body").innerText().catch(() => "");
    return /정상적인\s*접근이\s*아닙니다|비정상\s*접근|잘못된\s*접근|비정상적인\s*경로/.test(
      text,
    );
  };

  let attempts = 0;
  while (attempts < config.maxSaleAttempts) {
    attempts += 1;
    log.info(`예매 시도 ${attempts}/${config.maxSaleAttempts} (게이트 직행·${config.seatCount}연석)`);
    try {
      // 1회차: NOL '예매하기' 경로 우선 (게이트 URL 직행은 비정상접근 유발)
      // 2회차+: 재돌입 자체를 최소화 — NOL 버튼만
      await clickBookForGoods(page, goods, config, { preferGate: false });

      await page.waitForTimeout(400);
      if (page.url().includes(NOL_LOGIN_HOST)) {
        await waitForLogin(page);
        await clickBookForGoods(page, goods, config, { preferGate: false });
      }

      await page.waitForTimeout(300);
      const pages = context.pages();
      let active =
        pages.find((p) => /onestop\/seat/i.test(p.url())) ||
        pages.find((p) => /\/waiting/i.test(p.url())) ||
        pages.find((p) =>
          /gates\/ticket|gates\/partner|Seat|Book|tickets\./i.test(p.url()),
        ) ||
        pages[pages.length - 1] ||
        page;

      if (await isAbnormalAccess(active)) {
        log.error(
          "인터파크 '정상적인 접근이 아닙니다' 감지 — 재시도 중단. 폰/다른 PC 같은 계정 예매창 닫고, Take Control로 NOL→예매하기 한 번만 진입하세요.",
        );
        return;
      }

      active = await waitOutQueue(active);
      if (await isAbnormalAccess(active)) {
        log.error(
          "인터파크 '정상적인 접근이 아닙니다' 감지 — 재시도 중단. 같은 계정 동시접속/게이트 직행 반복이 원인일 수 있습니다.",
        );
        return;
      }
      log.ok("대기열 통과 — 확인하고 예매하기");

      await clickConfirmAndBookAfterQueue(active);
      active = await waitOutQueue(active);
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
      const msg = String(e);
      log.warn(msg);
      if (/정상적인\s*접근|비정상\s*접근|잘못된\s*접근/.test(msg)) {
        log.error("비정상 접근 — 추가 게이트 재진입 중단");
        return;
      }
      // 좌석 실패 후 바로 게이트 재돌입하지 않도록 잠시 대기
      await page.waitForTimeout(1500);
    }
  }
  throw new Error("예매 시도 횟수를 초과했습니다.");
}
