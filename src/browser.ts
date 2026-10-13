import fs from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { AppConfig } from "./types.js";
import { resolveProfileDir } from "./config.js";
import { log } from "./logger.js";

export async function launchContext(config: AppConfig): Promise<{
  context: BrowserContext;
  page: Page;
}> {
  const profile = resolveProfileDir(config);
  fs.mkdirSync(profile, { recursive: true });

  log.info(`브라우저 프로필: ${profile}`);
  const context = await chromium.launchPersistentContext(profile, {
    headless: config.headless,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1440, height: 960 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}
