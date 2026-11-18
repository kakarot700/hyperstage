---
name: hyperstage-world-builder
description: Build HyperStage 3D scenes (SceneAST JSON or TSX) with relational snapTo placement instead of guessed coordinates, and always lint with hyperstage_compile_and_lint before finishing.
---

# HyperStage World Builder

Use this skill whenever you author or edit a HyperStage scene (`*.scene.json`, `<scene>` TSX, or a `sceneJson` string for the `hyperstage_*` MCP tools).

## Core rules

1. **Place relationally, never by guessing.** Give one root (usually the ground slab) an absolute `position`; anchor everything else with `snapTo: { target, face, align?, offset? }`.
   - Faces map to world axes: `top` +Y, `bottom` -Y, `north` -Z, `south` +Z, `east` +X, `west` -X.
   - The resolver adds both half-extents so surfaces meet at exactly 0.000 m. Do not add half sizes yourself.
   - `align` (`center` | `min` | `max`) positions the child on the two axes orthogonal to the face; use `offset` for deliberate spacing.
2. **No anchor cycles.** `A snaps to B snaps to A` throws `AnchorCycleError` with the exact path. Anchor graphs must be trees rooted at absolutely-positioned nodes.
3. **Ids are stable contracts.** Use short kebab-case ids (`wall-north`, `block-2`); diagnostics, fixes and frames are keyed by id.
4. **Body kinds:** structural geometry is `static`; only objects that should move are `dynamic`. A dynamic object must start resting on a surface (snap it onto one) unless it is meant to roll from a ramp.
5. **Playable worlds need** exactly one `spawn` and one `goal`, walkable tops with >= 1.5 m headroom, step-ups <= 0.5 m and gaps <= 2.0 m.
6. **Every scene needs** a hero `camera` (`isHero: true`) whose target is the subject, and at least one `light` with `castShadow: true`.
7. **v2 kinds:** `capsule`, `torus`, `gltf` (`url` + `fallbackSize` bounds; nothing is fetched) and `csg` (`operation`: `union` | `subtract` | `intersect`, `base`, `tool`; operands may nest and take local `position` / `rotationDeg`). Carve doorways and windows with `subtract`: the linter, camera and navigator see the real opening.
8. **Materials:** a preset name (`brushed-metal`, `anodized-dark`, `frosted-glass`, `matte-concrete`, `warm-oak`, `emissive-cyan`, `emissive-amber`, `ceramic-white`) or a custom `{ color, roughness, metalness, ... }` object.
9. **Mechanisms:** top-level `joints` (`fixed` | `revolute` | `prismatic` | `spherical`) take body-local `anchorA` / `anchorB` that must coincide in the rest pose; `axis` is in bodyA's frame; revolute/prismatic accept `motorVelocity`, `motorMaxForce` and limits. Top-level `triggers` fire once when a dynamic body enters `onEnterNodeId`: `enable_motor`, `unlock_goal` or `impulse`.
10. **Start from a template:** `hyperstage_get_examples({ category })` returns verified scenes for `game`, `robotics`, `architecture` and `cad`.

## Finish line (mandatory)

1. Call `hyperstage_compile_and_lint` with the final `sceneJson`.
2. If `summary.valid` is `false`, apply each `suggestedFix.patch` (or run `hyperstage lint scene.json --fix`) and lint again.
3. Only report completion when the lint returns `valid: true`. Quote `elapsedMs` and the diagnostic count in your summary.
4. For CAD or engine hand-off, call `hyperstage_export_cad({ sceneJson, format: "stl" | "glb" })` (or `hyperstage export scene.json -o part.stl`).

## Minimal example

```json
{
  "name": "Two crates",
  "gravity": [0, -9.81, 0],
  "skyColor": "#08090A",
  "nodes": [
    { "id": "ground", "kind": "box", "size": [10, 0.5, 10], "position": [0, -0.25, 0] },
    { "id": "crate-a", "kind": "box", "size": [1, 1, 1], "snapTo": { "target": "ground", "face": "top" }, "physics": { "body": "dynamic", "mass": 2 } },
    { "id": "crate-b", "kind": "box", "size": [0.6, 0.6, 0.6], "snapTo": { "target": "crate-a", "face": "top" }, "physics": { "body": "dynamic", "mass": 1 } },
    { "id": "sun", "kind": "light", "position": [5, 10, 5], "intensity": 2, "castShadow": true },
    { "id": "cam", "kind": "camera", "position": [6, 4, 6], "target": [0, 1, 0], "isHero": true }
  ]
}
```
