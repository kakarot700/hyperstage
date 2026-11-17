import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { bodyKindOf } from "@hyperstage/core";
import type { GeometryNode, GoalNode, LightNode, ResolvedScene, SceneAST, SceneNode, SpawnNode, Vec3 } from "@hyperstage/core";
import type { LintReport } from "@hyperstage/spatial-linter";
import { cameraPose, easeInOutCubic, focusDistance } from "../lib/cameraRig";
import type { CameraMode } from "../lib/cameraRig";
import type { FixGhost } from "../lib/fixPreview";

export type CameraCommand = CameraMode | "reset";

export interface Viewport3DProps {
  scene: SceneAST | null;
  resolved: ResolvedScene | null;
  report: LintReport | null;
  frameIndex: number;
  /** Incremented when the auto-fixer produced a new scene: meshes tween to their repaired transforms. */
  transitionKey: number;
  /** Incremented when a different preset is loaded: the camera jumps to the hero camera. */
  presetKey: number;
  xray: boolean;
  trails: boolean;
  navmesh: boolean;
  walkMode: boolean;
  selectedId: string | null;
  onSelect: (nodeId: string | null) => void;
  /** Fly the camera to a node; `nonce` changes on every request. */
  focusRequest: { nodeId: string; nonce: number } | null;
  /** Camera switcher request from outside the viewport (command palette, R key). */
  cameraRequest: { command: CameraCommand; nonce: number } | null;
  /** Translucent Preview Fix ghost, or null. */
  ghost: FixGhost | null;
  onGoalReached?: () => void;
}

/** Linear-space HDR colours above the bloom threshold so only signal geometry glows. */
const HDR = {
  cyan: new THREE.Color(0x38bdf8).multiplyScalar(2.6),
  cyanSoft: new THREE.Color(0x22d3ee).multiplyScalar(1.4),
  emerald: new THREE.Color(0x10b981).multiplyScalar(2.4),
  crimson: new THREE.Color(0xf43f5e).multiplyScalar(2.6),
  amber: new THREE.Color(0xf59e0b).multiplyScalar(2.2),
  indigo: new THREE.Color(0x7170ff).multiplyScalar(1.9),
};

const BLOOM = { strength: 0.35, radius: 0.55, threshold: 0.85 } as const;
const ENV_INTENSITY = 0.45;
const FOG_DENSITY = 0.018;
const BG = 0x08090a;
const TWEEN_MS = 950;
const FLY_MS = 720;

interface Tween {
  start: number;
  duration: number;
  from: Map<string, { p: THREE.Vector3; q: THREE.Quaternion }>;
}

interface Flight {
  start: number;
  duration: number;
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  fromZoom: number;
  toZoom: number;
}

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function isGeometryNode(node: SceneNode): node is GeometryNode {
  return node.kind === "box" || node.kind === "sphere" || node.kind === "cylinder" || node.kind === "ramp";
}

function geometryFor(node: GeometryNode): THREE.BufferGeometry {
  switch (node.kind) {
    case "sphere":
      return new THREE.SphereGeometry(node.radius, 40, 20);
    case "cylinder":
      return new THREE.CylinderGeometry(node.radiusTop, node.radiusBottom, node.height, 40);
    case "box":
    case "ramp":
      return new THREE.BoxGeometry(node.size[0], node.size[1], node.size[2]);
  }
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.Line || obj instanceof THREE.LineSegments || obj instanceof THREE.Points) {
      obj.geometry.dispose();
      const material = obj.material as THREE.Material | THREE.Material[];
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material.dispose();
    }
  });
}

function disposeGroup(group: THREE.Object3D): void {
  disposeObject(group);
  group.clear();
}

const toV = (v: Vec3): THREE.Vector3 => new THREE.Vector3(v[0], v[1], v[2]);

/** Infinite fade grid: analytic anti-aliased lines, faded into the fog horizon. */
function createInfiniteGrid(): THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uMinor: { value: new THREE.Color(0x1c1f26) },
      uMajor: { value: new THREE.Color(0x2b303b) },
      uCamera: { value: new THREE.Vector3() },
      uDensity: { value: FOG_DENSITY },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uMinor;
      uniform vec3 uMajor;
      uniform vec3 uCamera;
      uniform float uDensity;
      varying vec3 vWorld;
      float gridLine(vec2 p, float size, float width) {
        vec2 c = p / size;
        vec2 d = fwidth(c);
        vec2 g = abs(fract(c - 0.5) - 0.5) / max(d * width, vec2(1e-4));
        return 1.0 - min(min(g.x, g.y), 1.0);
      }
      void main() {
        float minor = gridLine(vWorld.xz, 1.0, 1.0);
        float major = gridLine(vWorld.xz, 10.0, 1.4);
        float dist = distance(uCamera, vWorld);
        float fog = 1.0 - exp(-uDensity * uDensity * dist * dist);
        // Minor lines dissolve before they alias into moire at grazing angles.
        float minorFade = 1.0 - smoothstep(18.0, 60.0, dist);
        float alpha = max(minor * minorFade * 0.85, major);
        alpha *= (1.0 - fog);
        if (alpha < 0.003) discard;
        gl_FragColor = vec4(mix(uMinor, uMajor, major), alpha);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(600, 600, 1, 1), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -0.003;
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  return mesh;
}

