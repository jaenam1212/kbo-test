import type { Frame, Page } from "playwright";
import type { AppConfig, SelectedSeat } from "./types.js";
import {
  gradeTier,
  parseRemaining,
  pickBestGradeIndex,
  scoreGradeLabel,
} from "./prefer.js";
import { log } from "./logger.js";

function pagesAndFrames(page: Page): (Page | Frame)[] {
  const out: (Page | Frame)[] = [page, ...page.frames()];
  for (const p of page.context().pages()) {
    out.push(p, ...p.frames());
  }
  return out;
}

async function collectGradeCandidates(root: Page | Frame): Promise<
  { index: number; label: string; score: number; remaining: number | null }[]
> {
  const labels = await root.evaluate(() => {
    const nodes = [
      ...document.querySelectorAll(
        "button, a, li, [role='button'], [class*='Grade'], [class*='grade'], [class*='SeatType'], [class*='seatGrade'], [class*='SeatGrade']",
      ),
    ];
    return nodes
      .map((el, index) => ({
        index,
        label: (el.textContent || "").replace(/\s+/g, " ").trim(),
        tag: el.tagName,
      }))
      .filter(
        (x) =>
          x.label.length >= 2 &&
          x.label.length <= 80 &&
          /(석|내야|외야|테이블|응원|중앙|K\d|3루|1루|일반|지정|블루|오렌지|레드|네이비|그린|VIP|R석|S석)/.test(
            x.label,
          ) &&
          !/예매하기|결제|다음단계|이전|닫기|취소|확인하고|로그인|등급 별|선택 완료|매표소|무료입장|환불|좌석변경|시야가 방해|유의사항|안내|불가합니다|판매합니다/.test(
            x.label,
          ) &&
          // 문장형 공지 제외 (등급명은 보통 짧고 '석/테이블/루' 중심)
          !/[.。]/.test(x.label) &&
          x.label.length <= 40,
      );
  });
  return labels.map((x) => ({
    ...x,
    remaining: parseRemaining(x.label),
    score: 0,
  }));
}

async function clickGradeByLabel(
  root: Page | Frame,
  label: string,
): Promise<boolean> {
  const locators = [
    root.getByRole("button", { name: label, exact: false }),
    root.locator("button,a,li,[role='button']").filter({ hasText: label }),
  ];
  for (const loc of locators) {
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 5); i++) {
      const item = loc.nth(i);
      if (await item.isVisible().catch(() => false)) {
        await item.click({ timeout: 3000 }).catch(() => null);
        return true;
      }
    }
  }
  return false;
}

function isNoiseSeatLabel(label: string): boolean {
  return /선택 시간|등급|가격|예매|확인|마이페이지|관람 구역|입력완료|보안|문자|휠체어 장애인석은|익사이팅석은|시야방해|유의사항|닫기|취소|로그인|결제/.test(
    label,
  );
}

