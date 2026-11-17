import { beforeAll, describe, expect, it } from "vitest";
import { getPreset, resolveScene } from "@hyperstage/core";
import type { SceneAST } from "@hyperstage/core";
import { lintScene } from "@hyperstage/spatial-linter";
import type { LintReport, SpatialDiagnostic } from "@hyperstage/spatial-linter";
import { applyNodePatch, applySuggestedFix, computeFixGhost } from "../src/lib/fixPreview";
import { buildSceneTree, inspectNode } from "../src/lib/sceneTree";
import { SHORT_TITLE, diagnosticNodes, primaryMetric, secondaryMetrics } from "../src/lib/diagnostics";

function preset(index: number): SceneAST {
  const p = getPreset(index);
  if (p === undefined) throw new Error(`preset ${index} missing`);
  return p.scene;
}

let scene: SceneAST;
let report: LintReport;

beforeAll(async () => {
  scene = preset(1);
  report = await lintScene(scene);
});

const withFix = (): SpatialDiagnostic[] => report.diagnostics.filter((d) => d.suggestedFix !== undefined);

describe("fixPreview", () => {
  it("preset 1 ships fixable diagnostics", () => {
    expect(report.valid).toBe(false);
    expect(withFix().length).toBeGreaterThan(0);
  });

  it("applySuggestedFix changes only the targeted node", () => {
    for (const d of withFix()) {
      const fixed = applySuggestedFix(scene, d);
      expect(fixed).not.toBeNull();
      if (fixed === null) continue;
      const target = d.suggestedFix?.nodeId;
      fixed.nodes.forEach((node, i) => {
        if (node.id !== target) expect(node).toEqual(scene.nodes[i]);
        else expect(node).not.toEqual(scene.nodes[i]);
      });
    }
  });

  it("applyNodePatch drops position when a snapTo is supplied and deletes undefined keys", () => {
    const box = scene.nodes.find((n) => n.kind === "box" && "position" in n && n.position !== undefined);
    const ground = scene.nodes.find((n) => n.kind === "box" && n.id !== box?.id);
    if (box === undefined || ground === undefined) throw new Error("preset 1 lacks boxes");
    const snapped = applyNodePatch(box, { snapTo: { target: ground.id, face: "top" } });
    expect("position" in snapped ? snapped.position : undefined).toBeUndefined();
    expect("snapTo" in snapped ? snapped.snapTo?.target : undefined).toBe(ground.id);
    const cleared = applyNodePatch(box, { position: undefined });
    expect("position" in cleared ? cleared.position : undefined).toBeUndefined();
  });

  it("returns null when a diagnostic carries no fix or names a missing node", () => {
    const base = report.diagnostics[0];
    if (base === undefined) throw new Error("no diagnostics");
    const { suggestedFix: _drop, ...noFix } = base;
    expect(applySuggestedFix(scene, noFix)).toBeNull();
    expect(computeFixGhost(scene, noFix)).toBeNull();
    const ghostNode: SpatialDiagnostic = { ...base, suggestedFix: { nodeId: "missing-node", patch: {}, rationale: "" } };
    expect(applySuggestedFix(scene, ghostNode)).toBeNull();
  });

  it("computeFixGhost moves the node from its current pose to the patched pose", () => {
    for (const d of withFix()) {
      const ghost = computeFixGhost(scene, d);
      expect(ghost).not.toBeNull();
      if (ghost === null) continue;
      const fixed = applySuggestedFix(scene, d);
      if (fixed === null) throw new Error("fix vanished");
      expect(ghost.from).toEqual(resolveScene(scene).byId.get(ghost.nodeId)?.center);
      expect(ghost.to).toEqual(resolveScene(fixed).byId.get(ghost.nodeId)?.center);
      expect(Math.hypot(ghost.to[0] - ghost.from[0], ghost.to[1] - ghost.from[1], ghost.to[2] - ghost.from[2])).toBeGreaterThan(0);
    }
  });
});

