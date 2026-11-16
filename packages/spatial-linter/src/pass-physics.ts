import { bodyKindOf, distance, orientedHalfExtents, roundVec, tiltDegrees } from "@hyperstage/core";
import type { Quat, ResolvedGeometry, ResolvedScene, SceneAST, SceneNodeBase, Vec3 } from "@hyperstage/core";
import { aabbOverlapXZ, contact, shapeOf } from "./geometry.js";
import type { RapierModule } from "./rapier-loader.js";
import type { FrameSnapshot, SpatialDiagnostic } from "./types.js";

export const PHYSICS_DT = 1 / 60;
export const DEFAULT_TICKS = 180;
export const VOID_Y = -15;
export const DRIFT_LIMIT_M = 0.5;
export const TIP_LIMIT_DEG = 45;
const CONTACT_TOLERANCE_M = 0.03;

export interface RolloutResult {
  frames: FrameSnapshot[];
  /** Peak linear speed (m/s) per non-static body. */
  peakSpeeds: Record<string, number>;
  /** Peak angular speed (rad/s) per non-static body. */
  peakAngularSpeeds: Record<string, number>;
  finalTransforms: Record<string, { position: Vec3; quaternion: Quat }>;
}

function frustumPoints(radiusTop: number, radiusBottom: number, height: number, segments: number): Float32Array {
  const points = new Float32Array(segments * 2 * 3);
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    points.set([c * radiusTop, height / 2, s * radiusTop], i * 6);
    points.set([c * radiusBottom, -height / 2, s * radiusBottom], i * 6 + 3);
  }
  return points;
}

function colliderFor(rapier: RapierModule, g: ResolvedGeometry) {
  const node = g.node;
  switch (node.kind) {
    case "sphere":
      return rapier.ColliderDesc.ball(node.radius);
    case "cylinder":
      if (Math.abs(node.radiusTop - node.radiusBottom) < 1e-9) {
        return rapier.ColliderDesc.cylinder(node.height / 2, node.radiusTop);
      }
      return (
        rapier.ColliderDesc.convexHull(frustumPoints(node.radiusTop, node.radiusBottom, node.height, 24)) ??
        rapier.ColliderDesc.cylinder(node.height / 2, Math.max(node.radiusTop, node.radiusBottom))
      );
    case "box":
    case "ramp":
      return rapier.ColliderDesc.cuboid(g.localHalf[0], g.localHalf[1], g.localHalf[2]);
  }
}

/** Steps a deterministic Rapier world for `ticks` at dt = 1/60 and records a snapshot every tick. */
export function rollout(rapier: RapierModule, scene: SceneAST, resolved: ResolvedScene, ticks: number): RolloutResult {
  const world = new rapier.World({ x: scene.gravity[0], y: scene.gravity[1], z: scene.gravity[2] });
  world.timestep = PHYSICS_DT;
  const tracked: { id: string; body: ReturnType<typeof world.createRigidBody> }[] = [];
  try {
    for (const g of resolved.geometry) {
      const kind = bodyKindOf(g.node);
      const [qx, qy, qz, qw] = g.quaternion;
      const desc =
        kind === "dynamic"
          ? rapier.RigidBodyDesc.dynamic()
          : kind === "kinematic"
            ? rapier.RigidBodyDesc.kinematicPositionBased()
            : rapier.RigidBodyDesc.fixed();
      desc.setTranslation(g.center[0], g.center[1], g.center[2]).setRotation({ x: qx, y: qy, z: qz, w: qw });
      if (kind === "dynamic" && g.node.kind === "sphere") desc.setCcdEnabled(true);
      const body = world.createRigidBody(desc);
      const collider = colliderFor(rapier, g);
      collider.setFriction(g.node.physics?.friction ?? 0.6);
      collider.setRestitution(g.node.physics?.restitution ?? 0);
      if (g.node.physics?.mass !== undefined) collider.setMass(g.node.physics.mass);
      world.createCollider(collider, body);
      if (kind !== "static") tracked.push({ id: g.id, body });
    }

    const frames: FrameSnapshot[] = [];
    const peakSpeeds: Record<string, number> = {};
    const peakAngularSpeeds: Record<string, number> = {};
    for (const t of tracked) {
      peakSpeeds[t.id] = 0;
      peakAngularSpeeds[t.id] = 0;
    }
    for (let tick = 1; tick <= ticks; tick++) {
      world.step();
      const transforms: FrameSnapshot["transforms"] = {};
      for (const t of tracked) {
        const p = t.body.translation();
        const r = t.body.rotation();
        const v = t.body.linvel();
        const w = t.body.angvel();
        transforms[t.id] = { position: roundVec([p.x, p.y, p.z]), quaternion: [r.x, r.y, r.z, r.w] };
        const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
        const spin = Math.sqrt(w.x * w.x + w.y * w.y + w.z * w.z);
        if (speed > (peakSpeeds[t.id] ?? 0)) peakSpeeds[t.id] = speed;
        if (spin > (peakAngularSpeeds[t.id] ?? 0)) peakAngularSpeeds[t.id] = spin;
      }
      frames.push({ tick, timeSec: Number((tick * PHYSICS_DT).toFixed(6)), transforms });
    }
    const last = frames[frames.length - 1];
    const finalTransforms: RolloutResult["finalTransforms"] = {};
    for (const t of tracked) {
      const tr = last?.transforms[t.id];
      const g = resolved.byId.get(t.id);
      if (tr !== undefined) finalTransforms[t.id] = tr;
      else if (g !== undefined) finalTransforms[t.id] = { position: g.center, quaternion: g.quaternion };
    }
    return { frames, peakSpeeds, peakAngularSpeeds, finalTransforms };
  } finally {
    world.free();
  }
}