/** 선택 가능한 좌석 DOM을 모아 2연석을 고른다. */
async function findConsecutiveSeats(
  root: Page | Frame,
  count: number,
): Promise<{ indexes: number[]; labels: string[] } | null> {
  const seats = await root.evaluate(() => {
    const noise =
      /선택 시간|등급|가격|예매|확인|마이페이지|관람 구역|입력완료|보안|문자|유의사항|닫기|취소|로그인|결제|zoom|확대|축소/i;
    const selectors = [
      "[data-seat-status='available']",
      "[data-status='available']",
      "[data-available='true']",
      "rect.seat:not(.disabled):not(.sold):not(.unavailable)",
      "circle.seat:not(.disabled):not(.sold)",
      "[class*='Seat'][class*='available']",
      "[class*='seat'][class*='Available']",
      "button[aria-label*='열'][aria-label*='번']",
      "[role='button'][aria-label*='열']",
      "[role='button'][aria-label*='좌석']",
    ];
    const nodes: HTMLElement[] = [];
    // 중첩 함수 금지 — tsx가 __name을 넣어 page.evaluate에서 깨짐
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach((el) => {
        const h = el as HTMLElement;
        const label = (
          h.getAttribute("aria-label") ||
          h.getAttribute("title") ||
          h.getAttribute("data-seat") ||
          h.textContent ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim();
        if (noise.test(label)) return;
        if (!nodes.includes(h)) nodes.push(h);
      });
    }
    // Interpark onestop: svg circle 좌석 (항상 수집)
    document.querySelectorAll("svg circle, svg rect.seat, svg circle.seat").forEach((el) => {
      const cls = (el.getAttribute("class") || "").toLowerCase();
      const fillRaw =
        el.getAttribute("fill") || getComputedStyle(el).fill || "";
      const fill = fillRaw.toLowerCase();
      const pointer = getComputedStyle(el).cursor;
      const box = (el as HTMLElement).getBoundingClientRect();
      if (box.width < 3 || box.height < 3 || box.width > 28 || box.height > 28) {
        return;
      }
      if (/(sold|disable|close|unavailable|block)/.test(cls)) return;
      // 회색/매진 계열 제외
      if (
        /#([89a-f]{2})\1\1|rgb\(\s*(1\d\d|2\d\d)\s*,\s*\1\s*,\s*\1|gray|grey|none/.test(
          fill,
        )
      ) {
        return;
      }
      const colorful =
        /#|rgb|hsl/.test(fill) &&
        !/#([c-f])\1\1|#e|#d|#ccc|#ddd|#eee|rgb\(2[0-4]\d/.test(fill);
      if (!(pointer === "pointer" || colorful || /(avail|empty|on|open|select)/.test(cls))) {
        return;
      }
      const h = el as HTMLElement;
      const label = (
        h.getAttribute("aria-label") ||
        h.getAttribute("title") ||
        h.getAttribute("data-seat") ||
        h.id ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim();
      if (noise.test(label)) return;
      if (!nodes.includes(h)) nodes.push(h);
    });

    return nodes.slice(0, 800).map((el, index) => {
      const label =
        el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        el.getAttribute("data-seat") ||
        el.getAttribute("data-name") ||
        el.id ||
        el.textContent ||
        `seat-${index}`;
      const row =
        el.getAttribute("data-row") ||
        el.getAttribute("data-floor") ||
        label.match(/(\d+)\s*열/)?.[1] ||
        "";
      const num =
        el.getAttribute("data-seat-no") ||
        el.getAttribute("data-col") ||
        label.match(/(\d+)\s*번/)?.[1] ||
        "";
      const box = el.getBoundingClientRect();
      return {
        index,
        label: label.replace(/\s+/g, " ").trim().slice(0, 80),
        row: String(row),
        num: Number(num) || 0,
        x: box.x,
        y: box.y,
        w: box.width,
        h: box.height,
      };
    });
  });

  const seatsClean = seats.filter(
    (s) => !isNoiseSeatLabel(s.label) && s.w > 0 && s.h > 0 && s.w <= 48 && s.h <= 48,
  );

  if (seatsClean.length < count) return null;

  // Prefer same-row consecutive numbers
  const byRow = new Map<string, typeof seatsClean>();
  for (const s of seatsClean) {
    const key = s.row || `y:${Math.round(s.y)}`;
    const arr = byRow.get(key) || [];
    arr.push(s);
    byRow.set(key, arr);
  }

  let best: { indexes: number[]; labels: string[]; score: number } | null = null;
  for (const [, rowSeats] of byRow) {
    const sorted = [...rowSeats].sort((a, b) => {
      if (a.num && b.num) return a.num - b.num;
      return a.x - b.x;
    });
    for (let i = 0; i <= sorted.length - count; i++) {
      const slice = sorted.slice(i, i + count);
      const nums = slice.map((s) => s.num);
      const consecutive =
        nums.every((n) => n > 0) &&
        nums.every((n, idx) => idx === 0 || n === nums[idx - 1]! + 1);
      const nearByX =
        count === 1 ||
        slice.every((s, idx) => {
          if (idx === 0) return true;
          const prev = slice[idx - 1]!;
          const gap = Math.abs(s.x - (prev.x + prev.w));
          const centerGap = Math.abs(s.x - prev.x);
          return gap < Math.max(55, prev.w * 3) || centerGap < Math.max(40, prev.w * 2.8);
        });
      if (!consecutive && !nearByX) continue;
      const score =
        (consecutive ? 100 : 40) +
        (slice[0]!.num > 0 ? Math.max(0, 40 - slice[0]!.num) : 0) -
        Math.round(slice[0]!.y / 20);
      if (!best || score > best.score) {
        best = {
          indexes: slice.map((s) => s.index),
          labels: slice.map((s) => s.label),
          score,
        };
      }
    }
  }
  // 연석 휴리스틱 실패 시: 같은 행에서 x 인접 2석이라도 반환
  if (!best && count >= 2) {
    for (const [, rowSeats] of byRow) {
      if (rowSeats.length < count) continue;
      const sorted = [...rowSeats].sort((a, b) => a.x - b.x);
      for (let i = 0; i <= sorted.length - count; i++) {
        const slice = sorted.slice(i, i + count);
        const span = slice[slice.length - 1]!.x - slice[0]!.x;
        if (span > 120) continue;
        best = {
          indexes: slice.map((s) => s.index),
          labels: slice.map((s) => s.label),
          score: 10 - span,
        };
        break;
      }
      if (best) break;
    }
  }
  return best;
}

