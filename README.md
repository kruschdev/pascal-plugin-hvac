# `@kruschdev/pascal-plugin-hvac`

> Residential & Light-Commercial IMC / UMC / ACCA Manual J-D-S / ASHRAE 62.2 / IECC HVAC Plugin for [Pascal Editor](https://github.com/pascalorg/editor) (`apiVersion: 1`, MIT).

I built `@kruschdev/pascal-plugin-hvac` to complete the 4-trade MEP stack inside Pascal Editor alongside Structural (Priority #1), Plumbing (Priority #2), and Electrical (Priority #4). Every calculation runs deterministically in TypeScript with zero cloud dependencies, zero global CSS, and strict runtime boundary isolation across all 6 subpath exports.

## Capabilities

- **4 Native Pascal Node Kinds (`hvac:*`)**:
  - `hvac:equipment`: Split heat pump condensers, AC condensers, variable-speed air handlers, 96% and 80% gas furnaces, packaged rooftop units (RTU), multi-zone mini-splits, ASHRAE 62.2 ERV ventilators, whole-house dehumidifiers, bath exhaust fans, and kitchen range hoods.
  - `hvac:plenum`: Supply plenums, return plenums, outdoor-air mixing boxes, and motorized multi-zone damper trunk manifolds.
  - `hvac:terminal`: Floor registers, ceiling 4-way diffusers, sidewall registers, filter-back return grilles, bedroom transfer grilles, exhaust grilles, fresh-air intake hoods, mini-split wall heads, smart thermostats, and remote zone sensors.
  - `hvac:duct-run`: Rectangular sheet-metal trunks, round flex/rigid branches, ERV/exhaust ducts, insulated copper refrigerant linesets, and gravity-sloped 3/4" PVC condensate drains.
- **Framework-Free Engineering Engine (`./imc`)**:
  - Room-by-room simplified **ACCA Manual J** heating and cooling loads (sensible + latent) across all 14 ASHRAE Climate Zones (`1A` through `7`), with wall/attic R-value multipliers and occupancy scaling.
  - **ACCA Manual D** equal-friction duct sizing and Huebscher rectangular equivalent diameter (`Deq = 1.30 * (a*b)^0.625 / (a+b)^0.25`) with residential and commercial velocity limits.
  - **ACCA Manual S** equipment selection (`SEER2` / `HSPF2`), A2L refrigerant (`R-454B`, `R-32`, `R-410A`) lineset sizing, and thermostat cable specifications.
  - **ASHRAE 62.2** continuous fresh-air ERV ventilation and local bath/kitchen exhaust sizing.
  - **IECC** building envelope insulation takeoffs (wall batts, blown-in attic cellulose, rim-joist closed-cell spray foam, and air-sealing caulk/foam).
- **4-Trade MEP Coordination (Priority #3)**:
  - **Priority #1 Structural & Bones Framing**: Reads `structural:assembly` and `bones:framing` framing metadata (stud spacing, joist depth, floor system, load-bearing wall overrides) to evaluate wall penetration openings, double top-plate straps, and dropped-soffit chases per IRC R502.8 / R602.6 / R302.11, and detours ductwork around `structural:beam` and `structural:column` collision obstacles.
  - **Priority #2 Plumbing**: Detours ductwork around gravity DWV drains, stacks, manifolds, and plumbing equipment without forcing gravity drains to move. Gas furnaces publish `gasBtuh` so `@kruschdev/pascal-plugin-plumbing` automatically includes furnace demand in its IFGC fuel-gas main sizing.
  - **Priority #4 Electrical**: Every powered `hvac:equipment` node publishes a standardized `electricalDemand` payload (NEC Art. 440 / 424 voltage, poles, breaker amps, VA, dedicated circuit flag) consumed automatically by `@kruschdev/pascal-plugin-electrical`. Duct routing also respects `NEC 110.26(E)` dedicated panel footprints down to the floor (`minY = 0`).
- **42-Part Clean-Room MIT 3D CAD Library (`./cad`)**:
  - Procedural Three.js geometry for all 12 equipment types, 4 plenums, 10 terminals/controls, 9 sheet-metal/flex duct fittings, 5 refrigerant/condensate accessories, and 2 assemblies including an open-front **3D Air Handler, Supply/Return Plenum & Joist-Bay Cutaway**.
- **8 Pure Agent Tools & Operations (`./agent-tools`, `./agent-operations`)**:
  - `hvac_place_equipment`, `hvac_place_plenum`, `hvac_place_terminal`, `hvac_route_duct`, `hvac_autopopulate`, `hvac_calculate_loads`, `hvac_generate_schedule`, and `hvac_audit_imc`.

## Installation & Subpath Exports

```bash
bun add @kruschdev/pascal-plugin-hvac
```

| Subpath | Purpose | Runtime Constraints |
|---|---|---|
| `@kruschdev/pascal-plugin-hvac` | Full Pascal Editor plugin, left-rail panel, 6-tab schedule view, inspector card, chat cards | Browser + `@pascal-app/editor` |
| `@kruschdev/pascal-plugin-hvac/render` | Read-only 3D/2D node renderer manifest (`hvacRenderPlugin`) | Zero `@pascal-app/editor` or `next` |
| `@kruschdev/pascal-plugin-hvac/imc` | Pure Manual J/D/S, ASHRAE 62.2, IECC, routing, audit, schedule, and BOM engine | Zero React, Three.js, or `@pascal-app/*` |
| `@kruschdev/pascal-plugin-hvac/cad` | 42 procedural MIT Three.js CAD builders + cutaway model | Zero React or `@pascal-app/*` |
| `@kruschdev/pascal-plugin-hvac/agent-tools` | 8 Zod tool declarations for Pascal AI Chat & MCP | Zero React, Three.js, or `@pascal-app/editor` |
| `@kruschdev/pascal-plugin-hvac/agent-operations` | Pure scene operations returning `{ result, changes }` | Zero React, Three.js, or `@pascal-app/editor` |

## Host Registration Example

```ts
import { registerPlugin } from '@pascal-app/core'
import { registerEditorHostPanel, registerEditorHostView, registerPluginChatExtension } from '@pascal-app/editor'
import {
  hvacPlugin,
  hvacHostPanel,
  hvacScheduleView,
  hvacChatExtension,
} from '@kruschdev/pascal-plugin-hvac'

registerPlugin(hvacPlugin)
registerEditorHostPanel(hvacHostPanel)
registerEditorHostView(hvacScheduleView)
registerPluginChatExtension(hvacChatExtension)
```

## Development & Verification

```bash
bun install
bun run check        # tsc + tests + 5/5 entry boundary gates + ESM build
bun run export:cad   # Export all 42 .glb CAD assets into assets/cad/
```

## Documentation

- [Architecture & Trade Priority](docs/ARCHITECTURE.md)
- [IMC / ACCA / IECC Engineering Reference](docs/IMC-REFERENCE.md)
- [Agent Tools & Operations Reference](docs/AGENT-TOOLS.md)
- [3D CAD Catalog (42 Models)](docs/CAD-CATALOG.md)

## License

MIT. See [LICENSE](LICENSE).
