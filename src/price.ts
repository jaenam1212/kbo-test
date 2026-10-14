import type { Page } from "playwright";
import { log } from "./logger.js";

/** onestop `step=price` 에서 일반 수량 채우고 예매하기 → 결제 직전 */
export async function assignGeneralPriceAndBook(
  page: Page,
  count: number,
): Promise<boolean> {
  const body = await page.locator("body").innerText().catch(() => "");
  if (!/가격 선택|티켓 금액/.test(body)) {
    return false;
  }
  log.info("가격 선택 화면 — 일반 수량 설정");

  // 일반 행 찾기
  const row = page
    .locator("li, div, section, tr, [class*='price' i], [class*='Price']")
    .filter({ hasText: /일반/ })
    .filter({ hasNotText: /문화누리|패키지|할인/ })
    .first();

  let clicked = 0;
  if (await row.isVisible().catch(() => false)) {
    const plus = row
      .locator("button, [role='button'], span, a")
      .filter({ hasText: /^\+$|^＋$/ })
      .first();
    if (await plus.isVisible().catch(() => false)) {
      for (let i = 0; i < count; i++) {
        await plus.click({ timeout: 3000 }).catch(() => null);
        clicked += 1;
        await page.waitForTimeout(300);
      }
    }
  }

  if (clicked < count) {
    // 페이지 내 첫 번째 + 를 count번 (보통 일반이 최상단)
    const pluses = page
      .locator("button, [role='button']")
      .filter({ hasText: /^\+$|^＋$/ });
    const n = await pluses.count().catch(() => 0);
    if (n > 0) {
      for (let i = clicked; i < count; i++) {
        await pluses.nth(0).click({ timeout: 3000 }).catch(() => null);
        clicked += 1;
        await page.waitForTimeout(300);
      }
    }
  }

  log.info(`일반 수량 + 클릭 ${clicked}회`);
  await page.waitForTimeout(600);

  const t = await page.locator("body").innerText().catch(() => "");
  if (/0\s*\/\s*\d+/.test(t) && /티켓 금액\s*0원/.test(t)) {
    log.warn("수량이 아직 0 — + 버튼을 못 눌렀을 수 있음");
  }

  const book = page.getByRole("button", { name: /^예매하기$/ }).first();
  if (await book.isVisible().catch(() => false)) {
    for (let i = 0; i < 10; i++) {
      const disabled = await book.isDisabled().catch(() => true);
      if (!disabled) {
        log.info("예매하기 클릭 (가격 확정 → 결제)");
        await book.click({ timeout: 8000 }).catch(() => null);
        await page.waitForTimeout(1500);
        return true;
      }
      await page.waitForTimeout(400);
    }
  }
  log.warn("예매하기 비활성 — 가격 수량 확인 필요");
  return false;
}