/** 좌석 요소 중심 좌표를 모아 Playwright mouse로 클릭 (SVG dispatchEvent 무반응 대비) */
async function clickSeatIndexes(
  page: Page,
  root: Page | Frame,
  indexes: number[],
): Promise<boolean> {
  const points = await root.evaluate((idxs) => {
    const noise =
      /선택 시간|등급|가격|예매|확인|마이페이지|관람 구역|입력완료|보안|문자|유의사항|닫기|취소|로그인|결제/i;
    const selectors = [
      "[data-seat-status='available']",
      "[data-status='available']",
      "[data-available='true']",
      "rect.seat:not(.disabled):not(.sold):not(.unavailable)",
      "circle.seat:not(.disabled):not(.sold)",
      "[class*='Seat'][class*='available']",
      "[class*='seat'][class*='Available']",
      "button[aria-label*='열'][aria-label*='번']",
      "[role='button'][aria-label*='열']",
      "[role='button'][aria-label*='좌석']",
    ];
    const nodes: HTMLElement[] = [];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach((el) => {
        const h = el as HTMLElement;
        const label = (
          h.getAttribute("aria-label") ||
          h.getAttribute("title") ||
          h.textContent ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim();
        if (noise.test(label)) return;
        if (!nodes.includes(h)) nodes.push(h);
      });
    }
    document.querySelectorAll("svg circle, svg rect.seat, svg circle.seat").forEach((el) => {
      const cls = (el.getAttribute("class") || "").toLowerCase();
      const fill = (
        el.getAttribute("fill") ||
        getComputedStyle(el).fill ||
        ""
      ).toLowerCase();
      const pointer = getComputedStyle(el).cursor;
      const box = (el as HTMLElement).getBoundingClientRect();
      if (box.width < 3 || box.height < 3 || box.width > 28 || box.height > 28) {
        return;
      }
      if (/(sold|disable|close|unavailable)/.test(cls)) return;
      if (
        /#([89a-f]{2})\1\1|gray|grey|none|#ccc|#ddd|#eee/.test(fill)
      ) {
        return;
      }
      const colorful = /#|rgb|hsl/.test(fill);
      if (!(pointer === "pointer" || colorful)) return;
      const h = el as HTMLElement;
      if (!nodes.includes(h)) nodes.push(h);
    });
    return idxs.map((i) => {
      const el = nodes[i];
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return {
        x: b.x + b.width / 2,
        y: b.y + b.height / 2,
        label:
          el.getAttribute("aria-label") ||
          el.getAttribute("title") ||
          el.id ||
          `seat-${i}`,
      };
    });
  }, indexes);

  let ok = true;
  for (const p of points) {
    if (!p) {
      ok = false;
      continue;
    }
    await page.mouse.click(p.x, p.y, { delay: 40 });
    await page.waitForTimeout(200);
  }
  return ok && points.every(Boolean);
}

async function selectionConfirmed(page: Page): Promise<boolean> {
  const t = await page.locator("body").innerText().catch(() => "");
  // 사이드바에 선택 좌석이 잡히면 성공
  if (/선택한 좌석이 없습니다/.test(t)) return false;
  return /선택 좌석/.test(t);
}

async function waitForPriceOrNext(page: Page, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = page.url();
    const t = await page.locator("body").innerText().catch(() => "");
    if (/step=price/i.test(url) || /가격 선택|티켓 금액/.test(t)) {
      log.ok("가격 선택 화면 진입");
      return;
    }
    if (/결제|배송|수령|주문자|할인수단/.test(t)) {
      log.ok("결제/주문자 단계 진입");
      return;
    }
    await page.waitForTimeout(500);
  }
  log.warn("가격/결제 화면 전환 대기 시간 초과");
}

