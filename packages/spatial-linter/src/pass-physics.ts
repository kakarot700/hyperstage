import {
  add,
  bodyKindOf,
  cross,
  distance,
  dot,
  length,
  normalize,
  orientedHalfExtents,
  quatMultiply,
  round6,
  roundVec,
  rotateVec,
  scale,
  sub,
  tiltDegrees,
} from "@hyperstage/core";
import type { GoalNode, JointSpec, Quat, ResolvedGeometry, ResolvedScene, SceneAST, SceneNodeBase, TriggerSpec, Vec3 } from "@hyperstage/core";
import { aabbOverlapXZ, contact, lintMeshOf, meshProxyOf, pointAabbDistance, shapeOf } from "./geometry.js";
import type { RapierModule } from "./rapier-loader.js";
import type { FrameSnapshot, JointFrame, SpatialDiagnostic, TriggerEvent } from "./types.js";

export const PHYSICS_DT = 1 / 60;
export const DEFAULT_TICKS = 180;
export const VOID_Y = -15;
export const DRIFT_LIMIT_M = 0.5;
export const TIP_LIMIT_DEG = 45;
const CONTACT_TOLERANCE_M = 0.03;
/** E05 threshold: world-space anchor separation (metres). */
export const JOINT_SEPARATION_LIMIT_M = 0.15;
/** A dynamic body within this gap of a trigger volume counts as having entered it. */
export const TRIGGER_TOLERANCE_M = 0.01;
/** Velocity-motor gain passed to configureMotorVelocity. */
export const MOTOR_FACTOR = 10;
/** Default motor velocity for enable_motor when neither the trigger nor the joint gives one. */
export const DEFAULT_MOTOR_VELOCITY = 1;

export interface JointStats {
  /** Separation in the initial (rest) pose, before any step. */
  initialSeparation: number;
  maxSeparation: number;
  /** Tick of the peak separation (0 = initial pose). */
  maxSeparationTick: number;
}

export interface RolloutResult {
  frames: FrameSnapshot[];
  /** Peak linear speed (m/s) per non-static body. */
  peakSpeeds: Record<string, number>;
  /** Peak angular speed (rad/s) per non-static body. */
  peakAngularSpeeds: Record<string, number>;
  finalTransforms: Record<string, { position: Vec3; quaternion: Quat }>;
  /** v2: per-joint separation statistics over the rollout (tick 0 = rest pose). */
  jointStats: Record<string, JointStats>;
  /** v2: trigger firings in tick order. */
  triggerEvents: TriggerEvent[];
  /** v2: goals unlocked by unlock_goal triggers. */
  unlockedGoals: string[];
  /** v2: body id -> first tick its motion is intended (powered joint motor or impulse). */
  motionStart: Record<string, number>;
  /** v2: bodies held by a revolute, prismatic or spherical joint (their tilt is joint-driven). */
  articulatedBodies: string[];
}

const conj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
const toVec = (v: Vec3): { x: number; y: number; z: number } => ({ x: v[0], y: v[1], z: v[2] });
const toRot = (q: Quat): { x: number; y: number; z: number; w: number } => ({ x: q[0], y: q[1], z: q[2], w: q[3] });

/** World-space anchors of a joint for the given body poses. */
export function worldAnchors(
  joint: JointSpec,
  a: { position: Vec3; quaternion: Quat },
  b: { position: Vec3; quaternion: Quat },
): { anchorA: Vec3; anchorB: Vec3 } {
  return {
    anchorA: add(a.position, rotateVec(a.quaternion, joint.anchorA)),
    anchorB: add(b.position, rotateVec(b.quaternion, joint.anchorB)),
  };
}

/** Joint measurement: separation (prismatic: off-axis only), hinge angle or slide translation. */
export function measureJoint(
  joint: JointSpec,
  a: { position: Vec3; quaternion: Quat },
  b: { position: Vec3; quaternion: Quat },
  restRelative: Quat,
): JointFrame {
  const { anchorA, anchorB } = worldAnchors(joint, a, b);
  const gap = sub(anchorB, anchorA);
  if (joint.type === "prismatic") {
    const axis = normalize(rotateVec(a.quaternion, joint.axis));
    const along = dot(gap, axis);
    return { separation: round6(length(sub(gap, scale(axis, along)))), translation: round6(along) };
  }
  const frame: JointFrame = { separation: round6(length(gap)) };
  if (joint.type === "revolute") {
    const rel = quatMultiply(conj(a.quaternion), b.quaternion);
    const d = quatMultiply(rel, conj(restRelative));
    const axis = normalize(joint.axis);
    frame.angleRad = round6(2 * Math.atan2(dot([d[0], d[1], d[2]], axis), d[3]));
  }
  return frame;
}

