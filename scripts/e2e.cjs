// Countertop end to end: connect to a server, run a tool by hand, then a spoken-style turn through the model.
// Usage: node scripts/e2e.cjs [countertopUrl] [mcpUrl] [shotsDir]
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
const BASE = process.argv[2] || "https://countertop-mcp.vercel.app";
const MCP = process.argv[3] || "https://lowtide-energy.vercel.app/api/mcp";
const SHOTS = process.argv[4] || path.join(__dirname, "..", "docs");

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  p.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(BASE, { waitUntil: "load" });
  await p.getByLabel("Streamable HTTP endpoint").fill(MCP);
  await p.getByRole("button", { name: "Connect" }).click();
  await p.locator("#tools li code").first().waitFor();
  console.log("server:", await p.locator("#server").textContent());
  console.log("tools:", (await p.locator("#tools code").allTextContents()).join(", "));

  // By hand: get_tide with a place.
  await p.locator("#tools li", { hasText: "get_tide" }).getByRole("button", { name: "Run" }).click();
  await p.locator("#args").fill(JSON.stringify({ place: "SE1 7PB" }));
  await p.getByRole("button", { name: "Run on the screen" }).click();
  await p.frameLocator("#view iframe").locator(".headline").waitFor({ timeout: 60000 });
  console.log("view (by hand):", await p.frameLocator("#view iframe").locator(".headline").textContent());
  await p.waitForTimeout(1500);
  await p.evaluate(() => scrollTo(0, 0));
  await p.screenshot({ path: path.join(SHOTS, "countertop-tool.png") });

  // Through the model.
  await p.locator("#voice").uncheck();
  await p.locator("#utter").fill("When should I run the dishwasher in SE1 7PB? It has to be done by 7am.");
  await p.getByRole("button", { name: "Say it" }).click();
  await p.waitForFunction(() => document.querySelectorAll("#log li[data-who=assistant]").length > 0, null, { timeout: 90000 });
  console.log("tool calls:", (await p.locator("#log li[data-who=tool]").allTextContents()).join(" | "));
  console.log("assistant:", await p.locator("#log li[data-who=assistant]").last().textContent());
  console.log("view (model):", await p.frameLocator("#view iframe").locator(".headline").textContent());
  await p.waitForTimeout(1500);
  await p.evaluate(() => scrollTo(0, 0));
  await p.screenshot({ path: path.join(SHOTS, "countertop-model.png") });
  const sw = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  console.log("overflow:", sw, "console errors:", errors.length ? errors.join(" | ") : "none");
  await b.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