async function clickNextOrConfirm(root: Page | Frame): Promise<boolean> {
  const names = [
    /좌석\s*선택\s*완료/,
    /선택\s*완료/,
    /다음\s*단계/,
    /^다음$/,
    /결제하기/,
    /^예매하기$/,
  ];
  for (const re of names) {
    const btn = root.getByRole("button", { name: re }).first();
    if (await btn.isVisible().catch(() => false)) {
      const disabled = await btn.isDisabled().catch(() => false);
      if (disabled) continue;
      log.info(`다음 단계 클릭: ${re}`);
      await btn.click({ timeout: 5000 }).catch(() => null);
      return true;
    }
    const fallback = root
      .locator("button, a, [role='button']")
      .filter({ hasText: re })
      .first();
    if (await fallback.isVisible().catch(() => false)) {
      const disabled = await fallback.isDisabled().catch(() => false);
      if (disabled) continue;
      log.info(`다음 단계 클릭(fallback): ${re}`);
      await fallback.click({ timeout: 5000 }).catch(() => null);
      return true;
    }
  }
  return false;
}

const POST_QUEUE_BOOK_LABELS = [
  /확인하고\s*예매하기/,
  /확인\s*하고\s*예매하기/,
  /예매\s*정보\s*확인\s*후\s*예매하기/,
];

async function findVisibleConfirmBookButton(
  root: Page | Frame,
): Promise<ReturnType<Page["locator"]> | null> {
  for (const re of POST_QUEUE_BOOK_LABELS) {
    const roleBtn = root.getByRole("button", { name: re }).first();
    if (await roleBtn.isVisible().catch(() => false)) return roleBtn;

    const fallback = root
      .locator("button, a, [role='button']")
      .filter({ hasText: re })
      .first();
    if (await fallback.isVisible().catch(() => false)) return fallback;
  }
  return null;
}

/** 게이트 '예매 준비가 완료됐어요' 화면의 파란 예매하기 */
async function findGateReadyBookButton(
  root: Page | Frame,
): Promise<ReturnType<Page["locator"]> | null> {
  const body = await root.locator("body").innerText().catch(() => "");
  if (!/예매 준비가 완료|준비가 완료됐/.test(body)) return null;
  // exact-ish: 버튼 텍스트가 예매하기만 (확인하고 예매하기는 별도)
  const candidates = [
    root.getByRole("button", { name: /^예매하기$/ }),
    root.locator("button, a, [role='button']").filter({ hasText: /^예매하기$/ }),
  ];
  for (const loc of candidates) {
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 3); i++) {
      const b = loc.nth(i);
      if (await b.isVisible().catch(() => false)) return b;
    }
  }
  return null;
}

async function isConfirmBookModalVisible(page: Page): Promise<boolean> {
  for (const root of pagesAndFrames(page)) {
    if (await findVisibleConfirmBookButton(root)) return true;
  }
  return false;
}

/**
 * 정각 클릭 1회 — 연타 금지.
 * 여러 번 누르면 마지막 요청만 남거나 대기열이 꼬일 수 있음.
 * 서버시각 도달 후 버튼이 가능해질 때까지 짧게 폴링 → 성공 시 즉시 중단.
 */
export async function clickBookButtonOnceAtOpen(
  page: Page,
  waitMs = 8000,
): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    for (const root of pagesAndFrames(page)) {
      const locs = [
        root.getByRole("button", { name: /확인하고\s*예매하기/ }),
        root.locator("button, a, [role='button']").filter({
          hasText: /확인하고\s*예매하기/,
        }),
        root.getByRole("button", { name: /^예매하기$/ }),
        root
          .locator("button, a, [role='button']")
          .filter({ hasText: /^예매하기$/ }),
      ];
      for (const loc of locs) {
        const n = await loc.count().catch(() => 0);
        for (let i = 0; i < Math.min(n, 3); i++) {
          const b = loc.nth(i);
          const visible = await b.isVisible().catch(() => false);
          if (!visible) continue;
          const enabled = await b.isEnabled().catch(() => true);
          if (!enabled) continue;
          // force 없이 1회만 — 성공하면 절대 재클릭 안 함
          const ok = await b
            .click({ timeout: 400, noWaitAfter: true })
            .then(() => true)
            .catch(() => false);
          if (ok) {
            log.ok("정각 예매 클릭 1회 완료 — 추가 클릭 없음");
            return true;
          }
        }
      }
    }
    await new Promise((res) => setTimeout(res, 40));
  }
  log.warn("정각 클릭 대상 버튼을 못 찾음 (1회 정책 유지, 연타 안 함)");
  return false;
}

/** @deprecated 이름만 호환 — 내부는 1회 클릭 */
export async function slamBookButtonsNow(
  page: Page,
  _rounds = 1,
): Promise<boolean> {
  return clickBookButtonOnceAtOpen(page);
}

