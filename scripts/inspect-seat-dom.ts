import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

async function main() {
  const profile = path.join(process.cwd(), ".browser-profile");
  // connect to existing? if locked, use copy — try same profile first after killing test
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1400, height: 1000 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  const page = context.pages()[0] ?? (await context.newPage());

  // If already on seat page, reuse; else open via NOL
  if (!/gates\/ticket/.test(page.url())) {
    await page.goto(
      "https://nol.yanolja.com/ticket/genre/sports/postseason",
      { waitUntil: "domcontentloaded", timeout: 60000 },
    );
    await page.waitForSelector("button:has-text('예매하기')", { timeout: 30000 });
    await page.locator("button", { hasText: "예매하기" }).first().click();
    await page.waitForTimeout(4000);
  }

  const active =
    context.pages().find((p) => /gates\/ticket/.test(p.url())) || page;
  await active.waitForTimeout(3000);
  console.log("URL", active.url());

  await active.screenshot({ path: "/tmp/seat-dom.png", fullPage: true });

  const info = await active.evaluate(() => {
    const text = (document.body?.innerText || "").slice(0, 4000);
    const buttons = [...document.querySelectorAll("button, a, [role=button]")]
      .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
      .filter((t) => t && t.length < 40)
      .slice(0, 80);
    const iframes = [...document.querySelectorAll("iframe")].map((f) => ({
      src: f.src,
      id: f.id,
      name: f.name,
      cls: f.className,
    }));
    const svgCounts = {
      rect: document.querySelectorAll("svg rect").length,
      circle: document.querySelectorAll("svg circle").length,
      path: document.querySelectorAll("svg path").length,
      g: document.querySelectorAll("svg g").length,
    };
    const seatLike = [
      ...document.querySelectorAll(
        "[class*='seat' i], [class*='Seat'], [data-seat], [id*='seat' i], [class*='grade' i], [class*='Grade']",
      ),
    ].slice(0, 40).map((el) => ({
      tag: el.tagName,
      cls: el.className?.toString?.().slice(0, 120),
      id: el.id,
      text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
      aria: el.getAttribute("aria-label"),
    }));
    return { text, buttons, iframes, svgCounts, seatLike, title: document.title };
  });

  fs.writeFileSync("/tmp/seat-dom.json", JSON.stringify(info, null, 2));
  console.log("title", info.title);
  console.log("iframes", info.iframes);
  console.log("svg", info.svgCounts);
  console.log("buttons", info.buttons.slice(0, 40));
  console.log("seatLike", info.seatLike.slice(0, 20));
  console.log("TEXT:\n", info.text.slice(0, 2000));

  // inspect each iframe
  for (const frame of active.frames()) {
    const url = frame.url();
    if (!url || url === "about:blank") continue;
    console.log("\nFRAME", url);
    try {
      const fInfo = await frame.evaluate(() => {
        const text = (document.body?.innerText || "").slice(0, 2000);
        const buttons = [...document.querySelectorAll("button, a, li")]
          .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
          .filter((t) => t && t.length < 50)
          .slice(0, 60);
        const svg = {
          rect: document.querySelectorAll("svg rect").length,
          circle: document.querySelectorAll("svg circle").length,
        };
        const classes = [
          ...document.querySelectorAll("[class*='seat' i], [class*='Seat'], [class*='Grade'], [class*='block']"),
        ]
          .slice(0, 30)
          .map((el) => el.className?.toString?.().slice(0, 100));
        return { text, buttons, svg, classes };
      });
      console.log("frame svg", fInfo.svg);
      console.log("frame buttons", fInfo.buttons.slice(0, 30));
      console.log("frame classes", fInfo.classes.slice(0, 15));
      console.log("frame text", fInfo.text.slice(0, 800));
      fs.writeFileSync(
        `/tmp/seat-frame-${Buffer.from(url).toString("base64url").slice(0, 40)}.json`,
        JSON.stringify(fInfo, null, 2),
      );
    } catch (e) {
      console.log("frame err", e);
    }
  }

  await context.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
