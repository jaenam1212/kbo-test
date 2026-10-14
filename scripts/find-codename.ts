import { chromium } from "playwright";
import path from "node:path";

async function main() {
  const profile = path.join(process.cwd(), ".browser-profile");
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: true,
    locale: "ko-KR",
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const urls = [
    "https://tickets.interpark.com/contents/search?q=%EC%BD%94%EB%93%9C%EB%84%A4%EC%9E%84",
    "https://tickets.interpark.com/search?q=%EC%BD%94%EB%93%9C%EB%84%A4%EC%9E%84X",
    "https://nol.yanolja.com/ticket/search?keyword=%EC%BD%94%EB%93%9C%EB%84%A4%EC%9E%84X",
  ];
  for (const u of urls) {
    console.log("TRY", u);
    await page
      .goto(u, { waitUntil: "domcontentloaded", timeout: 45000 })
      .catch((e) => console.log("goto fail", e.message));
    await page.waitForTimeout(3000);
    console.log("url", page.url());
    const text = await page.locator("body").innerText().catch(() => "");
    console.log("text head", text.slice(0, 1000).replace(/\n/g, " | "));
    const links = await page.evaluate(() =>
      [...document.querySelectorAll("a")]
        .map((a) => ({
          href: a.href,
          t: (a.textContent || "").replace(/\s+/g, " ").trim(),
        }))
        .filter((x) =>
          /코드네임|Codename|goods|product|ticket|뮤지컬/i.test(x.href + x.t),
        )
        .slice(0, 25),
    );
    console.log("links", JSON.stringify(links, null, 2));
    const html = await page.content();
    const goods = [
      ...html.matchAll(/goodsCode["\s:=]+["]?(\d{5,})/g),
    ].map((m) => m[1]);
    console.log("goodsCodes", [...new Set(goods)].slice(0, 20));
  }
  await ctx.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
