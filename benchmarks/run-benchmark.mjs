#!/usr/bin/env node
/**
 * HyperStage spatial benchmark.
 *
 * 10 spatial authoring tasks, each written two ways:
 *   - baseline:   absolute coordinates, the way an agent writes a scene without a spatial
 *                 compiler (each draft reproduces one common, realistic mistake: half-extent
 *                 confusion, a sign error, a mis-measured anchor, an eyeballed camera ...).
 *   - hyperstage: the same intent expressed with snapTo anchors, then `autoFixScene`
 *                 (deterministic coordinate repair, <= 5 passes).
 * Every result is scored against the same geometric acceptance checks (contact error in
 * millimetres, joint anchor separation, camera visibility, navigation reachability) plus a
 * clean lint report. Runs fully offline and deterministically.
 *
 * Usage: node benchmarks/run-benchmark.mjs   (after `pnpm build`)
 * Writes benchmarks/results.json and benchmarks/BENCHMARK.md.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = (pkg) => import(pathToFileURL(join(root, "packages", pkg, "dist", "index.js")).href);
const { parseScene, resolveScene } = await load("core");
const { autoFixScene, getRapier, lintScene, measureOcclusion, computeNavigation, findSpawnGoal, worldAnchors, OCCLUSION_LIMIT } = await load("spatial-linter");

const CONTACT_TOLERANCE_MM = 1;
const COMPILE_BUDGET_MS = 20;
const RUNS = 15;

const scene = (name, nodes, extra = {}) => ({ name, gravity: [0, -9.81, 0], skyColor: "#08090A", nodes, ...extra });
const ground = { id: "ground", kind: "box", size: [20, 0.5, 20], position: [0, -0.25, 0], physics: { body: "static" } };
const AXIS = { top: [1, 1], bottom: [1, -1], east: [0, 1], west: [0, -1], south: [2, 1], north: [2, -1] };

/** Signed gap (mm) between `child`'s face opposite `face` and `parent`'s `face` (0 = perfect contact). */
function faceGapMm(resolved, childId, parentId, face) {
  const child = resolved.byId.get(childId);
  const parent = resolved.byId.get(parentId);
  if (child === undefined || parent === undefined) return Infinity;
  const [axis, sign] = AXIS[face];
  const gap = sign > 0 ? child.min[axis] - parent.max[axis] : parent.min[axis] - child.max[axis];
  return gap * 1000;
}

const contacts = (pairs) => (resolved) => pairs.map(([child, parent, face]) => ({ label: `${child} on ${parent}.${face}`, errorMm: Math.abs(faceGapMm(resolved, child, parent, face)) }));

function jointErrors(resolved, scene) {
  return (scene.joints ?? []).map((joint) => {
    const a = resolved.byId.get(joint.bodyA);
    const b = resolved.byId.get(joint.bodyB);
    const { anchorA, anchorB } = worldAnchors(joint, { position: a.center, quaternion: a.quaternion }, { position: b.center, quaternion: b.quaternion });
    return { label: `joint ${joint.id}`, errorMm: Math.hypot(anchorA[0] - anchorB[0], anchorA[1] - anchorB[1], anchorA[2] - anchorB[2]) * 1000 };
  });
}

