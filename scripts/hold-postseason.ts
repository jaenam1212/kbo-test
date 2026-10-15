/** 자동 예매 없이 NOL 포스트시즌만 열어 둠 (수동 Take Control용). */
import { loadConfig } from "../src/config.js";
import { launchContext } from "../src/browser.js";
import { log } from "../src/logger.js";

async function main() {
  const config = loadConfig();
  config.headless = false;
  const { page } = await launchContext(config);
  await page.goto(config.postseasonUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  log.ok("NOL 포스트시즌 유지 중 — 자동 예매 안 함. Take Control로 직접 예매하기.");
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
