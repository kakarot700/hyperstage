import { describe, expect, it } from "vitest";
import { getPreset, resolveScene } from "@hyperstage/core";
import type { SceneAST, Vec3 } from "@hyperstage/core";
import { lintScene } from "@hyperstage/spatial-linter";
import type { FrameSnapshot } from "@hyperstage/spatial-linter";
import { TICK_HZ, detectCollisionEvents, formatTimeReadout, stepPlayback, timelineTicks } from "../src/lib/timeline";
import { cameraPose, easeInOutCubic, focusDistance, heroCamera, sceneBounds } from "../src/lib/cameraRig";
import { filterCommands, fuzzyScore, isTypingTarget } from "../src/lib/commands";

function preset(index: number): SceneAST {
  const p = getPreset(index);
  if (p === undefined) throw new Error(`preset ${index} missing`);
  return p.scene;
}

const GRAVITY: Vec3 = [0, -9.81, 0];

/** Analytic trajectory: free fall until `impactTick`, then at rest. */
function dropFrames(ticks: number, impactTick: number): FrameSnapshot[] {
  const dt = 1 / TICK_HZ;
  const frames: FrameSnapshot[] = [];
  for (let t = 0; t < ticks; t++) {
    const k = Math.min(t, impactTick);
    const y = 10 + 0.5 * GRAVITY[1] * (k * dt) ** 2;
    frames.push({ tick: t + 1, timeSec: (t + 1) * dt, transforms: { ball: { position: [0, y, 0], quaternion: [0, 0, 0, 1] }, floor: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] } } });
  }
  return frames;
}

describe("timeline", () => {
  it("ignores pure free fall and resting bodies", () => {
    expect(detectCollisionEvents(dropFrames(60, 1000), GRAVITY)).toEqual([]);
  });

  it("detects a single abrupt stop", () => {
    const events = detectCollisionEvents(dropFrames(90, 40), GRAVITY);
    expect(events).toHaveLength(1);
    expect(events[0]?.ids).toEqual(["ball"]);
    expect(events[0]?.frame).toBe(40);
    expect(events[0]?.impulse).toBeGreaterThan(0.6);
  });

  it("finds impacts in a real Newton's cradle rollout", async () => {
    const scene = preset(5);
    const report = await lintScene(scene);
    const events = detectCollisionEvents(report.frames, scene.gravity);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.frame).toBeGreaterThanOrEqual(1);
      expect(e.frame).toBeLessThan(report.frames.length);
    }
  });

  it("formats the readout", () => {
    expect(formatTimeReadout(0, 180)).toBe("00.02s / 03.00s · 60Hz");
    expect(formatTimeReadout(179, 180)).toBe("03.00s / 03.00s · 60Hz");
    expect(formatTimeReadout(999, 180)).toBe("03.00s / 03.00s · 60Hz");
    expect(formatTimeReadout(5, 0)).toBe("00.00s / 00.00s · 60Hz");
  });

  it("places ticks across the track with whole seconds major", () => {
    const ticks = timelineTicks(180);
    expect(ticks[0]).toEqual({ frame: 0, major: true, at: 0 });
    expect(ticks[ticks.length - 1]?.frame).toBe(179);
    expect(ticks[ticks.length - 1]?.at).toBe(1);
    expect(ticks.filter((t) => t.major).map((t) => t.frame)).toEqual([0, 60, 120, 179]);
    expect(timelineTicks(1)).toEqual([]);
  });

  it("steps playback by whole ticks and clamps long gaps", () => {
    const a = stepPlayback(0, 0.05, 1);
    expect(a.steps).toBe(3);
    expect(a.accumulator).toBeCloseTo(0, 9);
    expect(stepPlayback(0, 5, 1).steps).toBe(6);
    expect(stepPlayback(0, 0.1, 0.25).steps).toBe(1);
    expect(stepPlayback(0, -1, 1)).toEqual({ steps: 0, accumulator: 0 });
  });
});

