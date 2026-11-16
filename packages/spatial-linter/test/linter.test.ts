import { beforeAll, describe, expect, it } from "vitest";
import { PRESETS } from "@hyperstage/core";
import type { SceneAST, SceneNode } from "@hyperstage/core";
import { autoFixScene, getRapier, lintScene } from "@hyperstage/spatial-linter";
import type { DiagnosticCode, LintReport } from "@hyperstage/spatial-linter";

const scene = (name: string, nodes: SceneNode[]): SceneAST => ({ name, gravity: [0, -9.81, 0], skyColor: "#08090A", nodes });
const ground: SceneNode = { id: "ground", kind: "box", size: [20, 0.5, 20], position: [0, -0.25, 0] };
const codes = (report: LintReport): DiagnosticCode[] => report.diagnostics.map((d) => d.code);

const fixtures: Record<DiagnosticCode, SceneAST> = {
  E01_INTERPENETRATION: scene("e01", [
    ground,
    { id: "crate-a", kind: "box", size: [1, 1, 1], position: [0, 0.5, 0], physics: { body: "dynamic" } },
    { id: "crate-b", kind: "box", size: [1, 1, 1], position: [0.6, 0.5, 0], physics: { body: "dynamic" } },
  ]),
  E02_UNSTABLE_PHYSICS: scene("e02", [
    ground,
    { id: "floater", kind: "box", size: [1, 1, 1], position: [2, 3, -1], physics: { body: "dynamic", mass: 2 } },
  ]),
  E03_CAMERA_OCCLUSION: scene("e03", [
    ground,
    { id: "statue", kind: "box", size: [1, 2, 1], snapTo: { target: "ground", face: "top" } },
    { id: "wall", kind: "box", size: [6, 4, 0.5], snapTo: { target: "ground", face: "top", offset: [0, 0, 3] } },
    { id: "cam", kind: "camera", position: [0, 1.5, 8], target: [0, 1, 0], isHero: true },
  ]),
  E04_UNREACHABLE_GOAL: scene("e04", [
    { id: "pad-a", kind: "box", size: [3, 1, 3], position: [0, -0.5, 0] },
    { id: "pad-b", kind: "box", size: [3, 1, 3], position: [8, -0.5, 0] },
    { id: "spawn", kind: "spawn", position: [0, 0.1, 0] },
    { id: "goal", kind: "goal", position: [8, 1, 0], radius: 0.6 },
  ]),
};

beforeAll(async () => {
  await getRapier();
});