const TASKS = [
  {
    id: "crate-stack",
    title: "Stack three crates on a pallet",
    check: contacts([["pallet", "ground", "top"], ["crate-1", "pallet", "top"], ["crate-2", "crate-1", "top"], ["crate-3", "crate-2", "top"]]),
    baseline: scene("crate-stack", [
      ground,
      { id: "pallet", kind: "box", size: [1.2, 0.15, 1], position: [0, 0.15, 0] }, // full height used as half height
      { id: "crate-1", kind: "box", size: [0.6, 0.6, 0.6], position: [0, 0.6, 0], physics: { body: "dynamic", mass: 4 } },
      { id: "crate-2", kind: "box", size: [0.6, 0.6, 0.6], position: [0, 1.2, 0], physics: { body: "dynamic", mass: 4 } },
      { id: "crate-3", kind: "box", size: [0.6, 0.6, 0.6], position: [0, 1.8, 0], physics: { body: "dynamic", mass: 4 } },
    ]),
    hyperstage: scene("crate-stack", [
      ground,
      { id: "pallet", kind: "box", size: [1.2, 0.15, 1], snapTo: { target: "ground", face: "top" } },
      { id: "crate-1", kind: "box", size: [0.6, 0.6, 0.6], snapTo: { target: "pallet", face: "top" }, physics: { body: "dynamic", mass: 4 } },
      { id: "crate-2", kind: "box", size: [0.6, 0.6, 0.6], snapTo: { target: "crate-1", face: "top" }, physics: { body: "dynamic", mass: 4 } },
      { id: "crate-3", kind: "box", size: [0.6, 0.6, 0.6], snapTo: { target: "crate-2", face: "top" }, physics: { body: "dynamic", mass: 4 } },
    ]),
  },
  {
    id: "desk-monitor",
    title: "Monitor on a desk, keyboard in front",
    check: contacts([["desk", "ground", "top"], ["monitor", "desk", "top"], ["keyboard", "desk", "top"]]),
    baseline: scene("desk-monitor", [
      ground,
      { id: "desk", kind: "box", size: [1.6, 0.75, 0.8], position: [0, 0.375, 0] },
      { id: "monitor", kind: "box", size: [0.6, 0.4, 0.05], position: [0, 0.95, -0.2], physics: { body: "dynamic", mass: 3 } }, // forgot desk thickness rounding: sinks 25 mm
      { id: "keyboard", kind: "box", size: [0.45, 0.03, 0.15], position: [0, 0.78, 0.15], physics: { body: "dynamic", mass: 0.6 } },
    ]),
    hyperstage: scene("desk-monitor", [
      ground,
      { id: "desk", kind: "box", size: [1.6, 0.75, 0.8], snapTo: { target: "ground", face: "top" } },
      { id: "monitor", kind: "box", size: [0.6, 0.4, 0.05], snapTo: { target: "desk", face: "top", offset: [0, 0, -0.2] }, physics: { body: "dynamic", mass: 3 } },
      { id: "keyboard", kind: "box", size: [0.45, 0.03, 0.15], snapTo: { target: "desk", face: "top", offset: [0, 0, 0.15] }, physics: { body: "dynamic", mass: 0.6 } },
    ]),
  },
  {
    id: "wall-frame",
    title: "Picture frame flush on a wall",
    check: contacts([["wall", "ground", "top"], ["frame", "wall", "south"]]),
    baseline: scene("wall-frame", [
      ground,
      { id: "wall", kind: "box", size: [4, 3, 0.2], position: [0, 1.5, 0] },
      { id: "frame", kind: "box", size: [0.8, 0.6, 0.04], position: [0, 1.6, 0.1] }, // centre on the wall face: half buried
    ]),
    hyperstage: scene("wall-frame", [
      ground,
      { id: "wall", kind: "box", size: [4, 3, 0.2], snapTo: { target: "ground", face: "top" } },
      { id: "frame", kind: "box", size: [0.8, 0.6, 0.04], snapTo: { target: "wall", face: "south", offset: [0, 0.1, 0] } },
    ]),
  },
  {
    id: "ceiling-lamp",
    title: "Pendant lamp hanging under a ceiling",
    check: contacts([["ceiling", "post", "top"], ["lamp", "ceiling", "bottom"]]),
    baseline: scene("ceiling-lamp", [
      ground,
      { id: "post", kind: "box", size: [0.2, 2.8, 0.2], position: [0, 1.4, 0] },
      { id: "ceiling", kind: "box", size: [4, 0.2, 4], position: [0, 2.9, 0] },
      { id: "lamp", kind: "cylinder", radiusTop: 0.05, radiusBottom: 0.3, height: 0.4, position: [1, 3.0, 1] }, // added the half height instead of subtracting it
    ]),
    hyperstage: scene("ceiling-lamp", [
      ground,
      { id: "post", kind: "box", size: [0.2, 2.8, 0.2], snapTo: { target: "ground", face: "top" } },
      { id: "ceiling", kind: "box", size: [4, 0.2, 4], snapTo: { target: "post", face: "top" } },
      { id: "lamp", kind: "cylinder", radiusTop: 0.05, radiusBottom: 0.3, height: 0.4, snapTo: { target: "ceiling", face: "bottom", offset: [1, 0, 1] } },
    ]),
  },
  {
    id: "shelf-books",
    title: "Books standing on a wall shelf",
    check: contacts([["shelf", "wall", "south"], ["book-1", "shelf", "top"], ["book-2", "shelf", "top"]]),
    baseline: scene("shelf-books", [
      ground,
      { id: "wall", kind: "box", size: [3, 2.5, 0.2], position: [0, 1.25, 0] },
      { id: "shelf", kind: "box", size: [1.2, 0.04, 0.3], position: [0, 1.5, 0.25] }, // 0.1 + 0.15 = 0.25: exact
      { id: "book-1", kind: "box", size: [0.04, 0.24, 0.18], position: [-0.2, 1.64, 0.25], physics: { body: "dynamic", mass: 0.4 } }, // 1.52 + 0.12 = 1.64: exact
      { id: "book-2", kind: "box", size: [0.05, 0.28, 0.2], position: [-0.1, 1.64, 0.25], physics: { body: "dynamic", mass: 0.5 } }, // copied book-1's y: buried 20 mm
    ]),
    hyperstage: scene("shelf-books", [
      ground,
      { id: "wall", kind: "box", size: [3, 2.5, 0.2], snapTo: { target: "ground", face: "top" } },
      { id: "shelf", kind: "box", size: [1.2, 0.04, 0.3], snapTo: { target: "wall", face: "south", offset: [0, 0.25, 0] } },
      { id: "book-1", kind: "box", size: [0.04, 0.24, 0.18], snapTo: { target: "shelf", face: "top", offset: [-0.2, 0, 0] }, physics: { body: "dynamic", mass: 0.4 } },
      { id: "book-2", kind: "box", size: [0.05, 0.28, 0.2], snapTo: { target: "shelf", face: "top", offset: [-0.1, 0, 0] }, physics: { body: "dynamic", mass: 0.5 } },
    ]),
    // Shelf is a static cantilever; it touches the wall face.
  },
  {
    id: "door-hinge",
    title: "Hinged door on a door frame (revolute joint)",
    check: (resolved, s) => [...contacts([["frame", "ground", "top"]])(resolved), ...jointErrors(resolved, s)],
    baseline: scene(
      "door-hinge",
      [
        ground,
        { id: "frame", kind: "box", size: [0.1, 2.2, 0.1], position: [0, 1.1, 0] },
        { id: "door", kind: "box", size: [0.9, 2, 0.05], position: [0.5, 1.05, 0], physics: { body: "dynamic", mass: 12 } },
      ],
      { joints: [{ id: "hinge", type: "revolute", bodyA: "frame", bodyB: "door", anchorA: [0.05, 0, 0], anchorB: [-0.9, 0, 0], axis: [0, 1, 0], limitsDeg: [0, 100] }] }, // used the full width as the half width
    ),
    hyperstage: scene(
      "door-hinge",
      [
        ground,
        { id: "frame", kind: "box", size: [0.1, 2.2, 0.1], snapTo: { target: "ground", face: "top" } },
        { id: "door", kind: "box", size: [0.9, 2, 0.05], position: [0.5, 1.05, 0], physics: { body: "dynamic", mass: 12 } },
      ],
      { joints: [{ id: "hinge", type: "revolute", bodyA: "frame", bodyB: "door", anchorA: [0.05, 0, 0], anchorB: [-0.9, 0, 0], axis: [0, 1, 0], limitsDeg: [0, 100] }] },
    ),
  },
  {
    id: "rover-axles",
    title: "Rover wheels on motorised axles",
    check: (resolved, s) => jointErrors(resolved, s),
    baseline: scene(
      "rover-axles",
      [
        ground,
        { id: "chassis", kind: "box", size: [1, 0.3, 1.4], position: [0, 0.5, 0], physics: { body: "dynamic", mass: 6 } },
        { id: "wheel-l", kind: "cylinder", radiusTop: 0.35, radiusBottom: 0.35, height: 0.15, position: [-0.6, 0.35, 0], rotationDeg: [0, 0, 90], physics: { body: "dynamic", mass: 1 } },
        { id: "wheel-r", kind: "cylinder", radiusTop: 0.35, radiusBottom: 0.35, height: 0.15, position: [0.6, 0.35, 0], rotationDeg: [0, 0, 90], physics: { body: "dynamic", mass: 1 } },
      ],
      {
        joints: [
          { id: "axle-l", type: "revolute", bodyA: "chassis", bodyB: "wheel-l", anchorA: [-0.6, -0.15, 0], anchorB: [0, 0, 0], axis: [1, 0, 0], motorVelocity: 2 },
          { id: "axle-r", type: "revolute", bodyA: "chassis", bodyB: "wheel-r", anchorA: [0.6, 0.15, 0], anchorB: [0, 0, 0], axis: [1, 0, 0], motorVelocity: 2 }, // sign error on y
        ],
      },
    ),
    hyperstage: null, // same draft as the baseline: auto-fix repairs the anchors (E05)
  },
  {
    id: "camera-statue",
    title: "Hero camera framing a statue behind a hedge",
    check: (resolved, s) => {
      const cam = s.nodes.find((n) => n.kind === "camera");
      const o = measureOcclusion(resolved.geometry, cam.position, cam.target);
      const ratio = o.totalRays === 0 ? 1 : o.blockedRays / o.totalRays;
      return [{ label: "camera occlusion", errorMm: ratio <= OCCLUSION_LIMIT ? 0 : Infinity, detail: ratio }, ...contacts([["statue", "ground", "top"]])(resolved)];
    },
    baseline: scene("camera-statue", [
      ground,
      { id: "statue", kind: "box", size: [1, 2, 1], position: [0, 1, 0] },
      { id: "hedge", kind: "box", size: [6, 2.5, 0.6], position: [0, 1.25, 3] },
      { id: "cam", kind: "camera", position: [0, 1.6, 8], target: [0, 1, 0], isHero: true }, // eye-level shot straight through the hedge
    ]),
    hyperstage: scene("camera-statue", [
      ground,
      { id: "statue", kind: "box", size: [1, 2, 1], snapTo: { target: "ground", face: "top" } },
      { id: "hedge", kind: "box", size: [6, 2.5, 0.6], snapTo: { target: "ground", face: "top", offset: [0, 0, 3] } },
      { id: "cam", kind: "camera", position: [0, 1.6, 8], target: [0, 1, 0], isHero: true },
    ]),
  },
  {
    id: "parkour-gap",
    title: "Spawn-to-goal route across platforms",
    check: (resolved) => {
      const pair = findSpawnGoal(resolved);
      const nav = pair === null ? { reachable: false } : computeNavigation(resolved, pair.spawn, pair.goal);
      return [{ label: "goal reachable", errorMm: nav.reachable ? 0 : Infinity }];
    },
    baseline: scene("parkour-gap", [
      { id: "pad-a", kind: "box", size: [3, 1, 3], position: [0, -0.5, 0] },
      { id: "pad-b", kind: "box", size: [3, 1, 3], position: [4, 0, 0] }, // 0.5 m higher and a 1 m gap: fine
      { id: "pad-c", kind: "box", size: [3, 1, 3], position: [9, 0.5, 0] }, // 2 m gap: too far to jump
      { id: "spawn", kind: "spawn", position: [0, 0.1, 0] },
      { id: "goal", kind: "goal", position: [9, 1.6, 0], radius: 0.6 },
    ]),
    hyperstage: scene("parkour-gap", [
      { id: "pad-a", kind: "box", size: [3, 1, 3], position: [0, -0.5, 0] },
      { id: "pad-b", kind: "box", size: [3, 1, 3], snapTo: { target: "pad-a", face: "east", offset: [1, 0.5, 0] } },
      { id: "pad-c", kind: "box", size: [3, 1, 3], snapTo: { target: "pad-b", face: "east", offset: [2, 0.5, 0] } },
      { id: "spawn", kind: "spawn", position: [0, 0.1, 0] },
      { id: "goal", kind: "goal", position: [9, 1.6, 0], radius: 0.6 },
    ]),
  },
  {
    id: "csg-doorway",
    title: "Walk through a CSG doorway into a room",
    check: (resolved) => {
      const pair = findSpawnGoal(resolved);
      const nav = pair === null ? { reachable: false } : computeNavigation(resolved, pair.spawn, pair.goal);
      return [{ label: "goal reachable", errorMm: nav.reachable ? 0 : Infinity }, ...contacts([["wall", "floor", "top"]])(resolved)];
    },
    baseline: scene("csg-doorway", [
      { id: "floor", kind: "box", size: [6, 0.5, 12], position: [0, -0.25, 0] },
      { id: "wall", kind: "box", size: [6, 3, 0.3], position: [0, 1.5, 0] }, // a solid wall where the doorway should be
      { id: "spawn", kind: "spawn", position: [0, 0.1, -4] },
      { id: "goal", kind: "goal", position: [0, 0.8, 4], radius: 0.6 },
    ]),
    hyperstage: scene("csg-doorway", [
      { id: "floor", kind: "box", size: [6, 0.5, 12], position: [0, -0.25, 0] },
      {
        id: "wall",
        kind: "csg",
        operation: "subtract",
        base: { kind: "box", size: [6, 3, 0.3] },
        tool: { kind: "box", size: [1.4, 2.4, 1], position: [0, -0.3, 0] },
        snapTo: { target: "floor", face: "top" },
      },
      { id: "spawn", kind: "spawn", position: [0, 0.1, -4] },
      { id: "goal", kind: "goal", position: [0, 0.8, 4], radius: 0.6 },
    ]),
  },
];

