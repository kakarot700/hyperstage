import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "hyperstage-cli-"));
const p = (file: string): string => join(work, file);

function cli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--conditions=source", "--import", "tsx", entry, ...args], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
    timeout: 90000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("hyperstage CLI", () => {
  it("init writes a preset scene", () => {
    const r = cli("init", p("castle.scene.json"), "--preset", "1");
    expect(r.status).toBe(0);
    const scene = JSON.parse(readFileSync(join(work, "castle.scene.json"), "utf8")) as { name: string };
    expect(scene.name).toContain("Broken Tower");
    expect(cli("init", p("castle.scene.json")).status).toBe(2);
  });

  it("lint exits 1 on the broken tower and reports E01/E02 with timings", () => {
    const r = cli("lint", p("castle.scene.json"));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("E01_INTERPENETRATION");
    expect(r.stdout).toContain("E02_UNSTABLE_PHYSICS");
    expect(r.stdout).toMatch(/passes: resolve [\d.]+/);
    const json = cli("lint", p("castle.scene.json"), "--json");
    const report = JSON.parse(json.stdout) as { valid: boolean; diagnostics: unknown[]; frames?: unknown };
    expect(report.valid).toBe(false);
    expect(report.diagnostics).toHaveLength(3);
    expect(report.frames).toBeUndefined();
  });

  it("lint --fix repairs the scene and exits 0", () => {
    const r = cli("lint", p("castle.scene.json"), "--fix", p("fixed.scene.json"));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("auto-fix:");
    expect(cli("lint", p("fixed.scene.json")).status).toBe(0);
  });

  it("sim runs the rollout and prints final transforms", () => {
    const r = cli("sim", p("castle.scene.json"), "--ticks", "120", "--json");
    expect(r.status).toBe(0);
    const sim = JSON.parse(r.stdout) as { ticks: number; finalTransforms: Record<string, unknown> };
    expect(sim.ticks).toBe(120);
    expect(sim.finalTransforms["block-1"]).toBeDefined();
    expect(cli("sim", p("castle.scene.json"), "--ticks", "0").status).not.toBe(0);
  });

  it("export writes a self-contained HTML player", () => {
    expect(cli("init", p("arena.scene.json"), "--preset", "3").status).toBe(0);
    const r = cli("export", p("arena.scene.json"), "-o", p("arena.html"), "--title", "Arena");
    expect(r.status).toBe(0);
    const html = readFileSync(join(work, "arena.html"), "utf8");
    expect(html).toContain("<title>Arena</title>");
    expect(html).toContain('id="hs-data"');
    expect(html.length).toBeGreaterThan(500_000);
  });

  it("skills install populates .hark, .openhands, .claude and .cursor", () => {
    const r = cli("skills", "install", "--target", work);
    expect(r.status).toBe(0);
    for (const name of ["hyperstage-world-builder", "hyperstage-physics-sim", "hyperstage-spatial-debug"]) {
      for (const agent of ["hark", "openhands", "claude"]) {
        const path = join(work, `.${agent}`, "skills", name, "SKILL.md");
        expect(existsSync(path)).toBe(true);
        expect(readFileSync(path, "utf8")).toMatch(new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n---`));
      }
      const rule = readFileSync(join(work, ".cursor", "rules", `${name}.mdc`), "utf8");
      expect(rule).toMatch(/^---\ndescription: ".+"\nglobs: .+\nalwaysApply: false\n---/);
    }
    expect(cli("skills", "install", "--agents", "vim").status).toBe(2);
  });
});