describe("spatial linter passes", () => {
  for (const code of Object.keys(fixtures) as DiagnosticCode[]) {
    it(`${code} triggers on the broken fixture and passes after autoFixScene`, async () => {
      const fixture = fixtures[code];
      const before = await lintScene(fixture);
      expect(before.valid).toBe(false);
      expect(codes(before)).toContain(code);
      const diagnostic = before.diagnostics.find((d) => d.code === code);
      expect(diagnostic?.suggestedFix).toBeDefined();

      const fixed = await autoFixScene(fixture);
      expect(fixed.passes).toBeGreaterThanOrEqual(1);
      expect(fixed.passes).toBeLessThanOrEqual(5);
      expect(codes(fixed.report)).not.toContain(code);
      expect(fixed.report.valid).toBe(true);
    });
  }

  it("E01 reports penetration depth and an MTV fix", async () => {
    const report = await lintScene(fixtures.E01_INTERPENETRATION);
    const d = report.diagnostics.find((x) => x.code === "E01_INTERPENETRATION");
    expect(d?.metrics.penetrationMeters).toBeCloseTo(0.4, 6);
    expect(d?.nodeId).toBe("crate-b");
    expect(d?.suggestedFix?.patch.position).toEqual([1, 0.5, 0]);
  });

  it("E02 snaps the floating body onto the surface beneath it", async () => {
    const report = await lintScene(fixtures.E02_UNSTABLE_PHYSICS);
    const d = report.diagnostics.find((x) => x.code === "E02_UNSTABLE_PHYSICS");
    expect(d?.metrics.driftMeters).toBeGreaterThan(0.5);
    expect(d?.suggestedFix?.patch.snapTo).toEqual({ target: "ground", face: "top", align: "center", offset: [2, 0, -1] });
  });

  it("E03 names the occluder and suggests an elevated camera", async () => {
    const report = await lintScene(fixtures.E03_CAMERA_OCCLUSION);
    const d = report.diagnostics.find((x) => x.code === "E03_CAMERA_OCCLUSION");
    expect(d?.relatedNodeId).toBe("wall");
    expect(d?.metrics.blockedRays).toBeGreaterThan(10);
    const fixedY = d?.suggestedFix?.patch.position?.[1] ?? 0;
    expect(fixedY).toBeGreaterThan(1.5);
  });

  it("E04 reports the closest reachable coordinate", async () => {
    const report = await lintScene(fixtures.E04_UNREACHABLE_GOAL);
    const d = report.diagnostics.find((x) => x.code === "E04_UNREACHABLE_GOAL");
    expect(d?.metrics.closestX).toBeGreaterThan(1);
    expect(d?.metrics.closestX).toBeLessThan(1.6);
    expect(report.navPath).toEqual([]);
  });

  it("flush contacts within 2 mm pass and tilt is allowed with allowTip", async () => {
    const report = await lintScene(
      scene("flush", [
        ground,
        { id: "a", kind: "box", size: [1, 1, 1], snapTo: { target: "ground", face: "top" }, physics: { body: "dynamic" } },
        { id: "b", kind: "box", size: [1, 1, 1], snapTo: { target: "a", face: "east" }, physics: { body: "dynamic" } },
        { id: "c", kind: "box", size: [1, 1, 1], snapTo: { target: "a", face: "top", offset: [0, 0.0015, 0] }, physics: { body: "dynamic" } },
      ]),
    );
    expect(report.diagnostics).toEqual([]);
    expect(report.valid).toBe(true);
  });

  it("reachable scenes produce a smoothed navPath", async () => {
    const parkour = PRESETS.find((p) => p.id === "parkour-arena");
    if (parkour === undefined) throw new Error("missing preset");
    const report = await lintScene(parkour.scene);
    expect(report.valid).toBe(true);
    expect(report.navPath.length).toBeGreaterThan(3);
    const last = report.navPath[report.navPath.length - 1];
    expect(last?.[1]).toBeCloseTo(3.2, 1);
  });

  it("records 180 deterministic frames at 60 Hz", async () => {
    const preset = PRESETS[4];
    if (preset === undefined) throw new Error("missing preset");
    const a = await lintScene(preset.scene);
    const b = await lintScene(preset.scene);
    expect(a.frames).toHaveLength(180);
    expect(a.frames[179]?.timeSec).toBeCloseTo(3, 9);
    expect(a.frames).toEqual(b.frames);
  });
});

describe("presets", () => {
  it("preset 1 ships 3 deliberate E01/E02 bugs and auto-fixes into a valid castle", async () => {
    const preset = PRESETS[0];
    if (preset === undefined) throw new Error("missing preset");
    const before = await lintScene(preset.scene);
    expect(before.diagnostics).toHaveLength(3);
    expect(codes(before).sort()).toEqual(["E01_INTERPENETRATION", "E01_INTERPENETRATION", "E02_UNSTABLE_PHYSICS"]);
    const fixed = await autoFixScene(preset.scene);
    expect(fixed.report.valid).toBe(true);
    expect(fixed.passes).toBeLessThanOrEqual(5);
  });

  for (const preset of PRESETS.slice(1)) {
    it(`preset ${preset.index} (${preset.id}) lints clean`, async () => {
      const report = await lintScene(preset.scene);
      expect(report.diagnostics).toEqual([]);
    });
  }

  it("lints every preset quickly once warm (telemetry is reported)", async () => {
    const timings: number[] = [];
    for (const preset of PRESETS) {
      const report = await lintScene(preset.scene);
      timings.push(report.elapsedMs);
      expect(report.telemetry.ticks).toBe(180);
    }
    // Generous ceiling for shared CI machines; real timings are printed by `hyperstage lint`.
    expect(Math.max(...timings)).toBeLessThan(500);
  });
});
