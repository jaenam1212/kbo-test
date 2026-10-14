import fs from "node:fs";
import path from "node:path";
import type { Page, Frame, Locator } from "playwright";
import sharp from "sharp";
import Tesseract from "tesseract.js";
import { log } from "./logger.js";

const CAPTCHA_IMG = [
  "img[src*='captcha' i]",
  "img[alt*='문자']",
  "img[alt*='보안']",
  "img[alt*='captcha' i]",
  "canvas",
  "[class*='captcha' i] img",
  "[class*='Captcha'] img",
].join(", ");

const CAPTCHA_INPUT = [
  "input[name*='captcha' i]",
  "input[id*='captcha' i]",
  "input[placeholder*='문자']",
  "input[placeholder*='보안']",
  "input[autocomplete='off'][type='text']",
].join(", ");

export type CaptchaOcrResult = {
  ok: boolean;
  text?: string;
  attempts: number;
  reason?: string;
};

function normalizeCaptchaText(raw: string): string {
  return raw
    .replace(/\s+/g, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
}

async function findCaptchaImage(
  root: Page | Frame,
): Promise<Locator | null> {
  const loc = root.locator(CAPTCHA_IMG);
  const n = await loc.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const el = loc.nth(i);
    if (await el.isVisible().catch(() => false)) return el;
  }
  // 모달 안 이미지 fallback
  const anyImg = root.locator("div[role='dialog'] img, .modal img, [class*='modal' i] img");
  const m = await anyImg.count().catch(() => 0);
  for (let i = 0; i < Math.min(m, 6); i++) {
    const el = anyImg.nth(i);
    const box = await el.boundingBox().catch(() => null);
    if (box && box.width >= 40 && box.width <= 400 && box.height >= 20 && box.height <= 120) {
      return el;
    }
  }
  return null;
}

async function findCaptchaInput(root: Page | Frame): Promise<Locator | null> {
  const loc = root.locator(CAPTCHA_INPUT);
  const n = await loc.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const el = loc.nth(i);
    if (await el.isVisible().catch(() => false)) return el;
  }
  // 보안문자 근처 text input
  const inputs = root.locator("input[type='text'], input:not([type])");
  const c = await inputs.count().catch(() => 0);
  for (let i = 0; i < c; i++) {
    const el = inputs.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const ph = ((await el.getAttribute("placeholder")) || "").toLowerCase();
    const name = ((await el.getAttribute("name")) || "").toLowerCase();
    if (/captcha|문자|보안|인증/.test(ph + name)) return el;
  }
  return null;
}

async function preprocessForOcr(png: Buffer): Promise<Buffer> {
  // 대비↑, 그레이스케일, 이진화로 인식률 소폭 개선
  return sharp(png)
    .greyscale()
    .normalize()
    .resize({ width: 360, height: 120, fit: "inside" })
    .threshold(140)
    .png()
    .toBuffer();
}

async function ocrImage(png: Buffer): Promise<string> {
  const processed = await preprocessForOcr(png);
  const dir = "/tmp/nol-captcha";
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `captcha-${Date.now()}.png`);
  fs.writeFileSync(file, processed);

  const { data } = await Tesseract.recognize(processed, "eng", {
    logger: () => {},
  });
  const text = normalizeCaptchaText(data.text || "");
  log.info(`OCR raw="${(data.text || "").trim()}" → "${text}" (${file})`);
  return text;
}

async function clickRefreshCaptcha(root: Page | Frame): Promise<void> {
  const refresh = root
    .getByRole("button", { name: /새로고침|다시|재생성|refresh/i })
    .or(root.locator("[class*='refresh' i], button:has(img[alt*='새로'])"));
  if (await refresh.first().isVisible().catch(() => false)) {
    await refresh.first().click({ timeout: 2000 }).catch(() => null);
    await new Promise((r) => setTimeout(r, 600));
  }
}

async function submitCaptcha(root: Page | Frame): Promise<void> {
  const submit = root.getByRole("button", {
    name: /확인|제출|입력|완료|인증/,
  });
  if (await submit.first().isVisible().catch(() => false)) {
    await submit.first().click({ timeout: 3000 }).catch(() => null);
  } else {
    const input = await findCaptchaInput(root);
    if (input) await input.press("Enter").catch(() => null);
  }
}

export async function pageHasCaptcha(page: Page): Promise<boolean> {
  const roots: (Page | Frame)[] = [page, ...page.frames()];
  for (const root of roots) {
    const t = await root.locator("body").innerText().catch(() => "");
    if (/보안문자|자동입력\s*방지|봇\s*감지|captcha/i.test(t)) return true;
    if (await findCaptchaImage(root)) return true;
    if (await findCaptchaInput(root)) return true;
  }
  return false;
}

/**
 * 보안문자 OCR — 최대 2회.
 * 1회 실패 시 새로고침(가능하면) 후 재시도.
 */
export async function solveCaptchaWithOcr(
  page: Page,
  maxAttempts = 2,
): Promise<CaptchaOcrResult> {
  const attempts = Math.min(2, Math.max(1, maxAttempts));
  const roots: (Page | Frame)[] = [page, ...page.frames()];

  for (let i = 1; i <= attempts; i++) {
    let root: Page | Frame | null = null;
    let img: Locator | null = null;
    let input: Locator | null = null;

    for (const r of roots) {
      const im = await findCaptchaImage(r);
      const inp = await findCaptchaInput(r);
      if (im || inp) {
        root = r;
        img = im;
        input = inp;
        break;
      }
    }

    if (!root || !input) {
      return { ok: false, attempts: i, reason: "captcha_input_not_found" };
    }

    let png: Buffer | null = null;
    if (img) {
      png = await img.screenshot({ type: "png" }).catch(() => null);
    }
    if (!png) {
      // 입력창 주변 영역 캡처 fallback
      const box = await input.boundingBox().catch(() => null);
      if (box) {
        png = await page
          .screenshot({
            type: "png",
            clip: {
              x: Math.max(0, box.x - 20),
              y: Math.max(0, box.y - 100),
              width: Math.min(400, box.width + 200),
              height: 120,
            },
          })
          .catch(() => null);
      }
    }
    if (!png) {
      log.warn(`OCR ${i}/${attempts}: 이미지 캡처 실패`);
      if (i < attempts) await clickRefreshCaptcha(root);
      continue;
    }

    const text = await ocrImage(png);
    if (text.length < 3) {
      log.warn(`OCR ${i}/${attempts}: 인식 결과 너무 짧음 "${text}"`);
      if (i < attempts) {
        await clickRefreshCaptcha(root);
        await page.waitForTimeout(500);
      }
      continue;
    }

    log.info(`OCR ${i}/${attempts}: "${text}" 입력`);
    await input.click({ timeout: 2000 }).catch(() => null);
    await input.fill("");
    await input.fill(text);
    await submitCaptcha(root);
    await page.waitForTimeout(1000);

    const still = await pageHasCaptcha(page);
    if (!still) {
      log.ok(`보안문자 OCR 성공 (시도 ${i}/${attempts}): ${text}`);
      return { ok: true, text, attempts: i };
    }

    log.warn(`OCR ${i}/${attempts}: 제출 후에도 보안문자 남음 — 재시도`);
    if (i < attempts) {
      await clickRefreshCaptcha(root);
      await page.waitForTimeout(500);
    }
  }

  return { ok: false, attempts, reason: "ocr_failed_max_attempts" };
}
