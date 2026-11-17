import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnchorCycleError, AnchorTargetError, PRESETS, SceneValidationError, parseScene, resolveScene } from "@hyperstage/core";
import type { ResolvedScene, SceneAST } from "@hyperstage/core";
import { autoFixScene, lintScene } from "@hyperstage/spatial-linter";
import type { AppliedFix, AutoFixResult, LintReport, SpatialDiagnostic } from "@hyperstage/spatial-linter";
import { exportSceneHtml } from "@hyperstage/mcp-server/html-exporter";
import { ByokModal } from "./components/ByokModal";
import { CodeEditorPane } from "./components/CodeEditorPane";
import type { EditorMarker } from "./components/CodeEditorPane";
import { CommandPalette, Keycaps } from "./components/CommandPalette";
import { DiagnosticsPane } from "./components/DiagnosticsPane";
import { SceneTree } from "./components/SceneTree";
import { TimelineBar } from "./components/TimelineBar";
import { Viewport3D } from "./components/Viewport3D";
import type { CameraCommand } from "./components/Viewport3D";
import { isMacPlatform, isTypingTarget } from "./lib/commands";
import type { Command } from "./lib/commands";
import { applySuggestedFix, computeFixGhost } from "./lib/fixPreview";
import { formatScene, lineOfNode, lineOfOffset } from "./lib/sceneText";
import { detectCollisionEvents } from "./lib/timeline";

export { formatScene };

export const STUDIO_VERSION = "1.1.0";

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

