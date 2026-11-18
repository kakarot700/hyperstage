import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("export picks .glb and .stl from the output extension", () => {
    const glb = cli("export", p("arena.scene.json"), "-o", p("arena.glb"));
    expect(glb.status).toBe(0);
    expect(glb.stdout).toContain("glb");
    const glbBytes = readFileSync(join(work, "arena.glb"));
    expect(glbBytes.readUInt32LE(0)).toBe(0x46546c67);
    expect(glbBytes.readUInt32LE(4)).toBe(2);
    expect(glbBytes.readUInt32LE(8)).toBe(glbBytes.length);

    const stl = cli("export", p("arena.scene.json"), "-o", p("arena.stl"));
    expect(stl.status).toBe(0);
    const stlBytes = readFileSync(join(work, "arena.stl"));
    const triangles = stlBytes.readUInt32LE(80);
    expect(triangles).toBeGreaterThan(0);
    expect(stlBytes.length).toBe(84 + 50 * triangles);

    expect(cli("export", p("arena.scene.json"), "-o", p("arena.obj")).status).toBe(2);
    expect(cli("export", p("arena.scene.json"), "--format", "stl").status).toBe(0);
    expect(existsSync(join(work, "arena.stl"))).toBe(true);
  });

  it("lint and export accept a .tsx scene compiled with esbuild", () => {
    writeFileSync(
      p("hinge.scene.tsx"),
      [
        "const joints = [{ id: \"hinge\", type: \"revolute\" as const, bodyA: \"post\", bodyB: \"door\", anchorA: [0.1, 0, 0] as [number, number, number], anchorB: [-0.8, 0, 0] as [number, number, number], axis: [0, 1, 0] as [number, number, number] }];",
        "export default (",
        "  <scene name=\"TSX Hinge\" joints={joints}>",
        "    <box id=\"ground\" size={[20, 0.5, 20]} position={[0, -0.25, 0]} />",
        "    <box id=\"post\" size={[0.2, 2, 0.2]} position={[0, 1, 0]} />",
        "    <box id=\"door\" size={[1, 1.8, 0.1]} position={[0.6, 1, 0]} physics={{ body: \"dynamic\", mass: 5 }} />",
        "  </scene>",
        ");",
        "",
      ].join("\n"),
    );
    const lint = cli("lint", p("hinge.scene.tsx"));
    expect(lint.status).toBe(1);
    expect(lint.stdout).toContain("TSX Hinge");
    expect(lint.stdout).toContain("E05_BROKEN_JOINT");
    const fix = cli("lint", p("hinge.scene.tsx"), "--fix");
    expect(fix.status).toBe(0);
    const fixed = JSON.parse(readFileSync(join(work, "hinge.fixed.json"), "utf8")) as { joints: { anchorB: number[] }[] };
    expect(fixed.joints[0]?.anchorB).toEqual([-0.5, 0, 0]);
    const glb = cli("export", p("hinge.scene.tsx"), "-o", p("hinge.glb"));
    expect(glb.status).toBe(0);
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
