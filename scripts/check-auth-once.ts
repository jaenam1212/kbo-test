import { loadConfig } from "../src/config.js";
import { launchContext } from "../src/browser.js";

async function main() {
  const config = loadConfig();
  config.headless = process.env.HEADLESS === "1";
  const { context, page } = await launchContext(config);
  await page.goto(config.postseasonUrl, {
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
  await context.close();
  if (!auth?.isLoggedIn || !auth?.isIdentityValid) process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
