import fs from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { AppConfig } from "./types.js";
import { resolveProfileDir } from "./config.js";
import { log } from "./logger.js";

/**
 * 로컬 PC 권장:
 * - CHANNEL=chrome  → 설치된 Chrome 사용 (지연·탐지 면에서 Chromium보다 유리)
 * - CDP_URL=http://127.0.0.1:9222 → 이미 띄운 Chrome에 붙기 (로그인 유지)
 */
export async function launchContext(config: AppConfig): Promise<{
  context: BrowserContext;
  page: Page;
  browser?: Browser;
}> {
  const cdp = process.env.CDP_URL?.trim();
  if (cdp) {
    log.info(`CDP 연결: ${cdp}`);
    const browser = await chromium.connectOverCDP(cdp);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    return { context, page, browser };
  }

  const profile = resolveProfileDir(config);
  fs.mkdirSync(profile, { recursive: true });
  log.info(`브라우저 프로필: ${profile}`);

  const channel = (process.env.CHANNEL || "").trim() || undefined;
  // LOCAL=1 이면 기본으로 시스템 Chrome
  const useChannel =
    channel ||
    (process.env.LOCAL === "1" || process.env.LOCAL === "true"
      ? "chrome"
      : undefined);

  if (useChannel) log.info(`Chrome 채널: ${useChannel}`);

  const context = await chromium.launchPersistentContext(profile, {
    headless: config.headless,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1440, height: 960 },
    channel: useChannel as "chrome" | "msedge" | undefined,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}
