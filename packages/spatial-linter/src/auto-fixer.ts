import { SceneNodeSchema, cloneScene, parseScene } from "@hyperstage/core";
import type { SceneAST, SceneNode } from "@hyperstage/core";
import { lintScene } from "./linter.js";
import type { DiagnosticCode, LintOptions, LintReport, SpatialDiagnostic } from "./types.js";

export const MAX_FIX_PASSES = 5;

export interface AppliedFix {
  pass: number;
  code: DiagnosticCode;
  nodeId: string;
  rationale: string;
}

export interface AutoFixResult {
  scene: SceneAST;
  report: LintReport;
  /** Initial report before any patch was applied. */
  initialReport: LintReport;
  passes: number;
  applied: AppliedFix[];
}

const PRIORITY: DiagnosticCode[] = [
  "E01_INTERPENETRATION",
  "E02_UNSTABLE_PHYSICS",
  "E03_CAMERA_OCCLUSION",
  "E04_UNREACHABLE_GOAL",
];

function applyPatch(node: SceneNode, patch: NonNullable<SpatialDiagnostic["suggestedFix"]>["patch"]): SceneNode {
  const next: Record<string, unknown> = { ...node };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  // An explicit snapTo anchor supersedes any absolute position.
  if (patch.snapTo !== undefined) delete next.position;
  return SceneNodeSchema.parse(next);
}

/**
 * Deterministic coordinate repair: applies the suggested fixes of the
 * highest-priority diagnostic class present, re-lints, and repeats for up to
 * 5 passes until the report is valid.
 */
export async function autoFixScene(input: SceneAST | unknown, options: LintOptions = {}): Promise<AutoFixResult> {
  let scene = cloneScene(parseScene(input));
  let report = await lintScene(scene, options);
  const initialReport = report;
  const applied: AppliedFix[] = [];
  let passes = 0;
  while (!report.valid && passes < MAX_FIX_PASSES) {
    const fixable = report.diagnostics.filter((d) => d.suggestedFix !== undefined);
    const code = PRIORITY.find((c) => fixable.some((d) => d.code === c));
    if (code === undefined) break;
    passes++;
    const patched = new Set<string>();
    const nodes = [...scene.nodes];
    for (const diagnostic of fixable) {
      const fix = diagnostic.suggestedFix;
      if (diagnostic.code !== code || fix === undefined || patched.has(fix.nodeId)) continue;
      const index = nodes.findIndex((n) => n.id === fix.nodeId);
      const node = nodes[index];
      if (node === undefined) continue;
      nodes[index] = applyPatch(node, fix.patch);
      patched.add(fix.nodeId);
      applied.push({ pass: passes, code, nodeId: fix.nodeId, rationale: fix.rationale });
    }
    scene = parseScene({ ...scene, nodes });
    report = await lintScene(scene, options);
  }
  return { scene, report, initialReport, passes, applied };
}
