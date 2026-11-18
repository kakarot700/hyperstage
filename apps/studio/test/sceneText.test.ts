import { describe, expect, it } from "vitest";
import { getPreset, parseScene } from "@hyperstage/core";
import type { SceneAST } from "@hyperstage/core";
import { formatScene, formatSource, lineOfNode, lineOfOffset, offsetOfLine } from "../src/lib/sceneText";

function preset(index: number): SceneAST {
  const p = getPreset(index);
  if (p === undefined) throw new Error(`preset ${index} missing`);
  return p.scene;
}

describe("formatScene", () => {
  it("round-trips every node through JSON.parse + parseScene", () => {
    const scene = preset(1);
    const text = formatScene(scene);
    expect(parseScene(JSON.parse(text))).toEqual(parseScene(scene));
  });

  it("keeps joints and triggers for every preset (v2 mechanisms survive the editor)", () => {
    for (let index = 1; index <= 6; index++) {
      const scene = preset(index);
      expect(parseScene(JSON.parse(formatScene(scene)))).toEqual(parseScene(scene));
    }
    const rover = parseScene(JSON.parse(formatScene(preset(2))));
    expect(rover.joints?.length ?? 0).toBeGreaterThan(0);
    expect(rover.triggers?.length ?? 0).toBeGreaterThan(0);
  });

  it("writes one node per line with kind and id first", () => {
    const scene = preset(4);
    const text = formatScene(scene);
    const block = text.slice(text.indexOf('"nodes": ['), text.indexOf("\n  ]"));
    const lines = block.split("\n").filter((l) => l.startsWith("    {"));
    expect(lines).toHaveLength(scene.nodes.length);
    for (const line of lines) expect(line).toMatch(/^ {4}\{"kind":"[a-z]+","id":"/);
  });
});

describe("line helpers", () => {
  const text = formatScene(preset(1));

  it("finds the line of a node id in compact and spaced form", () => {
    const first = preset(1).nodes[0];
    if (first === undefined) throw new Error("empty preset");
    const line = lineOfNode(text, first.id);
    expect(line).not.toBeNull();
    expect(text.split("\n")[(line ?? 1) - 1]).toContain(`"id":"${first.id}"`);
    expect(lineOfNode('{\n  "id": "x"\n}', "x")).toBe(2);
    expect(lineOfNode(text, "does-not-exist")).toBeNull();
  });

  it("does not match an id that is only a prefix of another", () => {
    expect(lineOfNode('{"id":"block-20"}\n{"id":"block-2"}', "block-2")).toBe(2);
  });

  it("converts between offsets and lines consistently", () => {
    const sample = "ab\ncd\n\nef";
    expect(lineOfOffset(sample, 0)).toBe(1);
    expect(lineOfOffset(sample, 3)).toBe(2);
    expect(lineOfOffset(sample, -5)).toBe(1);
    expect(offsetOfLine(sample, 1)).toBe(0);
    expect(offsetOfLine(sample, 2)).toBe(3);
    expect(offsetOfLine(sample, 4)).toBe(7);
    for (let line = 1; line <= 4; line++) expect(lineOfOffset(sample, offsetOfLine(sample, line))).toBe(line);
  });
});

describe("formatSource", () => {
  it("canonicalises a valid scene", () => {
    const result = formatSource(JSON.stringify(preset(3)));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.canonical).toBe(true);
      expect(result.text).toBe(formatScene(parseScene(preset(3))));
    }
  });

  it("pretty-prints well-formed JSON that fails the schema", () => {
    const result = formatSource('{"name":"x","nodes":[{"kind":"teapot"}]}');
    expect(result).toEqual({ ok: true, canonical: false, text: '{\n  "name": "x",\n  "nodes": [\n    {\n      "kind": "teapot"\n    }\n  ]\n}\n' });
  });

  it("reports malformed JSON", () => {
    const result = formatSource("{ nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^JSON: /);
  });
});
