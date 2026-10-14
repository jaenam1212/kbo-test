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

  let clicked = 0;
  // DOM에서 '일반' 텍스트 근처의 + 버튼 좌표를 찾아 mouse 클릭
  const plusPoint = await page.evaluate(() => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let el: Node | null = walk.nextNode();
    while (el) {
      const h = el as HTMLElement;
      const t = (h.textContent || "").replace(/\s+/g, " ").trim();
      if (
        h.children.length <= 6 &&
        /^일반/.test(t) &&
        t.length < 40 &&
        !/할인|패키지|문화/.test(t)
      ) {
        const root = h.closest("li, tr, [class*='item' i], [class*='row' i], div") || h.parentElement;
        if (root) {
          const btns = [
            ...root.querySelectorAll("button, [role='button'], span, a, div"),
          ] as HTMLElement[];
          for (const b of btns) {
            const bt = (b.textContent || "").trim();
            if (bt === "+" || bt === "＋") {
              const box = b.getBoundingClientRect();
              if (box.width > 0 && box.height > 0) {
                return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
              }
            }
          }
        }
      }
      el = walk.nextNode();
    }
    // fallback: 페이지에서 보이는 첫 + 
    for (const b of document.querySelectorAll("button, [role='button']")) {
      const bt = ((b as HTMLElement).textContent || "").trim();
      if (bt === "+" || bt === "＋") {
        const box = (b as HTMLElement).getBoundingClientRect();
        if (box.y > 150 && box.width > 0) {
          return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        }
      }
    }
    return null;
  });

  if (plusPoint) {
    log.info(`일반 + 좌표 (${Math.round(plusPoint.x)}, ${Math.round(plusPoint.y)})`);
    for (let i = 0; i < count; i++) {
      await page.mouse.click(plusPoint.x, plusPoint.y, { delay: 40 });
      clicked += 1;
      await page.waitForTimeout(350);
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