/**
 * 대기열/게이트 이후:
 * 1) '예매 준비가 완료됐어요' → 파란 예매하기
 * 2) 예매 안내(시야방해) 모달 → 확인하고 예매하기
 */
export async function clickConfirmAndBookAfterQueue(
  page: Page,
  timeoutMs = 180000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let clicked = false;

  while (Date.now() < deadline) {
    for (const root of pagesAndFrames(page)) {
      const body = await root.locator("body").innerText().catch(() => "");
      if (/접속 인원이 많아 대기|나의 대기순서|현재 대기인원/.test(body)) {
        await page.waitForTimeout(1500);
        continue;
      }

      const gateBtn = await findGateReadyBookButton(root);
      if (gateBtn) {
        log.info("예매 준비 완료 화면 — '예매하기' 클릭");
        await gateBtn.click({ timeout: 8000 }).catch(() => null);
        clicked = true;
        await page.waitForTimeout(1500);
        // 게이트 예매하기 직후 대기열이 다시 걸릴 수 있음 — 통과까지 대기
        const pages = page.context().pages();
        let active =
          pages.find((p) => /waiting|gates|onestop/i.test(p.url())) || page;
        if (await isWaitingRoom(active)) {
          log.info("게이트 이후 대기열 — 통과 대기 (새로고침 금지)");
          active = await waitOutQueue(active);
        }
        break;
      }

      const btn = await findVisibleConfirmBookButton(root);
      if (btn) {
        log.info("예매 안내 모달 — '확인하고 예매하기' 클릭");
        await btn.click({ timeout: 8000 }).catch(() => null);
        clicked = true;
        await page.waitForTimeout(1200);
        break;
      }
    }

    const stillConfirm = await isConfirmBookModalVisible(page);
    let stillGate = false;
    for (const root of pagesAndFrames(page)) {
      if (await findGateReadyBookButton(root)) {
        stillGate = true;
        break;
      }
    }

    if (clicked && !stillConfirm && !stillGate) {
      await page.waitForTimeout(1000);
      if (await isConfirmBookModalVisible(page)) continue;
      let gateAgain = false;
      for (const root of pagesAndFrames(page)) {
        if (await findGateReadyBookButton(root)) {
          gateAgain = true;
          break;
        }
      }
      if (gateAgain) continue;
      log.ok("예매 확인/게이트 단계 통과");
      return true;
    }

    // 모달·게이트 없이 이미 좌석 UI만 있으면 통과
    if (!stillConfirm && !stillGate) {
      const seatReady = await waitForSeatUi(page, 1500).catch(() => null);
      if (seatReady) {
        if (clicked) log.ok("예매 확인 후 좌석 화면 진입");
        return true;
      }
    }

    await page.waitForTimeout(800);
  }

  if (clicked) return true;
  log.warn(
    "'확인하고 예매하기'/게이트 예매하기 버튼을 찾지 못했습니다 — 수동 클릭이 필요할 수 있음",
  );
  return false;
}

/** 대기열 페이지면 true */
export async function isWaitingRoom(page: Page): Promise<boolean> {
  const url = page.url();
  if (/\/waiting/.test(url)) return true;
  const t = await page.locator("body").innerText().catch(() => "");
  return /접속 인원이 많아 대기|나의 대기순서|현재 대기인원/.test(t);
}

function isGateLoadingText(t: string): boolean {
  return /예매에 필요한 정보를 확인|잠시만 기다려|로딩/.test(t);
}

