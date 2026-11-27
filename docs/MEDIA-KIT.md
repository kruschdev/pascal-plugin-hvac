# Media Kit and Launch Package (`@kruschdev/pascal-plugin-hvac`)

Ready-to-share narrated video, high-resolution screenshots, 42-model 3D CAD contact sheet, OpenGraph hero banner, and launch copy for [`@kruschdev/pascal-plugin-hvac`](https://github.com/kruschdev/pascal-plugin-hvac).

## Included Visual Assets

| Asset | Resolution / Format | Best Use |
|---|---|---|
| [`assets/social-preview.png`](https://github.com/kruschdev/pascal-plugin-hvac/releases/download/v0.2.0/social-preview.png) | `1280 x 640` PNG | GitHub Social Preview, OpenGraph card, LinkedIn/X link banner |
| [`assets/demo-walkthrough.mp4`](https://github.com/kruschdev/pascal-plugin-hvac/releases/download/v0.2.0/demo-walkthrough.mp4) | `1280 x 720` H.264 MP4 (`87.0s`, narrated 48 kHz AAC + `+faststart`) | X video post, LinkedIn native video, YouTube, GitHub Release |
| [`assets/demo-walkthrough.gif`](https://github.com/kruschdev/pascal-plugin-hvac/releases/download/v0.2.0/demo-walkthrough.gif) | `640px` palette-optimized GIF | README preview, Reddit, Discord, Slack |
| [`assets/demo-3d-duct-routing.png`](https://github.com/kruschdev/pascal-plugin-hvac/releases/download/v0.2.0/demo-3d-duct-routing.png) | `1440 x 810` PNG | Live Pascal Editor 3D HVAC routing, Manual J summary & Duct/Mechanical Layer rail |
| [`assets/demo-air-handler-cutaway.png`](https://github.com/kruschdev/pascal-plugin-hvac/releases/download/v0.2.0/demo-air-handler-cutaway.png) | `1920 x 760` PNG | 4-panel 3D Air Handler, Plenum & Joist-Bay Cutaway + Commercial Packaged RTU showcase |
| [`assets/demo-hvac-schedule.png`](https://github.com/kruschdev/pascal-plugin-hvac/releases/download/v0.2.0/demo-hvac-schedule.png) | `1440 x 810` PNG | Live split-pane 3D house + populated ACCA Manual J room load & ductwork schedule |
| [`assets/cad-material-catalog.png`](https://github.com/kruschdev/pascal-plugin-hvac/releases/download/v0.2.0/cad-material-catalog.png) | `1820 x 1780` PNG | Complete 42-model clean-room MIT HVAC CAD catalog contact sheet (6x7 studio grid) |
| [`assets/screenshots/`](https://github.com/kruschdev/pascal-plugin-hvac/releases/download/v0.2.0/hvac-screenshots-v0.2.0.tar.gz) | `1440 x 810` PNGs (9 shots) | Full step-by-step live editor capture set (Before Auto-Populate, 3D Routing, 2D Floorplan, Open/Closed Cutaway, Manual J, Loads & Power/Gas, Priced BOM + IECC, IMC Audit Pass) |
| [`docs/WALKTHROUGH-SCRIPT.md`](./WALKTHROUGH-SCRIPT.md) | Markdown Beat Sheet | Timed `87.0s` chapter-by-chapter narration script & TTS input text |
| [`scripts/add-voiceover.sh`](../scripts/add-voiceover.sh) | Bash (`gemini-api tts` + `ffmpeg`) | One-command Gemini TTS synthesis (`gemini-3.8-flash-tts`) and loudnorm AAC muxing into `assets/demo-walkthrough.mp4` |

## Project Facts (Quick Reference)

- **Repository**: `https://github.com/kruschdev/pascal-plugin-hvac`
- **npm Package**: `https://www.npmjs.com/package/@kruschdev/pascal-plugin-hvac` (`@kruschdev/pascal-plugin-hvac`)
- **License**: MIT (clean-room procedural Three.js geometry, zero third-party meshes)
- **Host Compatibility**: Pascal Editor Plugin API v1 (`E-014`, `E-016`, `E-017`), zero upstream core changes required
- **3D CAD Library**: 42 exported binary `.glb` models + 42 studio thumbnails across 6 categories (Heat Pumps & Furnaces, Plenums & Zone Damper Manifolds, Registers & Smart Controls, Duct Fittings & Transitions, Lineset/Condensate Accessories, and 3D Air Handler Cutaway Assemblies)
- **Live Editor Equipment & Controls**: 26 live placeable kinds (`12` `hvac:equipment`, `4` `hvac:plenum`, `10` `hvac:terminal`) plus `8` color-coded `hvac:duct-run` systems with live layer toggles, 2D floorplan symbols, interactive 3D Air Handler Cutaway, IMC/IECC audit, and contractor-priced BOM + IECC envelope insulation takeoff
- **4-Trade MEP Coordination (Priority #3)**: Reads `structural:assembly` and `bones:framing` for wall openings and dropped-soffit chases (`IRC R502.8 / R602.6 / R302.11`), routes cleanly around Priority #1 Structural beams/columns and Priority #2 Plumbing DWV/stacks, respects `NEC 110.26(E)` electrical panel space, publishes `gasBtuh` for Plumbing IFGC gas mains, and publishes standardized `electricalDemand` (`NEC Art. 440 / 424`) for automatic breaker handoff in `@kruschdev/pascal-plugin-electrical`
- **Verification**: 46/46 deterministic IMC, ACCA Manual J/D/S, ASHRAE 62.2, IECC, cross-trade 4-MEP coordination, CAD, and boundary tests (`825` assertions), `tsc --noEmit` clean, 5/5 entrypoint boundary gates, compiled Node 22 ESM + Bun `dist/` build

## Ready-to-Post Copy

### Pascal GitHub Discussions (`pascalorg/editor` -> `Show and tell`)

**Category**: `Show and tell` (`https://github.com/pascalorg/editor/discussions/categories/show-and-tell`)

**Title**: `MIT Residential & Light-Commercial IMC HVAC Plugin (@kruschdev/pascal-plugin-hvac): Manual J/D/S, 3D Duct Routing, 3D Air Handler Cutaway, IECC Insulation & 42 .glb CAD Models`

**Attachments to drag-and-drop into the GitHub Discussion editor**:
1. `assets/demo-walkthrough.mp4` (renders an inline native video player in GitHub Discussions)
2. `assets/demo-air-handler-cutaway.png`

**Body**:

I built a standalone, MIT-licensed **Residential and Light-Commercial IMC/UMC HVAC** plugin for Pascal Editor (`@kruschdev/pascal-plugin-hvac`) implementing Pascal's Plugin API v1 (`E-014`, `E-016`, `E-017`) with zero upstream core changes.

It completes the 4-trade MEP coordination stack inside Pascal alongside Structural (Priority #1), Plumbing (Priority #2), and Electrical (Priority #4), running 100% deterministically in pure TypeScript with zero cloud dependencies.

**What it ships**

- **One-click ACCA Manual J/D/S & ASHRAE 62.2 auto-populate**: Scans every room and exterior wall across all 14 ASHRAE Climate Zones (`1A` through `7`) to compute room-by-room heating and sensible/latent cooling BTU/h, select equipment tonnage (`SEER2` / `HSPF2`), A2L refrigerant linesets (`R-454B`, `R-32`, `R-410A`), continuous ERV fresh-air ventilation, bath and kitchen range-hood exhaust, and place an entire color-coded 3D duct, lineset, and gravity condensate network in one click.
- **4-trade Priority #3 3D routing & framing coordination**: Detours ductwork automatically around Structural beams/columns and Priority #2 Plumbing DWV pipes/stacks, respects `NEC 110.26(E)` dedicated electrical space down to the floor, checks wall penetrations and dropped-soffit chases against `structural:assembly` and `bones:framing` (`IRC R502.8 / R602.6 / R302.11`), publishes `gasBtuh` to Plumbing's IFGC gas main sizing, and publishes standardized `NEC Art. 440 / 424` `electricalDemand` payloads for automatic breaker handoff to `@kruschdev/pascal-plugin-electrical`.
- **Interactive 3D Air Handler, Supply/Return Plenum & Joist-Bay Cutaway**: Opens in Pascal's split-pane `HVAC Schedule` view with live orbit controls and 3 view modes (`Joist-Bay & Open Air Handler`, `Cabinet Cover Off`, `Cabinet Door Closed`) showing the evaporator A-coil, copper lineset stubs, ECM blower, MERV-13 filter rack, secondary galvanized pan with SS2 float switch (`IMC 307.2`), balancing dampers, and live room branch assignments.
- **6-tab engineering schedule & priced BOM with IECC envelope insulation**: Includes Room-by-Room Manual J & Ductwork Summary, Manual S Equipment & Cross-Trade Electrical/Gas Handoff, live IMC/IECC/Manual D Audit (`0 Errors / 0 Warnings`), Structural Framing & Soffits, Contractor-Priced BOM (labor, markup, tax, CSV, plus optional IECC wall/attic/rim-joist insulation takeoff), and the 3D Cutaway.
- **42 clean-room MIT `.glb` CAD models and 8 pure Zod agent tools**: Strict runtime boundary exports across `.`, `./render`, `./cad`, `./imc`, `./agent-tools`, and `./agent-operations`.

> Drafting and engineering aid, not stamped engineering. Always verify Manual J/D/S calculations, duct sizing, clearances, and local AHJ amendments with a licensed mechanical engineer or HVAC contractor before construction.

**Try it**

```bash
bun add @kruschdev/pascal-plugin-hvac
```

```ts
import { extendPluginDiscovery } from '@pascal-app/core'
import { registerEditorHostPanel, registerEditorHostView, registerPluginChatExtension } from '@pascal-app/editor'
import {
  hvacChatExtension,
  hvacHostPanel,
  hvacPlugin,
  hvacScheduleView,
} from '@kruschdev/pascal-plugin-hvac'

extendPluginDiscovery(async () => [hvacPlugin])
registerEditorHostPanel(hvacHostPanel)
registerEditorHostView(hvacScheduleView)
registerPluginChatExtension(hvacChatExtension)
```

Or clone and run the full deterministic check suite locally (`46/46` tests, `825` assertions, typecheck, 5/5 entry boundary gates, and compiled `dist/` build):

```bash
git clone https://github.com/kruschdev/pascal-plugin-hvac.git
cd pascal-plugin-hvac
bun install && bun run check
```

Repo (MIT): https://github.com/kruschdev/pascal-plugin-hvac

**What I would love feedback on**

1. If you run it on multi-level residential or light-commercial floorplans alongside Plumbing, Structural, or Electrical, let me know where duct routing, soffit chases, or climate-zone assumptions hit edge cases.
2. Any feedback on the Manual D friction-rate defaults, A2L refrigerant lineset tables, or IECC insulation takeoff quantities would be super helpful.

### Pascal Discord (`https://discord.gg/XRKsDcpqgS`)

Attach `assets/demo-walkthrough.mp4` or `assets/demo-walkthrough.gif`:

Hey everyone! I just put together a full walkthrough and media pack for my open-source MIT Residential and Light-Commercial HVAC plugin for Pascal Editor (`@kruschdev/pascal-plugin-hvac`, built on Plugin API v1 with zero core changes).

One click runs simplified ACCA Manual J/D/S sizing across all 14 ASHRAE climate zones, routes color-coded 3D supply, return, ERV, exhaust, R-454B linesets, and sloped PVC condensate around Structural and Plumbing obstacles, opens an interactive 3D Air Handler and Joist-Bay Cutaway inside Pascal's split pane, hands off NEC Art. 440 breaker loads straight to the Electrical plugin, and computes a live priced BOM with IECC envelope insulation and an instant IMC compliance audit. It also ships 42 clean-room MIT `.glb` CAD models and 8 pure Zod agent tools.

GitHub (MIT): https://github.com/kruschdev/pascal-plugin-hvac

Would love feedback from anyone testing it on real floorplans!

### OSArch Community (`https://community.osarch.org`)

**Title**: `Open-source MIT IMC/ACCA Manual J-D-S HVAC Plugin + 42 Procedural Three.js .glb CAD Models for Pascal Editor`

**Body**:

I built and open-sourced `@kruschdev/pascal-plugin-hvac`, a standalone MIT-licensed residential and light-commercial HVAC authoring plugin for Pascal Editor (open-source browser-first 3D AECO editor built on React Three Fiber and WebGPU).

A few technical details that may be useful to OpenBIM / AECO builders here:

- **Framework-free engineering core (`./imc`)**: Pure TypeScript implementations of room-by-room simplified ACCA Manual J heating and sensible/latent cooling loads across all 14 ASHRAE climate zones (`1A` through `7`), Manual D equal-friction duct sizing with Huebscher rectangular equivalent diameter and quiet velocity caps, Manual S equipment & A2L refrigerant lineset selection (`R-454B`, `R-32`, `R-410A`), ASHRAE 62.2 continuous ERV ventilation, IECC building envelope insulation takeoffs, and IMC/UMC compliance auditing (including segment-level IECC R403.3.1 attic duct R-8 checks, IMC 601.5 prohibited return zones, IMC 307.2 condensate slope and overflow pans, and `NEC 110.26(E)` electrical panel clearances).
- **4-trade MEP coordination (Priority #3)**: Automatically detours ductwork around Structural beams/columns and Plumbing gravity DWV drains/vents, evaluates wall openings and dropped-soffit chases against `structural:assembly` and `bones:framing` (`IRC R502.8 / R602.6 / R302.11`), publishes `gasBtuh` for Plumbing IFGC gas mains, and emits standardized `electricalDemand` payloads (`NEC Art. 440 / 424`) for automatic panel breaker coordination.
- **42 clean-room MIT `.glb` HVAC CAD models (`./cad`)**: Generated purely in Three.js with no third-party meshes, covering split heat pumps, AC condensers, variable-speed air handlers, 96% and 80% gas furnaces, commercial packaged RTUs, multi-zone mini-splits, ERVs, dehumidifiers, plenums, motorized zone damper manifolds, registers, smart thermostats, sheet-metal and flex duct fittings, lineset/condensate accessories, and open-front 3D Air Handler & Joist-Bay cutaways.
- **8 pure Zod agent tools (`./agent-tools`)**: Designed so MCP servers or headless workflows can place equipment, route ductwork, run Manual J/D/S sizing, audit IMC/IECC compliance, and export priced BOMs without pulling in React or Three.js.

Repo & walkthrough video: https://github.com/kruschdev/pascal-plugin-hvac

Drafting and engineering aid only, not stamped engineering. I would appreciate any critique on Manual J/D edge cases, A2L refrigerant requirements, or IFC / OpenBIM mechanical export interoperability.

### X (Main Video Post)

I built an open-source MIT HVAC engineering plugin for @pascal (Pascal Editor) that turns any floorplan into a sized, IMC-checked 3D mechanical model in one click.

It runs ACCA Manual J room loads across all 14 ASHRAE climate zones, routes color-coded 3D supply trunks, R-8 branches, returns, ASHRAE 62.2 ERV ducts, exhaust runs, R-454B linesets, and sloped condensate drains around structural beams and plumbing pipes, and opens a live interactive 3D Air Handler and Joist-Bay Cutaway right inside Pascal's split pane.

Every powered unit automatically hands off NEC Art. 440 breaker loads to my Electrical plugin, backed by 42 clean-room MIT `.glb` CAD models, a live priced BOM with IECC envelope insulation, and 8 pure Zod agent tools.

Repo (MIT): https://github.com/kruschdev/pascal-plugin-hvac

### LinkedIn Post

I just released an open-source MIT-licensed IMC/UMC HVAC authoring plugin for Pascal Editor (`@kruschdev/pascal-plugin-hvac`).

Starting from any architectural floorplan, one click calculates room-by-room ACCA Manual J heating and cooling loads across all 14 ASHRAE climate zones (`1A` through `7`), selects Manual S equipment capacity and A2L refrigerant linesets (`R-454B`, `R-32`, `R-410A`), sizes ASHRAE 62.2 ERV ventilation and bath/kitchen exhaust, and generates the entire 3D ductwork network.

A few engineering details I focused on:
- Four-trade MEP priority routing (Structural -> Plumbing -> HVAC -> Electrical) where ductwork automatically detours around structural beams/columns and gravity plumbing DWV pipes, evaluates framing openings and dropped-soffit chases (`IRC R502.8 / R602.6 / R302.11`), respects `NEC 110.26(E)` electrical panel space, publishes furnace `gasBtuh` to Plumbing IFGC gas mains, and hands off standardized `NEC Art. 440 / 424` breaker demands straight to `@kruschdev/pascal-plugin-electrical`.
- An interactive 3D Air Handler, Supply/Return Plenum, and Joist-Bay Cutaway inside Pascal's split-pane schedule view with live orbit controls and `Joist-Bay & Open Air Handler`, `Cabinet Cover Off`, and `Cabinet Door Closed` modes showing the evaporator A-coil, ECM blower, MERV-13 filter rack, balancing dampers, and secondary overflow pan with SS2 float switch.
- A live 6-tab engineering schedule pairing room-by-room Manual J airflow tables, Manual S sizing, framing clearances, an instant IMC/IECC compliance audit, and a contractor-priced BOM calculator with optional IECC building envelope insulation takeoffs (labor, markup, tax, and CSV export).
- A 42-model clean-room MIT `.glb` CAD library covering heat pumps, condensing furnaces, commercial packaged RTUs, multi-zone mini-splits, ERVs, zone damper manifolds, registers, smart thermostats, and duct fittings, plus 8 pure Zod agent tools with zero React or Three.js dependencies.

Code, all 42 `.glb` models, and walkthrough docs are open source under MIT: https://github.com/kruschdev/pascal-plugin-hvac

### Hacker News (`Show HN`)

**Title**: `Show HN: Open-source IMC/Manual J HVAC CAD and 3D duct routing plugin for Pascal Editor`

**Body**:
I built an open-source MIT HVAC plugin (`@kruschdev/pascal-plugin-hvac`) for Pascal Editor that implements Pascal's Plugin API v1 (`E-014` / `E-016`) as a standalone external package with zero core merges.

Given a Pascal floorplan, it computes deterministic room-by-room ACCA Manual J loads across all 14 ASHRAE climate zones, sizes Manual D equal-friction ducts (Huebscher equivalent diameter + quiet velocity caps) and Manual S equipment/R-454B linesets, routes 3D supply, return, ERV, exhaust, refrigerant lineset, and sloped condensate runs while yielding around higher-priority Structural and Plumbing obstacles, renders an interactive 3D Air Handler and Joist-Bay Cutaway inside Pascal's split pane, and produces a live 6-tab schedule, IMC/IECC compliance audit, cross-trade NEC Art. 440 electrical breaker handoff, and contractor-priced BOM with IECC envelope insulation.

It also ships 42 clean-room procedural Three.js `.glb` HVAC CAD models plus 8 pure Zod agent tools with zero React or Three.js dependencies.

Repo: https://github.com/kruschdev/pascal-plugin-hvac

## Regenerating the Full Media Kit

```bash
bun run export:cad
bun run render:cad-thumbs
bun run render:cutaway
PASCAL_EDITOR_URL=http://localhost:3210/project/<id> bun run render:walkthrough
bun run render:social
bash scripts/add-voiceover.sh --voice Charon
```
