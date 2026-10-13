import { chromium } from "playwright";
import path from "node:path";

async function main() {
  const profile = path.join(process.cwd(), ".browser-profile");
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1280, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(
    "https://accounts.yanolja.com/v3/login?service=yanolja&redirect=b64.aHR0cHM6Ly9ub2wueWFub2xqYS5jb20vdGlja2V0L2dlbnJlL3Nwb3J0cy9wb3N0c2Vhc29u",
    { waitUntil: "domcontentloaded", timeout: 60000 },
  );
  console.log("OPEN", page.url());
  console.log("Take Control로 로그인하세요. 브라우저는 유지됩니다.");
  // 로그인 후 포스트시즌으로 안 넘어가면 수동 이동용 안내
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