/** Body-local anchorB that makes both world anchors coincide in the rest pose. */
export function alignedAnchorB(joint: JointSpec, a: ResolvedGeometry, b: ResolvedGeometry): Vec3 {
  const worldA = add(a.center, rotateVec(a.quaternion, joint.anchorA));
  return roundVec(rotateVec(conj(b.quaternion), sub(worldA, b.center)));
}

function triggerVolumeHit(
  zone: { kind: "goal"; goal: GoalNode } | { kind: "body"; g: ResolvedGeometry; pose: { position: Vec3; quaternion: Quat } },
  body: ResolvedGeometry,
  pose: { position: Vec3; quaternion: Quat },
): boolean {
  const half = body.node.kind === "sphere" ? body.localHalf : orientedHalfExtents(pose.quaternion, body.localHalf);
  const min = sub(pose.position, half);
  const max = add(pose.position, half);
  if (zone.kind === "goal") return pointAabbDistance(zone.goal.position, min, max) <= zone.goal.radius;
  const zh = zone.g.node.kind === "sphere" ? zone.g.localHalf : orientedHalfExtents(zone.pose.quaternion, zone.g.localHalf);
  for (let axis = 0; axis < 3; axis++) {
    const gap = Math.abs((pose.position[axis] ?? 0) - (zone.pose.position[axis] ?? 0)) - (half[axis] ?? 0) - (zh[axis] ?? 0);
    if (gap > TRIGGER_TOLERANCE_M) return false;
  }
  return true;
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

/** Local-frame vertices / indices of a mesh-kind node (world mesh moved back into the body frame). */
function localMeshArrays(g: ResolvedGeometry): { vertices: Float32Array; indices: Uint32Array } {
  const mesh = lintMeshOf(g);
  const inverse = conj(g.quaternion);
  const vertices = new Float32Array(mesh.triangleCount * 9);
  const indices = new Uint32Array(mesh.triangleCount * 3);
  for (let i = 0; i < mesh.triangleCount * 3; i++) {
    const p: Vec3 = [mesh.tris[i * 3] ?? 0, mesh.tris[i * 3 + 1] ?? 0, mesh.tris[i * 3 + 2] ?? 0];
    const local = rotateVec(inverse, sub(p, g.center));
    vertices.set(local, i * 3);
    indices[i] = i;
  }
  return { vertices, indices };
}

function colliderFor(rapier: RapierModule, g: ResolvedGeometry) {
  const node = g.node;
  if ((node.kind === "torus" || node.kind === "csg") && meshProxyOf(g) !== null) {
    const { vertices, indices } = localMeshArrays(g);
    // Static / kinematic: exact triangles (doorways stay open). Dynamic: convex hull.
    if (bodyKindOf(node) !== "dynamic") return rapier.ColliderDesc.trimesh(vertices, indices);
    const hull = rapier.ColliderDesc.convexHull(vertices);
    if (hull !== null) return hull;
  }
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
    case "capsule":
      return rapier.ColliderDesc.capsule(Math.max(0, node.height / 2 - node.radius), node.radius);
    case "box":
    case "ramp":
    case "torus":
    case "gltf":
    case "csg":
      return rapier.ColliderDesc.cuboid(g.localHalf[0], g.localHalf[1], g.localHalf[2]);
  }
}

