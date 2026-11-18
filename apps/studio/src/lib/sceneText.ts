import { SceneValidationError, parseScene } from "@hyperstage/core";
import type { SceneAST } from "@hyperstage/core";

/**
 * One node per line keeps the DSL compact and makes per-node error markers precise.
 * Every other top-level field (joints, triggers, ...) is kept, arrays one entry per line,
 * so a scene round-trips through the editor without losing data.
 */
export function formatScene(scene: SceneAST): string {
  const { name, gravity, skyColor, nodes, ...extra } = scene;
  const parts: string[] = [
    `  "name": ${JSON.stringify(name)}`,
    `  "gravity": ${JSON.stringify(gravity)}`,
    `  "skyColor": ${JSON.stringify(skyColor)}`,
  ];
  const nodeLines = nodes.map((n) => {
    // Canonical key order: kind and id first, then the remaining fields as authored.
    const { kind, id, ...rest } = n;
    return `    ${JSON.stringify({ kind, id, ...rest })}`;
  });
  parts.push(`  "nodes": [\n${nodeLines.join(",\n")}\n  ]`);
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      const lines = value.map((entry) => `    ${JSON.stringify(entry)}`);
      parts.push(`  ${JSON.stringify(key)}: [\n${lines.join(",\n")}\n  ]`);
    } else {
      parts.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
    }
  }
  return `{\n${parts.join(",\n")}\n}\n`;
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
