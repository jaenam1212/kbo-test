/**
 * 내 PC에서 한 번 로그인·본인인증해 두기.
 *   LOCAL=1 npm run login
 * 끝나면 창을 닫지 말고 Enter — 프로필에 세션 저장.
 */
import { loadConfig } from "../src/config.js";
import { launchContext } from "../src/browser.js";
import { log } from "../src/logger.js";
import readline from "node:readline";

async function main() {
  process.env.LOCAL = process.env.LOCAL || "1";
  const config = loadConfig();
  config.headless = false;

  const { context, page } = await launchContext(config);
  await page.goto(config.postseasonUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  log.ok("브라우저에서 NOL 로그인·본인인증을 완료하세요.");
  log.info("끝나면 이 터미널에서 Enter 를 누르세요. (창은 자동으로 닫힙니다)");

  await new Promise<void>((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question("", () => {
      rl.close();
      resolve();
    });
  });

  const auth = await page
    .evaluate(async () => {
      try {
        const r = await fetch("/ticket/genre/sports/api/auth", {
          credentials: "include",
        });
        return await r.json();
      } catch {
        return { isLoggedIn: false };
      }
    })
    .catch(() => ({ isLoggedIn: false }));

  log.info("auth", auth);
  if (auth?.isLoggedIn && auth?.isIdentityValid) {
    log.ok("로그인·본인인증 OK — 이제 npm run game-day:local 로 오픈을 노리세요.");
  } else {
    log.warn("아직 로그인/본인인증이 안 됐을 수 있습니다. 다시 npm run login");
  }

  await context.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
