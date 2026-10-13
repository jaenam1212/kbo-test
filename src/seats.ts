import type { Frame, Page } from "playwright";
import type { AppConfig, SelectedSeat } from "./types.js";
import { pickBestGradeIndex, scoreGradeLabel } from "./prefer.js";
import { log } from "./logger.js";

function pagesAndFrames(page: Page): (Page | Frame)[] {
  const out: (Page | Frame)[] = [page, ...page.frames()];
  for (const p of page.context().pages()) {
    out.push(p, ...p.frames());
  }
  return out;
}

async function collectGradeCandidates(root: Page | Frame): Promise<
  { index: number; label: string; score: number }[]
> {
  const labels = await root.evaluate(() => {
    const nodes = [
      ...document.querySelectorAll(
        "button, a, li, [role='button'], [class*='Grade'], [class*='grade'], [class*='SeatType']",
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
          x.label.length <= 40 &&
          /(석|내야|외야|테이블|응원|중앙|K\d|3루|1루|일반|지정)/.test(x.label) &&
          !/예매|결제|다음|이전|닫기|취소|확인|로그인/.test(x.label),
      );
  });
  return labels.map((x) => ({
    ...x,
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

/** 선택 가능한 좌석 DOM을 모아 2연석을 고른다. */
async function findConsecutiveSeats(
  root: Page | Frame,
  count: number,
): Promise<{ indexes: number[]; labels: string[] } | null> {
  const seats = await root.evaluate(() => {
    const selectors = [
      "[data-seat-status='available']",
      "[data-status='available']",
      "[data-available='true']",
      "rect.seat:not(.disabled):not(.sold):not(.unavailable)",
      "circle.seat:not(.disabled):not(.sold)",
      "[class*='Seat'][class*='available']",
      "[class*='seat'][class*='Available']",
      "button[aria-label*='열']",
      "button[aria-label*='석']",
      "[role='button'][aria-label*='좌석']",
    ];
    const nodes: HTMLElement[] = [];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach((el) => {
        if (!nodes.includes(el as HTMLElement)) nodes.push(el as HTMLElement);
      });
    }
    // SVG path/rect with fill that looks selectable
    if (nodes.length === 0) {
      document.querySelectorAll("svg rect, svg circle, svg path").forEach((el) => {
        const cls = (el.getAttribute("class") || "").toLowerCase();
        const fill = (el.getAttribute("fill") || "").toLowerCase();
        const pointer = getComputedStyle(el).cursor;
        if (
          pointer === "pointer" ||
          /(avail|empty|on|open|select)/.test(cls) ||
          fill === "#ffffff" ||
          fill === "#fff"
        ) {
          if (!/(sold|disable|close|selected|mine)/.test(cls)) {
            nodes.push(el as HTMLElement);
          }
        }
      });
    }

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

  if (seats.length < count) return null;

  // Prefer same-row consecutive numbers
  const byRow = new Map<string, typeof seats>();
  for (const s of seats) {
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
        slice.every((s, idx) => {
          if (idx === 0) return true;
          const prev = slice[idx - 1]!;
          return Math.abs(s.x - (prev.x + prev.w)) < Math.max(40, prev.w * 1.8);
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
  return best;
}

async function clickSeatIndexes(
  root: Page | Frame,
  indexes: number[],
): Promise<boolean> {
  return root.evaluate((idxs) => {
    const selectors = [
      "[data-seat-status='available']",
      "[data-status='available']",
      "[data-available='true']",
      "rect.seat:not(.disabled):not(.sold):not(.unavailable)",
      "circle.seat:not(.disabled):not(.sold)",
      "[class*='Seat'][class*='available']",
      "[class*='seat'][class*='Available']",
      "button[aria-label*='열']",
      "button[aria-label*='석']",
      "[role='button'][aria-label*='좌석']",
    ];
    const nodes: HTMLElement[] = [];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach((el) => {
        if (!nodes.includes(el as HTMLElement)) nodes.push(el as HTMLElement);
      });
    }
    if (nodes.length === 0) {
      document.querySelectorAll("svg rect, svg circle, svg path").forEach((el) => {
        const cls = (el.getAttribute("class") || "").toLowerCase();
        const pointer = getComputedStyle(el).cursor;
        if (pointer === "pointer" || /(avail|empty|on|open|select)/.test(cls)) {
          nodes.push(el as HTMLElement);
        }
      });
    }
    let ok = true;
    for (const i of idxs) {
      const el = nodes[i];
      if (!el) {
        ok = false;
        continue;
      }
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    }
    return ok;
  }, indexes);
}

async function clickNextOrConfirm(root: Page | Frame): Promise<boolean> {
  const names = [
    "좌석선택완료",
    "선택완료",
    "다음단계",
    "다음",
    "결제하기",
    "예매하기",
    "확인",
  ];
  for (const name of names) {
    const btn = root.getByRole("button", { name: new RegExp(name) }).first();
    if (await btn.isVisible().catch(() => false)) {
      // 결제 최종 승인/카드입력 직전까지만 — "결제하기"는 누르되 카드 정보는 입력하지 않음
      await btn.click({ timeout: 5000 }).catch(() => null);
      return true;
    }
  }
  return false;
}

export async function waitForSeatUi(
  page: Page,
  timeoutMs = 120000,
): Promise<Page | Frame | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const root of pagesAndFrames(page)) {
      const has = await root
        .evaluate(() => {
          const t = document.body?.innerText || "";
          return (
            /좌석|등급|구역|내야|외야|열|번/.test(t) &&
            !/오류가 발생했습니다/.test(t)
          );
        })
        .catch(() => false);
      if (has) return root;
    }
    await page.waitForTimeout(1000);
  }
  return null;
}

export async function selectGoodConsecutiveSeats(
  page: Page,
  config: AppConfig,
): Promise<SelectedSeat[]> {
  const root = await waitForSeatUi(page);
  if (!root) {
    throw new Error("좌석 선택 화면을 찾지 못했습니다. 로그인이 끝났는지 확인하세요.");
  }

  // 등급/구역 후보
  let gradeLabels: string[] = [];
  for (const r of pagesAndFrames(page)) {
    const cands = await collectGradeCandidates(r).catch(() => []);
    for (const c of cands) {
      if (!gradeLabels.includes(c.label)) gradeLabels.push(c.label);
    }
  }
  gradeLabels = gradeLabels
    .map((l) => ({ l, s: scoreGradeLabel(l, config) }))
    .filter((x) => x.s > -500)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.l);

  log.info(
    "등급 후보:",
    gradeLabels.slice(0, 8).join(" / ") || "(자동 감지 실패 — 화면 기준 진행)",
  );

  const tryOrder =
    gradeLabels.length > 0
      ? gradeLabels
      : [...config.preferredGrades];

  for (const grade of tryOrder.slice(0, 12)) {
    log.info(`등급 시도: ${grade}`);
    let clicked = false;
    for (const r of pagesAndFrames(page)) {
      if (await clickGradeByLabel(r, grade)) {
        clicked = true;
        break;
      }
    }
    if (clicked) await page.waitForTimeout(1200);

    for (const r of pagesAndFrames(page)) {
      const pair = await findConsecutiveSeats(r, config.seatCount);
      if (!pair) continue;
      log.ok(`연석 발견: ${pair.labels.join(" + ")}`);
      const ok = await clickSeatIndexes(r, pair.indexes);
      if (!ok) continue;
      await page.waitForTimeout(800);
      for (const rr of pagesAndFrames(page)) {
        await clickNextOrConfirm(rr);
      }
      return pair.labels.map((label) => ({ label, grade }));
    }
  }

  // 등급 클릭 없이도 좌석만 있는 경우
  for (const r of pagesAndFrames(page)) {
    const pair = await findConsecutiveSeats(r, config.seatCount);
    if (!pair) continue;
    log.ok(`연석 발견(등급 생략): ${pair.labels.join(" + ")}`);
    await clickSeatIndexes(r, pair.indexes);
    await page.waitForTimeout(800);
    for (const rr of pagesAndFrames(page)) await clickNextOrConfirm(rr);
    return pair.labels.map((label) => ({ label }));
  }

  throw new Error(
    "좋은 2연석을 자동으로 못 찾았습니다. 브라우저에서 좌석만 고르면 결제 직전까지는 직접 진행하세요.",
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