/** 로딩/대기열이 끝나고 예매 화면이 될 때까지 대기 (대기열에선 새로고침 금지). */
export async function waitOutQueue(
  page: Page,
  timeoutMs = 45 * 60 * 1000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  let active = page;
  let loadingSince = Date.now();
  while (Date.now() < deadline) {
    const pages = page.context().pages();
    // onestop/seat 를 gates 보다 우선 (게이트 탭이 남아 있으면 좌석 탭을 놓침)
    active =
      pages.find((p) => /onestop\/seat/i.test(p.url())) ||
      pages.find((p) => /\/waiting/i.test(p.url())) ||
      pages.find((p) =>
        /gates\/ticket|Seat|Book|booking|onestop/i.test(p.url()),
      ) ||
      pages[pages.length - 1] ||
      page;

    const t = await active.locator("body").innerText().catch(() => "");
    const url = active.url();

    if (await isWaitingRoom(active)) {
      loadingSince = Date.now();
      const orderRaw = t.match(/나의 대기순서\s*([\d,]+)/)?.[1];
      const totalRaw = t.match(/현재 대기인원\s*([\d,]+)/)?.[1];
      if (orderRaw) {
        const order = orderRaw.replace(/,/g, "");
        const total = totalRaw ? totalRaw.replace(/,/g, "") : "";
        log.info(
          `대기열 순서: ${Number(order).toLocaleString("ko-KR")}` +
            (total ? ` / 전체 ${Number(total).toLocaleString("ko-KR")}` : ""),
        );
      }
      await page.waitForTimeout(800);
      continue;
    }

    if (isGateLoadingText(t) && !/좌석선택|등급선택|잔여석/.test(t)) {
      // 로딩이 너무 길면 한 번만 게이트 재진입 (대기열이 아닐 때만)
      if (Date.now() - loadingSince > 45000 && /gates\/ticket/.test(url)) {
        log.warn("게이트 로딩 지연 — 같은 URL 재로드 1회");
        await active.reload({ waitUntil: "domcontentloaded" }).catch(() => null);
        loadingSince = Date.now();
      }
      await page.waitForTimeout(400);
      continue;
    }

    // 실제 예매/좌석 관련 화면 (게이트 준비완료 / onestop / 예매안내 포함)
    if (
      /onestop\/seat/i.test(url) ||
      POST_QUEUE_BOOK_LABELS.some((re) => re.test(t)) ||
      /예매 준비가 완료|준비가 완료됐/.test(t) ||
      /좌석선택|등급선택|잔여석|원하시는 좌석|좌석을 선택|예매 안내/.test(t) ||
      (/gates\/ticket/.test(url) && t.length > 80 && !isGateLoadingText(t))
    ) {
      return active;
    }

    await page.waitForTimeout(400);
  }
  throw new Error("대기열/로딩 타임아웃");
}

export async function waitForSeatUi(
  page: Page,
  timeoutMs = 180000,
): Promise<Page | Frame | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // 대기열이면 좌석 UI로 보지 않음
    for (const p of page.context().pages()) {
      if (await isWaitingRoom(p)) {
        await page.waitForTimeout(1500);
        continue;
      }
    }
    // 예매 안내 모달(확인하고 예매하기)이 떠 있으면 아직 좌석 선택 단계가 아님
    if (await isConfirmBookModalVisible(page)) {
      await page.waitForTimeout(800);
      continue;
    }
    for (const root of pagesAndFrames(page)) {
      const has = await root
        .evaluate(() => {
          const t = document.body?.innerText || "";
          if (/접속 인원이 많아 대기|나의 대기순서|현재 대기인원/.test(t)) {
            return false;
          }
          if (/오류가 발생했습니다/.test(t)) return false;
          // 실제 좌석/등급 선택 화면 신호
          return (
            (/등급선택|좌석선택|잔여석|원하시는 좌석|좌석을 선택|관람 구역|선택 좌석|선택 완료|STAGE/.test(
              t,
            ) ||
              /내야|외야|테이블석|응원|블루석|레드석|네이비|VIP|R석|S석/.test(
                t,
              )) &&
            document.querySelectorAll(
              "svg rect, svg circle, [class*='seat' i], [class*='Seat'], [data-seat], button, li",
            ).length > 5
          );
        })
        .catch(() => false);
      if (has) return root;
    }
    await page.waitForTimeout(1000);
  }
  return null;
}

/** 예매 안내/시야방해 모달 닫기 ('확인하고 예매하기' 포함) */
export async function dismissBookingNotices(page: Page): Promise<void> {
  // 실측: 모달 CTA가 '확인'이 아니라 '확인하고 예매하기'
  for (const root of pagesAndFrames(page)) {
    const confirmBook = await findVisibleConfirmBookButton(root);
    if (confirmBook) {
      log.info("예매 안내 — '확인하고 예매하기' 클릭");
      await confirmBook.click({ timeout: 5000 }).catch(() => null);
      await page.waitForTimeout(800);
    }
  }

  for (const name of ["확인", "닫기", "동의", "다음에"]) {
    for (const root of pagesAndFrames(page)) {
      const btn = root.getByRole("button", { name: new RegExp(`^${name}$`) });
      const n = await btn.count().catch(() => 0);
      for (let i = 0; i < Math.min(n, 3); i++) {
        const b = btn.nth(i);
        if (await b.isVisible().catch(() => false)) {
          const ctx = await root
            .locator("body")
            .innerText()
            .catch(() => "");
          if (/예매 안내|시야방해|유의사항|안내/.test(ctx)) {
            await b.click({ timeout: 2000 }).catch(() => null);
            await page.waitForTimeout(400);
          }
        }
      }
    }
  }
}

