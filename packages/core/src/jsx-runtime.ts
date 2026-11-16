/**
 * Zero-DOM JSX factory. Configure TSX with `"jsx": "react-jsx"` and
 * `"jsxImportSource": "@hyperstage/core"`, then pass the root `<scene>` element
 * to `compileJsx()` to obtain a validated SceneAST.
 */
import type {
  BoxNode,
  CameraNode,
  CylinderNode,
  GoalNode,
  LightNode,
  RampNode,
  SceneAST,
  SceneNode,
  SpawnNode,
  SphereNode,
  Vec3,
} from "./schema.js";
import { parseScene } from "./schema.js";

export type HyperChild = HyperElement | HyperChild[] | null | undefined | false;

export interface HyperElement {
  readonly $$hyperstage: true;
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: readonly HyperElement[];
}

type WithChildren<T> = Omit<T, "kind"> & { children?: HyperChild; key?: string };

export interface SceneProps {
  name: string;
  gravity?: Vec3;
  skyColor?: string;
  children?: HyperChild;
}

export type Component<P> = (props: P) => HyperElement | null;

export const Fragment = "hyperstage.fragment";

function flatten(child: unknown, out: HyperElement[]): void {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) {
    for (const item of child) flatten(item, out);
    return;
  }
  if (isHyperElement(child)) {
    if (child.type === Fragment) {
      for (const inner of child.children) out.push(inner);
    } else {
      out.push(child);
    }
    return;
  }
  throw new TypeError(`Unsupported JSX child: ${JSON.stringify(child)}`);
}

export function isHyperElement(value: unknown): value is HyperElement {
  return typeof value === "object" && value !== null && (value as { $$hyperstage?: unknown }).$$hyperstage === true;
}

export function jsx(
  type: string | Component<Record<string, unknown>>,
  props: Record<string, unknown> | null,
  key?: string,
): HyperElement {
  const allProps: Record<string, unknown> = { ...(props ?? {}) };
  if (typeof type === "function") {
    const rendered = type(allProps);
    return rendered ?? { $$hyperstage: true, type: Fragment, props: {}, children: [] };
  }
  const children: HyperElement[] = [];
  flatten(allProps.children, children);
  delete allProps.children;
  if (key !== undefined && allProps.id === undefined) allProps.id = key;
  return { $$hyperstage: true, type, props: allProps, children };
}

export const jsxs = jsx;

const NODE_KINDS = new Set(["box", "sphere", "cylinder", "ramp", "camera", "light", "spawn", "goal"]);

function collectNodes(element: HyperElement, out: unknown[]): void {
  if (element.type === Fragment || element.type === "group") {
    for (const child of element.children) collectNodes(child, out);
    return;
  }
  if (!NODE_KINDS.has(element.type)) {
    throw new TypeError(`Unknown HyperStage element <${element.type}>`);
  }
  out.push({ kind: element.type, ...element.props });
  for (const child of element.children) collectNodes(child, out);
}

/** Compiles a `<scene>` JSX tree to a validated SceneAST. */
export function compileJsx(root: HyperElement): SceneAST {
  if (root.type !== "scene") throw new TypeError(`Root element must be <scene>, received <${root.type}>`);
  const nodes: unknown[] = [];
  for (const child of root.children) collectNodes(child, nodes);
  return parseScene({
    name: root.props.name,
    gravity: root.props.gravity ?? [0, -9.81, 0],
    skyColor: root.props.skyColor ?? "#08090A",
    nodes: nodes as SceneNode[],
  });
}

export declare namespace JSX {
  type Element = HyperElement;
  interface ElementChildrenAttribute {
    children: unknown;
  }
  interface IntrinsicAttributes {
    key?: string;
  }
  interface IntrinsicElements {
    scene: SceneProps;
    group: { children?: HyperChild };
    box: WithChildren<BoxNode>;
    sphere: WithChildren<SphereNode>;
    cylinder: WithChildren<CylinderNode>;
    ramp: WithChildren<RampNode>;
    camera: WithChildren<CameraNode>;
    light: WithChildren<LightNode>;
    spawn: WithChildren<SpawnNode>;
    goal: WithChildren<GoalNode>;
  }
}
