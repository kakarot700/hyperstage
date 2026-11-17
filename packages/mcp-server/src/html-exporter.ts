import { bodyKindOf, resolveScene } from "@hyperstage/core";
import type { CameraNode, GoalNode, LightNode, SceneAST, SpawnNode, Vec3 } from "@hyperstage/core";
import type { FrameSnapshot } from "@hyperstage/spatial-linter";

/** Raw ES module sources inlined into the exported file so it runs offline. */
export interface ThreeSources {
  /** three/build/three.core.min.js */
  core: string;
  /** three/build/three.module.min.js (imports ./three.core.min.js) */
  module: string;
  /** three/examples/jsm/controls/OrbitControls.js (imports 'three') */
  orbitControls: string;
}

export interface ExportSceneOptions {
  scene: SceneAST;
  frames: FrameSnapshot[];
  navPath: Vec3[];
  title?: string;
  three: ThreeSources;
}

export interface ExportedMesh {
  id: string;
  kind: "box" | "sphere" | "cylinder" | "ramp";
  body: string;
  dims: number[];
  position: Vec3;
  quaternion: [number, number, number, number];
  color: string;
  metalness: number;
  roughness: number;
  opacity: number;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** UTF-8 -> base64 that works identically in Node and browsers. */
export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const out: string[] = [];
  let chunk = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;
    chunk +=
      (B64[(triple >> 18) & 63] ?? "") +
      (B64[(triple >> 12) & 63] ?? "") +
      (i + 1 < bytes.length ? (B64[(triple >> 6) & 63] ?? "") : "=") +
      (i + 2 < bytes.length ? (B64[triple & 63] ?? "") : "=");
    if (chunk.length >= 8192) {
      out.push(chunk);
      chunk = "";
    }
  }
  out.push(chunk);
  return out.join("");
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;",
  );
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** Bakes resolved transforms + materials for every geometry node. */
export function bakeMeshes(scene: SceneAST): ExportedMesh[] {
  const resolved = resolveScene(scene);
  return resolved.geometry.map((g) => {
    const node = g.node;
    const dims =
      node.kind === "sphere"
        ? [node.radius]
        : node.kind === "cylinder"
          ? [node.radiusTop, node.radiusBottom, node.height]
          : [node.size[0], node.size[1], node.size[2]];
    return {
      id: g.id,
      kind: node.kind,
      body: bodyKindOf(node),
      dims,
      position: g.center,
      quaternion: g.quaternion,
      color: node.material?.color ?? "#8a8f98",
      metalness: node.material?.metalness ?? 0.1,
      roughness: node.material?.roughness ?? 0.8,
      opacity: node.material?.opacity ?? 1,
    };
  });
}

