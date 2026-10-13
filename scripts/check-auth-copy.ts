import { chromium } from "playwright";

async function main() {
  const context = await chromium.launchPersistentContext("/tmp/nol-profile-check", {
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
  await page.waitForTimeout(2500);
  const auth = await page.evaluate(async () => {
    try {
      const r = await fetch("/ticket/genre/sports/api/auth", { credentials: "include" });
      return await r.json();
    } catch (e) {
      return { error: String(e) };
    }
  });
  console.log("AUTH", JSON.stringify(auth));
  console.log("URL", page.url());
  await context.close();
}
main();