/**
 * 보안문자: OCR 최대 2회 → 실패 시 수동(Take Control) 대기.
 */
export async function solveCaptchaIfPresent(
  page: Page,
  opts?: { text?: string; waitManualMs?: number; ocrAttempts?: number },
): Promise<boolean> {
  const { pageHasCaptcha, solveCaptchaWithOcr } = await import("./captcha.js");
  if (!(await pageHasCaptcha(page))) return false;

  // 직접 문자열이 넘어오면 1회 입력만
  if (opts?.text) {
    const input = page
      .locator(
        "input[name*='captcha' i], input[placeholder*='문자'], input[type='text']",
      )
      .first();
    if (await input.isVisible().catch(() => false)) {
      await input.fill(opts.text);
      const submit = page.getByRole("button", {
        name: /확인|제출|입력|완료/,
      });
      if (await submit.first().isVisible().catch(() => false)) {
        await submit.first().click();
      }
      await page.waitForTimeout(800);
      return !(await pageHasCaptcha(page));
    }
  }

  const attempts = opts?.ocrAttempts ?? 2;
  log.info(`보안문자 감지 — OCR 최대 ${attempts}회 시도`);
  const ocr = await solveCaptchaWithOcr(page, attempts);
  if (ocr.ok) return true;

  log.warn(
    `OCR ${ocr.attempts}회 실패(${ocr.reason}) — Take Control로 직접 입력 대기`,
  );
  const waitMs = opts?.waitManualMs ?? 90000;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!(await pageHasCaptcha(page))) {
      log.ok("보안문자 수동 입력 확인");
      return true;
    }
    await page.waitForTimeout(1000);
  }
  return false;
}

