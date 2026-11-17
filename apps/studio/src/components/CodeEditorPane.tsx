import { useEffect, useMemo, useRef, useState } from "react";
import type { SyntheticEvent } from "react";
import { tokenizeDocument } from "../lib/highlight";
import { formatSource, lineOfOffset, offsetOfLine } from "../lib/sceneText";

export interface EditorMarker {
  line: number;
  message: string;
  /** Short diagnostic code shown as the gutter badge, e.g. "E01". Parse errors omit it. */
  code?: string;
}

export interface CodeEditorPaneProps {
  value: string;
  onChange: (value: string) => void;
  markers: EditorMarker[];
  status: string;
  statusIsError: boolean;
  /** Select and scroll to a 1-based line; `nonce` changes on every request. */
  revealLine: { line: number; nonce: number } | null;
  /** Reports the outcome of the Format button. */
  onNotice: (message: string) => void;
}

interface LineMarker {
  codes: string[];
  messages: string[];
}

/**
 * Zero-dependency highlighted editor: a transparent textarea over a tokenized mirror, a
 * tabular line-number gutter with E01–E04 badges, active-line highlight and a Format button.
 */
export function CodeEditorPane({ value, onChange, markers, status, statusIsError, revealLine, onNotice }: CodeEditorPaneProps) {
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const [activeLine, setActiveLine] = useState(1);

  const tokens = useMemo(() => tokenizeDocument(value), [value]);
  const markerByLine = useMemo(() => {
    const map = new Map<number, LineMarker>();
    for (const m of markers) {
      const entry = map.get(m.line) ?? { codes: [], messages: [] };
      const code = m.code ?? "ERR";
      if (!entry.codes.includes(code)) entry.codes.push(code);
      entry.messages.push(m.message);
      map.set(m.line, entry);
    }
    return map;
  }, [markers]);

  const syncScroll = () => {
    const area = areaRef.current;
    if (area === null) return;
    if (gutterRef.current !== null) gutterRef.current.scrollTop = area.scrollTop;
    if (layerRef.current !== null) {
      layerRef.current.scrollTop = area.scrollTop;
      layerRef.current.scrollLeft = area.scrollLeft;
    }
  };

  const trackCaret = (event: SyntheticEvent<HTMLTextAreaElement>) => {
    const area = event.currentTarget;
    setActiveLine(lineOfOffset(area.value, area.selectionStart));
  };

  useEffect(() => {
    if (revealLine === null) return;
    const area = areaRef.current;
    if (area === null) return;
    const start = offsetOfLine(area.value, revealLine.line);
    const length = area.value.split("\n")[revealLine.line - 1]?.length ?? 0;
    // Selection is set without stealing focus, so viewport shortcuts keep working.
    area.setSelectionRange(start, start + length);
    const lineHeight = Number.parseFloat(getComputedStyle(area).lineHeight) || 19;
    area.scrollTop = Math.max(0, (revealLine.line - 4) * lineHeight);
    setActiveLine(revealLine.line);
    syncScroll();
  }, [revealLine]);

  useEffect(syncScroll, [value]);

  const onFormat = () => {
    const result = formatSource(value);
    if (!result.ok) {
      onNotice(`Format failed — ${result.error}`);
      return;
    }
    if (result.text === value) {
      onNotice("Already formatted");
      return;
    }
    onChange(result.text);
    onNotice(result.canonical ? "Formatted · canonical one-node-per-line layout" : "Formatted · JSON pretty-printed (scene has schema errors)");
  };

  const errorCount = markers.length;
  return (
    <section className="hs-pane" aria-label="Scene editor">
      <div className="hs-pane-head">
        Scene DSL
        <span className="hs-badge">SceneAST · JSON</span>
        <span className="hs-spacer" />
        <span className={`hs-badge ${errorCount > 0 ? "hs-badge-err" : "hs-badge-ok"}`} data-testid="editor-markers">
          {errorCount > 0 ? `${errorCount} marker${errorCount === 1 ? "" : "s"}` : "clean"}
        </span>
        <button type="button" className="hs-btn hs-btn-sm" onClick={onFormat} title="Format document" data-testid="format">
          Format
        </button>
      </div>
      <div className="hs-editor">
        <div className="hs-gutter" ref={gutterRef} aria-hidden="true">
          {tokens.map((_, i) => {
            const marker = markerByLine.get(i + 1);
            return (
              <div key={i} className="hs-gutter-line" data-error={marker !== undefined} data-active={i + 1 === activeLine}>
                {marker !== undefined && (
                  <span className="hs-gutter-badge" title={marker.messages.join("\n")}>
                    {marker.codes[0]}
                    {marker.codes.length > 1 ? `+${marker.codes.length - 1}` : ""}
                  </span>
                )}
                {i + 1}
              </div>
            );
          })}
          <div className="hs-gutter-pad" />
        </div>
        <div className="hs-code">
          <div className="hs-code-layer" ref={layerRef} aria-hidden="true">
            {tokens.map((line, i) => (
              <div
                key={i}
                className="hs-code-line"
                data-active={i + 1 === activeLine}
                data-error={markerByLine.has(i + 1)}
                title={markerByLine.get(i + 1)?.messages.join("\n")}
              >
                {line.length === 0
                  ? "\u200b"
                  : line.map((token, j) => (
                      <span key={j} className={`hs-tok-${token.kind}`}>
                        {token.text}
                      </span>
                    ))}
              </div>
            ))}
          </div>
          <textarea
            ref={areaRef}
            className="hs-textarea"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
            value={value}
            onChange={(event) => {
              onChange(event.target.value);
              trackCaret(event);
            }}
            onSelect={trackCaret}
            onKeyUp={trackCaret}
            onClick={trackCaret}
            onScroll={syncScroll}
            aria-label="Scene JSON"
            data-testid="scene-editor"
          />
        </div>
      </div>
      <div className="hs-editor-status" data-error={statusIsError} title={status}>
        {status}
      </div>
    </section>
  );
}
