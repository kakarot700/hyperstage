/** Zero-dependency JSON tokenizer for the Scene DSL editor's highlight layer. */

export type TokenKind = "key" | "keyword" | "string" | "number" | "literal" | "punct" | "text";

export interface Token {
  kind: TokenKind;
  text: string;
}

/** Keys that drive relational placement; they render in the keyword colour. */
export const SNAP_KEYWORDS: ReadonlySet<string> = new Set(["snapTo"]);

const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const LITERAL = /^(?:true|false|null)/;

function readString(source: string, start: number): number {
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "\n") return ch === '"' ? i + 1 : i;
    i++;
  }
  return i;
}

function nextSignificant(source: string, from: number): string | undefined {
  let i = from;
  while (i < source.length && (source[i] === " " || source[i] === "\t" || source[i] === "\r" || source[i] === "\n")) i++;
  return source[i];
}

/**
 * Splits `line` into coloured tokens. Object keys followed by `:` are keys; everything
 * inside a `snapTo` object (and the `snapTo` key itself) is a keyword. `depthIn` carries the
 * snapTo nesting state across lines: -1 means "not inside snapTo", otherwise the brace depth
 * still open inside it.
 */
export function tokenizeLine(line: string, depthIn: number): { tokens: Token[]; depthOut: number } {
  const tokens: Token[] = [];
  let snapDepth = depthIn;
  let pendingSnap = false;
  let i = 0;
  const push = (kind: TokenKind, text: string) => {
    const last = tokens[tokens.length - 1];
    if (last !== undefined && last.kind === kind && (kind === "text" || kind === "punct")) last.text += text;
    else tokens.push({ kind, text });
  };
  while (i < line.length) {
    const ch = line[i] ?? "";
    if (ch === '"') {
      const end = readString(line, i);
      const text = line.slice(i, end);
      const isKey = nextSignificant(line, end) === ":";
      if (isKey) {
        const name = text.slice(1, -1);
        if (SNAP_KEYWORDS.has(name)) {
          push("keyword", text);
          pendingSnap = true;
        } else push(snapDepth >= 0 ? "keyword" : "key", text);
      } else {
        push("string", text);
        pendingSnap = false;
      }
      i = end;
      continue;
    }
    const rest = line.slice(i);
    const num = NUMBER.exec(rest);
    if (num !== null && (ch === "-" || (ch >= "0" && ch <= "9"))) {
      push("number", num[0]);
      pendingSnap = false;
      i += num[0].length;
      continue;
    }
    const lit = LITERAL.exec(rest);
    if (lit !== null) {
      push("literal", lit[0]);
      pendingSnap = false;
      i += lit[0].length;
      continue;
    }
    if (ch === "{" || ch === "[") {
      if (pendingSnap && ch === "{") snapDepth = 1;
      else if (snapDepth >= 0) snapDepth++;
      pendingSnap = false;
      push("punct", ch);
    } else if (ch === "}" || ch === "]") {
      if (snapDepth >= 0) {
        snapDepth--;
        if (snapDepth === 0) snapDepth = -1;
      }
      push("punct", ch);
    } else if (ch === ":" || ch === ",") {
      push("punct", ch);
    } else {
      push("text", ch);
    }
    i++;
  }
  return { tokens, depthOut: snapDepth };
}

/** Tokenizes a whole document, one token list per line. */
export function tokenizeDocument(source: string): Token[][] {
  const out: Token[][] = [];
  let depth = -1;
  for (const line of source.split("\n")) {
    const { tokens, depthOut } = tokenizeLine(line, depth);
    out.push(tokens);
    depth = depthOut;
  }
  return out;
}