const now = () => performance.now();
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const round = (value, digits = 3) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);

function score(sceneAst, report, check) {
  const resolved = resolveScene(parseScene(sceneAst));
  const measurements = check(resolved, sceneAst);
  const maxErrorMm = Math.max(0, ...measurements.map((m) => m.errorMm));
  const geometric = measurements.every((m) => m.errorMm <= CONTACT_TOLERANCE_MM);
  return {
    pass: geometric && report.valid,
    lintValid: report.valid,
    diagnostics: report.diagnostics.map((d) => d.code),
    maxErrorMm: round(maxErrorMm),
    measurements: measurements.map((m) => ({ label: m.label, errorMm: round(m.errorMm) })),
  };
}

await getRapier();
const results = [];
for (const task of TASKS) {
  const baselineReport = await lintScene(task.baseline);
  const baseline = score(task.baseline, baselineReport, task.check);
  const draft = task.hyperstage ?? task.baseline;
  const fixed = await autoFixScene(draft);
  const hyperstage = { ...score(fixed.scene, fixed.report, task.check), fixPasses: fixed.passes, patches: fixed.applied.length };
  // Compile = parse + snapTo resolve; lint = full 5-pass report incl. the 180-tick rollout. Warm, median of RUNS.
  const compileMs = [];
  const lintMs = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = now();
    resolveScene(parseScene(fixed.scene));
    compileMs.push(now() - t0);
    lintMs.push((await lintScene(fixed.scene)).elapsedMs);
  }
  results.push({ id: task.id, title: task.title, baseline, hyperstage, compileMedianMs: round(median(compileMs)), lintMedianMs: round(median(lintMs), 2) });
  process.stdout.write(`${hyperstage.pass ? "✔" : "✖"} ${task.id.padEnd(14)} baseline ${baseline.pass ? "pass" : "FAIL"} (${baseline.maxErrorMm ?? "∞"} mm)  hyperstage ${hyperstage.pass ? "pass" : "FAIL"} (${hyperstage.maxErrorMm ?? "∞"} mm)\n`);
}

