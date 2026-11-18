---
name: hyperstage-spatial-debug
description: Step-by-step workflow for resolving HyperStage spatial diagnostics E01_INTERPENETRATION, E02_UNSTABLE_PHYSICS, E03_CAMERA_OCCLUSION and E04_UNREACHABLE_GOAL using metrics and suggested fixes.
---

# HyperStage Spatial Debugging

Always fix in priority order: **E01 -> E05 -> E02 -> E03 -> E04**. Interpenetration corrupts the physics rollout, and physics changes what the camera and navigator see.

## 1. Gather facts
- `hyperstage_compile_and_lint` -> list of diagnostics with `metrics` and `suggestedFix`.
- `hyperstage_inspect_bounds` -> world AABBs and pairwise clearances (negative = penetration depth).

## 2. E01_INTERPENETRATION
- `metrics.penetrationMeters` is the SAT depth; `mtvX/Y/Z` is the repair vector. Flush contacts (<= 2 mm) are legal.
- Prefer replacing absolute `position` with `snapTo` onto the touching surface. The suggested patch preserves an existing `snapTo` by adjusting its `offset`.

## 3. E02_UNSTABLE_PHYSICS
- `driftMeters` > 0.5: the body floated or slid. Snap it onto `relatedNodeId` (the nearest surface beneath) as suggested.
- `maxTiltDeg` > 45: center the body over its support, widen the base, or set `allowTip: true` if toppling is intended (dominoes).
- `minY` < -15: it fell off the world. Add a floor or snap it onto one.
- Bodies riding on an unstable anchor are not reported separately; fixing the anchor fixes them.

## 3b. E05_BROKEN_JOINT
- A joint's world anchors are more than 0.15 m apart in the rest pose or during the rollout (`initialSeparation`, `maxSeparation`, `maxSeparationTick`).
- `suggestedJointFix.patch.anchorB` is the body-local anchor that coincides with `anchorA`; apply it to the joint (not to a node). The auto-fixer does this for you.
- If the rest pose is fine but the joint pulls apart later, lower `motorMaxForce` or add limits.

## 4. E03_CAMERA_OCCLUSION
- More than 40% of the 5x5 rays to the subject are blocked by `relatedNodeId`.
- Apply the suggested elevated `position`, or move the camera around the occluder; keep `target` on the subject.

## 5. E04_UNREACHABLE_GOAL
- `closestX/Y/Z` is the furthest reachable point. Bridge from there: add a platform within 2.0 m horizontally and <= 0.5 m higher, or lower the next ledge.
- Check headroom: walkable tops need 1.5 m clearance.
- The auto-fix moves the goal to the closest reachable point; prefer adding geometry when the goal location matters.

## 6. Close the loop
- `hyperstage lint scene.json --fix` (or `autoFixScene`) applies fixes for up to 5 passes.
- Re-lint and confirm `valid: true` before reporting success.
