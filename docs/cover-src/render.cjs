// Renders docs/cover-src/cover.html to docs/cover.png (1800x1000) and a 600px-wide check of how it reads small.
// Usage: PLAYWRIGHT=<path to a playwright package> node docs/cover-src/render.cjs (small-check.png is a scratch preview; not committed)
const path = require("path");
const { pathToFileURL } = require("url");
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1800, height: 1000 }, deviceScaleFactor: 1 });
  await p.goto(pathToFileURL(path.join(__dirname, "cover.html")).href, { waitUntil: "networkidle" });
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(300);
  const font = await p.evaluate(() => document.fonts.check('600 92px "Space Grotesk"'));
  if (!font) throw new Error("Space Grotesk didn't load");
  await p.screenshot({ path: path.join(__dirname, "..", "cover.png") });
  const small = await b.newPage({ viewport: { width: 1800, height: 1000 }, deviceScaleFactor: 1 / 3 });
  await small.goto(pathToFileURL(path.join(__dirname, "cover.html")).href, { waitUntil: "networkidle" });
  await small.evaluate(() => document.fonts.ready);
  await small.screenshot({ path: path.join(__dirname, "small-check.png") });
  console.log("wrote docs/cover.png");
  await b.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