const RUNTIME = String.raw`
const DATA = JSON.parse(document.getElementById("hs-data").textContent);
function decode(id) {
  const bin = atob(document.getElementById(id).textContent.trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
const blobUrl = (src) => URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
const coreUrl = blobUrl(decode("hs-three-core"));
const moduleUrl = blobUrl(decode("hs-three-module").replace(/(["'])\.\/three\.core(?:\.min)?\.js\1/g, JSON.stringify(coreUrl)));
const orbitUrl = blobUrl(decode("hs-orbit").replace(/from\s*(["'])three\1/g, "from " + JSON.stringify(moduleUrl)));
const THREE = await import(moduleUrl);
const { OrbitControls } = await import(orbitUrl);

const canvasHost = document.getElementById("hs-stage");
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
canvasHost.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(DATA.skyColor);
scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x101218, 0.9));

const heroCam = DATA.cameras.find((c) => c.isHero) || DATA.cameras[0];
const camera = new THREE.PerspectiveCamera(heroCam ? heroCam.fov || 50 : 50, window.innerWidth / window.innerHeight, 0.05, 500);
camera.position.fromArray(heroCam ? heroCam.position : [12, 9, 12]);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.fromArray(heroCam ? heroCam.target : [0, 1, 0]);
controls.update();

for (const l of DATA.lights) {
  const color = new THREE.Color(l.color || "#ffffff");
  if (l.castShadow) {
    const light = new THREE.DirectionalLight(color, l.intensity);
    light.position.fromArray(l.position);
    light.castShadow = true;
    light.shadow.mapSize.set(2048, 2048);
    const s = 20;
    Object.assign(light.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 0.5, far: 80 });
    scene.add(light);
  } else {
    const light = new THREE.PointLight(color, l.intensity * 4, 0, 0.6);
    light.position.fromArray(l.position);
    scene.add(light);
  }
}

const meshes = new Map();
const solids = [];
for (const m of DATA.meshes) {
  let geometry;
  if (m.kind === "sphere") geometry = new THREE.SphereGeometry(m.dims[0], 32, 16);
  else if (m.kind === "cylinder") geometry = new THREE.CylinderGeometry(m.dims[0], m.dims[1], m.dims[2], 32);
  else geometry = new THREE.BoxGeometry(m.dims[0], m.dims[1], m.dims[2]);
  const material = new THREE.MeshStandardMaterial({
    color: m.color, metalness: m.metalness, roughness: m.roughness,
    transparent: m.opacity < 1, opacity: m.opacity,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.fromArray(m.position);
  mesh.quaternion.fromArray(m.quaternion);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.home = { p: mesh.position.clone(), q: mesh.quaternion.clone() };
  scene.add(mesh);
  meshes.set(m.id, mesh);
  solids.push(mesh);
}

if (DATA.navPath.length > 1) {
  const pts = DATA.navPath.map((p) => new THREE.Vector3(p[0], p[1] + 0.06, p[2]));
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x22d3ee }));
  scene.add(line);
}
if (DATA.goal) {
  const ring = new THREE.Mesh(new THREE.TorusGeometry(DATA.goal.radius, 0.05, 12, 48), new THREE.MeshBasicMaterial({ color: 0x22d3ee }));
  ring.rotation.x = Math.PI / 2;
  ring.position.fromArray(DATA.goal.position);
  scene.add(ring);
}

// Player for WASD walk mode.
const player = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.9, 6, 16), new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0x3b1d00 }));
player.castShadow = true;
player.visible = false;
scene.add(player);
const spawn = DATA.spawn ? DATA.spawn.position : [0, 2, 0];
const state = { frame: 0, playing: true, walk: false, vel: new THREE.Vector3(), grounded: false, keys: new Set() };
player.position.set(spawn[0], spawn[1] + 0.75, spawn[2]);

const hud = document.getElementById("hs-frame");
const playBtn = document.getElementById("hs-play");
const walkBtn = document.getElementById("hs-walk");
const scrub = document.getElementById("hs-scrub");
scrub.max = String(Math.max(0, DATA.frames.length - 1));
playBtn.onclick = () => { state.playing = !state.playing; playBtn.textContent = state.playing ? "Pause" : "Play"; };
scrub.oninput = () => { state.playing = false; playBtn.textContent = "Play"; state.frame = Number(scrub.value); applyFrame(state.frame); };
const toggleWalk = () => {
  state.walk = !state.walk;
  player.visible = state.walk;
  walkBtn.textContent = state.walk ? "Exit walk mode" : "Walk mode (WASD)";
  if (state.walk) { player.position.set(spawn[0], spawn[1] + 0.75, spawn[2]); state.vel.set(0, 0, 0); }
};
walkBtn.onclick = toggleWalk;
window.addEventListener("keydown", (e) => {
  if (e.code === "KeyF") toggleWalk();
  state.keys.add(e.code);
  if (state.walk && e.code === "Space") e.preventDefault();
});
window.addEventListener("keyup", (e) => state.keys.delete(e.code));

function applyFrame(index) {
  const frame = DATA.frames[index];
  hud.textContent = "frame " + String(index + 1).padStart(3, "0") + " / " + DATA.frames.length + (frame ? "  t=" + frame.timeSec.toFixed(2) + "s" : "");
  if (!frame) return;
  for (const [id, tr] of Object.entries(frame.transforms)) {
    const mesh = meshes.get(id);
    if (!mesh) continue;
    mesh.position.fromArray(tr.position);
    mesh.quaternion.fromArray(tr.quaternion);
  }
}

const ray = new THREE.Raycaster();
const down = new THREE.Vector3(0, -1, 0);
function stepPlayer(dt) {
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  forward.y = 0; forward.normalize();
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));
  const wish = new THREE.Vector3();
  if (state.keys.has("KeyW")) wish.add(forward);
  if (state.keys.has("KeyS")) wish.sub(forward);
  if (state.keys.has("KeyD")) wish.add(right);
  if (state.keys.has("KeyA")) wish.sub(right);
  if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(5);
  state.vel.x = wish.x; state.vel.z = wish.z;
  if (state.grounded && state.keys.has("Space")) { state.vel.y = 6.2; state.grounded = false; }
  state.vel.y += DATA.gravity[1] * dt;
  const before = player.position.clone();
  const horizontal = new THREE.Vector3(state.vel.x * dt, 0, state.vel.z * dt);
  if (horizontal.lengthSq() > 0) {
    ray.set(before.clone().add(new THREE.Vector3(0, -0.2, 0)), horizontal.clone().normalize());
    ray.far = horizontal.length() + 0.3;
    if (ray.intersectObjects(solids, false).length === 0) player.position.add(horizontal);
  }
  player.position.y += state.vel.y * dt;
  ray.set(new THREE.Vector3(player.position.x, player.position.y + 0.2, player.position.z), down);
  ray.far = 50;
  const hit = ray.intersectObjects(solids, false)[0];
  const feet = player.position.y - 0.75;
  if (hit && state.vel.y <= 0 && feet <= hit.point.y + 0.05 && feet >= hit.point.y - 0.6) {
    player.position.y = hit.point.y + 0.75; state.vel.y = 0; state.grounded = true;
  } else if (!hit || feet > hit.point.y + 0.05) {
    state.grounded = false;
  }
  if (player.position.y < -15) { player.position.set(spawn[0], spawn[1] + 0.75, spawn[2]); state.vel.set(0, 0, 0); }
  const delta = player.position.clone().sub(controls.target);
  controls.target.add(delta);
  camera.position.add(delta);
  if (DATA.goal && player.position.distanceTo(new THREE.Vector3().fromArray(DATA.goal.position)) < DATA.goal.radius + 0.8) {
    hud.textContent = "GOAL REACHED";
  }
}

let last = performance.now();
let acc = 0;
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (state.playing && DATA.frames.length > 0) {
    acc += dt;
    while (acc >= 1 / 60) { acc -= 1 / 60; state.frame = (state.frame + 1) % DATA.frames.length; }
    scrub.value = String(state.frame);
    applyFrame(state.frame);
  }
  if (state.walk) stepPlayer(dt);
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
applyFrame(0);
requestAnimationFrame(loop);
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
document.body.dataset.ready = "true";
`;

