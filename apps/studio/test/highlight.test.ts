import { describe, expect, it } from "vitest";
import { tokenizeDocument, tokenizeLine } from "../src/lib/highlight";
import type { Token } from "../src/lib/highlight";

const kinds = (tokens: Token[]) => tokens.map((t) => `${t.kind}:${t.text}`);

describe("tokenizeLine", () => {
  it("classifies keys, strings, numbers, literals and punctuation", () => {
    const { tokens, depthOut } = tokenizeLine('{"id":"a","size":[1,-2.5e3,0],"isHero":true,"x":null}', -1);
    expect(kinds(tokens)).toEqual([
      "punct:{", 'key:"id"', "punct::", 'string:"a"', "punct:,", 'key:"size"', "punct::[", "number:1", "punct:,", "number:-2.5e3",
      "punct:,", "number:0", "punct:],", 'key:"isHero"', "punct::", "literal:true", "punct:,", 'key:"x"', "punct::", "literal:null", "punct:}",
    ]);
    expect(depthOut).toBe(-1);
  });

  it("reconstructs the input exactly", () => {
    const line = '    {"kind":"box","id":"a\\"b","snapTo":{"target":"g","face":"top","offset":[0, 1, 0]}}, ';
    expect(tokenizeLine(line, -1).tokens.map((t) => t.text).join("")).toBe(line);
  });

  it("colours the snapTo key and everything inside its object as keywords", () => {
    const { tokens, depthOut } = tokenizeLine('{"snapTo":{"target":"g","offset":[0,1,0]},"mass":2}', -1);
    const keyTokens = tokens.filter((t) => t.text.startsWith('"') && (t.kind === "key" || t.kind === "keyword"));
    expect(keyTokens.map((t) => `${t.kind}:${t.text}`)).toEqual(['keyword:"snapTo"', 'keyword:"target"', 'keyword:"offset"', 'key:"mass"']);
    expect(depthOut).toBe(-1);
  });

  it("does not enter snapTo mode when snapTo is not an object", () => {
    const { tokens } = tokenizeLine('{"snapTo":null,"physics":{"body":"dynamic"}}', -1);
    expect(tokens.find((t) => t.text === '"body"')?.kind).toBe("key");
  });

  it("treats an unterminated string as a string to the end of the line", () => {
    expect(kinds(tokenizeLine('"abc', -1).tokens)).toEqual(['string:"abc']);
  });
});

describe("tokenizeDocument", () => {
  it("carries snapTo depth across lines", () => {
    const lines = tokenizeDocument('{"snapTo":{\n"face":"top",\n"offset":[0,0,0]\n},\n"mass":1}');
    expect(lines).toHaveLength(5);
    expect(lines[1]?.find((t) => t.text === '"face"')?.kind).toBe("keyword");
    expect(lines[2]?.find((t) => t.text === '"offset"')?.kind).toBe("keyword");
    expect(lines[4]?.find((t) => t.text === '"mass"')?.kind).toBe("key");
  });
});
