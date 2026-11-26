# Walkthrough Voiceover Script (`@kruschdev/pascal-plugin-hvac`)

Timed narration script synchronized to [`assets/demo-walkthrough.mp4`](../assets/demo-walkthrough.mp4) (`87.0s` narrated runtime, `1280 x 720` H.264 @ 24fps + 48 kHz AAC voiceover via `gemini-3.8-flash-tts` voice `Charon`, 183 words, singular first-person voice).

## Clean Continuous Narration Text (TTS Input)

```text
This is Pascal Plugin HVAC, an MIT plugin I built for Pascal Editor. Starting from the same residential floorplan with a live Plumbing Mechanical Room, one click runs Manual J sizing and places the air handler, plenums, and ERV right inside the mechanical room, cleanly clear of the water heater and PEX manifold, with the heat pump condenser outside clear of the gas meter.

Supply trunks, R-8 branches, return drops, fresh air ducts, exhaust runs, refrigerant linesets, and condensate drains route automatically in 3D, stepping cleanly around plumbing pipes and structural framing. Isolate any mechanical layer or flip straight into a color-matched 2D floorplan.

Next, I open the interactive 3D Air Handler Cutaway inside Pascal's split pane. Orbit around the overhead joists, evaporator A-coil, ECM blower, MERV-13 filter rack, balancing dampers, and secondary pan switch, or toggle between open and closed service doors.

Every room flows into a live Manual J airflow schedule, Manual S lineset sizing, structural soffit clearances, and automatic NEC Article 440 breaker handoffs to the Electrical plugin.

Adjust labor, markup, and tax in the priced BOM with IECC envelope insulation included, backed by an instant IMC compliance audit with zero errors. Everything is MIT licensed on GitHub.
```

## Chapter-by-Chapter Beat Sheet

| Time | Chapter | Visual On Screen | Spoken Line |
|---|---|---|---|
| `0:00 - 0:14` | **1. One-Click IMC / Manual J Auto-Populate in Shared Mechanical Room** | Shared Residential Mechanical Room + Live Plumbing -> `Auto-Populate HVAC` -> `3.5 Ton · 1400 CFM`, Air Handler & ERV inside Mechanical Room clear of Water Heater & PEX Manifold, Heat Pump Condenser on West wall clear of Gas Meter -> Catalog Picker `Smart Wi-Fi Thermostat (18/8)` -> `+ Term` | "This is Pascal Plugin HVAC, an MIT plugin I built for Pascal Editor. Starting from the same residential floorplan with a live Plumbing Mechanical Room, one click runs Manual J sizing and places the air handler, plenums, and ERV right inside the mechanical room, cleanly clear of the water heater and PEX manifold, with the heat pump condenser outside clear of the gas meter." |
| `0:14 - 0:37` | **2. Priority #3 3D Duct Routing, Layer Isolation & 2D Floorplan** | 3D zoom & multi-angle orbit around blue 28"x8" supply trunk, cyan R-8 branches, violet 30"x10" return, green ERV, amber exhaust, copper lineset, and PVC condensate stepping around Plumbing DWV & PEX -> `Supply Branch` layer toggle -> `2D` schematic floorplan peek | "Supply trunks, R-8 branches, return drops, fresh air ducts, exhaust runs, refrigerant linesets, and condensate drains route automatically in 3D, stepping cleanly around plumbing pipes and structural framing. Isolate any mechanical layer or flip straight into a color-matched 2D floorplan." |
| `0:37 - 0:58` | **3. 3D Air Handler, Plenum & Joist-Bay Cutaway** | Split-pane `3D Air Handler Cutaway` -> live 3D drag orbit -> `Cabinet Cover Off` -> `Cabinet Door Closed` -> `Joist-Bay & Open Air Handler` | "Next, I open the interactive 3D Air Handler Cutaway inside Pascal's split pane. Orbit around the overhead joists, evaporator A-coil, ECM blower, MERV-13 filter rack, balancing dampers, and secondary pan switch, or toggle between open and closed service doors." |
| `0:58 - 1:14` | **4. Manual J Schedule, Loads & Cross-Trade Power/Gas Handoff, Framing** | `Manual J (7)` room-by-room load & ductwork tables -> `Loads & Power/Gas` (`3.5 Ton`, `R-454B`, NEC Art. 440 electrical handoff) -> `Framing & Soffits` | "Every room flows into a live Manual J airflow schedule, Manual S lineset sizing, structural soffit clearances, and automatic NEC Article 440 breaker handoffs to the Electrical plugin." |
| `1:14 - 1:27.0` | **5. Live Priced BOM + IECC Insulation & IMC/IECC Audit** | `BOM` live Labor (`115 $/hr`), Markup (`15%`), Tax (`8.25%`) edits with `IECC Insulation (R-20 / R-49)` -> `IMC Audit (0/0)` green pass banner | "Adjust labor, markup, and tax in the priced BOM with IECC envelope insulation included, backed by an instant IMC compliance audit with zero errors. Everything is MIT licensed on GitHub." |

## Synthesizing & Muxing Voiceover with Gemini TTS

Run:

```bash
bash scripts/add-voiceover.sh --voice Charon
```

Use `--dry-run` first to validate the exact `gemini-api tts` request offline at zero cost:

```bash
bash scripts/add-voiceover.sh --dry-run
```
