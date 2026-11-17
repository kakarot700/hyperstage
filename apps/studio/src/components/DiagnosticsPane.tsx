import type { AppliedFix, LintReport, SpatialDiagnostic } from "@hyperstage/spatial-linter";
import { SHORT_TITLE, diagnosticNodes, primaryMetric, secondaryMetrics } from "../lib/diagnostics";

export interface DiagnosticsPaneProps {
  report: LintReport | null;
  busy: boolean;
  applied: AppliedFix[];
  selectedId: string | null;
  /** The diagnostic whose fix ghost is currently shown, or null. */
  previewing: SpatialDiagnostic | null;
  onAutoFix: () => void;
  /** Node chip click: select the node and fly the camera to it. */
  onFlyTo: (nodeId: string) => void;
  /** Hover/focus on Preview Fix shows a ghost; leaving clears it (null). */
  onPreviewFix: (diagnostic: SpatialDiagnostic | null) => void;
  /** Applies only this diagnostic's suggested fix. */
  onApplyFix: (diagnostic: SpatialDiagnostic) => void;
}

/** Compiler error cards, pass telemetry and the 1-click Auto-Fix trigger. */
export function DiagnosticsPane({ report, busy, applied, selectedId, previewing, onAutoFix, onFlyTo, onPreviewFix, onApplyFix }: DiagnosticsPaneProps) {
  const errors = report?.diagnostics.filter((d) => d.severity === "error").length ?? 0;
  const fixable = report?.diagnostics.some((d) => d.suggestedFix !== undefined) ?? false;
  return (
    <aside className="hs-pane" aria-label="Diagnostics">
      <div className="hs-pane-head">
        Diagnostics
        <span className="hs-spacer" />
        {report === null ? (
          <span className="hs-badge">{busy ? "compiling…" : "—"}</span>
        ) : (
          <span className={`hs-badge ${report.valid ? "hs-badge-ok" : "hs-badge-err"}`} data-testid="lint-status">
            {report.valid ? "VALID" : `${errors} ERROR${errors === 1 ? "" : "S"}`}
          </span>
        )}
      </div>
      <div className="hs-diag-body">
        {report !== null && (
          <div className="hs-telemetry">
            <Metric label="lint" value={`${report.elapsedMs.toFixed(1)}ms`} testId="lint-ms" />
            <Metric label="rapier" value={`${report.telemetry.passMs.physics.toFixed(1)}ms`} />
            <Metric label="bodies" value={`${report.telemetry.dynamicBodyCount}/${report.telemetry.geometryCount}`} />
            <Metric label="E01 sat" value={`${report.telemetry.passMs.overlap.toFixed(2)}ms`} />
            <Metric label="E03 rays" value={`${report.telemetry.passMs.camera.toFixed(2)}ms`} />
            <Metric label="E04 a*" value={`${report.telemetry.passMs.navmesh.toFixed(2)}ms`} />
          </div>
        )}

        <button
          type="button"
          className="hs-btn hs-btn-primary hs-autofix"
          onClick={onAutoFix}
          disabled={busy || report === null || report.valid || !fixable}
          data-testid="autofix"
        >
          {busy ? "Repairing…" : "Auto-Fix Spatial Errors"}
        </button>

        {report !== null && report.diagnostics.length === 0 && <div className="hs-empty">✓ 0 spatial errors · {report.frames.length}-tick rollout stable</div>}

        {report?.diagnostics.map((d, i) => {
          const metric = primaryMetric(d);
          const extra = secondaryMetrics(d);
          const isPreviewing = previewing === d;
          return (
            <article key={`${d.code}-${d.nodeId}-${i}`} className="hs-card" data-severity={d.severity} data-testid="diagnostic-card">
              <div className="hs-card-head">
                <span className="hs-sev" data-severity={d.severity}>
                  {d.code.slice(0, 3)}
                </span>
                <span className="hs-card-name">{SHORT_TITLE[d.code]}</span>
                <span className="hs-spacer" />
                <span className="hs-card-code">{d.severity.toUpperCase()}</span>
              </div>
              {metric !== null && (
                <div className="hs-card-metric" data-testid="diagnostic-metric">
                  <span className="hs-card-metric-label">{metric.label}:</span>
                  <span className="hs-card-metric-value">{metric.value}</span>
                </div>
              )}
              <div className="hs-card-title">{d.message}</div>
              <div className="hs-chips">
                {diagnosticNodes(d).map((id) => (
                  <button
                    key={id}
                    type="button"
                    className="hs-chip"
                    aria-pressed={id === selectedId}
                    onClick={() => onFlyTo(id)}
                    title={`Fly camera to ${id}`}
                    data-testid={`chip-${id}`}
                  >
                    <span className="hs-chip-dot" />
                    {id}
                  </button>
                ))}
              </div>
              {extra.length > 0 && (
                <div className="hs-card-metrics">
                  {extra.map((x) => (
                    <span key={x.label} className="hs-badge">
                      {x.label} {x.value}
                    </span>
                  ))}
                </div>
              )}
              {d.suggestedFix !== undefined && (
                <div className="hs-card-fix">
                  <span>
                    <b>fix</b> {d.suggestedFix.rationale}
                  </span>
                  <button
                    type="button"
                    className="hs-btn hs-btn-sm hs-preview-btn"
                    data-previewing={isPreviewing}
                    disabled={busy}
                    onMouseEnter={() => onPreviewFix(d)}
                    onMouseLeave={() => onPreviewFix(null)}
                    onFocus={() => onPreviewFix(d)}
                    onBlur={() => onPreviewFix(null)}
                    onClick={() => onApplyFix(d)}
                    title="Hover to preview the ghost · click to apply this fix"
                    data-testid="preview-fix"
                  >
                    ◇ Preview Fix
                  </button>
                </div>
              )}
            </article>
          );
        })}

        {applied.length > 0 && (
          <div className="hs-card">
            <div className="hs-card-code" style={{ color: "var(--hs-cyan)" }}>
              AUTO-FIX LOG
            </div>
            <div className="hs-log" data-testid="autofix-log">
              {applied.map((a) => `pass ${a.pass} · ${a.code.slice(0, 3)} · ${a.nodeId}`).join("\n")}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function Metric({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="hs-metric">
      <div className="hs-metric-label">{label}</div>
      <div className="hs-metric-value" data-testid={testId}>
        {value}
      </div>
    </div>
  );
}