const presetLabel = (title: string): string => title.replace(" -> Auto-Fixed Castle", "");
const presetTabLabel = (title: string): string => presetLabel(title).split(" ").slice(0, 2).join(" ");

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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ nodeId: string; nonce: number } | null>(null);
  const [cameraRequest, setCameraRequest] = useState<{ command: CameraCommand; nonce: number } | null>(null);
  const [revealLine, setRevealLine] = useState<{ line: number; nonce: number } | null>(null);
  const [previewing, setPreviewing] = useState<SpatialDiagnostic | null>(null);
  const sequence = useRef(0);
  const nonce = useRef(0);
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

  // A selection or preview that no longer exists in the recompiled scene is dropped.
  useEffect(() => {
    setPreviewing(null);
    if (compiled !== null && selectedId !== null && !compiled.scene.nodes.some((n) => n.id === selectedId)) setSelectedId(null);
  }, [compiled]);

  const loadPreset = useCallback((index: number) => {
    const preset = PRESETS[index];
    if (preset === undefined) return;
    setPresetIndex(index);
    setPresetKey((k) => k + 1);
    setApplied([]);
    setPlaying(false);
    setWalkMode(false);
    setSelectedId(null);
    setPreviewing(null);
    setText(formatScene(preset.scene));
  }, []);

  const acceptFixed = useCallback((result: AutoFixResult, animate: boolean) => {
    const resolved = resolveScene(result.scene);
    skipNextCompile.current = true;
    sequence.current++;
    setText(formatScene(result.scene));
    setCompiled({ scene: result.scene, resolved, report: result.report });
    setApplied(result.applied);
    setError(null);
    setFrame(0);
    if (animate) setTransitionKey((k) => k + 1);
  }, []);

  const onAutoFix = useCallback(async () => {
    if (compiled === null) return;
    setBusy(true);
    setPlaying(false);
    setPreviewing(null);
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
  }, [compiled, acceptFixed]);

  const onApplyFix = useCallback(
    async (diagnostic: SpatialDiagnostic) => {
      if (compiled === null) return;
      let next: SceneAST | null;
      try {
        next = applySuggestedFix(compiled.scene, diagnostic);
      } catch (e) {
        setToast(`Fix could not be applied — ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      if (next === null) return;
      setPreviewing(null);
      setPlaying(false);
      setBusy(true);
      const id = ++sequence.current;
      try {
        const resolved = resolveScene(next);
        const report = await lintScene(next);
        if (id !== sequence.current) return;
        skipNextCompile.current = true;
        setText(formatScene(next));
        setCompiled({ scene: next, resolved, report });
        setError(null);
        setFrame(0);
        setTransitionKey((k) => k + 1);
        setToast(`Applied ${diagnostic.code.slice(0, 3)} fix to ${diagnostic.suggestedFix?.nodeId ?? diagnostic.nodeId}`);
      } catch (e) {
        setToast(`Fix could not be applied — ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        if (id === sequence.current) setBusy(false);
      }
    },
    [compiled],
  );

  const onExport = useCallback(async () => {
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
  }, [compiled]);

  const requestCamera = useCallback((command: CameraCommand) => {
    setCameraRequest({ command, nonce: ++nonce.current });
  }, []);

  const flyTo = useCallback((nodeId: string) => {
    setSelectedId(nodeId);
    setFocusRequest({ nodeId, nonce: ++nonce.current });
  }, []);

  const revealNode = useCallback(
    (nodeId: string) => {
      const line = lineOfNode(text, nodeId);
      if (line !== null) setRevealLine({ line, nonce: ++nonce.current });
    },
    [text],
  );

  const selectNode = useCallback((nodeId: string | null) => {
    setSelectedId(nodeId);
  }, []);

  /** F: fly to the selection, or back to the hero camera when nothing is selected. */
  const focusSelection = useCallback(() => {
    if (selectedId !== null) flyTo(selectedId);
    else requestCamera("hero");
  }, [selectedId, flyTo, requestCamera]);

  const togglePlay = useCallback(() => {
    const count = compiled?.report.frames.length ?? 0;
    if (count === 0) return;
    if (!playing && frame >= count - 1) setFrame(0);
    setPlaying(!playing);
  }, [compiled, playing, frame]);

  const ghost = useMemo(() => {
    if (previewing === null || compiled === null) return null;
    return computeFixGhost(compiled.scene, previewing);
  }, [previewing, compiled]);

  const collisionEvents = useMemo(
    () => (compiled === null ? [] : detectCollisionEvents(compiled.report.frames, compiled.scene.gravity)),
    [compiled],
  );

  const markers: EditorMarker[] = useMemo(() => {
    const list: EditorMarker[] = [];
    if (error !== null && error.line !== null) list.push({ line: error.line, message: error.message });
    if (error === null && compiled !== null) {
      for (const d of compiled.report.diagnostics) {
        const line = lineOfNode(text, d.nodeId);
        if (line !== null) list.push({ line, message: `${d.code}: ${d.message}`, code: d.code.slice(0, 3) });
      }
    }
    return list;
  }, [error, compiled, text]);

  const report = compiled?.report ?? null;
  const hasSpawn = compiled?.scene.nodes.some((n) => n.kind === "spawn") ?? false;
  const frameCount = report?.frames.length ?? 0;
  const fixable = report?.diagnostics.some((d) => d.suggestedFix !== undefined) ?? false;
  const mod = isMacPlatform() ? "⌘" : "Ctrl";

  const commands: Command[] = useMemo(() => {
    const list: Command[] = PRESETS.map((preset, i) => ({
      id: `preset-${preset.index}`,
      title: `Load preset: ${presetLabel(preset.title)}`,
      group: "Presets",
      keys: [String(preset.index)],
      hint: preset.description,
      run: () => loadPreset(i),
    }));
    list.push(
      { id: "autofix", title: "Run Spatial Auto-Fix", group: "Spatial", keys: [], hint: "repair E01–E04", disabled: busy || report === null || report.valid || !fixable, run: () => void onAutoFix() },
      { id: "play", title: playing ? "Pause physics playback" : "Play physics playback", group: "Spatial", keys: ["Space"], disabled: frameCount === 0 || walkMode, run: togglePlay },
      { id: "xray", title: xray ? "Disable X-Ray" : "Enable X-Ray", group: "View", keys: ["X"], run: () => setXray((v) => !v) },
      { id: "trails", title: trails ? "Hide Trails" : "Show Trails", group: "View", keys: ["T"], run: () => setTrails((v) => !v) },
      { id: "navpath", title: navmesh ? "Hide NavPath" : "Show NavPath", group: "View", keys: ["N"], run: () => setNavmesh((v) => !v) },
      { id: "tree", title: treeCollapsed ? "Show Scene Tree" : "Hide Scene Tree", group: "View", keys: [], run: () => setTreeCollapsed((v) => !v) },
      { id: "focus", title: selectedId !== null ? `Focus selection (${selectedId})` : "Focus hero camera", group: "Camera", keys: ["F"], disabled: walkMode, run: focusSelection },
      { id: "cam-hero", title: "Hero camera", group: "Camera", keys: [], disabled: walkMode, run: () => requestCamera("hero") },
      { id: "cam-top", title: "Top orthographic camera", group: "Camera", keys: [], disabled: walkMode, run: () => requestCamera("top") },
      { id: "cam-iso", title: "Isometric camera", group: "Camera", keys: [], disabled: walkMode, run: () => requestCamera("iso") },
      { id: "cam-reset", title: "Reset camera", group: "Camera", keys: ["R"], disabled: walkMode, run: () => requestCamera("reset") },
      { id: "export", title: "Export standalone .html", group: "File", keys: [], disabled: compiled === null, run: () => void onExport() },
      { id: "ai", title: "AI Generate scene (BYOK)", group: "File", keys: [], run: () => setByokOpen(true) },
    );
    if (hasSpawn) {
      list.push({ id: "walk", title: walkMode ? "Exit play mode" : "Enter play mode (WASD)", group: "Spatial", keys: [], run: () => setWalkMode((v) => !v) });
    }
    return list;
  }, [busy, report, fixable, playing, frameCount, walkMode, xray, trails, navmesh, treeCollapsed, selectedId, compiled, hasSpawn, loadPreset, onAutoFix, togglePlay, focusSelection, requestCamera, onExport]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (walkMode || byokOpen) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (paletteOpen || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      if (isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (event.key === " ") {
        event.preventDefault();
        togglePlay();
      } else if (key === "f") focusSelection();
      else if (key === "r") requestCamera("reset");
      else if (key === "x") setXray((v) => !v);
      else if (key === "t") setTrails((v) => !v);
      else if (key === "n") setNavmesh((v) => !v);
      else if (key === "escape") setSelectedId(null);
      else if (/^[1-9]$/.test(key)) {
        const index = Number(key) - 1;
        if (index < PRESETS.length) loadPreset(index);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [walkMode, byokOpen, paletteOpen, togglePlay, focusSelection, requestCamera, loadPreset]);

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
          HyperStage <small data-testid="version">v{STUDIO_VERSION}</small>
        </div>
        <nav className="hs-presets" aria-label="Presets">
          {PRESETS.map((preset, i) => (
            <button
              key={preset.id}
              type="button"
              className="hs-preset"
              aria-pressed={i === presetIndex}
              onClick={() => loadPreset(i)}
              title={`${preset.description} (${preset.index})`}
              data-testid={`preset-${preset.index}`}
            >
              <span className="hs-preset-index">{preset.index}</span>
              {presetTabLabel(preset.title)}
            </button>
          ))}
        </nav>
        <span className="hs-spacer" />
        <button type="button" className="hs-btn hs-btn-ghost hs-palette-trigger" onClick={() => setPaletteOpen(true)} data-testid="open-palette">
          Commands <Keycaps keys={[mod, "K"]} />
        </button>
        <button type="button" className="hs-btn" onClick={() => void onExport()} disabled={compiled === null} data-testid="export">
          ⤓ Export .html
        </button>
        <button type="button" className="hs-btn hs-btn-primary" onClick={() => setByokOpen(true)}>
          ✦ AI Generate
        </button>
      </header>

      <main className="hs-main">
        <SceneTree
          scene={compiled?.scene ?? null}
          resolved={compiled?.resolved ?? null}
          report={report}
          frameIndex={frame}
          selectedId={selectedId}
          collapsed={treeCollapsed}
          onCollapsedChange={setTreeCollapsed}
          onSelect={(id) => {
            setSelectedId(id);
            revealNode(id);
          }}
          onFocus={flyTo}
        />

        <CodeEditorPane
          value={text}
          onChange={setText}
          markers={markers}
          status={status}
          statusIsError={error !== null}
          revealLine={revealLine}
          onNotice={setToast}
        />

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
            selectedId={selectedId}
            onSelect={selectNode}
            focusRequest={focusRequest}
            cameraRequest={cameraRequest}
            ghost={ghost}
            onGoalReached={() => setToast("🏁 Goal reached!")}
          />
          <div className="hs-hud">
            <div className="hs-pill" role="group" aria-label="Overlays">
              <button type="button" className="hs-toggle" aria-pressed={xray} onClick={() => setXray((v) => !v)} data-testid="toggle-xray" title="X-Ray (X)">
                <span className="hs-toggle-dot" />
                X-Ray
                <kbd className="hs-kbd hs-kbd-sm">X</kbd>
              </button>
              <button type="button" className="hs-toggle" aria-pressed={trails} onClick={() => setTrails((v) => !v)} data-testid="toggle-trails" title="Trails (T)">
                <span className="hs-toggle-dot" />
                Trails
                <kbd className="hs-kbd hs-kbd-sm">T</kbd>
              </button>
              <button type="button" className="hs-toggle" aria-pressed={navmesh} onClick={() => setNavmesh((v) => !v)} data-testid="toggle-navpath" title="NavPath (N)">
                <span className="hs-toggle-dot" />
                NavPath
                <kbd className="hs-kbd hs-kbd-sm">N</kbd>
              </button>
            </div>
            {hasSpawn && (
              <div className="hs-pill">
                <button
                  type="button"
                  className="hs-toggle"
                  data-variant="play"
                  aria-pressed={walkMode}
                  onClick={() => setWalkMode((v) => !v)}
                  data-testid="walk-mode"
                >
                  <span className="hs-toggle-dot" />
                  {walkMode ? "■ EXIT PLAY" : "▶ PLAY · WASD + SPACE"}
                </button>
              </div>
            )}
            <span className="hs-hud-right" />
            {report !== null && (
              <div className="hs-pill hs-hud-stats">
                <span className="hs-badge">{report.telemetry.geometryCount} solids</span>
                <span className="hs-badge">{report.navPath.length > 0 ? `nav ${report.navPath.length} pts` : "nav —"}</span>
                <span className={`hs-badge ${report.valid ? "hs-badge-ok" : "hs-badge-err"}`}>{report.elapsedMs.toFixed(1)} ms</span>
              </div>
            )}
          </div>
          {(toast !== null || walkMode) && (
            <div className="hs-hint" data-testid="toast">
              {toast ?? "WASD move · SPACE jump · drag to orbit"}
            </div>
          )}
        </section>

        <DiagnosticsPane
          report={report}
          busy={busy}
          applied={applied}
          selectedId={selectedId}
          previewing={previewing}
          onAutoFix={() => void onAutoFix()}
          onFlyTo={(id) => {
            flyTo(id);
            revealNode(id);
          }}
          onPreviewFix={setPreviewing}
          onApplyFix={(d) => void onApplyFix(d)}
        />
      </main>

      <TimelineBar frameCount={frameCount} frame={frame} playing={playing} events={collisionEvents} onFrame={setFrame} onPlayingChange={setPlaying} />

      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />

      <ByokModal
        open={byokOpen}
        onClose={() => setByokOpen(false)}
        onAccept={(_scene, result) => {
          acceptFixed(result, false);
          setPresetKey((k) => k + 1);
          setSelectedId(null);
          setByokOpen(false);
          setToast("Generated world loaded");
        }}
      />
    </div>
  );
}
