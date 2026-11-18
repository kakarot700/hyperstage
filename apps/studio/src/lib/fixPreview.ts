import { SceneNodeSchema, parseScene, resolveScene } from "@hyperstage/core";
import type { Quat, SceneAST, SceneNode, Vec3 } from "@hyperstage/core";
import type { SpatialDiagnostic } from "@hyperstage/spatial-linter";

type Patch = NonNullable<SpatialDiagnostic["suggestedFix"]>["patch"];

/** Mirrors the auto-fixer: shallow patch, `undefined` deletes, an explicit snapTo supersedes position. */
export function applyNodePatch(node: SceneNode, patch: Patch): SceneNode {
  const next: Record<string, unknown> = { ...node };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  if (patch.snapTo !== undefined) delete next.position;
  return SceneNodeSchema.parse(next);
}

/** Returns a new scene with one diagnostic's suggested fix applied, or null when it has none. */
export function applySuggestedFix(scene: SceneAST, diagnostic: SpatialDiagnostic): SceneAST | null {
  const jointFix = diagnostic.suggestedJointFix;
  if (jointFix !== undefined) {
    const joints = scene.joints ?? [];
    const index = joints.findIndex((j) => j.id === jointFix.jointId);
    const joint = joints[index];
    if (joint === undefined) return null;
    const next = [...joints];
    next[index] = { ...joint, ...jointFix.patch };
    return parseScene({ ...scene, joints: next });
  }
  const fix = diagnostic.suggestedFix;
  if (fix === undefined) return null;
  const index = scene.nodes.findIndex((n) => n.id === fix.nodeId);
  const node = scene.nodes[index];
  if (node === undefined) return null;
  const nodes = [...scene.nodes];
  nodes[index] = applyNodePatch(node, fix.patch);
  return parseScene({ ...scene, nodes });
}

export interface FixGhost {
  nodeId: string;
  /** The node after the patch (its geometry fields drive the ghost mesh). */
  node: SceneNode;
  /** Where the node sits today. */
  from: Vec3;
  /** Where the fix moves it to. */
  to: Vec3;
  quaternion: Quat;
}

function anchorOf(scene: SceneAST, nodeId: string): { position: Vec3; quaternion: Quat } | null {
  const resolved = resolveScene(scene);
  const geometry = resolved.byId.get(nodeId);
  if (geometry !== undefined) return { position: geometry.center, quaternion: geometry.quaternion };
  const node = scene.nodes.find((n) => n.id === nodeId);
  if (node === undefined) return null;
  if (node.kind === "camera" || node.kind === "light" || node.kind === "spawn" || node.kind === "goal") {
    return { position: node.position, quaternion: [0, 0, 0, 1] };
  }
  return null;
}

/**
 * Resolves where a diagnostic's suggested fix would place its node, without touching the
 * live scene: the Preview Fix ghost renders at `to`, with a guide from `from`.
 */
export function computeFixGhost(scene: SceneAST, diagnostic: SpatialDiagnostic): FixGhost | null {
  const fix = diagnostic.suggestedFix;
  if (fix === undefined) return null;
  let patched: SceneAST | null;
  try {
    patched = applySuggestedFix(scene, diagnostic);
  } catch {
    return null;
  }
  if (patched === null) return null;
  let before: { position: Vec3; quaternion: Quat } | null;
  let after: { position: Vec3; quaternion: Quat } | null;
  try {
    before = anchorOf(scene, fix.nodeId);
    after = anchorOf(patched, fix.nodeId);
  } catch {
    return null;
  }
  const node = patched.nodes.find((n) => n.id === fix.nodeId);
  if (before === null || after === null || node === undefined) return null;
  return { nodeId: fix.nodeId, node, from: before.position, to: after.position, quaternion: after.quaternion };
}