export async function selectGoodConsecutiveSeats(
  page: Page,
  config: AppConfig,
): Promise<SelectedSeat[]> {
  // onestop/seat 등 실측 URL 우선
  const seatPage =
    page
      .context()
      .pages()
      .find((p) => /onestop\/seat|gates\/ticket/i.test(p.url())) || page;

  await clickConfirmAndBookAfterQueue(seatPage);
  await dismissBookingNotices(seatPage);
  await solveCaptchaIfPresent(seatPage);

  const root = await waitForSeatUi(seatPage);
  if (!root) {
    throw new Error("좌석 선택 화면을 찾지 못했습니다. 로그인이 끝났는지 확인하세요.");
  }

  // 등급/구역 후보 — 잔여 0 제외, 테이블석 점수 우선
  type Graded = { label: string; s: number; remaining: number | null };
  const graded: Graded[] = [];
  for (const r of pagesAndFrames(page)) {
    const cands = await collectGradeCandidates(r).catch(() => []);
    for (const c of cands) {
      if (graded.some((g) => g.label === c.label)) continue;
      // 가격표(…120,000원)는 제외 — 잔여 목록만 사용
      if (/원/.test(c.label)) continue;
      if (c.remaining === 0) continue;
      // 잔여 숫자가 안 보이면 후순위 (매진 등급일 수 있음)
      const s =
        scoreGradeLabel(c.label, config) +
        (c.remaining != null && c.remaining > 0
          ? 40 + Math.min(30, c.remaining)
          : -20);
      if (s <= -500) continue;
      graded.push({ label: c.label, s, remaining: c.remaining });
    }
  }
  // 폭포: 1) 중앙테이블≈3루테이블 → 2) 그 외 테이블 → 3) 아무 3연석
  const pool = graded.filter((g) => g.remaining == null || g.remaining > 0);
  pool.sort((a, b) => {
    const d = gradeTier(b.label) - gradeTier(a.label);
    if (d !== 0) return d;
    return b.s - a.s;
  });

  const gradeLabels = pool.map((g) => g.label);
  const tier1 = pool.filter((g) => gradeTier(g.label) === 3);
  const tier2 = pool.filter((g) => gradeTier(g.label) === 2);
  log.info(
    "등급 후보 폭포(①중앙≈3루테이블 → ②테이블3연석 → ③아무3연석):",
    [
      tier1.length
        ? `① ${tier1
            .slice(0, 6)
            .map(
              (g) =>
                `${g.label}${g.remaining != null ? `(잔여${g.remaining})` : ""}`,
            )
            .join(" / ")}`
        : "① (없음)",
      tier2.length
        ? `② ${tier2
            .slice(0, 6)
            .map(
              (g) =>
                `${g.label}${g.remaining != null ? `(잔여${g.remaining})` : ""}`,
            )
            .join(" / ")}`
        : "② (없음)",
      "③ 나머지 등급·도면 직선택",
    ].join(" | "),
  );

  const tryOrder =
    gradeLabels.length > 0
      ? gradeLabels
      : [...config.preferredGrades];

  // 티어1~2 먼저, 없으면 일반 등급까지 넓게 시도 (마지막에 도면 직선택 폴백)
  for (const grade of tryOrder.slice(0, 28)) {
    log.info(`등급 시도: ${grade}`);
    // 클릭용 짧은 이름 (잔여 숫자·가격 제거)
    const clickName = grade
      .replace(/\d+원/g, "")
      .replace(/\s*\d+\s*$/, "")
      .replace(/\s+/g, " ")
      .trim();
    let clicked = false;
    for (const r of pagesAndFrames(page)) {
      if (
        (await clickGradeByLabel(r, clickName)) ||
        (clickName !== grade && (await clickGradeByLabel(r, grade)))
      ) {
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      log.warn(`등급 클릭 실패: ${clickName}`);
      continue;
    }
    await page.waitForTimeout(500);
    await solveCaptchaIfPresent(seatPage, {
      ocrAttempts: 2,
      waitManualMs: 90000,
    });

    // 테이블석(N인) 패키지는 유닛 1개 = N명 → 1칸만 선택
    const wantTable = /테이블/.test(grade);
    const need = wantTable && /\(\d+\s*인\)/.test(grade) ? 1 : config.seatCount;

    for (const r of pagesAndFrames(page)) {
      const pair = await findConsecutiveSeats(r, need);
      if (!pair) continue;
      if (pair.labels.some(isNoiseSeatLabel)) continue;
      log.ok(`좌석 발견: ${pair.labels.join(" + ")}`);
      const ok = await clickSeatIndexes(page, r, pair.indexes);
      if (!ok) continue;
      await page.waitForTimeout(600);
      if (!(await selectionConfirmed(page))) {
        log.warn("클릭 후에도 좌석 미선택 — 다음 후보");
        continue;
      }
      log.ok("좌석 선택 확인됨");
      await clickNextOrConfirm(seatPage);
      await waitForPriceOrNext(seatPage);
      return pair.labels.map((label) => ({ label, grade: clickName }));
    }
  }

  // 등급 클릭 없이도 좌석만 있는 경우 (뮤지컬 등 도면 직선택)
  for (const r of pagesAndFrames(page)) {
    const pair = await findConsecutiveSeats(r, config.seatCount);
    if (!pair) continue;
    if (pair.labels.some(isNoiseSeatLabel)) continue;
    log.ok(`연석 발견(등급 생략): ${pair.labels.join(" + ")}`);
    const ok = await clickSeatIndexes(page, r, pair.indexes);
    if (!ok) continue;
    await page.waitForTimeout(600);
    if (!(await selectionConfirmed(page))) {
      log.warn("등급 생략 클릭 실패 — 다른 연석 시도");
      continue;
    }
    log.ok("좌석 선택 확인됨");
    await clickNextOrConfirm(seatPage);
    await waitForPriceOrNext(seatPage);
    return pair.labels.map((label) => ({ label }));
  }

  throw new Error(
    "3연석을 자동으로 못 찾았습니다. 브라우저에서 좌석만 고르면 결제 직전까지는 직접 진행하세요.",
  );
}

export async function stopBeforePayment(page: Page): Promise<void> {
  log.ok(
    "결제 직전에서 멈춥니다. 카드/간편결제는 직접 완료하세요. 브라우저는 열어둡니다.",
  );
  // 카드번호 입력창이 보이면 절대 자동 입력하지 않음
  const paymentHints = [
    /카드번호/,
    /결제수단/,
    /무통장/,
    /PAYCO|페이코|카카오페이|네이버페이/,
    /최종결제/,
  ];
  for (let i = 0; i < 30; i++) {
    const text = await page.locator("body").innerText().catch(() => "");
    if (paymentHints.some((re) => re.test(text))) {
      log.ok("결제 화면 감지 — 여기서 수동 결제하세요.");
      return;
    }
    // 다음 단계가 남았으면 좌석확정까지만 한 번 더
    await page.waitForTimeout(2000);
  }
}

export { pickBestGradeIndex };
