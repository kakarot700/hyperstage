import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnchorCycleError, AnchorTargetError, PRESETS, SceneValidationError, parseScene, resolveScene } from "@hyperstage/core";
import type { ResolvedScene, SceneAST } from "@hyperstage/core";
import { autoFixScene, lintScene } from "@hyperstage/spatial-linter";
import type { AppliedFix, AutoFixResult, LintReport } from "@hyperstage/spatial-linter";
import { exportSceneHtml } from "@hyperstage/mcp-server/html-exporter";
import { ByokModal } from "./components/ByokModal";
import { CodeEditorPane } from "./components/CodeEditorPane";
import type { EditorMarker } from "./components/CodeEditorPane";
import { DiagnosticsPane } from "./components/DiagnosticsPane";
import { TimelineBar } from "./components/TimelineBar";
import { Viewport3D } from "./components/Viewport3D";

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

function lineOfNode(text: string, nodeId: string): number | null {
  const needle = `"id":${JSON.stringify(nodeId)}`;
  const spaced = `"id": ${JSON.stringify(nodeId)}`;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.includes(needle) || line.includes(spaced)) return i + 1;
  }
  return null;
}

function lineOfOffset(text: string, offset: number): number {
  return text.slice(0, Math.max(0, offset)).split("\n").length;
}

interface Compiled {
  scene: SceneAST;
  resolved: ResolvedScene;
  report: LintReport;
}

async function loadThreeSources() {
  const [core, module, orbit] = await Promise.all([
    import("three-root/build/three.core.min.js?raw"),
    import("three-root/build/three.module.min.js?raw"),
    import("three-root/examples/jsm/controls/OrbitControls.js?raw"),
  ]);
  return { core: core.default, module: module.default, orbitControls: orbit.default };
}

