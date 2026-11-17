import type { Vec3 } from "@hyperstage/core";
import type { FrameSnapshot } from "@hyperstage/spatial-linter";

export const TICK_HZ = 60;
export const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 2] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

export interface CollisionEvent {
  /** 0-based frame index of the impact. */
  frame: number;
  /** Bodies whose velocity changed abruptly at this frame. */
  ids: string[];
  /** Largest non-gravitational velocity change at this frame, in m/s. */
  impulse: number;
}

/**
 * Finds impacts in a rollout: a body's velocity change between consecutive ticks, minus what
 * gravity alone would add, above `threshold` m/s. Events within `mergeFrames` collapse together.
 */
export function detectCollisionEvents(frames: FrameSnapshot[], gravity: Vec3, threshold = 0.6, mergeFrames = 4): CollisionEvent[] {
  const dt = 1 / TICK_HZ;
  const ids = frames.length > 0 ? Object.keys(frames[0]?.transforms ?? {}) : [];
  const raw: CollisionEvent[] = [];
  for (let f = 2; f < frames.length; f++) {
    const a = frames[f - 2]?.transforms;
    const b = frames[f - 1]?.transforms;
    const c = frames[f]?.transforms;
    if (a === undefined || b === undefined || c === undefined) continue;
    const hit: string[] = [];
    let impulse = 0;
    for (const id of ids) {
      const pa = a[id]?.position;
      const pb = b[id]?.position;
      const pc = c[id]?.position;
      if (pa === undefined || pb === undefined || pc === undefined) continue;
      const dv0 = (pc[0] - pb[0] - (pb[0] - pa[0])) / dt - gravity[0] * dt;
      const dv1 = (pc[1] - pb[1] - (pb[1] - pa[1])) / dt - gravity[1] * dt;
      const dv2 = (pc[2] - pb[2] - (pb[2] - pa[2])) / dt - gravity[2] * dt;
      const restingBefore = Math.hypot(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]) < 1e-5;
      const restingAfter = Math.hypot(pc[0] - pb[0], pc[1] - pb[1], pc[2] - pb[2]) < 1e-5;
      if (restingBefore && restingAfter) continue;
      const mag = Math.hypot(dv0, dv1, dv2);
      if (mag > threshold) {
        hit.push(id);
        impulse = Math.max(impulse, mag);
      }
    }
    if (hit.length === 0) continue;
    const last = raw[raw.length - 1];
    if (last !== undefined && f - last.frame <= mergeFrames) {
      for (const id of hit) if (!last.ids.includes(id)) last.ids.push(id);
      last.impulse = Math.max(last.impulse, impulse);
    } else raw.push({ frame: f - 1, ids: hit, impulse });
  }
  return raw.map((e) => ({ ...e, impulse: Math.round(e.impulse * 1000) / 1000 }));
}

/** `01.50s / 03.00s · 60Hz` for a 0-based frame index. */
export function formatTimeReadout(frame: number, frameCount: number): string {
  const total = frameCount / TICK_HZ;
  const current = frameCount === 0 ? 0 : (Math.min(Math.max(0, frame), frameCount - 1) + 1) / TICK_HZ;
  const pad = (s: number) => s.toFixed(2).padStart(5, "0");
  return `${pad(current)}s / ${pad(total)}s · ${TICK_HZ}Hz`;
}

/** Tick-marker positions as fractions of the track, with every second marked major. */
export function timelineTicks(frameCount: number, every = 10): { frame: number; major: boolean; at: number }[] {
  if (frameCount < 2) return [];
  const out: { frame: number; major: boolean; at: number }[] = [];
  for (let f = 0; f < frameCount; f += every) out.push({ frame: f, major: f % TICK_HZ === 0, at: f / (frameCount - 1) });
  const lastFrame = frameCount - 1;
  if (out[out.length - 1]?.frame !== lastFrame) out.push({ frame: lastFrame, major: frameCount % TICK_HZ === 0, at: 1 });
  return out;
}

/** Advances an accumulator-driven playhead: returns whole ticks to step and the remainder. */
export function stepPlayback(accumulatorSec: number, elapsedSec: number, speed: number): { steps: number; accumulator: number } {
  let acc = accumulatorSec + Math.min(0.1, Math.max(0, elapsedSec)) * speed;
  let steps = 0;
  const dt = 1 / TICK_HZ;
  while (acc >= dt) {
    acc -= dt;
    steps++;
  }
  return { steps, accumulator: acc };
}
