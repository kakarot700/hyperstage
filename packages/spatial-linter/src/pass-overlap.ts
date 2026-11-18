import { add, bodyKindOf, roundVec, scale } from "@hyperstage/core";
import type { ResolvedGeometry, ResolvedScene, SceneNodeBase, Vec3 } from "@hyperstage/core";
import { contact, lintMeshOf, meshContact, meshProxyOf, shapeOf } from "./geometry.js";
import type { SpatialDiagnostic } from "./types.js";

/** Flush contacts within 2 mm are legal. */
export const OVERLAP_TOLERANCE_M = 0.002;

function chooseMover(a: ResolvedGeometry, b: ResolvedGeometry): ResolvedGeometry {
  const aDynamic = bodyKindOf(a.node) === "dynamic";
  const bDynamic = bodyKindOf(b.node) === "dynamic";
  if (aDynamic !== bDynamic) return aDynamic ? a : b;
  // Otherwise move the child: the body resting higher up, then the node resolved later.
  if (Math.abs(a.center[1] - b.center[1]) > 1e-6) return a.center[1] > b.center[1] ? a : b;
  return a.order > b.order ? a : b;
}

/** Builds a patch that translates `mover` by `delta`, preserving relational snapTo anchors. */
export function translatePatch(mover: ResolvedGeometry, delta: Vec3): Partial<SceneNodeBase> {
  const snap = mover.node.snapTo;
  if (snap !== undefined) {
    return { snapTo: { ...snap, offset: roundVec(add(snap.offset ?? [0, 0, 0], delta)) } };
  }
  return { position: roundVec(add(mover.center, delta)) };
}

/** Pass 1 (E01_INTERPENETRATION): pairwise SAT / closest-point penetration with an MTV repair. */
export function passOverlap(resolved: ResolvedScene): SpatialDiagnostic[] {
  // Bodies connected by a joint have contacts disabled in the rollout; their overlap is by design.
  const jointed = new Set<string>();
  for (const joint of resolved.scene.joints ?? []) {
    jointed.add(`${joint.bodyA}\u0000${joint.bodyB}`);
    jointed.add(`${joint.bodyB}\u0000${joint.bodyA}`);
  }
  const diagnostics: SpatialDiagnostic[] = [];
  const geometry = resolved.geometry;
  const shapes = geometry.map((g) => shapeOf(g));
  for (let i = 0; i < geometry.length; i++) {
    const a = geometry[i];
    const shapeA = shapes[i];
    if (a === undefined || shapeA === undefined) continue;
    for (let j = i + 1; j < geometry.length; j++) {
      const b = geometry[j];
      const shapeB = shapes[j];
      if (b === undefined || shapeB === undefined) continue;
      // Broad phase: AABB rejection.
      if (
        a.max[0] <= b.min[0] || b.max[0] <= a.min[0] ||
        a.max[1] <= b.min[1] || b.max[1] <= a.min[1] ||
        a.max[2] <= b.min[2] || b.max[2] <= a.min[2]
      ) {
        continue;
      }
      if (jointed.has(`${a.id}\u0000${b.id}`)) continue;
      // Translating along the axis of least AABB overlap separates the boxes (and so the solids),
      // so the true penetration depth can never exceed it: flush contacts skip the narrow phase.
      const aabbOverlap = Math.min(
        Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]),
        Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]),
        Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]),
      );
      if (aabbOverlap <= OVERLAP_TOLERANCE_M) continue;
      // Narrow phase: exact sphere/OBB proxies for v1 kinds, real triangles for closed
      // capsule/torus/CSG meshes (so carved doorways and windows are respected).
      const meshA = meshProxyOf(a);
      const meshB = meshProxyOf(b);
      const hit =
        meshA === null && meshB === null
          ? contact(shapeA, shapeB)
          : meshContact(meshA ?? lintMeshOf(a), meshB ?? lintMeshOf(b), contact(shapeA, shapeB).normal);
      if (hit.depth <= OVERLAP_TOLERANCE_M) continue;
      const mover = chooseMover(a, b);
      const other = mover === a ? b : a;
      const direction = mover === b ? hit.normal : scale(hit.normal, -1);
      const delta = roundVec(scale(direction, hit.depth));
      diagnostics.push({
        code: "E01_INTERPENETRATION",
        severity: "error",
        nodeId: mover.id,
        relatedNodeId: other.id,
        message: `"${mover.id}" penetrates "${other.id}" by ${(hit.depth * 1000).toFixed(1)} mm`,
        metrics: {
          penetrationMeters: Number(hit.depth.toFixed(6)),
          mtvX: delta[0],
          mtvY: delta[1],
          mtvZ: delta[2],
        },
        suggestedFix: {
          nodeId: mover.id,
          patch: translatePatch(mover, delta),
          rationale: `Translate "${mover.id}" ${(hit.depth * 1000).toFixed(1)} mm along the minimum translation vector [${direction
            .map((v) => v.toFixed(3))
            .join(", ")}] so its surface meets "${other.id}" at 0.000 m contact.`,
        },
      });
    }
  }
  return diagnostics;
}