const passRate = (key) => results.filter((r) => r[key].pass).length / results.length;
const finiteErrors = (key) => results.map((r) => r[key].maxErrorMm).filter((v) => v !== null);
const summary = {
  tasks: results.length,
  contactToleranceMm: CONTACT_TOLERANCE_MM,
  baselinePassRate: passRate("baseline"),
  hyperstagePassRate: passRate("hyperstage"),
  baselineMedianErrorMm: round(median(finiteErrors("baseline"))),
  hyperstageMedianErrorMm: round(median(finiteErrors("hyperstage"))),
  hyperstageMaxErrorMm: round(Math.max(...finiteErrors("hyperstage"))),
  medianCompileMs: round(median(results.map((r) => r.compileMedianMs))),
  medianLintMs: round(median(results.map((r) => r.lintMedianMs)), 2),
  compileBudgetMs: COMPILE_BUDGET_MS,
  node: process.version,
  generatedAt: new Date().toISOString(),
};

const out = join(root, "benchmarks");
writeFileSync(join(out, "results.json"), `${JSON.stringify({ summary, results }, null, 2)}\n`);

const pct = (v) => `${Math.round(v * 100)}%`;
const mmCell = (v) => (v === null ? "unreachable / occluded" : `${v} mm`);
const md = [
  "# HyperStage Spatial Benchmark",
  "",
  `10 deterministic spatial authoring tasks. Each is written once with absolute coordinates (**baseline**, reproducing a common agent mistake) and once with HyperStage \`snapTo\` anchors plus \`autoFixScene\` (**HyperStage**). A task passes when every contact is within ${CONTACT_TOLERANCE_MM} mm, every joint anchor pair coincides within ${CONTACT_TOLERANCE_MM} mm, the hero camera sees its subject, the goal is reachable, and the lint report is clean.`,
  "",
  "| Metric | Baseline | HyperStage |",
  "| --- | --- | --- |",
  `| Pass rate | ${pct(summary.baselinePassRate)} | **${pct(summary.hyperstagePassRate)}** |`,
  `| Median worst-contact error (measurable tasks) | ${summary.baselineMedianErrorMm} mm | **${summary.hyperstageMedianErrorMm} mm** |`,
  `| Median compile (parse + snapTo solve) | n/a | **${summary.medianCompileMs} ms** (budget < ${COMPILE_BUDGET_MS} ms) |`,
  `| Median full lint (5 passes, 180-tick Rapier rollout) | n/a | ${summary.medianLintMs} ms |`,
  "",
  "| # | Task | Baseline | Baseline error | HyperStage | HyperStage error | Fix passes | Compile |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ...results.map(
    (r, i) =>
      `| ${i + 1} | ${r.title} | ${r.baseline.pass ? "pass" : `fail (${r.baseline.diagnostics.join(", ") || "geometry"})`} | ${mmCell(r.baseline.maxErrorMm)} | ${r.hyperstage.pass ? "pass" : "fail"} | ${mmCell(r.hyperstage.maxErrorMm)} | ${r.hyperstage.fixPasses} | ${r.compileMedianMs} ms |`,
  ),
  "",
  `Generated by \`node benchmarks/run-benchmark.mjs\` on Node ${process.version}. Timings are warm medians of ${RUNS} runs; raw numbers are in [results.json](./results.json).`,
  "",
];
writeFileSync(join(out, "BENCHMARK.md"), md.join("\n"));

process.stdout.write(
  `\nbaseline ${pct(summary.baselinePassRate)} -> hyperstage ${pct(summary.hyperstagePassRate)} | median error ${summary.baselineMedianErrorMm} mm -> ${summary.hyperstageMedianErrorMm} mm | median compile ${summary.medianCompileMs} ms\n`,
);
const ok = summary.hyperstagePassRate === 1 && summary.medianCompileMs < COMPILE_BUDGET_MS;
process.exitCode = ok ? 0 : 1;