function ancestry(resolved: ResolvedScene, id: string): Set<string> {
  const chain = new Set<string>();
  let current = resolved.byId.get(id);
  while (current?.node.snapTo !== undefined && !chain.has(current.node.snapTo.target)) {
    chain.add(current.node.snapTo.target);
    current = resolved.byId.get(current.node.snapTo.target);
  }
  return chain;
}

/** Finds the highest flat support directly beneath `g` (or the nearest static floor if it hangs over the void). */
export function nearestSurfaceBelow(resolved: ResolvedScene, g: ResolvedGeometry, exclude: Set<string>): ResolvedGeometry | null {
  let best: ResolvedGeometry | null = null;
  for (const other of resolved.geometry) {
    if (other.id === g.id || exclude.has(other.id)) continue;
    if (other.node.kind === "sphere" || other.node.kind === "ramp") continue;
    if (ancestry(resolved, other.id).has(g.id)) continue;
    if (!aabbOverlapXZ(g, other, 1e-4)) continue;
    if (other.max[1] > g.min[1] + 0.002) continue;
    if (best === null || other.max[1] > best.max[1]) best = other;
  }
  if (best !== null) return best;
  let nearest: ResolvedGeometry | null = null;
  let nearestDist = Infinity;
  for (const other of resolved.geometry) {
    if (other.id === g.id || exclude.has(other.id)) continue;
    if (bodyKindOf(other.node) !== "static" || other.node.kind !== "box") continue;
    if (ancestry(resolved, other.id).has(g.id)) continue;
    const dx = other.center[0] - g.center[0];
    const dz = other.center[2] - g.center[2];
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = other;
    }
  }
  return nearest;
}

export function snapOntoPatch(g: ResolvedGeometry, support: ResolvedGeometry): Partial<SceneNodeBase> {
  const clampAxis = (axis: 0 | 2): number => {
    const room = Math.max(0, support.halfExtents[axis] - g.halfExtents[axis]);
    const d = g.center[axis] - support.center[axis];
    return Math.max(-room, Math.min(room, d));
  };
  const offset = roundVec([clampAxis(0), 0, clampAxis(2)]);
  return { snapTo: { target: support.id, face: "top", align: "center", offset } };
}

interface BodyStats {
  g: ResolvedGeometry;
  minY: number;
  maxTilt: number;
  driftBeforeTrigger: number;
  triggeredAt: number | null;
  trigger: string | null;
}

