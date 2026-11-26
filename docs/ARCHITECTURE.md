# Architecture & 4-Trade MEP Coordination

## Runtime Boundary Isolation

I designed `@kruschdev/pascal-plugin-hvac` around six strict subpath exports verified on every build by `scripts/check-render-entry.ts` (5/5 boundary gates plus a negative probe):

1. `./imc` (`src/imc/*`): Pure engineering calculations, obstacle-aware routing, framing clearance analysis, code auditing, scheduling, and priced BOMs. Contains zero React, zero Three.js, and zero `@pascal-app/*` imports so it runs in Node.js, Bun, Cloudflare Workers, or browser workers.
2. `./cad` (`src/cad/*`): Clean-room MIT procedural Three.js geometry builders with a lazy getter-backed material pool. Contains zero React and zero `@pascal-app/*` imports.
3. `./render` (`src/render.ts` + `src/nodes/*`): Read-only Pascal Plugin API v1 manifest registering `hvac:equipment`, `hvac:plenum`, `hvac:terminal`, and `hvac:duct-run`. Contains zero `@pascal-app/editor` or `next` imports so standalone 3D viewers can render saved scenes without the editor bundle.
4. `./agent-tools` (`src/agent-tools.ts`): Pure Zod v4 input schemas for the 8 HVAC tools. Contains zero Three.js, React, or editor imports.
5. `./agent-operations` (`src/agent-operations.ts`): Pure scene-graph functions returning `{ result, changes }` for single-undo-step editor execution or headless MCP execution.
6. `.` (`src/index.ts` + `src/ui/*`): Full Pascal Editor integration (left-rail `HvacHostPanel`, 6-tab `HvacScheduleView`, `HvacInspectorCard`, `HvacChatCard`, and interactive WebGL `AirHandlerCutawayView`).

## MEP Trade Routing Priority Hierarchy

When multiple MEP plugins share a Pascal scene, each trade respects higher-priority obstacles without requiring direct npm dependencies between plugins:

| Priority | Trade | Right-of-Way Rule |
|---|---|---|
| **#1** | Structural & Bones (`structural:*`, `bones:framing`) | Fixed load-bearing beams, columns, trusses, and framing walls. Never moved by MEP. |
| **#2** | Plumbing (`plumbing:*`) | Gravity DWV drains and vent stacks require monotonic downward slope. Never displaced by ductwork or wiring. |
| **#3** | **HVAC (`hvac:*`)** | Large rectangular trunks and branches route around Structural, Plumbing, and `NEC 110.26(E)` dedicated electrical panel footprints (`minY = 0`). |
| **#4** | Electrical (`electrical:*`) | Flexible cable/conduit routes around Structural, Plumbing, and HVAC trunks while auto-provisioning dedicated circuits for powered Plumbing and HVAC nodes. |

## Zero-Coupling Cross-Trade Data Contracts

- **HVAC to Electrical (`electricalDemand`)**: Every powered `hvac:equipment` node stores a typed `electricalDemand` object (`voltage`, `poles`, `breakerAmps`, `loadVa`, `continuous`, `dedicatedCircuit`, `gfciRequired`, `loadCategory`, `label`). When `@kruschdev/pascal-plugin-electrical` runs auto-populate, it reads these payloads automatically, allocates dedicated 240V/208V/120V breakers (NEC Art. 440 / 424 / 422.12), and routes 3D power runs back with `metadata.mepSourceNodeId`.
- **HVAC to Plumbing (`gasBtuh`)**: Condensing 96% and standard 80% gas furnaces publish `gasBtuh` (e.g., `60,000` to `100,000 BTU/h`). `@kruschdev/pascal-plugin-plumbing` sums `gasBtuh` across both `plumbing:equipment` gas water heaters and `hvac:equipment` gas furnaces when sizing IFGC fuel-gas mains.
- **Structural / Bones to HVAC (`extractHvacFramingContext`)**: Reads `structural:assembly` (preferred) or `bones:framing` (`studSpacingIn`, `joistDepthIn`, `floorSystem`, `wallOverrides`) to evaluate wall penetration headers, double top-plate tie straps (IRC R602.6.1), fireblocking (IRC R302.11), and under-joist dropped soffits (IRC R502.8).

## Performance & Memory Hygiene

- **WeakMap Caching**: `extractWallSegments`, `extractRoomPolygons`, `extractHvacFramingContext`, `extractHvacObstacles`, `buildHvacSchedule`, and `auditSceneHvac` are memoized via `WeakMap` keyed on the immutable Pascal `nodes` dictionary reference.
- **Lazy Material Pool & Shared Unit Geometries**: `src/cad/materials.ts` instantiates Three.js materials lazily on first property access, and `buildDuctRunCad` reuses shared unit cylinder and box geometries across segments.
- **WebGL Teardown**: `AirHandlerCutawayView` collects every `BufferGeometry` and `Material` into deduplicated `Set` instances, disposes them on unmount or mode change, clears the scene, and disposes the `WebGLRenderer`.