export function App() {
  const [presetIndex, setPresetIndex] = useState(0);
  const [presetKey, setPresetKey] = useState(0);
  const [text, setText] = useState(() => formatScene(PRESETS[0]?.scene ?? { name: "empty", gravity: [0, -9.81, 0], skyColor: "#08090A", nodes: [] }));
  const [compiled, setCompiled] = useState<Compiled | null>(null);
  const [error, setError] = useState<{ message: string; line: number | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [xray, setXray] = useState(false);
  const [trails, setTrails] = useState(true);
  const [navmesh, setNavmesh] = useState(true);
  const [walkMode, setWalkMode] = useState(false);
  const [applied, setApplied] = useState<AppliedFix[]>([]);
  const [transitionKey, setTransitionKey] = useState(0);
  const [byokOpen, setByokOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const sequence = useRef(0);
  const skipNextCompile = useRef(false);

  const compile = useCallback(async (source: string): Promise<void> => {
    const id = ++sequence.current;
    let raw: unknown;
    try {
      raw = JSON.parse(source);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const pos = /position (\d+)/.exec(message);
      setError({ message: `JSON: ${message}`, line: pos?.[1] !== undefined ? lineOfOffset(source, Number(pos[1])) : null });
      return;
    }
    try {
      const scene = parseScene(raw);
      const resolved = resolveScene(scene);
      setBusy(true);
      const report = await lintScene(scene);
      if (id !== sequence.current) return;
      setCompiled({ scene, resolved, report });
      setError(null);
      setFrame(0);
    } catch (e) {
      if (id !== sequence.current) return;
      if (e instanceof SceneValidationError) {
        const first = e.issues[0];
        const nodeIndex = first !== undefined ? /^nodes\.(\d+)/.exec(first.path)?.[1] : undefined;
        const nodes = (raw as { nodes?: { id?: unknown }[] }).nodes;
        const nodeId = nodeIndex !== undefined ? nodes?.[Number(nodeIndex)]?.id : undefined;
        setError({ message: e.message, line: typeof nodeId === "string" ? lineOfNode(source, nodeId) : null });
      } else if (e instanceof AnchorCycleError) {
        setError({ message: e.message, line: lineOfNode(source, e.cycle[0] ?? "") });
      } else if (e instanceof AnchorTargetError) {
        setError({ message: e.message, line: lineOfNode(source, e.nodeId) });
      } else {
        setError({ message: e instanceof Error ? e.message : String(e), line: null });
      }
    } finally {
      if (id === sequence.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (skipNextCompile.current) {
      skipNextCompile.current = false;
      return;
    }
    const timer = window.setTimeout(() => void compile(text), 280);
    return () => window.clearTimeout(timer);
  }, [text, compile]);

  useEffect(() => {
    if (toast === null) return;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const loadPreset = (index: number) => {
    const preset = PRESETS[index];
    if (preset === undefined) return;
    setPresetIndex(index);
    setPresetKey((k) => k + 1);
    setApplied([]);
    setPlaying(false);
    setWalkMode(false);
    setText(formatScene(preset.scene));
  };

  const acceptFixed = (result: AutoFixResult, animate: boolean) => {
    const resolved = resolveScene(result.scene);
    skipNextCompile.current = true;
    sequence.current++;
    setText(formatScene(result.scene));
    setCompiled({ scene: result.scene, resolved, report: result.report });
    setApplied(result.applied);
    setError(null);
    setFrame(0);
    if (animate) setTransitionKey((k) => k + 1);
  };

  const onAutoFix = async () => {
    if (compiled === null) return;
    setBusy(true);
    setPlaying(false);
    try {
      const result = await autoFixScene(compiled.scene);
      acceptFixed(result, true);
      setToast(
        result.report.valid
          ? `Auto-fix applied ${result.applied.length} patch(es) in ${result.passes} pass(es) — scene valid`
          : `Auto-fix applied ${result.applied.length} patch(es); ${result.report.diagnostics.length} diagnostic(s) remain`,
      );
    } finally {
      setBusy(false);
    }
  };

  const onExport = async () => {
    if (compiled === null) return;
    const three = await loadThreeSources();
    const html = exportSceneHtml({ scene: compiled.scene, frames: compiled.report.frames, navPath: compiled.report.navPath, title: compiled.scene.name, three });
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${compiled.scene.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "scene"}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    setToast(`Exported ${(html.length / 1024).toFixed(0)} KiB standalone HTML`);
  };

  const onFocusNode = (nodeId: string) => {
    const line = lineOfNode(text, nodeId);
    const area = document.querySelector<HTMLTextAreaElement>('[data-testid="scene-editor"]');
    if (line === null || area === null) return;
    const lines = text.split("\n");
    const start = lines.slice(0, line - 1).reduce((acc, l) => acc + l.length + 1, 0);
    area.focus();
    area.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
    area.scrollTop = Math.max(0, (line - 4) * 18);
  };

  const markers: EditorMarker[] = useMemo(() => {
    const list: EditorMarker[] = [];
    if (error !== null && error.line !== null) list.push({ line: error.line, message: error.message });
    if (error === null && compiled !== null) {
      for (const d of compiled.report.diagnostics) {
        const line = lineOfNode(text, d.nodeId);
        if (line !== null) list.push({ line, message: `${d.code}: ${d.message}` });
      }
    }
    return list;
  }, [error, compiled, text]);

  const report = compiled?.report ?? null;
  const hasSpawn = compiled?.scene.nodes.some((n) => n.kind === "spawn") ?? false;
  const frameCount = report?.frames.length ?? 0;
  const status =
    error !== null
      ? `✖ ${error.message}`
      : compiled === null
        ? "compiling…"
        : `✓ ${compiled.scene.nodes.length} nodes · ${compiled.resolved.geometry.length} solids · topo-sorted · lint ${compiled.report.elapsedMs.toFixed(1)} ms`;

  return (
    <div className="hs-app">
      <header className="hs-topbar">
        <div className="hs-brand">
          <span className="hs-brand-mark" />
          HyperStage <small>v1.0.0</small>
        </div>
        <nav className="hs-presets" aria-label="Presets">
          {PRESETS.map((preset, i) => (
            <button
              key={preset.id}
              type="button"
              className="hs-preset"
              aria-pressed={i === presetIndex}
              onClick={() => loadPreset(i)}
              title={preset.description}
              data-testid={`preset-${preset.index}`}
            >
              <span className="hs-preset-index">{preset.index}</span>
              {preset.title.replace(" -> Auto-Fixed Castle", "")}
            </button>
          ))}
        </nav>
        <span className="hs-spacer" />
        <button type="button" className="hs-btn" onClick={() => void onExport()} disabled={compiled === null} data-testid="export">
          ⤓ Export .html
        </button>
        <button type="button" className="hs-btn hs-btn-cyan" onClick={() => setByokOpen(true)}>
          ✦ AI Generate
        </button>
      </header>

      <main className="hs-main">
        <CodeEditorPane value={text} onChange={setText} markers={markers} status={status} statusIsError={error !== null} />

        <section className="hs-viewport" aria-label="3D viewport">
          <Viewport3D
            scene={compiled?.scene ?? null}
            resolved={compiled?.resolved ?? null}
            report={report}
            frameIndex={frame}
            transitionKey={transitionKey}
            presetKey={presetKey}
            xray={xray}
            trails={trails}
            navmesh={navmesh}
            walkMode={walkMode}
            onGoalReached={() => setToast("🏁 Goal reached!")}
          />
          <div className="hs-hud">
            <button type="button" className="hs-toggle" aria-pressed={xray} onClick={() => setXray((v) => !v)} data-testid="toggle-xray">
              X-RAY
            </button>
            <button type="button" className="hs-toggle" aria-pressed={trails} onClick={() => setTrails((v) => !v)}>
              TRAILS
            </button>
            <button type="button" className="hs-toggle" aria-pressed={navmesh} onClick={() => setNavmesh((v) => !v)}>
              NAVPATH
            </button>
            {hasSpawn && (
              <button
                type="button"
                className="hs-toggle"
                aria-pressed={walkMode}
                onClick={() => setWalkMode((v) => !v)}
                data-testid="walk-mode"
              >
                {walkMode ? "■ EXIT PLAY" : "▶ PLAY · WASD + SPACE"}
              </button>
            )}
            <span className="hs-hud-right" />
            {report !== null && (
              <>
                <span className="hs-badge">{report.telemetry.geometryCount} solids</span>
                <span className="hs-badge">{report.navPath.length > 0 ? `nav ${report.navPath.length} pts` : "nav —"}</span>
                <span className={`hs-badge ${report.valid ? "hs-badge-ok" : "hs-badge-err"}`}>{report.elapsedMs.toFixed(1)} ms</span>
              </>
            )}
          </div>
          {(toast !== null || walkMode) && (
            <div className="hs-hint" data-testid="toast">
              {toast ?? "WASD move · SPACE jump · drag to orbit"}
            </div>
          )}
        </section>

        <DiagnosticsPane report={report} busy={busy} applied={applied} onAutoFix={() => void onAutoFix()} onFocusNode={onFocusNode} />
      </main>

      <TimelineBar frameCount={frameCount} frame={frame} playing={playing} onFrame={setFrame} onPlayingChange={setPlaying} />

      <ByokModal
        open={byokOpen}
        onClose={() => setByokOpen(false)}
        onAccept={(_scene, result) => {
          acceptFixed(result, false);
          setPresetKey((k) => k + 1);
          setByokOpen(false);
          setToast("Generated world loaded");
        }}
      />
    </div>
  );
}
