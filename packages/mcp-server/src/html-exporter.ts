import { bodyKindOf, buildSceneMeshes, meshTriangleCount, resolveScene } from "@hyperstage/core";
import type { CameraNode, GeometryKind, GoalNode, LightNode, ResolvedGeometry, SceneAST, SpawnNode, Vec3 } from "@hyperstage/core";
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

export interface MeshBufferRange {
  /** Byte offset into the packed mesh binary (always 4-byte aligned). */
  byteOffset: number;
  /** Element count (floats for positions/normals, uint32 for indices). */
  length: number;
}

export interface ExportedMesh {
  id: string;
  kind: GeometryKind;
  body: string;
  /** Primitive dimensions (v1 field; the runtime renders `positions/normals/indices` instead). */
  dims: number[];
  position: Vec3;
  quaternion: [number, number, number, number];
  color: string;
  metalness: number;
  roughness: number;
  opacity: number;
  emissive: string;
  emissiveIntensity: number;
  transparent: boolean;
  triangles: number;
  /** Local-frame mesh ranges inside the packed binary (`hs-mesh-bin`). */
  positions: MeshBufferRange;
  normals: MeshBufferRange;
  indices: MeshBufferRange;
}

export interface BakedMeshes {
  meshes: ExportedMesh[];
  /** Concatenated little-endian Float32 positions, Float32 normals and Uint32 indices of every mesh. */
  binary: Uint8Array;
  /** World-space AABB of all geometry (null for scenes without geometry). */
  bounds: { min: Vec3; max: Vec3 } | null;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Bytes -> base64 that works identically in Node and browsers. */
export function bytesToBase64(bytes: Uint8Array): string {
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

/** UTF-8 -> base64 that works identically in Node and browsers. */
export function toBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

function primitiveDims(g: ResolvedGeometry): number[] {
  const node = g.node;
  if (node.kind === "sphere") return [node.radius];
  if (node.kind === "cylinder") return [node.radiusTop, node.radiusBottom, node.height];
  if (node.kind === "box" || node.kind === "ramp") return [node.size[0], node.size[1], node.size[2]];
  return [g.localHalf[0] * 2, g.localHalf[1] * 2, g.localHalf[2] * 2];
}

/**
 * Bakes every geometry node into real triangle meshes (core mesh builder, CSG included) in the
 * node's local frame, with resolved PBR materials and the resolved world transform.
 */
export function bakeMeshData(scene: SceneAST): BakedMeshes {
  const resolved = resolveScene(scene);
  const sceneMeshes = buildSceneMeshes(resolved);
  const byId = new Map(resolved.geometry.map((g) => [g.id, g]));
  let totalBytes = 0;
  for (const m of sceneMeshes) totalBytes += (m.local.positions.length + m.local.normals.length + m.local.indices.length) * 4;
  const buffer = new ArrayBuffer(totalBytes);
  const view = new DataView(buffer);
  let offset = 0;
  const writeFloats = (values: Float32Array): MeshBufferRange => {
    const range = { byteOffset: offset, length: values.length };
    for (const v of values) {
      view.setFloat32(offset, v, true);
      offset += 4;
    }
    return range;
  };
  const writeUints = (values: Uint32Array): MeshBufferRange => {
    const range = { byteOffset: offset, length: values.length };
    for (const v of values) {
      view.setUint32(offset, v, true);
      offset += 4;
    }
    return range;
  };
  let min: Vec3 | null = null;
  let max: Vec3 | null = null;
  const meshes = sceneMeshes.map((m): ExportedMesh => {
    const g = byId.get(m.id);
    const material = m.material;
    min = min === null ? [...m.bounds.min] : [Math.min(min[0], m.bounds.min[0]), Math.min(min[1], m.bounds.min[1]), Math.min(min[2], m.bounds.min[2])];
    max = max === null ? [...m.bounds.max] : [Math.max(max[0], m.bounds.max[0]), Math.max(max[1], m.bounds.max[1]), Math.max(max[2], m.bounds.max[2])];
    return {
      id: m.id,
      kind: m.node.kind,
      body: bodyKindOf(m.node),
      dims: g === undefined ? [] : primitiveDims(g),
      position: m.center,
      quaternion: m.quaternion,
      color: material.color,
      metalness: material.metalness,
      roughness: material.roughness,
      opacity: material.opacity,
      emissive: material.emissive,
      emissiveIntensity: material.emissiveIntensity,
      transparent: material.transparent,
      triangles: meshTriangleCount(m.local),
      positions: writeFloats(m.local.positions),
      normals: writeFloats(m.local.normals),
      indices: writeUints(m.local.indices),
    };
  });
  const bounds = min !== null && max !== null ? { min, max } : null;
  return { meshes, binary: new Uint8Array(buffer), bounds };
}

/** Bakes resolved transforms, materials and mesh ranges for every geometry node. */
export function bakeMeshes(scene: SceneAST): ExportedMesh[] {
  return bakeMeshData(scene).meshes;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;",
  );
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export const HYPERSTAGE_VERSION = "2.0.0";
export const HYPERSTAGE_REPO_URL = "https://github.com/kakarot700/hyperstage";

const RUNTIME = String.raw`
const DATA = JSON.parse(document.getElementById("hs-data").textContent);
function decode(id) {
  const bin = atob(document.getElementById(id).textContent.trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function decodeBytes(id) {
  const bin = atob(document.getElementById(id).textContent.trim());
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
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

const meshBin = decodeBytes("hs-mesh-bin");
const meshes = new Map();
const solids = [];
for (const m of DATA.meshes) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(meshBin.buffer, m.positions.byteOffset, m.positions.length), 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(meshBin.buffer, m.normals.byteOffset, m.normals.length), 3));
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(meshBin.buffer, m.indices.byteOffset, m.indices.length), 1));
  geometry.computeBoundingSphere();
  const material = new THREE.MeshStandardMaterial({
    color: m.color, metalness: m.metalness, roughness: m.roughness,
    emissive: m.emissive, emissiveIntensity: m.emissiveIntensity,
    transparent: m.transparent, opacity: m.opacity, depthWrite: !m.transparent,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = m.id;
  mesh.position.fromArray(m.position);
  mesh.quaternion.fromArray(m.quaternion);
  mesh.castShadow = !m.transparent;
  mesh.receiveShadow = true;
  mesh.userData.home = { p: mesh.position.clone(), q: mesh.quaternion.clone() };
  scene.add(mesh);
  meshes.set(m.id, mesh);
  solids.push(mesh);
}

// Camera presets: Hero (scene hero camera), Top, Iso, framed on the geometry bounds.
const bmin = DATA.bounds ? new THREE.Vector3().fromArray(DATA.bounds.min) : new THREE.Vector3(-5, 0, -5);
const bmax = DATA.bounds ? new THREE.Vector3().fromArray(DATA.bounds.max) : new THREE.Vector3(5, 2, 5);
const center = bmin.clone().add(bmax).multiplyScalar(0.5);
const radius = Math.max(0.05, bmax.clone().sub(bmin).length() / 2);
const span = radius / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
const VIEWS = {
  hero: heroCam
    ? { position: new THREE.Vector3().fromArray(heroCam.position), target: new THREE.Vector3().fromArray(heroCam.target) }
    : { position: center.clone().add(new THREE.Vector3(0.6, 0.45, 1).normalize().multiplyScalar(span * 1.1)), target: center.clone() },
  top: { position: center.clone().add(new THREE.Vector3(0, span * 1.15, 0.001)), target: center.clone() },
  iso: { position: center.clone().add(new THREE.Vector3(1, 0.82, 1).normalize().multiplyScalar(span * 1.15)), target: center.clone() },
};
camera.near = Math.max(0.001, radius / 500);
camera.far = Math.max(500, radius * 20);
camera.updateProjectionMatrix();
function setView(name) {
  const v = VIEWS[name];
  if (!v) return;
  camera.position.copy(v.position);
  controls.target.copy(v.target);
  controls.update();
  for (const btn of document.querySelectorAll("[data-view]")) btn.classList.toggle("on", btn.dataset.view === name);
}
for (const btn of document.querySelectorAll("[data-view]")) btn.onclick = () => setView(btn.dataset.view);
setView("hero");

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
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === "KeyF") toggleWalk();
  if (!state.walk && ["KeyW", "KeyA", "KeyS", "KeyD"].includes(e.code)) toggleWalk();
  if (e.code === "KeyP") playBtn.onclick();
  if (e.code === "Digit1") setView("hero");
  if (e.code === "Digit2") setView("top");
  if (e.code === "Digit3") setView("iso");
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
 * real triangle meshes (all geometry kinds, CSG included) are embedded as packed binary with
 * resolved PBR materials, the 180-frame simulation is embedded as JSON with play/pause and a
 * scrubber, and WASD + Space walk mode, Hero/Top/Iso camera presets and a repo badge are built in.
 */
export function exportSceneHtml(options: ExportSceneOptions): string {
  const { scene, frames, navPath, three } = options;
  const title = options.title ?? scene.name;
  const baked = bakeMeshData(scene);
  const data = {
    title,
    skyColor: scene.skyColor,
    gravity: scene.gravity,
    meshes: baked.meshes,
    bounds: baked.bounds,
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
<meta name="generator" content="HyperStage ${HYPERSTAGE_VERSION}" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #08090a; color: #e6e8ec; font: 13px/1.4 ui-sans-serif, system-ui, sans-serif; overflow: hidden; }
  #hs-stage { position: fixed; inset: 0; }
  #hs-bar { position: fixed; left: 12px; right: 190px; bottom: 12px; display: flex; gap: 10px; align-items: center; padding: 8px 12px;
    background: rgba(14,16,19,0.86); border: 1px solid rgba(255,255,255,0.07); border-radius: 10px; backdrop-filter: blur(8px); }
  #hs-bar button { background: #16181d; color: #e6e8ec; border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; padding: 5px 10px; cursor: pointer; }
  #hs-bar input[type=range] { flex: 1; accent-color: #22d3ee; }
  #hs-title { position: fixed; top: 12px; left: 12px; padding: 6px 10px; border-radius: 8px; background: rgba(14,16,19,0.86); border: 1px solid rgba(255,255,255,0.07); }
  #hs-views { position: fixed; top: 12px; right: 12px; display: flex; gap: 4px; padding: 4px; border-radius: 9px; background: rgba(14,16,19,0.86); border: 1px solid rgba(255,255,255,0.07); }
  #hs-views button { background: transparent; color: #9aa3b2; border: 0; border-radius: 6px; padding: 5px 10px; cursor: pointer; font: inherit; }
  #hs-views button.on { background: #22262e; color: #e6e8ec; }
  #hs-badge { position: fixed; right: 12px; bottom: 18px; padding: 5px 9px; border-radius: 999px; font-size: 11px; letter-spacing: 0.02em; color: #9aa3b2; text-decoration: none;
    background: rgba(14,16,19,0.72); border: 1px solid rgba(255,255,255,0.07); opacity: 0.75; transition: opacity 0.15s, color 0.15s; }
  #hs-badge:hover { opacity: 1; color: #22d3ee; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #9aa3b2; }
</style>
</head>
<body>
<div id="hs-stage"></div>
<div id="hs-title">${escapeHtml(title)} <span class="mono">· WASD / F = walk · Space = jump · P = play · 1-3 = views</span></div>
<div id="hs-views">
  <button type="button" data-view="hero">Hero</button>
  <button type="button" data-view="top">Top</button>
  <button type="button" data-view="iso">Iso</button>
</div>
<div id="hs-bar">
  <button id="hs-play" type="button">Pause</button>
  <input id="hs-scrub" type="range" min="0" max="0" value="0" />
  <span id="hs-frame" class="mono">frame 001</span>
  <button id="hs-walk" type="button">Walk mode (WASD)</button>
</div>
<a id="hs-badge" href="${HYPERSTAGE_REPO_URL}" target="_blank" rel="noopener noreferrer">Built with HyperStage</a>
<script type="application/json" id="hs-data">${safeJson(data)}</script>
<script type="text/plain" id="hs-mesh-bin">${bytesToBase64(baked.binary)}</script>
<script type="text/plain" id="hs-three-core">${toBase64(three.core)}</script>
<script type="text/plain" id="hs-three-module">${toBase64(three.module)}</script>
<script type="text/plain" id="hs-orbit">${toBase64(three.orbitControls)}</script>
<script type="module">${RUNTIME}</script>
</body>
</html>
`;
}
