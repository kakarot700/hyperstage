import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { bodyKindOf } from "@hyperstage/core";
import type { CameraNode, GoalNode, LightNode, ResolvedGeometry, ResolvedScene, SceneAST, SpawnNode } from "@hyperstage/core";
import type { LintReport } from "@hyperstage/spatial-linter";

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
  onGoalReached?: () => void;
}

interface Tween {
  start: number;
  duration: number;
  from: Map<string, { p: THREE.Vector3; q: THREE.Quaternion }>;
}

const TWEEN_MS = 950;

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function geometryFor(g: ResolvedGeometry): THREE.BufferGeometry {
  const node = g.node;
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

function disposeGroup(group: THREE.Object3D): void {
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.Line || obj instanceof THREE.LineSegments) {
      obj.geometry.dispose();
      const material = obj.material as THREE.Material | THREE.Material[];
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material.dispose();
    }
  });
  group.clear();
}

class StageController {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.05, 600);
  readonly controls: OrbitControls;
  private readonly meshes = new Map<string, THREE.Mesh>();
  private readonly home = new Map<string, { p: THREE.Vector3; q: THREE.Quaternion }>();
  private readonly world = new THREE.Group();
  private readonly lights = new THREE.Group();
  private readonly trailGroup = new THREE.Group();
  private readonly navGroup = new THREE.Group();
  private readonly markerGroup = new THREE.Group();
  private readonly player: THREE.Mesh;
  private readonly resizeObserver: ResizeObserver;
  private readonly keys = new Set<string>();
  private readonly velocity = new THREE.Vector3();
  private readonly raycaster = new THREE.Raycaster();
  private grounded = false;
  private spawn = new THREE.Vector3(0, 1, 0);
  private goal: GoalNode | null = null;
  private goalRing: THREE.Mesh | null = null;
  private report: LintReport | null = null;
  private frameIndex = 0;
  private tween: Tween | null = null;
  private xray = false;
  private walk = false;
  private raf = 0;
  private last = performance.now();
  private goalReachedFired = false;
  onGoalReached: (() => void) | undefined;

  constructor(private readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.domElement.dataset.testid = "viewport-canvas";
    host.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color("#08090A");
    this.scene.fog = new THREE.Fog("#08090A", 40, 120);
    this.scene.add(new THREE.HemisphereLight(0xc7d2fe, 0x0b0c10, 0.85));
    const grid = new THREE.GridHelper(80, 80, 0x1f2430, 0x14171d);
    grid.position.y = -0.002;
    this.scene.add(grid, this.world, this.lights, this.trailGroup, this.navGroup, this.markerGroup);

    this.player = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.3, 0.9, 6, 16),
      new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0x3b1d00, roughness: 0.4 }),
    );
    this.player.castShadow = true;
    this.player.visible = false;
    this.scene.add(this.player);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
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

  private resize(): void {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(width, height, true);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
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
    if (scene === null || resolved === null) return;

    this.scene.background = new THREE.Color(scene.skyColor);
    for (const g of resolved.geometry) {
      const node = g.node;
      const material = new THREE.MeshStandardMaterial({
        color: node.material?.color ?? "#8a8f98",
        metalness: node.material?.metalness ?? 0.1,
        roughness: node.material?.roughness ?? 0.8,
        transparent: (node.material?.opacity ?? 1) < 1,
        opacity: node.material?.opacity ?? 1,
      });
      const mesh = new THREE.Mesh(geometryFor(g), material);
      mesh.name = g.id;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.body = bodyKindOf(node);
      mesh.userData.baseOpacity = material.opacity;
      const p = new THREE.Vector3(g.center[0], g.center[1], g.center[2]);
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
      const hero = scene.nodes.find((n): n is CameraNode => n.kind === "camera" && n.isHero === true) ??
        scene.nodes.find((n): n is CameraNode => n.kind === "camera");
      if (hero !== undefined) {
        this.camera.position.set(hero.position[0], hero.position[1], hero.position[2]);
        this.controls.target.set(hero.target[0], hero.target[1], hero.target[2]);
        this.camera.fov = hero.fov ?? 50;
      } else {
        this.camera.position.set(12, 9, 12);
        this.controls.target.set(0, 1, 0);
        this.camera.fov = 50;
      }
      this.camera.updateProjectionMatrix();
      this.controls.update();
    }
    this.applyXray();
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
      new THREE.RingGeometry(0.35, 0.5, 40),
      new THREE.MeshBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(node.position[0], node.position[1] - 0.08, node.position[2]);
    this.markerGroup.add(disc);
  }

  private addGoal(node: GoalNode): void {
    this.goal = node;
    this.goalReachedFired = false;
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(node.radius, 0.06, 12, 64),
      new THREE.MeshBasicMaterial({ color: 0x22d3ee }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.set(node.position[0], node.position[1], node.position[2]);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(node.radius * 0.9, node.radius * 0.9, 3, 32, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    beam.position.set(node.position[0], node.position[1] + 0.5, node.position[2]);
    this.goalRing = ring;
    this.markerGroup.add(ring, beam);
  }

  setReport(report: LintReport | null): void {
    this.report = report;
    disposeGroup(this.trailGroup);
    disposeGroup(this.navGroup);
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

    // Ghost trajectory trails for every moving body.
    const frames = report.frames;
    const ids = frames.length > 0 ? Object.keys(frames[0]?.transforms ?? {}) : [];
    for (const id of ids) {
      const points: THREE.Vector3[] = [];
      for (const frame of frames) {
        const tr = frame.transforms[id];
        if (tr !== undefined) points.push(new THREE.Vector3(tr.position[0], tr.position[1], tr.position[2]));
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
          new THREE.MeshBasicMaterial({ color: 0x818cf8, transparent: true, opacity: 0.12, depthWrite: false }),
        );
        ghost.position.set(tr.position[0], tr.position[1], tr.position[2]);
        ghost.quaternion.set(tr.quaternion[0], tr.quaternion[1], tr.quaternion[2], tr.quaternion[3]);
        this.trailGroup.add(ghost);
      }
    }

    // Glowing cyan NavMesh path from spawn to goal.
    if (report.navPath.length > 1) {
      const pts = report.navPath.map((p) => new THREE.Vector3(p[0], p[1] + 0.09, p[2]));
      const curve = new THREE.CatmullRomCurve3(pts, false, "centripetal", 0.2);
      const segments = Math.max(32, pts.length * 12);
      const core = new THREE.Mesh(new THREE.TubeGeometry(curve, segments, 0.05, 8, false), new THREE.MeshBasicMaterial({ color: 0x67e8f9 }));
      const glow = new THREE.Mesh(
        new THREE.TubeGeometry(curve, segments, 0.18, 12, false),
        new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      this.navGroup.add(glow, core);
      for (const p of pts) {
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 8), new THREE.MeshBasicMaterial({ color: 0xa5f3fc }));
        dot.position.copy(p);
        this.navGroup.add(dot);
      }
    }
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
      this.player.position.set(this.spawn.x, this.spawn.y + 0.75, this.spawn.z);
      this.velocity.set(0, 0, 0);
      const offset = new THREE.Vector3(0, 4.5, 7);
      this.controls.target.copy(this.player.position);
      this.camera.position.copy(this.player.position).add(offset);
      this.controls.update();
    }
  }

  private stepPlayer(dt: number, gravityY: number): void {
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
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
    this.camera.position.add(delta);
    if (this.goal !== null && !this.goalReachedFired) {
      const g = new THREE.Vector3(this.goal.position[0], this.goal.position[1], this.goal.position[2]);
      if (this.player.position.distanceTo(g) < this.goal.radius + 0.9) {
        this.goalReachedFired = true;
        this.onGoalReached?.();
      }
    }
  }

  gravityY = -9.81;

  private readonly loop = (now: number): void => {
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
    if (this.walk) this.stepPlayer(dt, this.gravityY);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.raf = requestAnimationFrame(this.loop);
  };

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.controls.dispose();
    disposeGroup(this.world);
    disposeGroup(this.trailGroup);
    disposeGroup(this.navGroup);
    disposeGroup(this.markerGroup);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

export function Viewport3D(props: Viewport3DProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<StageController | null>(null);
  const lastTransition = useRef(0);
  const lastPreset = useRef(-1);
  const { scene, resolved, report, frameIndex, transitionKey, presetKey, xray, trails, navmesh, walkMode, onGoalReached } = props;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const stage = new StageController(host);
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
    const stage = stageRef.current;
    if (stage !== null) stage.onGoalReached = onGoalReached;
  }, [onGoalReached]);

  return <div ref={hostRef} className="hs-viewport-canvas" style={{ position: "absolute", inset: 0 }} />;
}