/** A solid tube arrow (shaft + head) so error vectors read at any zoom and catch bloom. */
function createArrow(origin: THREE.Vector3, direction: THREE.Vector3, length: number, color: THREE.Color): THREE.Group {
  const group = new THREE.Group();
  const material = new THREE.MeshBasicMaterial({ color, toneMapped: true, depthTest: false, transparent: true, opacity: 0.95 });
  const head = Math.min(0.32, length * 0.35);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, length - head, 10), material);
  shaft.position.y = (length - head) / 2;
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.11, head, 16), material.clone());
  cone.position.y = length - head / 2;
  group.add(shaft, cone);
  group.position.copy(origin);
  group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize());
  group.renderOrder = 12;
  group.traverse((o) => {
    o.renderOrder = 12;
  });
  return group;
}

class StageController {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly perspective = new THREE.PerspectiveCamera(50, 1, 0.05, 600);
  readonly ortho = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.05, 800);
  private active: THREE.PerspectiveCamera | THREE.OrthographicCamera = this.perspective;
  private orthoHalfHeight = 10;
  readonly controls: OrbitControls;
  private readonly composer: EffectComposer;
  private readonly renderPass: RenderPass;
  private readonly bloomPass: UnrealBloomPass;
  private readonly outputPass: OutputPass;
  private readonly pmrem: THREE.PMREMGenerator;
  private readonly envTarget: THREE.WebGLRenderTarget;
  private readonly grid: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly meshes = new Map<string, THREE.Mesh>();
  private readonly home = new Map<string, { p: THREE.Vector3; q: THREE.Quaternion }>();
  private readonly world = new THREE.Group();
  private readonly lights = new THREE.Group();
  private readonly trailGroup = new THREE.Group();
  private readonly navGroup = new THREE.Group();
  private readonly markerGroup = new THREE.Group();
  private readonly errorGroup = new THREE.Group();
  private readonly ghostGroup = new THREE.Group();
  private readonly selectionGroup = new THREE.Group();
  private readonly player: THREE.Mesh;
  private readonly resizeObserver: ResizeObserver;
  private readonly keys = new Set<string>();
  private readonly velocity = new THREE.Vector3();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerDown = new THREE.Vector2();
  private sceneAst: SceneAST | null = null;
  private resolved: ResolvedScene | null = null;
  private grounded = false;
  private spawn = new THREE.Vector3(0, 1, 0);
  private goal: GoalNode | null = null;
  private goalRing: THREE.Mesh | null = null;
  private report: LintReport | null = null;
  private frameIndex = 0;
  private tween: Tween | null = null;
  private flight: Flight | null = null;
  private selected: string | null = null;
  private xray = false;
  private walk = false;
  private raf = 0;
  private last = performance.now();
  private goalReachedFired = false;
  private disposed = false;
  gravityY = -9.81;
  onGoalReached: (() => void) | undefined;
  onSelect: ((id: string | null) => void) | undefined;
  onCameraMode: ((mode: CameraMode) => void) | undefined;

  constructor(private readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.dataset.testid = "viewport-canvas";
    host.appendChild(this.renderer.domElement);

    // Procedural studio HDRI so metals and rough plastics pick up specular rims.
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.envTarget = this.pmrem.fromScene(room, 0.04);
    disposeObject(room);
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = ENV_INTENSITY;

    this.scene.background = new THREE.Color(BG);
    this.scene.fog = new THREE.FogExp2(BG, FOG_DENSITY);
    this.scene.add(new THREE.HemisphereLight(0xc7d2fe, 0x0b0c10, 0.55));
    this.grid = createInfiniteGrid();
    this.scene.add(this.grid, this.world, this.lights, this.trailGroup, this.navGroup, this.markerGroup, this.errorGroup, this.ghostGroup, this.selectionGroup);

    this.player = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.3, 0.9, 6, 16),
      new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0x3b1d00, roughness: 0.4 }),
    );
    this.player.castShadow = true;
    this.player.visible = false;
    this.scene.add(this.player);

    this.controls = new OrbitControls(this.perspective, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.screenSpacePanning = true;

    // Strict pass order: RenderPass -> UnrealBloomPass -> OutputPass (ACES tone map + sRGB).
    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.perspective);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(256, 256), BLOOM.strength, BLOOM.radius, BLOOM.threshold);
    this.outputPass = new OutputPass();
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.outputPass);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.addEventListener("pointerup", this.onPointerUp);
    this.renderer.domElement.addEventListener("dblclick", this.onDoubleClick);
    this.raf = requestAnimationFrame(this.loop);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.walk) return;
    const target = event.target as HTMLElement | null;
    if (target !== null && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) return;
    this.keys.add(event.code);
    if (event.code === "Space" || event.code.startsWith("Arrow")) event.preventDefault();
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private pick(event: MouseEvent): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.active);
    this.raycaster.far = Infinity;
    const hit = this.raycaster.intersectObjects([...this.meshes.values()], false)[0];
    return hit?.object.name ?? null;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.pointerDown.set(event.clientX, event.clientY);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.walk || event.button !== 0) return;
    if (Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y) > 4) return;
    this.onSelect?.(this.pick(event));
  };

  private readonly onDoubleClick = (event: MouseEvent): void => {
    if (this.walk) return;
    const id = this.pick(event);
    if (id === null) return;
    this.onSelect?.(id);
    this.focusNode(id);
  };

  private resize(): void {
    if (this.disposed) return;
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    const ratio = Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height, true);
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(width, height);
    this.perspective.aspect = width / height;
    this.perspective.updateProjectionMatrix();
    this.updateOrthoFrustum();
  }

  private updateOrthoFrustum(): void {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    const aspect = width / height;
    const h = this.orthoHalfHeight;
    this.ortho.left = -h * aspect;
    this.ortho.right = h * aspect;
    this.ortho.top = h;
    this.ortho.bottom = -h;
    this.ortho.updateProjectionMatrix();
  }

  private useCamera(camera: THREE.PerspectiveCamera | THREE.OrthographicCamera): void {
    this.active = camera;
    this.controls.object = camera;
    this.renderPass.camera = camera;
  }

  /** Camera switcher: Hero flies (perspective); Top/Iso cut to orthographic; Reset snaps to hero and clears selection. */
  setCameraMode(command: CameraCommand): void {
    if (this.sceneAst === null || this.resolved === null) return;
    if (command === "reset") {
      this.flight = null;
      this.applyHero(false);
      this.onSelect?.(null);
      this.onCameraMode?.("hero");
      return;
    }
    if (command === "hero") {
      this.applyHero(true);
      this.onCameraMode?.("hero");
      return;
    }
    const pose = cameraPose(command, this.sceneAst, this.resolved);
    this.flight = null;
    this.orthoHalfHeight = pose.orthoHalfHeight;
    this.ortho.zoom = 1;
    this.ortho.position.copy(toV(pose.position));
    this.ortho.up.set(0, 1, 0);
    this.ortho.lookAt(toV(pose.target));
    this.updateOrthoFrustum();
    this.useCamera(this.ortho);
    this.controls.target.copy(toV(pose.target));
    this.controls.update();
    this.onCameraMode?.(command);
  }

  private applyHero(animate: boolean): void {
    if (this.sceneAst === null || this.resolved === null) return;
    const pose = cameraPose("hero", this.sceneAst, this.resolved);
    const wasOrtho = this.active !== this.perspective;
    this.perspective.fov = pose.fov;
    this.perspective.updateProjectionMatrix();
    this.useCamera(this.perspective);
    if (animate && !wasOrtho) {
      this.startFlight(toV(pose.position), toV(pose.target), 1);
    } else {
      this.flight = null;
      this.perspective.position.copy(toV(pose.position));
      this.controls.target.copy(toV(pose.target));
      this.controls.update();
    }
  }

  private startFlight(toPos: THREE.Vector3, toTarget: THREE.Vector3, toZoom: number): void {
    this.flight = {
      start: performance.now(),
      duration: FLY_MS,
      fromPos: this.active.position.clone(),
      toPos,
      fromTarget: this.controls.target.clone(),
      toTarget,
      fromZoom: this.active.zoom,
      toZoom,
    };
  }

  /** Smoothly frames a node, keeping the current viewing direction. */
  focusNode(nodeId: string): void {
    const mesh = this.meshes.get(nodeId);
    let center: THREE.Vector3;
    let radius: number;
    if (mesh !== undefined) {
      const sphere = new THREE.Box3().setFromObject(mesh, true).getBoundingSphere(new THREE.Sphere());
      center = sphere.center;
      radius = Math.max(0.35, sphere.radius);
    } else {
      const node = this.sceneAst?.nodes.find((n) => n.id === nodeId);
      if (node === undefined || isGeometryNode(node)) return;
      center = toV(node.position);
      radius = node.kind === "goal" ? Math.max(0.6, node.radius) : 0.8;
    }
    const direction = this.active.position.clone().sub(this.controls.target);
    if (direction.lengthSq() < 1e-6) direction.set(1, 0.8, 1);
    direction.normalize();
    if (this.active === this.perspective) {
      const distance = focusDistance(radius, this.perspective.fov);
      this.startFlight(center.clone().add(direction.multiplyScalar(distance)), center, 1);
    } else {
      const keep = this.active.position.distanceTo(this.controls.target);
      const zoom = Math.min(40, Math.max(0.2, this.orthoHalfHeight / (radius * 1.8)));
      this.startFlight(center.clone().add(direction.multiplyScalar(keep)), center, zoom);
    }
  }

  setScene(scene: SceneAST | null, resolved: ResolvedScene | null, animate: boolean, resetCamera: boolean): void {
    const previous = new Map<string, { p: THREE.Vector3; q: THREE.Quaternion }>();
    for (const [id, mesh] of this.meshes) previous.set(id, { p: mesh.position.clone(), q: mesh.quaternion.clone() });
    disposeGroup(this.world);
    disposeGroup(this.lights);
    disposeGroup(this.markerGroup);
    this.meshes.clear();
    this.home.clear();
    this.goal = null;
    this.goalRing = null;
    this.sceneAst = scene;
    this.resolved = resolved;
    if (scene === null || resolved === null) return;

    const sky = new THREE.Color(scene.skyColor);
    this.scene.background = sky;
    if (this.scene.fog instanceof THREE.FogExp2) this.scene.fog.color.copy(sky);
    for (const g of resolved.geometry) {
      const node = g.node;
      const material = new THREE.MeshStandardMaterial({
        color: node.material?.color ?? "#8a8f98",
        metalness: node.material?.metalness ?? 0.1,
        roughness: node.material?.roughness ?? 0.8,
        transparent: (node.material?.opacity ?? 1) < 1,
        opacity: node.material?.opacity ?? 1,
      });
      const mesh = new THREE.Mesh(geometryFor(node), material);
      mesh.name = g.id;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.body = bodyKindOf(node);
      mesh.userData.baseOpacity = material.opacity;
      const p = toV(g.center);
      const q = new THREE.Quaternion(g.quaternion[0], g.quaternion[1], g.quaternion[2], g.quaternion[3]);
      mesh.position.copy(p);
      mesh.quaternion.copy(q);
      this.home.set(g.id, { p, q });

      // X-Ray collision proxy: OBB edges (or sphere wireframe) that ride along with the mesh.
      const wireGeometry =
        node.kind === "sphere"
          ? new THREE.WireframeGeometry(new THREE.SphereGeometry(node.radius, 12, 8))
          : new THREE.EdgesGeometry(new THREE.BoxGeometry(g.localHalf[0] * 2, g.localHalf[1] * 2, g.localHalf[2] * 2));
      const wire = new THREE.LineSegments(
        wireGeometry,
        new THREE.LineBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.9, depthTest: false }),
      );
      wire.name = "xray";
      wire.renderOrder = 10;
      wire.visible = this.xray;
      mesh.add(wire);

      this.world.add(mesh);
      this.meshes.set(g.id, mesh);
    }

    for (const node of scene.nodes) {
      if (node.kind === "light") this.addLight(node);
      if (node.kind === "spawn") this.addSpawn(node);
      if (node.kind === "goal") this.addGoal(node);
    }

    if (animate && previous.size > 0) {
      const from = new Map<string, { p: THREE.Vector3; q: THREE.Quaternion }>();
      for (const [id, mesh] of this.meshes) {
        const prev = previous.get(id);
        if (prev === undefined) continue;
        from.set(id, prev);
        mesh.position.copy(prev.p);
        mesh.quaternion.copy(prev.q);
      }
      this.tween = { start: performance.now(), duration: TWEEN_MS, from };
    } else {
      this.tween = null;
    }

    if (resetCamera) {
      this.applyHero(false);
      this.onCameraMode?.("hero");
    }
    this.applyXray();
    this.rebuildSelection();
  }

  private addLight(node: LightNode): void {
    const color = new THREE.Color(node.color ?? "#ffffff");
    if (node.castShadow === true) {
      const light = new THREE.DirectionalLight(color, node.intensity);
      light.position.set(node.position[0], node.position[1], node.position[2]);
      light.castShadow = true;
      light.shadow.mapSize.set(2048, 2048);
      const cam = light.shadow.camera;
      cam.left = -22;
      cam.right = 22;
      cam.top = 22;
      cam.bottom = -22;
      cam.near = 0.5;
      cam.far = 90;
      light.shadow.bias = -0.0004;
      light.shadow.normalBias = 0.02;
      this.lights.add(light, light.target);
    } else {
      const light = new THREE.PointLight(color, node.intensity * 4, 0, 0.6);
      light.position.set(node.position[0], node.position[1], node.position[2]);
      this.lights.add(light);
    }
  }

  private addSpawn(node: SpawnNode): void {
    this.spawn.set(node.position[0], node.position[1], node.position[2]);
    const disc = new THREE.Mesh(
      new THREE.RingGeometry(0.34, 0.5, 48),
      new THREE.MeshBasicMaterial({ color: HDR.amber, transparent: true, opacity: 0.95, side: THREE.DoubleSide }),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(node.position[0], node.position[1] - 0.08, node.position[2]);
    const beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 1.6, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: HDR.amber, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    beacon.position.set(node.position[0], node.position[1] + 0.72, node.position[2]);
    this.markerGroup.add(disc, beacon);
  }

  private addGoal(node: GoalNode): void {
    this.goal = node;
    this.goalReachedFired = false;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(node.radius, 0.06, 12, 64), new THREE.MeshBasicMaterial({ color: HDR.emerald }));
    ring.rotation.x = Math.PI / 2;
    ring.position.set(node.position[0], node.position[1], node.position[2]);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(node.radius * 0.9, node.radius * 0.9, 3, 32, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x10b981, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    beam.position.set(node.position[0], node.position[1] + 0.5, node.position[2]);
    this.goalRing = ring;
    this.markerGroup.add(ring, beam);
  }

  setReport(report: LintReport | null): void {
    this.report = report;
    disposeGroup(this.trailGroup);
    disposeGroup(this.navGroup);
    disposeGroup(this.errorGroup);
    const errorIds = new Set<string>();
    for (const d of report?.diagnostics ?? []) {
      errorIds.add(d.nodeId);
      if (d.relatedNodeId !== undefined && d.code === "E01_INTERPENETRATION") errorIds.add(d.relatedNodeId);
    }
    for (const [id, mesh] of this.meshes) {
      const wire = mesh.getObjectByName("xray");
      if (wire instanceof THREE.LineSegments) {
        (wire.material as THREE.LineBasicMaterial).color.set(errorIds.has(id) ? 0xf43f5e : 0x34d399);
      }
    }
    if (report === null) return;
    this.buildErrorVectors(report, errorIds);

    // Ghost trajectory trails for every moving body.
    const frames = report.frames;
    const ids = frames.length > 0 ? Object.keys(frames[0]?.transforms ?? {}) : [];
    for (const id of ids) {
      const points: THREE.Vector3[] = [];
      for (const frame of frames) {
        const tr = frame.transforms[id];
        if (tr !== undefined) points.push(toV(tr.position));
      }
      if (points.length < 2) continue;
      const first = points[0];
      const lastPoint = points[points.length - 1];
      if (first === undefined || lastPoint === undefined || first.distanceTo(lastPoint) < 0.02) continue;
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color: 0x818cf8, transparent: true, opacity: 0.85 }),
      );
      this.trailGroup.add(line);
      const source = this.meshes.get(id);
      if (source === undefined) continue;
      for (let i = 0; i < frames.length; i += 20) {
        const tr = frames[i]?.transforms[id];
        if (tr === undefined) continue;
        const ghost = new THREE.Mesh(
          source.geometry.clone(),
          new THREE.MeshBasicMaterial({ color: 0x818cf8, transparent: true, opacity: 0.1, depthWrite: false }),
        );
        ghost.position.set(tr.position[0], tr.position[1], tr.position[2]);
        ghost.quaternion.set(tr.quaternion[0], tr.quaternion[1], tr.quaternion[2], tr.quaternion[3]);
        this.trailGroup.add(ghost);
      }
    }

    // Glowing cyan A* NavMesh energy tube from spawn to goal.
    if (report.navPath.length > 1) {
      const pts = report.navPath.map((p) => new THREE.Vector3(p[0], p[1] + 0.09, p[2]));
      const curve = new THREE.CatmullRomCurve3(pts, false, "centripetal", 0.2);
      const segments = Math.max(32, pts.length * 12);
      const core = new THREE.Mesh(new THREE.TubeGeometry(curve, segments, 0.05, 8, false), new THREE.MeshBasicMaterial({ color: HDR.cyan }));
      const glow = new THREE.Mesh(
        new THREE.TubeGeometry(curve, segments, 0.17, 12, false),
        new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      this.navGroup.add(glow, core);
      for (const p of pts) {
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 8), new THREE.MeshBasicMaterial({ color: HDR.cyanSoft }));
        dot.position.copy(p);
        this.navGroup.add(dot);
      }
    }
  }

  /** Crimson E01–E04 vectors: outlines on offending solids plus arrows along the correction. */
  private buildErrorVectors(report: LintReport, errorIds: Set<string>): void {
    for (const id of errorIds) {
      const mesh = this.meshes.get(id);
      const g = this.resolved?.byId.get(id);
      if (mesh === undefined || g === undefined) continue;
      const box = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(g.localHalf[0] * 2 + 0.06, g.localHalf[1] * 2 + 0.06, g.localHalf[2] * 2 + 0.06)),
        new THREE.LineBasicMaterial({ color: HDR.crimson, transparent: true, opacity: 0.95, depthTest: false }),
      );
      box.renderOrder = 11;
      box.position.copy(mesh.position);
      box.quaternion.copy(mesh.quaternion);
      this.errorGroup.add(box);
    }
    for (const d of report.diagnostics) {
      const g = this.resolved?.byId.get(d.nodeId);
      if (d.code === "E01_INTERPENETRATION" && g !== undefined) {
        const mtv = new THREE.Vector3(d.metrics.mtvX ?? 0, d.metrics.mtvY ?? 0, d.metrics.mtvZ ?? 0);
        const dir = mtv.lengthSq() > 1e-9 ? mtv.clone().normalize() : new THREE.Vector3(0, 1, 0);
        const origin = toV(g.center);
        const top = new THREE.Vector3(0, g.halfExtents[1], 0);
        this.errorGroup.add(createArrow(origin.add(dir.y >= 0 ? top.multiplyScalar(0.2) : top.multiplyScalar(-0.2)), dir, Math.max(1.1, mtv.length() * 3), HDR.crimson));
      } else if (d.code === "E02_UNSTABLE_PHYSICS" && g !== undefined) {
        const start = toV(g.center).add(new THREE.Vector3(0, g.halfExtents[1] + 1.25, 0));
        this.errorGroup.add(createArrow(start, new THREE.Vector3(0, -1, 0), 1.15, HDR.crimson));
      } else if (d.code === "E03_CAMERA_OCCLUSION") {
        const cam = this.sceneAst?.nodes.find((n) => n.id === d.nodeId);
        if (cam !== undefined && cam.kind === "camera") {
          const from = toV(cam.position);
          const to = toV(cam.target);
          const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([from, to]), new THREE.LineDashedMaterial({ color: HDR.crimson, dashSize: 0.4, gapSize: 0.25, depthTest: false, transparent: true }));
          line.computeLineDistances();
          line.renderOrder = 11;
          const marker = new THREE.Mesh(new THREE.OctahedronGeometry(0.3), new THREE.MeshBasicMaterial({ color: HDR.crimson, wireframe: true }));
          marker.position.copy(from);
          this.errorGroup.add(line, marker);
        }
      } else if (d.code === "E04_UNREACHABLE_GOAL") {
        const goal = this.sceneAst?.nodes.find((n) => n.id === d.nodeId);
        if (goal !== undefined && goal.kind === "goal") {
          const ring = new THREE.Mesh(new THREE.TorusGeometry(goal.radius + 0.18, 0.05, 10, 64), new THREE.MeshBasicMaterial({ color: HDR.crimson }));
          ring.rotation.x = Math.PI / 2;
          ring.position.copy(toV(goal.position));
          this.errorGroup.add(ring);
          if (d.metrics.closestX !== undefined && d.metrics.closestY !== undefined && d.metrics.closestZ !== undefined) {
            const from = new THREE.Vector3(d.metrics.closestX, d.metrics.closestY + 0.1, d.metrics.closestZ);
            const to = toV(goal.position);
            const dir = to.clone().sub(from);
            if (dir.length() > 0.2) this.errorGroup.add(createArrow(from, dir, dir.length(), HDR.crimson));
          }
        }
      }
    }
  }

  setGhost(ghost: FixGhost | null): void {
    disposeGroup(this.ghostGroup);
    if (ghost === null) return;
    const material = new THREE.MeshBasicMaterial({ color: 0x10b981, transparent: true, opacity: 0.22, depthWrite: false });
    const geometry = isGeometryNode(ghost.node) ? geometryFor(ghost.node) : new THREE.OctahedronGeometry(0.35);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(toV(ghost.to));
    mesh.quaternion.set(ghost.quaternion[0], ghost.quaternion[1], ghost.quaternion[2], ghost.quaternion[3]);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 25), new THREE.LineBasicMaterial({ color: HDR.emerald, transparent: true, opacity: 0.9, depthTest: false }));
    edges.renderOrder = 13;
    mesh.add(edges);
    const guide = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([toV(ghost.from), toV(ghost.to)]),
      new THREE.LineDashedMaterial({ color: HDR.emerald, dashSize: 0.18, gapSize: 0.12, depthTest: false, transparent: true }),
    );
    guide.computeLineDistances();
    guide.renderOrder = 13;
    this.ghostGroup.add(mesh, guide);
  }

  setSelected(id: string | null): void {
    this.selected = id;
    this.rebuildSelection();
  }

  /** Indigo selection outline: hairline edges drawn on top plus a back-face hull halo. */
  private rebuildSelection(): void {
    disposeGroup(this.selectionGroup);
    for (const mesh of this.meshes.values()) {
      const old = mesh.getObjectByName("selection");
      if (old !== undefined) {
        disposeObject(old);
        mesh.remove(old);
      }
    }
    const id = this.selected;
    if (id === null) return;
    const mesh = this.meshes.get(id);
    if (mesh !== undefined) {
      const holder = new THREE.Group();
      holder.name = "selection";
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 25), new THREE.LineBasicMaterial({ color: HDR.indigo, depthTest: false, transparent: true }));
      edges.renderOrder = 14;
      const hull = new THREE.Mesh(mesh.geometry.clone(), new THREE.MeshBasicMaterial({ color: 0x7170ff, side: THREE.BackSide, transparent: true, opacity: 0.4, depthWrite: false }));
      hull.scale.setScalar(1.045);
      holder.add(hull, edges);
      mesh.add(holder);
      return;
    }
    const node = this.sceneAst?.nodes.find((n) => n.id === id);
    if (node === undefined || isGeometryNode(node)) return;
    const marker = new THREE.Mesh(new THREE.SphereGeometry(node.kind === "goal" ? node.radius + 0.25 : 0.45, 20, 12), new THREE.MeshBasicMaterial({ color: HDR.indigo, wireframe: true, transparent: true, opacity: 0.8 }));
    marker.position.copy(toV(node.position));
    this.selectionGroup.add(marker);
  }

  setFrame(index: number): void {
    this.frameIndex = index;
  }

  setToggles(xray: boolean, trails: boolean, navmesh: boolean): void {
    this.xray = xray;
    this.trailGroup.visible = trails;
    this.navGroup.visible = navmesh;
    this.applyXray();
  }

  private applyXray(): void {
    for (const mesh of this.meshes.values()) {
      const material = mesh.material as THREE.MeshStandardMaterial;
      const base = typeof mesh.userData.baseOpacity === "number" ? mesh.userData.baseOpacity : 1;
      material.transparent = this.xray || base < 1;
      material.opacity = this.xray ? Math.min(base, 0.22) : base;
      material.depthWrite = !this.xray;
      material.needsUpdate = true;
      const wire = mesh.getObjectByName("xray");
      if (wire !== undefined) wire.visible = this.xray;
    }
  }

  setWalkMode(enabled: boolean): void {
    if (enabled === this.walk) return;
    this.walk = enabled;
    this.player.visible = enabled;
    this.keys.clear();
    this.goalReachedFired = false;
    if (enabled) {
      this.flight = null;
      this.useCamera(this.perspective);
      this.onCameraMode?.("hero");
      this.player.position.set(this.spawn.x, this.spawn.y + 0.75, this.spawn.z);
      this.velocity.set(0, 0, 0);
      const offset = new THREE.Vector3(0, 4.5, 7);
      this.controls.target.copy(this.player.position);
      this.perspective.position.copy(this.player.position).add(offset);
      this.controls.update();
    }
  }

  private stepPlayer(dt: number, gravityY: number): void {
    const forward = new THREE.Vector3();
    this.perspective.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));
    const wish = new THREE.Vector3();
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) wish.add(forward);
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) wish.sub(forward);
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) wish.add(right);
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) wish.sub(right);
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(5);
    this.velocity.x = wish.x;
    this.velocity.z = wish.z;
    if (this.grounded && this.keys.has("Space")) {
      this.velocity.y = 6.2;
      this.grounded = false;
    }
    this.velocity.y += gravityY * dt;
    const solids = [...this.meshes.values()];
    const before = this.player.position.clone();
    const horizontal = new THREE.Vector3(this.velocity.x * dt, 0, this.velocity.z * dt);
    if (horizontal.lengthSq() > 0) {
      this.raycaster.set(before.clone().add(new THREE.Vector3(0, -0.2, 0)), horizontal.clone().normalize());
      this.raycaster.far = horizontal.length() + 0.32;
      if (this.raycaster.intersectObjects(solids, false).length === 0) this.player.position.add(horizontal);
    }
    this.player.position.y += this.velocity.y * dt;
    this.raycaster.set(new THREE.Vector3(this.player.position.x, this.player.position.y + 0.2, this.player.position.z), new THREE.Vector3(0, -1, 0));
    this.raycaster.far = 60;
    const hit = this.raycaster.intersectObjects(solids, false)[0];
    const feet = this.player.position.y - 0.75;
    if (hit !== undefined && this.velocity.y <= 0 && feet <= hit.point.y + 0.05 && feet >= hit.point.y - 0.6) {
      this.player.position.y = hit.point.y + 0.75;
      this.velocity.y = 0;
      this.grounded = true;
    } else if (hit === undefined || feet > hit.point.y + 0.05) {
      this.grounded = false;
    }
    if (this.player.position.y < -15) {
      this.player.position.set(this.spawn.x, this.spawn.y + 0.75, this.spawn.z);
      this.velocity.set(0, 0, 0);
    }
    const delta = this.player.position.clone().sub(this.controls.target);
    this.controls.target.add(delta);
    this.perspective.position.add(delta);
    if (this.goal !== null && !this.goalReachedFired) {
      const g = toV(this.goal.position);
      if (this.player.position.distanceTo(g) < this.goal.radius + 0.9) {
        this.goalReachedFired = true;
        this.onGoalReached?.();
      }
    }
  }

  private readonly loop = (now: number): void => {
    if (this.disposed) return;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (this.tween !== null) {
      const t = Math.min(1, (now - this.tween.start) / this.tween.duration);
      const k = easeOutBack(t);
      for (const [id, mesh] of this.meshes) {
        const to = this.home.get(id);
        const from = this.tween.from.get(id);
        if (to === undefined) continue;
        if (from === undefined) {
          mesh.position.copy(to.p);
          mesh.quaternion.copy(to.q);
          continue;
        }
        mesh.position.lerpVectors(from.p, to.p, k);
        mesh.quaternion.slerpQuaternions(from.q, to.q, Math.min(1, t * 1.4));
      }
      if (t >= 1) this.tween = null;
    } else {
      const frame = this.report?.frames[this.frameIndex];
      for (const [id, mesh] of this.meshes) {
        const tr = frame?.transforms[id];
        const home = this.home.get(id);
        if (tr !== undefined) {
          mesh.position.set(tr.position[0], tr.position[1], tr.position[2]);
          mesh.quaternion.set(tr.quaternion[0], tr.quaternion[1], tr.quaternion[2], tr.quaternion[3]);
        } else if (home !== undefined) {
          mesh.position.copy(home.p);
          mesh.quaternion.copy(home.q);
        }
      }
    }
    if (this.goalRing !== null) {
      this.goalRing.rotation.z += dt * 1.2;
      const s = 1 + Math.sin(now / 300) * 0.06;
      this.goalRing.scale.set(s, s, s);
    }
    if (this.flight !== null) {
      const t = Math.min(1, (now - this.flight.start) / this.flight.duration);
      const k = easeInOutCubic(t);
      this.active.position.lerpVectors(this.flight.fromPos, this.flight.toPos, k);
      this.controls.target.lerpVectors(this.flight.fromTarget, this.flight.toTarget, k);
      if (this.active === this.ortho) {
        this.ortho.zoom = this.flight.fromZoom + (this.flight.toZoom - this.flight.fromZoom) * k;
        this.ortho.updateProjectionMatrix();
      }
      if (t >= 1) this.flight = null;
    }
    if (this.walk) this.stepPlayer(dt, this.gravityY);
    this.controls.update();
    const u = this.grid.material.uniforms.uCamera;
    if (u !== undefined) u.value = this.active.position;
    this.grid.position.x = Math.round(this.active.position.x / 10) * 10;
    this.grid.position.z = Math.round(this.active.position.z / 10) * 10;
    this.composer.render(dt);
    this.raf = requestAnimationFrame(this.loop);
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.removeEventListener("pointerup", this.onPointerUp);
    this.renderer.domElement.removeEventListener("dblclick", this.onDoubleClick);
    this.controls.dispose();
    for (const group of [this.world, this.lights, this.trailGroup, this.navGroup, this.markerGroup, this.errorGroup, this.ghostGroup, this.selectionGroup]) disposeGroup(group);
    disposeObject(this.player);
    disposeObject(this.grid);
    this.renderPass.dispose();
    this.bloomPass.dispose();
    this.outputPass.dispose();
    this.composer.dispose();
    this.envTarget.dispose();
    this.pmrem.dispose();
    this.scene.environment = null;
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

const CAMERA_BUTTONS: { command: CameraCommand; label: string; key?: string }[] = [
  { command: "hero", label: "Hero Cam" },
  { command: "top", label: "Top Ortho" },
  { command: "iso", label: "Isometric" },
  { command: "reset", label: "Reset", key: "R" },
];

export function Viewport3D(props: Viewport3DProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<StageController | null>(null);
  const lastTransition = useRef(0);
  const lastPreset = useRef(-1);
  const [cameraMode, setCameraMode] = useState<CameraMode>("hero");
  const { scene, resolved, report, frameIndex, transitionKey, presetKey, xray, trails, navmesh, walkMode, selectedId, onSelect, focusRequest, cameraRequest, ghost, onGoalReached } = props;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const stage = new StageController(host);
    stage.onCameraMode = setCameraMode;
    stageRef.current = stage;
    return () => {
      stage.dispose();
      stageRef.current = null;
    };
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    const animate = transitionKey !== lastTransition.current;
    const resetCamera = presetKey !== lastPreset.current;
    // Only consume the keys once a scene is actually on stage (the first render has none yet).
    if (resolved !== null) {
      lastTransition.current = transitionKey;
      lastPreset.current = presetKey;
    }
    stage.gravityY = scene?.gravity[1] ?? -9.81;
    stage.setScene(scene, resolved, animate, resetCamera);
    stage.setReport(report);
    stage.setToggles(xray, trails, navmesh);
    // The scene and report always arrive together from the compile step.
  }, [resolved]);

  useEffect(() => {
    stageRef.current?.setReport(report);
  }, [report]);

  useEffect(() => {
    stageRef.current?.setFrame(frameIndex);
  }, [frameIndex]);

  useEffect(() => {
    stageRef.current?.setToggles(xray, trails, navmesh);
  }, [xray, trails, navmesh]);

  useEffect(() => {
    stageRef.current?.setWalkMode(walkMode);
  }, [walkMode]);

  useEffect(() => {
    stageRef.current?.setSelected(selectedId);
  }, [selectedId, resolved]);

  useEffect(() => {
    stageRef.current?.setGhost(ghost);
  }, [ghost]);

  useEffect(() => {
    if (focusRequest !== null) stageRef.current?.focusNode(focusRequest.nodeId);
  }, [focusRequest]);

  useEffect(() => {
    if (cameraRequest !== null) stageRef.current?.setCameraMode(cameraRequest.command);
  }, [cameraRequest]);

  useEffect(() => {
    const stage = stageRef.current;
    if (stage !== null) {
      stage.onGoalReached = onGoalReached;
      stage.onSelect = onSelect;
    }
  }, [onGoalReached, onSelect]);

  return (
    <>
      <div ref={hostRef} className="hs-viewport-canvas" />
      <div className="hs-pill hs-camswitch" role="group" aria-label="Camera" data-testid="camera-switcher">
        {CAMERA_BUTTONS.map((b) => (
          <button
            key={b.command}
            type="button"
            className="hs-pill-btn"
            aria-pressed={b.command !== "reset" && cameraMode === b.command}
            onClick={() => stageRef.current?.setCameraMode(b.command)}
            disabled={walkMode}
            data-testid={`cam-${b.command}`}
          >
            {b.label}
            {b.key !== undefined && <kbd className="hs-kbd hs-kbd-sm">{b.key}</kbd>}
          </button>
        ))}
      </div>
    </>
  );
}