/**
 * Compiles a scene + pre-baked Rapier rollout into one self-contained HTML file:
 * three.js and OrbitControls are inlined (base64 ES modules loaded through blob URLs),
 * the 180-frame simulation is embedded as JSON, and WASD walk mode is built in.
 */
export function exportSceneHtml(options: ExportSceneOptions): string {
  const { scene, frames, navPath, three } = options;
  const title = options.title ?? scene.name;
  const data = {
    title,
    skyColor: scene.skyColor,
    gravity: scene.gravity,
    meshes: bakeMeshes(scene),
    cameras: scene.nodes.filter((n): n is CameraNode => n.kind === "camera"),
    lights: scene.nodes.filter((n): n is LightNode => n.kind === "light"),
    spawn: scene.nodes.find((n): n is SpawnNode => n.kind === "spawn") ?? null,
    goal: scene.nodes.find((n): n is GoalNode => n.kind === "goal") ?? null,
    frames,
    navPath,
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="generator" content="HyperStage 1.1.0" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #08090a; color: #e6e8ec; font: 13px/1.4 ui-sans-serif, system-ui, sans-serif; overflow: hidden; }
  #hs-stage { position: fixed; inset: 0; }
  #hs-bar { position: fixed; left: 12px; right: 12px; bottom: 12px; display: flex; gap: 10px; align-items: center; padding: 8px 12px;
    background: rgba(14,16,19,0.86); border: 1px solid rgba(255,255,255,0.07); border-radius: 10px; backdrop-filter: blur(8px); }
  #hs-bar button { background: #16181d; color: #e6e8ec; border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; padding: 5px 10px; cursor: pointer; }
  #hs-bar input[type=range] { flex: 1; accent-color: #22d3ee; }
  #hs-title { position: fixed; top: 12px; left: 12px; padding: 6px 10px; border-radius: 8px; background: rgba(14,16,19,0.86); border: 1px solid rgba(255,255,255,0.07); }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #9aa3b2; }
</style>
</head>
<body>
<div id="hs-stage"></div>
<div id="hs-title">${escapeHtml(title)} <span class="mono">· HyperStage · F = walk mode</span></div>
<div id="hs-bar">
  <button id="hs-play" type="button">Pause</button>
  <input id="hs-scrub" type="range" min="0" max="0" value="0" />
  <span id="hs-frame" class="mono">frame 001</span>
  <button id="hs-walk" type="button">Walk mode (WASD)</button>
</div>
<script type="application/json" id="hs-data">${safeJson(data)}</script>
<script type="text/plain" id="hs-three-core">${toBase64(three.core)}</script>
<script type="text/plain" id="hs-three-module">${toBase64(three.module)}</script>
<script type="text/plain" id="hs-orbit">${toBase64(three.orbitControls)}</script>
<script type="module">${RUNTIME}</script>
</body>
</html>
`;
}