describe("sceneTree", () => {
  it("lists every node exactly once, geometry before markers, cameras and lights", () => {
    const rows = buildSceneTree(scene, report);
    expect(rows.map((r) => r.id).sort()).toEqual(scene.nodes.map((n) => n.id).sort());
    const firstNonGeometry = rows.findIndex((r) => r.depth === 0 && !["box", "sphere", "cylinder", "ramp"].includes(r.kind));
    if (firstNonGeometry >= 0) {
      for (const row of rows.slice(firstNonGeometry)) if (row.depth === 0) expect(["box", "sphere", "cylinder", "ramp"]).not.toContain(row.kind);
    }
  });

  it("nests snapped nodes under their target and counts children", () => {
    const rows = buildSceneTree(preset(4), null);
    const byId = new Map(rows.map((r) => [r.id, r]));
    let nested = 0;
    rows.forEach((row, i) => {
      if (row.snapTarget === null || !byId.has(row.snapTarget)) return;
      nested++;
      const parent = byId.get(row.snapTarget);
      expect(row.depth).toBe((parent?.depth ?? -1) + 1);
      expect(rows.findIndex((r) => r.id === row.snapTarget)).toBeLessThan(i);
    });
    expect(nested).toBeGreaterThan(0);
    for (const row of rows) expect(row.childCount).toBe(rows.filter((r) => r.snapTarget === row.id).length);
  });

  it("tags nodes with the diagnostic codes that name them", () => {
    const rows = buildSceneTree(scene, report);
    for (const d of report.diagnostics) expect(rows.find((r) => r.id === d.nodeId)?.errors).toContain(d.code.slice(0, 3));
    expect(buildSceneTree(scene, null).every((r) => r.errors.length === 0)).toBe(true);
  });

  it("keeps nodes in a snapTo cycle visible", () => {
    const cyclic: SceneAST = {
      ...scene,
      nodes: [
        { kind: "box", id: "a", size: [1, 1, 1], snapTo: { target: "b", face: "top" } },
        { kind: "box", id: "b", size: [1, 1, 1], snapTo: { target: "a", face: "top" } },
      ],
    };
    expect(buildSceneTree(cyclic, null).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("inspectNode reports bounds, body and frame state", () => {
    const resolved = resolveScene(scene);
    const dynamicId = resolved.geometry.find((g) => g.node.physics?.body === "dynamic")?.id;
    if (dynamicId === undefined) throw new Error("preset 1 has no dynamic body");
    const start = inspectNode(scene, resolved, report, dynamicId, 0);
    expect(start?.body).toBe("dynamic");
    expect(start?.speed).toBe(0);
    const g = resolved.byId.get(dynamicId);
    if (g === undefined || start === null || start.size === null) throw new Error("missing geometry");
    expect(start.size[0]).toBeCloseTo(g.max[0] - g.min[0], 3);
    const late = inspectNode(scene, resolved, report, dynamicId, 10_000);
    expect(late?.framePosition).toEqual(
      report.frames[report.frames.length - 1]?.transforms[dynamicId]?.position.map((v) => Math.round(v * 1000) / 1000),
    );
    expect(inspectNode(scene, resolved, report, "missing-node", 0)).toBeNull();
    const camera = scene.nodes.find((n) => n.kind === "camera");
    if (camera !== undefined) {
      const info = inspectNode(scene, resolved, null, camera.id, 0);
      expect(info?.body).toBe("none");
      expect(info?.min).toBeNull();
      expect(info?.framePosition).toBeNull();
    }
  });
});

describe("diagnostics", () => {
  const base: SpatialDiagnostic = { code: "E01_INTERPENETRATION", severity: "error", nodeId: "a", relatedNodeId: "b", message: "", metrics: {} };

  it("formats the headline metric per class", () => {
    expect(primaryMetric({ ...base, metrics: { penetrationMeters: 0.34 } })).toEqual({ label: "overlap", value: "0.340m" });
    expect(primaryMetric({ ...base, code: "E02_UNSTABLE_PHYSICS", metrics: { minY: -20.5 } })).toEqual({ label: "fell to", value: "-20.50m" });
    expect(primaryMetric({ ...base, code: "E02_UNSTABLE_PHYSICS", metrics: { driftMeters: 0.75 } })).toEqual({ label: "drift", value: "0.750m" });
    expect(primaryMetric({ ...base, code: "E02_UNSTABLE_PHYSICS", metrics: { maxTiltDeg: 61.24 } })).toEqual({ label: "tilt", value: "61.2°" });
    expect(primaryMetric({ ...base, code: "E03_CAMERA_OCCLUSION", metrics: { occlusionRatio: 0.82 } })).toEqual({ label: "occluded", value: "82%" });
    expect(primaryMetric({ ...base, code: "E04_UNREACHABLE_GOAL", metrics: { distanceToGoal: 3 } })).toEqual({ label: "gap", value: "3.000m" });
    expect(primaryMetric({ ...base, code: "E04_UNREACHABLE_GOAL", metrics: { navCells: 12 } })).toEqual({ label: "nav cells", value: "12" });
    expect(primaryMetric(base)).toBeNull();
  });

  it("excludes the headline from secondary chips and scales precision", () => {
    expect(secondaryMetrics({ ...base, metrics: { penetrationMeters: 0.3, a: 1234.5, b: 2.345, c: 0.12345 } })).toEqual([
      { label: "a", value: "1235" },
      { label: "b", value: "2.35" },
      { label: "c", value: "0.123" },
    ]);
  });

  it("names subject and related nodes once", () => {
    expect(diagnosticNodes(base)).toEqual(["a", "b"]);
    expect(diagnosticNodes({ ...base, relatedNodeId: "a" })).toEqual(["a"]);
    expect(diagnosticNodes({ ...base, relatedNodeId: undefined })).toEqual(["a"]);
  });

  it("has a short title for every real diagnostic in preset 1", () => {
    for (const d of report.diagnostics) {
      expect(SHORT_TITLE[d.code]).toBeTruthy();
      expect(primaryMetric(d)).not.toBeNull();
    }
  });
});
