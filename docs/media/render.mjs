// Renders every docs/media/*.html to a PNG of the same name. Documentation tooling only.
// Needs Chromium and playwright-core: PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs node docs/media/render.mjs
// Each page declares its size with <meta name="size" content="WIDTHxHEIGHT">.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const media = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true });
try {
  for (const name of (await readdir(media)).filter(file => file.endsWith(".html"))) {
    const html = path.join(media, name);
    const [width, height] = (/name="size" content="(\d+)x(\d+)"/.exec(await readFile(html, "utf8")) ?? []).slice(1).map(Number);
    if (!width || !height) throw new Error(`${name} needs <meta name="size" content="WIDTHxHEIGHT">`);
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1.5 });
    await page.goto(pathToFileURL(html).href);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: html.replace(/\.html$/, ".png") });
    await page.close();
    console.log("rendered", name);
  }
} finally {
  await browser.close();
}
