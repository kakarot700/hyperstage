#!/usr/bin/env node
// HyperStage Studio end-to-end verification.
// Builds the studio, serves `vite preview` on :4173, drives it with headless Chromium
// (SwiftShader WebGL), captures screenshots and fails on any console or page error.
// Usage (from the repo root): node verification/verify-studio.mjs
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const OUT = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(OUT);
const STUDIO = join(ROOT, "apps", "studio");
const VITE = join(STUDIO, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite");
const PORT = 4173;
const URL = `http://localhost:${PORT}/`;

const log = [];
const note = (line) => {
  log.push(line);
  console.log(line);
};
const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
const failures = [];
const check = (ok, label) => {
  note(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) failures.push(label);
};

let server = null;
let browser = null;

function stopServer() {
  if (server === null || server.exitCode !== null) return;
  try {
    // Negative pid kills the whole process group (vite spawns esbuild children).
    process.kill(-server.pid, "SIGTERM");
  } catch {
    server.kill("SIGTERM");
  }
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server !== null && server.exitCode !== null) throw new Error(`vite preview exited with code ${server.exitCode}`);
    try {
      const res = await fetch(URL);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`vite preview did not answer on ${URL} within ${timeoutMs} ms`);
}

async function main() {
  note(`HyperStage Studio verification · ${new Date().toISOString()}`);

  note("vite build …");
  const build = spawnSync(VITE, ["build"], { cwd: STUDIO, encoding: "utf8", env: { ...process.env, NODE_ENV: "production" } });
  if (build.status !== 0) {
    note(build.stdout ?? "");
    note(build.stderr ?? "");
    throw new Error(`vite build failed with status ${build.status}`);
  }
  note("vite build ok");

  server = spawn(VITE, ["preview", "--port", String(PORT), "--strictPort", "--host", "localhost"], {
    cwd: STUDIO,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOutput = "";
  server.stdout.on("data", (d) => (serverOutput += d));
  server.stderr.on("data", (d) => (serverOutput += d));
  await waitForServer(30000);
  note(`vite preview listening on ${URL}`);

  browser = await chromium.launch({
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("requestfailed", (r) => failedRequests.push(`${r.url()} ${r.failure()?.errorText ?? ""}`));

  const status = () => page.locator('[data-testid="lint-status"]').textContent();
  const frameLabel = () => page.getByTestId("frame-label").textContent();

  // Preset 1: broken tower.
  await page.goto(URL, { waitUntil: "load" });
  await page.waitForSelector('canvas[data-testid="viewport-canvas"]', { timeout: 60000 });
  await page.waitForSelector('[data-testid="lint-status"]', { timeout: 60000 });
  await page.waitForTimeout(1500);
  const before = (await status())?.trim() ?? "";
  note(`preset1 initial status: ${before}`);
  check(before !== "VALID" && /ERROR/i.test(before), "preset 1 loads with spatial errors");
  await page.screenshot({ path: join(OUT, "preset1-before.png") });

  // Apply the auto-fix.
  await page.getByTestId("autofix").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="lint-status"]')?.textContent?.trim() === "VALID", null, { timeout: 60000 });
  await page.waitForTimeout(1600);
  note(`preset1 after auto-fix status: ${(await status())?.trim()}`);
  const fixLog = await page.locator('[data-testid="autofix-log"]').textContent().catch(() => null);
  if (fixLog !== null) note(`auto-fix log: ${fixLog.replace(/\s*\n\s*/g, " | ")}`);
  check(((await status())?.trim() ?? "") === "VALID", "auto-fix makes preset 1 VALID");
  await page.screenshot({ path: join(OUT, "preset1-after.png") });

  // Scrub and play the physics timeline.
  const scrubber = page.getByTestId("scrubber");
  await scrubber.focus();
  await page.keyboard.press("End");
  await page.waitForTimeout(250);
  const atEnd = (await frameLabel())?.trim() ?? "";
  note(`scrub End -> ${atEnd}`);
  for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(250);
  const back = (await frameLabel())?.trim() ?? "";
  note(`scrub -30 -> ${back}`);
  check(atEnd !== "" && back !== "" && atEnd !== back, "scrubber moves the frame label");
  await page.keyboard.press("Home");
  await page.waitForTimeout(150);
  const home = (await frameLabel())?.trim() ?? "";
  await page.getByTestId("play").click();
  await page.waitForTimeout(1200);
  const played = (await frameLabel())?.trim() ?? "";
  await page.getByTestId("play").click();
  note(`play 1.2s: ${home} -> ${played}`);
  check(played !== home, "play advances the timeline");

  // Preset 3: parkour arena.
  await page.getByTestId("preset-3").click();
  await page.waitForFunction(
    () => {
      const editor = document.querySelector('[data-testid="scene-editor"]');
      const value = editor instanceof HTMLTextAreaElement ? editor.value : (editor?.textContent ?? "");
      return value.includes("Playable Parkour Arena") && document.querySelector('[data-testid="lint-status"]') !== null;
    },
    null,
    { timeout: 60000 },
  );
  await page.waitForFunction(() => document.querySelector('[data-testid="lint-status"]')?.textContent?.trim() === "VALID", null, { timeout: 60000 });
  await page.waitForTimeout(1800);
  note(`preset3 status: ${(await status())?.trim()}`);
  check(((await status())?.trim() ?? "") === "VALID", "preset 3 lints VALID");
  await page.screenshot({ path: join(OUT, "preset3.png") });

  await browser.close();
  browser = null;
  if (failures.length > 0 && serverOutput.trim() !== "") note(`vite preview output:\n${serverOutput.trim()}`);
}

function reportErrors() {
  note(`console errors (${consoleErrors.length}): ${JSON.stringify(consoleErrors)}`);
  note(`page errors (${pageErrors.length}): ${JSON.stringify(pageErrors)}`);
  note(`failed requests (${failedRequests.length}): ${JSON.stringify(failedRequests)}`);
  check(consoleErrors.length === 0, "zero console errors");
  check(pageErrors.length === 0, "zero page errors");
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  note(`FATAL ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
} finally {
  if (browser !== null) await browser.close().catch(() => undefined);
  stopServer();
}
reportErrors();
if (failures.length > 0) {
  note(`RESULT: FAILED (${failures.length}): ${failures.join("; ")}`);
  exitCode = 1;
} else note("RESULT: PASSED");
writeFileSync(join(OUT, "verification-log.txt"), `${log.join("\n")}\n`);
process.exit(exitCode);
