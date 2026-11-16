import { useMemo, useRef } from "react";
import type { UIEvent } from "react";

export interface EditorMarker {
  line: number;
  message: string;
}

export interface CodeEditorPaneProps {
  value: string;
  onChange: (value: string) => void;
  markers: EditorMarker[];
  status: string;
  statusIsError: boolean;
}

/** Live Scene DSL (SceneAST JSON) editor with a line gutter and diagnostic markers. */
export function CodeEditorPane({ value, onChange, markers, status, statusIsError }: CodeEditorPaneProps) {
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const lineCount = useMemo(() => value.split("\n").length, [value]);
  const markerByLine = useMemo(() => {
    const map = new Map<number, string>();
    for (const m of markers) map.set(m.line, map.has(m.line) ? `${map.get(m.line) ?? ""}\n${m.message}` : m.message);
    return map;
  }, [markers]);

  const onScroll = (event: UIEvent<HTMLTextAreaElement>) => {
    if (gutterRef.current !== null) gutterRef.current.scrollTop = event.currentTarget.scrollTop;
  };

  return (
    <section className="hs-pane" aria-label="Scene editor">
      <div className="hs-pane-head">
        Scene DSL
        <span className="hs-badge">SceneAST · JSON</span>
        <span className="hs-spacer" />
        <span className={`hs-badge ${markers.length > 0 ? "hs-badge-err" : "hs-badge-ok"}`}>
          {markers.length > 0 ? `${markers.length} marker${markers.length === 1 ? "" : "s"}` : "clean"}
        </span>
      </div>
      <div className="hs-editor">
        <div className="hs-gutter" ref={gutterRef} aria-hidden="true">
          {Array.from({ length: lineCount }, (_, i) => {
            const message = markerByLine.get(i + 1);
            return (
              <div key={i} className="hs-gutter-line" data-error={message !== undefined} title={message}>
                {i + 1}
              </div>
            );
          })}
        </div>
        <textarea
          className="hs-textarea"
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onScroll={onScroll}
          aria-label="Scene JSON"
          data-testid="scene-editor"
        />
      </div>
      <div className="hs-editor-status" data-error={statusIsError}>
        {status}
      </div>
    </section>
  );
}