describe("cameraRig", () => {
  it("bounds every solid", () => {
    const resolved = resolveScene(preset(3));
    const b = sceneBounds(resolved);
    for (const g of resolved.geometry) for (let i = 0; i < 3; i++) {
      expect(g.min[i]).toBeGreaterThanOrEqual(b.min[i] ?? Infinity);
      expect(g.max[i]).toBeLessThanOrEqual(b.max[i] ?? -Infinity);
    }
    expect(sceneBounds({ ...resolved, geometry: [] }).radius).toBeCloseTo(8.66, 2);
  });

  it("uses the hero camera for the hero pose", () => {
    const scene = preset(5);
    const hero = heroCamera(scene);
    expect(hero?.isHero).toBe(true);
    const pose = cameraPose("hero", scene, resolveScene(scene));
    expect(pose.position).toEqual(hero?.position);
    expect(pose.target).toEqual(hero?.target);
    expect(pose.orthoHalfHeight).toBe(0);
  });

  it("frames the scene when there is no camera", () => {
    const scene = { ...preset(4), nodes: preset(4).nodes.filter((n) => n.kind !== "camera") };
    const resolved = resolveScene(scene);
    expect(heroCamera(scene)).toBeUndefined();
    const pose = cameraPose("hero", scene, resolved);
    expect(pose.target).toEqual(sceneBounds(resolved).center);
  });

  it("puts top above the scene and iso on the 35.264° diagonal", () => {
    const scene = preset(3);
    const resolved = resolveScene(scene);
    const b = sceneBounds(resolved);
    const top = cameraPose("top", scene, resolved);
    expect(top.position[1]).toBeGreaterThan(b.max[1]);
    expect(top.orthoHalfHeight).toBeGreaterThan(0);
    const iso = cameraPose("iso", scene, resolved);
    const d: Vec3 = [iso.position[0] - iso.target[0], iso.position[1] - iso.target[1], iso.position[2] - iso.target[2]];
    expect((Math.atan2(d[1], Math.hypot(d[0], d[2])) * 180) / Math.PI).toBeCloseTo(35.264, 2);
    expect(d[0]).toBeCloseTo(d[2], 9);
  });

  it("eases and frames", () => {
    expect(easeInOutCubic(-1)).toBe(0);
    expect(easeInOutCubic(0.5)).toBe(0.5);
    expect(easeInOutCubic(2)).toBe(1);
    expect(easeInOutCubic(0.25)).toBeLessThan(0.25);
    expect(focusDistance(0.01, 50)).toBe(1.5);
    expect(focusDistance(10, 60)).toBeCloseTo(32, 6);
    expect(focusDistance(10, 1)).toBe(focusDistance(10, 10));
  });
});

describe("commands", () => {
  const commands = [
    { title: "Load Preset 1 · Broken Tower", group: "Presets" as const },
    { title: "Auto-Fix Spatial Errors", group: "Spatial" as const, hint: "repair E01-E04" },
    { title: "Toggle X-Ray", group: "View" as const },
    { title: "Top Camera", group: "Camera" as const },
    { title: "Export HTML", group: "File" as const },
  ];

  it("scores subsequences and rejects non-matches", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
    expect(fuzzyScore("xyz", "Export HTML")).toBe(-1);
    expect(fuzzyScore("exp", "Export HTML")).toBeGreaterThan(fuzzyScore("exp", "Toggle X-Ray preset"));
    expect(fuzzyScore("afse", "Auto-Fix Spatial Errors")).toBeGreaterThan(fuzzyScore("afse", "Load Preset 1 · Broken Tower Safe"));
  });

  it("filters, ranks and keeps declared order on an empty query", () => {
    expect(filterCommands(commands, "  ")).toBe(commands);
    expect(filterCommands(commands, "autofix")[0]?.title).toBe("Auto-Fix Spatial Errors");
    expect(filterCommands(commands, "camera").map((c) => c.title)).toContain("Top Camera");
    expect(filterCommands(commands, "e04")[0]?.title).toBe("Auto-Fix Spatial Errors");
    expect(filterCommands(commands, "qqq")).toEqual([]);
  });

  it("isTypingTarget is false outside the DOM", () => {
    expect(isTypingTarget(null)).toBe(false);
  });
});