/** Pass 2 (E02_UNSTABLE_PHYSICS): analyses a 180-tick rollout for void falls, unintended drift and tipping. */
export function passPhysics(resolved: ResolvedScene, rolloutResult: RolloutResult): SpatialDiagnostic[] {
  const dynamic = resolved.geometry.filter((g) => bodyKindOf(g.node) === "dynamic");
  if (dynamic.length === 0) return [];
  const ramps = resolved.geometry.filter((g) => g.node.kind === "ramp");
  const stats = new Map<string, BodyStats>();
  for (const g of dynamic) {
    stats.set(g.id, { g, minY: g.center[1], maxTilt: 0, driftBeforeTrigger: 0, triggeredAt: null, trigger: null });
  }

  const transformAt = (frame: FrameSnapshot | null, g: ResolvedGeometry): { position: Vec3; quaternion: Quat } => {
    const tr = frame?.transforms[g.id];
    return tr ?? { position: g.center, quaternion: g.quaternion };
  };
  const near = (a: ResolvedGeometry, ta: { position: Vec3; quaternion: Quat }, b: ResolvedGeometry, tb: { position: Vec3; quaternion: Quat }): boolean => {
    const ha = a.node.kind === "sphere" ? a.localHalf : orientedHalfExtents(ta.quaternion, a.localHalf);
    const hb = b.node.kind === "sphere" ? b.localHalf : orientedHalfExtents(tb.quaternion, b.localHalf);
    for (let axis = 0; axis < 3; axis++) {
      const gap = Math.abs((ta.position[axis] ?? 0) - (tb.position[axis] ?? 0)) - (ha[axis] ?? 0) - (hb[axis] ?? 0);
      if (gap > CONTACT_TOLERANCE_M) return false;
    }
    return contact(shapeOf(a, ta.position, ta.quaternion), shapeOf(b, tb.position, tb.quaternion)).depth > -CONTACT_TOLERANCE_M;
  };

  const frames: (FrameSnapshot | null)[] = [null, ...rolloutResult.frames];
  for (const frame of frames) {
    const tick = frame?.tick ?? 0;
    // Trigger seeds: contact with any ramp surface.
    for (const s of stats.values()) {
      const t = transformAt(frame, s.g);
      if (s.triggeredAt === null) {
        for (const ramp of ramps) {
          if (ramp.id === s.g.id) continue;
          if (near(s.g, t, ramp, transformAt(frame, ramp))) {
            s.triggeredAt = tick;
            s.trigger = ramp.id;
            break;
          }
        }
      }
    }
    // Collision chain: contact with an already-triggered body propagates the trigger.
    let changed = true;
    while (changed) {
      changed = false;
      for (const s of stats.values()) {
        if (s.triggeredAt !== null) continue;
        const t = transformAt(frame, s.g);
        for (const o of stats.values()) {
          if (o === s || o.triggeredAt === null) continue;
          const to = transformAt(frame, o.g);
          if (near(s.g, t, o.g, to)) {
            s.triggeredAt = tick;
            s.trigger = o.g.id;
            changed = true;
            break;
          }
        }
      }
    }
    for (const s of stats.values()) {
      const t = transformAt(frame, s.g);
      s.minY = Math.min(s.minY, t.position[1]);
      if (s.g.node.kind !== "sphere") s.maxTilt = Math.max(s.maxTilt, tiltDegrees(t.quaternion));
      if (s.triggeredAt === null) {
        s.driftBeforeTrigger = Math.max(s.driftBeforeTrigger, distance(t.position, s.g.center));
      }
    }
  }

  const diagnostics: SpatialDiagnostic[] = [];
  const flagged = new Set<string>();
  for (const s of stats.values()) {
    const { g } = s;
    const peak = rolloutResult.peakSpeeds[g.id] ?? 0;
    const metrics: Record<string, number> = {
      minY: Number(s.minY.toFixed(4)),
      maxTiltDeg: Number(s.maxTilt.toFixed(2)),
      driftMeters: Number(s.driftBeforeTrigger.toFixed(4)),
      peakSpeed: Number(peak.toFixed(4)),
    };
    let reason: string | null = null;
    if (s.minY < VOID_Y) {
      reason = `falls into the void (y = ${s.minY.toFixed(2)} m < ${VOID_Y} m)`;
    } else if (s.driftBeforeTrigger > DRIFT_LIMIT_M) {
      reason = `moves ${s.driftBeforeTrigger.toFixed(2)} m while intended to rest (no ramp or collision trigger)`;
    } else if (s.maxTilt > TIP_LIMIT_DEG && g.node.physics?.allowTip !== true) {
      reason = `tips ${s.maxTilt.toFixed(1)}° (> ${TIP_LIMIT_DEG}°) without physics.allowTip`;
    }
    if (reason === null) continue;
    flagged.add(g.id);
    const support = nearestSurfaceBelow(resolved, g, new Set());
    const diagnostic: SpatialDiagnostic = {
      code: "E02_UNSTABLE_PHYSICS",
      severity: "error",
      nodeId: g.id,
      message: `"${g.id}" ${reason} during the ${rolloutResult.frames.length}-tick rollout`,
      metrics,
    };
    if (support !== null) {
      diagnostic.relatedNodeId = support.id;
      diagnostic.suggestedFix = {
        nodeId: g.id,
        patch: snapOntoPatch(g, support),
        rationale: `Snap "${g.id}" onto the top face of "${support.id}" (nearest surface beneath it) with its footprint fully supported.`,
      };
    }
    diagnostics.push(diagnostic);
  }
  // Bodies riding on an unstable anchor are consequences, not root causes: fixing the anchor repairs them.
  return diagnostics.filter((d) => {
    const target = resolved.byId.get(d.nodeId)?.node.snapTo?.target;
    return target === undefined || !flagged.has(target);
  });
}