/** Steps a deterministic Rapier world for `ticks` at dt = 1/60 and records a snapshot every tick. */
export function rollout(rapier: RapierModule, scene: SceneAST, resolved: ResolvedScene, ticks: number): RolloutResult {
  const world = new rapier.World({ x: scene.gravity[0], y: scene.gravity[1], z: scene.gravity[2] });
  world.timestep = PHYSICS_DT;
  type Body = ReturnType<typeof world.createRigidBody>;
  const tracked: { id: string; body: Body }[] = [];
  const bodies = new Map<string, Body>();
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
      bodies.set(g.id, body);
      if (kind !== "static") tracked.push({ id: g.id, body });
    }

    // Joints: RAPIER.JointData with body-local anchors, limits and velocity motors.
    const joints = scene.joints ?? [];
    const triggers: TriggerSpec[] = scene.triggers ?? [];
    const gated = new Set(triggers.filter((t) => t.action === "enable_motor").map((t) => t.targetId));
    const motionStart: Record<string, number> = {};
    const markMotion = (id: string, tick: number): void => {
      const g = resolved.byId.get(id);
      if (g === undefined || bodyKindOf(g.node) === "static") return;
      if (motionStart[id] === undefined) motionStart[id] = tick;
    };
    const articulated = new Set<string>();
    const unitJoints = new Map<string, InstanceType<RapierModule["UnitImpulseJoint"]>>();
    const restRelative = new Map<string, Quat>();
    const jointStats: Record<string, JointStats> = {};
    for (const joint of joints) {
      const ga = resolved.byId.get(joint.bodyA);
      const gb = resolved.byId.get(joint.bodyB);
      const ba = bodies.get(joint.bodyA);
      const bb = bodies.get(joint.bodyB);
      if (ga === undefined || gb === undefined || ba === undefined || bb === undefined) continue;
      const rel = quatMultiply(conj(ga.quaternion), gb.quaternion);
      restRelative.set(joint.id, rel);
      const anchor1 = toVec(joint.anchorA);
      const anchor2 = toVec(joint.anchorB);
      let data: ReturnType<RapierModule["JointData"]["fixed"]>;
      switch (joint.type) {
        case "fixed":
          data = rapier.JointData.fixed(anchor1, { x: 0, y: 0, z: 0, w: 1 }, anchor2, toRot(conj(rel)));
          break;
        case "spherical":
          data = rapier.JointData.spherical(anchor1, anchor2);
          break;
        case "revolute": {
          const axis1 = normalize(joint.axis);
          const axis2 = normalize(rotateVec(conj(rel), axis1));
          data = rapier.JointData.revoluteWithAxes(anchor1, anchor2, toVec(axis1), toVec(axis2));
          if (joint.limitsDeg !== undefined) {
            data.limitsEnabled = true;
            data.limits = [(joint.limitsDeg[0] * Math.PI) / 180, (joint.limitsDeg[1] * Math.PI) / 180];
          }
          break;
        }
        case "prismatic":
          data = rapier.JointData.prismatic(anchor1, anchor2, toVec(normalize(joint.axis)));
          if (joint.limits !== undefined) {
            data.limitsEnabled = true;
            data.limits = [joint.limits[0], joint.limits[1]];
          }
          break;
      }
      const created = world.createImpulseJoint(data, ba, bb, true);
      created.setContactsEnabled(false);
      if (joint.type !== "fixed") {
        articulated.add(joint.bodyA);
        articulated.add(joint.bodyB);
      }
      if ((joint.type === "revolute" || joint.type === "prismatic") && created instanceof rapier.UnitImpulseJoint) {
        unitJoints.set(joint.id, created);
        // Limits are (re)applied on the live joint: JointData limits are not carried by every constructor.
        if (joint.type === "revolute" && joint.limitsDeg !== undefined) {
          created.setLimits((joint.limitsDeg[0] * Math.PI) / 180, (joint.limitsDeg[1] * Math.PI) / 180);
        } else if (joint.type === "prismatic" && joint.limits !== undefined) {
          created.setLimits(joint.limits[0], joint.limits[1]);
        }
        if (joint.motorMaxForce !== undefined) created.setMotorMaxForce(joint.motorMaxForce);
        if (joint.motorVelocity !== undefined && !gated.has(joint.id)) {
          created.configureMotorVelocity(joint.motorVelocity, MOTOR_FACTOR);
          markMotion(joint.bodyA, 0);
          markMotion(joint.bodyB, 0);
        }
      }
      const sep = measureJoint(joint, { position: ga.center, quaternion: ga.quaternion }, { position: gb.center, quaternion: gb.quaternion }, rel).separation;
      jointStats[joint.id] = { initialSeparation: sep, maxSeparation: sep, maxSeparationTick: 0 };
    }
    const poseOf = (id: string): { position: Vec3; quaternion: Quat } | null => {
      const body = bodies.get(id);
      if (body === undefined) return null;
      const p = body.translation();
      const r = body.rotation();
      return { position: [p.x, p.y, p.z], quaternion: [r.x, r.y, r.z, r.w] };
    };
    const goals = new Map<string, GoalNode>();
    for (const n of scene.nodes) if (n.kind === "goal") goals.set(n.id, n);
    const fired = new Set<string>();
    const triggerEvents: TriggerEvent[] = [];
    const unlockedGoals: string[] = [];

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
      let jointFrames: Record<string, JointFrame> | undefined;
      if (joints.length > 0) {
        jointFrames = {};
        for (const joint of joints) {
          const pa = poseOf(joint.bodyA);
          const pb = poseOf(joint.bodyB);
          const rel = restRelative.get(joint.id);
          const stats = jointStats[joint.id];
          if (pa === null || pb === null || rel === undefined || stats === undefined) continue;
          const m = measureJoint(joint, pa, pb, rel);
          jointFrames[joint.id] = m;
          if (m.separation > stats.maxSeparation) {
            stats.maxSeparation = m.separation;
            stats.maxSeparationTick = tick;
          }
        }
      }
      // Triggers: a dynamic body entering the volume fires each trigger once; effects act from the next step.
      let firedNow: string[] | undefined;
      for (const trigger of triggers) {
        if (fired.has(trigger.id)) continue;
        const goal = goals.get(trigger.onEnterNodeId);
        const zoneGeometry = resolved.byId.get(trigger.onEnterNodeId);
        const zonePose = poseOf(trigger.onEnterNodeId);
        let entered: string | null = null;
        for (const t of tracked) {
          if (t.id === trigger.onEnterNodeId) continue;
          const g = resolved.byId.get(t.id);
          const pose = poseOf(t.id);
          if (g === undefined || pose === null || bodyKindOf(g.node) !== "dynamic") continue;
          const hit =
            goal !== undefined
              ? triggerVolumeHit({ kind: "goal", goal }, g, pose)
              : zoneGeometry !== undefined && zonePose !== null && triggerVolumeHit({ kind: "body", g: zoneGeometry, pose: zonePose }, g, pose);
          if (hit) {
            entered = t.id;
            break;
          }
        }
        if (entered === null) continue;
        fired.add(trigger.id);
        (firedNow ??= []).push(trigger.id);
        triggerEvents.push({ tick, triggerId: trigger.id, action: trigger.action, targetId: trigger.targetId, bodyId: entered });
        if (trigger.action === "unlock_goal") {
          if (!unlockedGoals.includes(trigger.targetId)) unlockedGoals.push(trigger.targetId);
        } else if (trigger.action === "enable_motor") {
          const joint = joints.find((j) => j.id === trigger.targetId);
          const unit = unitJoints.get(trigger.targetId);
          if (joint !== undefined && unit !== undefined && (joint.type === "revolute" || joint.type === "prismatic")) {
            const velocity = typeof trigger.value === "number" ? trigger.value : (joint.motorVelocity ?? DEFAULT_MOTOR_VELOCITY);
            unit.configureMotorVelocity(velocity, MOTOR_FACTOR);
            bodies.get(joint.bodyA)?.wakeUp();
            bodies.get(joint.bodyB)?.wakeUp();
            markMotion(joint.bodyA, tick);
            markMotion(joint.bodyB, tick);
          }
        } else {
          const impulse: Vec3 = Array.isArray(trigger.value) ? trigger.value : [0, typeof trigger.value === "number" ? trigger.value : 0, 0];
          const target = bodies.get(trigger.targetId);
          if (target !== undefined) {
            target.applyImpulse(toVec(impulse), true);
            markMotion(trigger.targetId, tick);
          }
        }
      }
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
      const frame: FrameSnapshot = { tick, timeSec: Number((tick * PHYSICS_DT).toFixed(6)), transforms };
      if (jointFrames !== undefined) frame.joints = jointFrames;
      if (firedNow !== undefined) frame.triggers = firedNow;
      frames.push(frame);
    }
    const last = frames[frames.length - 1];
    const finalTransforms: RolloutResult["finalTransforms"] = {};
    for (const t of tracked) {
      const tr = last?.transforms[t.id];
      const g = resolved.byId.get(t.id);
      if (tr !== undefined) finalTransforms[t.id] = tr;
      else if (g !== undefined) finalTransforms[t.id] = { position: g.center, quaternion: g.quaternion };
    }
    // Bodies connected through any joint chain to a driven body move with it from the same tick.
    let spread = true;
    while (spread) {
      spread = false;
      for (const joint of joints) {
        const sa = motionStart[joint.bodyA];
        const sb = motionStart[joint.bodyB];
        const earliest = Math.min(sa ?? Infinity, sb ?? Infinity);
        if (!Number.isFinite(earliest)) continue;
        for (const id of [joint.bodyA, joint.bodyB]) {
          const g = resolved.byId.get(id);
          if (g === undefined || bodyKindOf(g.node) !== "dynamic") continue;
          if ((motionStart[id] ?? Infinity) > earliest) {
            motionStart[id] = earliest;
            spread = true;
          }
        }
      }
    }
    return {
      frames,
      peakSpeeds,
      peakAngularSpeeds,
      finalTransforms,
      jointStats,
      triggerEvents,
      unlockedGoals,
      motionStart,
      articulatedBodies: [...articulated].sort(),
    };
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
    const start = rolloutResult.motionStart[g.id];
    // Bodies driven by a joint motor or a trigger impulse are intended to move from that tick on.
    stats.set(g.id, {
      g,
      minY: g.center[1],
      maxTilt: 0,
      driftBeforeTrigger: 0,
      triggeredAt: start === undefined ? null : start,
      trigger: start === undefined ? null : "motor",
    });
  }
  const articulated = new Set(rolloutResult.articulatedBodies);

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
      if (s.g.node.kind !== "sphere" && !articulated.has(s.g.id)) s.maxTilt = Math.max(s.maxTilt, tiltDegrees(t.quaternion));
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

