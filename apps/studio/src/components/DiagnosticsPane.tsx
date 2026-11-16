import type { AppliedFix, LintReport } from "@hyperstage/spatial-linter";

export interface DiagnosticsPaneProps {
  report: LintReport | null;
  busy: boolean;
  applied: AppliedFix[];
  onAutoFix: () => void;
  onFocusNode: (nodeId: string) => void;
}

const fmt = (value: number): string => (Math.abs(value) >= 100 ? value.toFixed(0) : Math.abs(value) >= 1 ? value.toFixed(2) : value.toFixed(3));

/** Compiler error cards, pass telemetry and the 1-click Auto-Fix trigger. */
export function DiagnosticsPane({ report, busy, applied, onAutoFix, onFocusNode }: DiagnosticsPaneProps) {
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
            <div className="hs-metric">
              <div className="hs-metric-label">lint</div>
              <div className="hs-metric-value" data-testid="lint-ms">{report.elapsedMs.toFixed(1)}ms</div>
            </div>
            <div className="hs-metric">
              <div className="hs-metric-label">rapier</div>
              <div className="hs-metric-value">{report.telemetry.passMs.physics.toFixed(1)}ms</div>
            </div>
            <div className="hs-metric">
              <div className="hs-metric-label">bodies</div>
              <div className="hs-metric-value">
                {report.telemetry.dynamicBodyCount}/{report.telemetry.geometryCount}
              </div>
            </div>
            <div className="hs-metric">
              <div className="hs-metric-label">E01 sat</div>
              <div className="hs-metric-value">{report.telemetry.passMs.overlap.toFixed(2)}</div>
            </div>
            <div className="hs-metric">
              <div className="hs-metric-label">E03 rays</div>
              <div className="hs-metric-value">{report.telemetry.passMs.camera.toFixed(2)}</div>
            </div>
            <div className="hs-metric">
              <div className="hs-metric-label">E04 a*</div>
              <div className="hs-metric-value">{report.telemetry.passMs.navmesh.toFixed(2)}</div>
            </div>
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

        {report !== null && report.diagnostics.length === 0 && (
          <div className="hs-empty">✓ 0 spatial errors · 180-tick rollout stable</div>
        )}

        {report?.diagnostics.map((d, i) => (
          <article
            key={`${d.code}-${d.nodeId}-${i}`}
            className="hs-card"
            data-severity={d.severity}
            onClick={() => onFocusNode(d.nodeId)}
          >
            <div className="hs-card-code">{d.code}</div>
            <div className="hs-card-title">{d.message}</div>
            <div className="hs-card-metrics">
              {Object.entries(d.metrics).map(([key, value]) => (
                <span key={key} className="hs-badge">
                  {key} {fmt(value)}
                </span>
              ))}
            </div>
            {d.suggestedFix !== undefined && (
              <div className="hs-card-fix">
                <b>fix</b> {d.suggestedFix.rationale}
              </div>
            )}
          </article>
        ))}

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
