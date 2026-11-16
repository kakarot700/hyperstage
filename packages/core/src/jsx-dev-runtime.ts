import { jsx, type Component, type HyperElement } from "./jsx-runtime.js";

export { Fragment, jsx, jsxs, compileJsx, isHyperElement } from "./jsx-runtime.js";
export type { JSX, HyperElement, HyperChild, SceneProps } from "./jsx-runtime.js";

export function jsxDEV(
  type: string | Component<Record<string, unknown>>,
  props: Record<string, unknown> | null,
  key?: string,
): HyperElement {
  return jsx(type, props, key);
}
