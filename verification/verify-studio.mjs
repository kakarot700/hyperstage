import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
const OUT = "/workspace/projects/288e1ca2-eead-4164-ad7e-bc38f2299ad0/hyperstage/verification";
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const consoleErrors = [], consoleWarnings = [], pageErrors = [], failedRequests = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); if (m.type() === "warning") consoleWarnings.push(m.text()); });
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("requestfailed", (r) => failedRequests.push(r.url() + " " + (r.failure()?.errorText ?? "")));
const log = [];
const note = (s) => { log.push(s); console.log(s); };

const pixelStats = () => page.evaluate(() => {
  const c = document.querySelector('canvas[data-testid="viewport-canvas"]');
  if (!c) return null;
  const tmp = document.createElement("canvas"); tmp.width = c.width; tmp.height = c.height;
  const ctx = tmp.getContext("2d"); ctx.drawImage(c, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let nonBg = 0, total = 0; const colors = new Set();
  for (let i = 0; i < d.length; i += 4 * 7) { total++; const r = d[i], g = d[i+1], b = d[i+2];
    if (Math.abs(r - 8) + Math.abs(g - 9) + Math.abs(b - 10) > 24) nonBg++;
    colors.add((r >> 4) << 8 | (g >> 4) << 4 | (b >> 4)); }
  const gl = c.getContext("webgl2");
  return { width: c.width, height: c.height, sampled: total, nonBackground: nonBg, ratio: +(nonBg / total).toFixed(4), distinctColorBuckets: colors.size, renderer: gl ? gl.getParameter(gl.RENDERER) : "n/a" };
});

await page.goto("http://localhost:4173/", { waitUntil: "load" });
await page.waitForSelector('[data-testid="lint-status"]', { timeout: 60000 });
await page.waitForTimeout(1500);
note("preset1 initial status: " + await page.textContent('[data-testid="lint-status"]'));
note("preset1 initial pixels: " + JSON.stringify(await pixelStats()));
await page.screenshot({ path: `${OUT}/preset1-before.png` });

await page.getByRole("button", { name: "Auto-Fix Spatial Errors" }).click();
await page.waitForFunction(() => document.querySelector('[data-testid="lint-status"]')?.textContent === "VALID", null, { timeout: 60000 });
await page.waitForTimeout(1600);
note("preset1 after autofix status: " + await page.textContent('[data-testid="lint-status"]'));
note("autofix log: " + (await page.textContent('[data-testid="autofix-log"]')).replace(/\n/g, " | "));
note("toast: " + await page.textContent('[data-testid="toast"]').catch(() => "none"));
note("preset1 after pixels: " + JSON.stringify(await pixelStats()));
await page.screenshot({ path: `${OUT}/preset1-after.png` });

// Scrub the physics timeline.
const scrub = page.getByTestId("scrubber");
await scrub.focus();
await page.keyboard.press("End");
await page.waitForTimeout(300);
note("scrub End -> " + await page.textContent('[data-testid="frame-label"]'));
for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowLeft");
await page.waitForTimeout(200);
note("scrub -30 -> " + await page.textContent('[data-testid="frame-label"]'));
await page.keyboard.press("Home");
await page.getByTestId("play").click();
await page.waitForTimeout(1200);
note("play 1.2s -> " + await page.textContent('[data-testid="frame-label"]'));
await page.getByTestId("play").click();

// X-ray toggle sanity
await page.getByTestId("toggle-xray").click();
await page.waitForTimeout(300);
note("xray pixels: " + JSON.stringify(await pixelStats()));
await page.getByTestId("toggle-xray").click();

// Preset 3
await page.getByTestId("preset-3").click();
await page.waitForFunction(() => document.querySelector('[data-testid="lint-status"]')?.textContent === "VALID" && document.querySelector(".hs-status, .hs-editor-status")?.textContent?.includes("Arena") !== true, null, { timeout: 60000 });
await page.waitForTimeout(1800);
note("preset3 status: " + await page.textContent('[data-testid="lint-status"]'));
note("preset3 editor status: " + await page.textContent('.hs-editor-status'));
const p3 = await pixelStats();
note("preset3 pixels: " + JSON.stringify(p3));
await page.screenshot({ path: `${OUT}/preset3.png` });

// Walk mode smoke test
await page.getByTestId("walk-mode").click();
await page.mouse.click(800, 450);
await page.keyboard.down("KeyD"); await page.waitForTimeout(500); await page.keyboard.up("KeyD");
await page.keyboard.press("Space"); await page.waitForTimeout(500);
await page.getByTestId("walk-mode").click();

// Export download + open the standalone file
const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export").click()]);
const exportPath = "/tmp/hyperstage-export.html";
await download.saveAs(exportPath);
note("export file: " + download.suggestedFilename());
await page.close();
const p2 = await context.newPage();
const exportErrors = [];
p2.on("console", (m) => { if (m.type() === "error") exportErrors.push(m.text()); });
p2.on("pageerror", (e) => exportErrors.push(String(e)));
await p2.goto("file://" + exportPath);
await p2.waitForFunction(() => document.body.dataset.ready === "true", null, { timeout: 60000 });
await p2.waitForTimeout(1500);
note("exported page frame label (after 1.5s): " + await p2.textContent("#hs-frame"));
await p2.waitForTimeout(1000);
note("exported page frame label: " + await p2.textContent("#hs-frame"));
note("exported page errors: " + JSON.stringify(exportErrors));
await p2.close();

note("console errors: " + JSON.stringify(consoleErrors));
note("page errors: " + JSON.stringify(pageErrors));
note("failed requests: " + JSON.stringify(failedRequests));
note("console warnings: " + JSON.stringify(consoleWarnings.slice(0, 10)));
writeFileSync(`${OUT}/verification-log.txt`, log.join("\n") + "\n");
await browser.close();
