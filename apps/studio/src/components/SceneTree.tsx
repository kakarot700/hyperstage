import { useMemo } from "react";
import type { ResolvedScene, SceneAST, Vec3 } from "@hyperstage/core";
import type { LintReport } from "@hyperstage/spatial-linter";
import { buildSceneTree, inspectNode } from "../lib/sceneTree";
import type { TreeIcon } from "../lib/sceneTree";

export interface SceneTreeProps {
  scene: SceneAST | null;
  resolved: ResolvedScene | null;
  report: LintReport | null;
  frameIndex: number;
  selectedId: string | null;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onSelect: (nodeId: string) => void;
  onFocus: (nodeId: string) => void;
}

function NodeIcon({ icon }: { icon: TreeIcon }) {
  const common = { className: "hs-tree-icon", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.3, "aria-hidden": true } as const;
  switch (icon) {
    case "box":
      return (
        <svg {...common}>
          <path d="M8 1.8 13.6 5v6L8 14.2 2.4 11V5z" />
          <path d="M2.4 5 8 8.2 13.6 5M8 8.2v6" />
        </svg>
      );
    case "sphere":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.8" />
          <ellipse cx="8" cy="8" rx="5.8" ry="2.2" />
        </svg>
      );
    case "cylinder":
      return (
        <svg {...common}>
          <ellipse cx="8" cy="3.8" rx="4.6" ry="1.8" />
          <path d="M3.4 3.8v8.4c0 1 2 1.8 4.6 1.8s4.6-.8 4.6-1.8V3.8" />
        </svg>
      );
    case "ramp":
      return (
        <svg {...common}>
          <path d="M1.8 13h12.4V4.2z" />
        </svg>
      );
    case "camera":
      return (
        <svg {...common}>
          <rect x="1.8" y="4.4" width="9" height="7.2" rx="1.4" />
          <path d="m10.8 7 3.4-2v6l-3.4-2" />
        </svg>
      );
    case "light":
      return (
        <svg {...common}>
          <circle cx="8" cy="7" r="3.4" />
          <path d="M6.4 12.6h3.2M8 1.2v1.2M2.6 7H1.4M14.6 7h-1.2" />
        </svg>
      );
    case "spawn":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="2" />
          <circle cx="8" cy="8" r="5.6" strokeDasharray="2 2" />
        </svg>
      );
    case "goal":
      return (
        <svg {...common}>
          <path d="M3.4 14.4V1.8" />
          <path d="M3.4 2.4h9.2l-2.2 3 2.2 3H3.4" />
        </svg>
      );
  }
}

const vec = (v: Vec3 | null): string => (v === null ? "—" : `[${v.map((x) => x.toFixed(3)).join(", ")}]`);

/** Collapsible outliner (snapTo hierarchy) with a live Properties Inspector for the selection. */
export function SceneTree({ scene, resolved, report, frameIndex, selectedId, collapsed, onCollapsedChange, onSelect, onFocus }: SceneTreeProps) {
  const rows = useMemo(() => (scene === null ? [] : buildSceneTree(scene, report)), [scene, report]);
  const inspection = useMemo(() => {
    if (scene === null || resolved === null || selectedId === null) return null;
    try {
      return inspectNode(scene, resolved, report, selectedId, frameIndex);
    } catch {
      return null;
    }
  }, [scene, resolved, report, selectedId, frameIndex]);

  return (
    <aside className="hs-pane hs-tree" data-collapsed={collapsed} aria-label="Scene tree" data-testid="scene-tree">
      <div className="hs-pane-head">
        <button
          type="button"
          className="hs-tree-toggle"
          onClick={() => onCollapsedChange(!collapsed)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand scene tree" : "Collapse scene tree"}
          title={collapsed ? "Expand scene tree" : "Collapse scene tree"}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
            <rect x="1.8" y="2.4" width="12.4" height="11.2" rx="2" />
            <path d="M6 2.4v11.2" />
          </svg>
        </button>
        <span className="hs-tree-title">Scene Tree</span>
        <span className="hs-spacer hs-tree-title" />
        <span className="hs-badge hs-tree-title">{rows.length}</span>
      </div>
      <div className="hs-tree-body" role="tree" aria-label="Scene nodes">
        {rows.map((row) => (
          <button
            key={row.id}
            type="button"
            role="treeitem"
            className="hs-tree-row"
            data-kind={row.kind}
            aria-selected={row.id === selectedId}
            style={{ paddingLeft: 6 + row.depth * 14 }}
            onClick={() => onSelect(row.id)}
            onDoubleClick={() => onFocus(row.id)}
            title={row.snapTarget !== null ? `${row.id} → snapTo ${row.snapTarget}.${row.snapFace ?? ""}` : row.id}
            data-testid={`tree-${row.id}`}
          >
            {row.depth > 0 && <span className="hs-tree-chain">↳</span>}
            <NodeIcon icon={row.icon} />
            <span className="hs-tree-name">{row.id}</span>
            {row.snapFace !== null && <span className="hs-tree-snap">.{row.snapFace}</span>}
            {row.errors.length > 0 && <span className="hs-tree-err">{row.errors.join(" ")}</span>}
          </button>
        ))}
      </div>
      <div className="hs-inspector" data-testid="inspector">
        <div className="hs-inspector-title">
          Properties
          <span className="hs-spacer" />
          {inspection !== null && <span className="hs-badge">{inspection.kind}</span>}
        </div>
        {inspection === null ? (
          <div className="hs-note">Select a node in the tree or viewport.</div>
        ) : (
          <>
            <Prop label="id" value={inspection.id} />
            <Prop label="center" value={vec(inspection.center)} />
            <Prop label="min" value={vec(inspection.min)} />
            <Prop label="max" value={vec(inspection.max)} />
            <Prop label="size" value={vec(inspection.size)} />
            <Prop label="snapTo" value={inspection.snap ?? "—"} />
            <Prop label="body" value={inspection.mass !== null ? `${inspection.body} · ${inspection.mass.toFixed(2)}kg` : inspection.body} />
            {inspection.framePosition !== null && (
              <>
                <Prop label={`t=${frameIndex + 1}`} value={vec(inspection.framePosition)} />
                <Prop label="Δ rest" value={inspection.displacement !== null ? `${inspection.displacement.toFixed(3)}m` : "—"} />
                <Prop label="speed" value={inspection.speed !== null ? `${inspection.speed.toFixed(3)}m/s` : "—"} />
              </>
            )}
            <Prop label="lint" value={inspection.diagnostics.length > 0 ? inspection.diagnostics.join(", ") : "clean"} />
          </>
        )}
      </div>
    </aside>
  );
}

function Prop({ label, value }: { label: string; value: string }) {
  return (
    <div className="hs-prop">
      <span className="hs-prop-label">{label}</span>
      <span className="hs-prop-value">{value}</span>
    </div>
  );
}
