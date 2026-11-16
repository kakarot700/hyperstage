import RAPIER from "@dimforge/rapier3d-deterministic-compat";

export type RapierModule = typeof RAPIER;

let ready: Promise<RapierModule> | null = null;

function warmUp(rapier: RapierModule): void {
  // Prime the WASM/JIT path once so the first real lint is representative.
  const world = new rapier.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / 60;
  world.createCollider(rapier.ColliderDesc.cuboid(5, 0.5, 5).setTranslation(0, -0.5, 0));
  for (let i = 0; i < 8; i++) {
    const body = world.createRigidBody(rapier.RigidBodyDesc.dynamic().setTranslation(i * 0.3 - 1, 0.6 + i * 0.4, 0));
    world.createCollider(i % 2 === 0 ? rapier.ColliderDesc.ball(0.2) : rapier.ColliderDesc.cuboid(0.2, 0.2, 0.2), body);
  }
  for (let i = 0; i < 120; i++) world.step();
  world.free();
}

/**
 * Singleton deterministic Rapier loader. `RAPIER.init()` decodes the embedded
 * base64 WASM exactly once per process / page; every caller shares the promise.
 */
export function getRapier(): Promise<RapierModule> {
  if (ready === null) {
    ready = RAPIER.init().then(() => {
      warmUp(RAPIER);
      return RAPIER;
    });
    ready.catch(() => {
      ready = null;
    });
  }
  return ready;
}
