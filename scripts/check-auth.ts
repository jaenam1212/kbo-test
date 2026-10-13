import { chromium } from "playwright";
import path from "node:path";

async function main() {
  const profile = path.join(process.cwd(), ".browser-profile");
  // attach-like: open with same profile briefly (may conflict if lock held)
  // Instead navigate via CDP if possible — fallback: use cookies from profile by connecting over remote debugging
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://nol.yanolja.com/ticket/genre/sports/postseason", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(2000);
  const auth = await page.evaluate(async () => {
    const r = await fetch("/ticket/genre/sports/api/auth", {
      credentials: "include",
    });
    return r.json();
  });
  console.log(JSON.stringify(auth, null, 2));
  console.log("URL", page.url());
  await context.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
