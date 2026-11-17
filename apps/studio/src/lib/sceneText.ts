import { SceneValidationError, parseScene } from "@hyperstage/core";
import type { SceneAST } from "@hyperstage/core";

/** One node per line keeps the DSL compact and makes per-node error markers precise. */
export function formatScene(scene: SceneAST): string {
  const head = `  "name": ${JSON.stringify(scene.name)},\n  "gravity": ${JSON.stringify(scene.gravity)},\n  "skyColor": ${JSON.stringify(scene.skyColor)},\n`;
  const nodes = scene.nodes
    .map((n) => {
      // Canonical key order: kind and id first, then the remaining fields as authored.
      const { kind, id, ...rest } = n;
      return `    ${JSON.stringify({ kind, id, ...rest })}`;
    })
    .join(",\n");
  return `{\n${head}  "nodes": [\n${nodes}\n  ]\n}\n`;
}

/** 1-based line of the node whose `"id"` equals `nodeId`, or null when it is not in the text. */
export function lineOfNode(text: string, nodeId: string): number | null {
  const needle = `"id":${JSON.stringify(nodeId)}`;
  const spaced = `"id": ${JSON.stringify(nodeId)}`;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.includes(needle) || line.includes(spaced)) return i + 1;
  }
  return null;
}

/** 1-based line containing the character at `offset`. */
export function lineOfOffset(text: string, offset: number): number {
  return text.slice(0, Math.max(0, offset)).split("\n").length;
}

/** Character offset where the 1-based `line` starts. */
export function offsetOfLine(text: string, line: number): number {
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < Math.min(line - 1, lines.length); i++) offset += (lines[i]?.length ?? 0) + 1;
  return offset;
}

export type FormatResult = { ok: true; text: string; canonical: boolean } | { ok: false; error: string };

/**
 * The editor's Format button: a schema-valid scene is rewritten in the canonical
 * one-node-per-line layout; any other well-formed JSON is pretty-printed with 2 spaces.
 */
export function formatSource(source: string): FormatResult {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    return { ok: false, error: `JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    return { ok: true, text: formatScene(parseScene(raw)), canonical: true };
  } catch (error) {
    if (error instanceof SceneValidationError) return { ok: true, text: `${JSON.stringify(raw, null, 2)}\n`, canonical: false };
    throw error;
  }
}