/**
 * Pass 2b (E05_BROKEN_JOINT): flags joints whose world anchors separate by more than
 * 0.15 m in the rest pose or at any tick of the rollout, and suggests a body-local
 * anchorB that coincides with anchorA in the rest pose.
 */
export function passJoints(scene: SceneAST, resolved: ResolvedScene, rolloutResult: RolloutResult): SpatialDiagnostic[] {
  const diagnostics: SpatialDiagnostic[] = [];
  for (const joint of scene.joints ?? []) {
    const stats = rolloutResult.jointStats[joint.id];
    const a = resolved.byId.get(joint.bodyA);
    const b = resolved.byId.get(joint.bodyB);
    if (stats === undefined || a === undefined || b === undefined) continue;
    if (stats.maxSeparation <= JOINT_SEPARATION_LIMIT_M) continue;
    const anchorB = alignedAnchorB(joint, a, b);
    const atRest = stats.initialSeparation > JOINT_SEPARATION_LIMIT_M;
    const where = atRest
      ? `in the rest pose`
      : `at tick ${stats.maxSeparationTick} of the rollout`;
    diagnostics.push({
      code: "E05_BROKEN_JOINT",
      severity: "error",
      nodeId: joint.bodyB,
      relatedNodeId: joint.bodyA,
      jointId: joint.id,
      message: `Joint "${joint.id}" (${joint.type}) anchors are ${stats.maxSeparation.toFixed(3)} m apart ${where} (> ${JOINT_SEPARATION_LIMIT_M} m)`,
      metrics: {
        initialSeparation: Number(stats.initialSeparation.toFixed(4)),
        maxSeparation: Number(stats.maxSeparation.toFixed(4)),
        maxSeparationTick: stats.maxSeparationTick,
      },
      suggestedJointFix: {
        jointId: joint.id,
        patch: { anchorB },
        rationale: `Move anchorB of "${joint.id}" to [${anchorB.join(", ")}] in "${joint.bodyB}"'s frame so it coincides with anchorA on "${joint.bodyA}".`,
      },
    });
  }
  return diagnostics;
}
