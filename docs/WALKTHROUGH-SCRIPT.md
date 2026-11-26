# Walkthrough Voiceover Script (`@kruschdev/pascal-plugin-hvac`)

Timed narration script synchronized to [`assets/demo-walkthrough.mp4`](../assets/demo-walkthrough.mp4) (`69.6s` narrated runtime, `1280 x 720` H.264 @ 24fps + 48 kHz AAC voiceover via `gemini-3.8-flash-tts` voice `Charon`, 149 words, singular first-person voice).

## Clean Continuous Narration Text (TTS Input)

```text
This is Pascal Plugin HVAC, an MIT plugin I built for Pascal Editor. One click sizes a complete residential or commercial system using Manual J, placing the air handler, heat pump, plenums, ERV, and smart thermostat.

Supply trunks, R-8 branches, return drops, fresh air ducts, exhaust runs, refrigerant linesets, and condensate drains route automatically in 3D, yielding around structural framing and plumbing pipes. You can isolate any mechanical layer or flip straight into a color-matched 2D floorplan.

Next, I open the interactive 3D Air Handler Cutaway inside Pascal's split pane. Orbit around the overhead joists, evaporator A-coil, ECM blower, MERV-13 filter rack, balancing dampers, and secondary pan switch, or toggle between open and closed service doors.

Every room flows into a live Manual J airflow schedule, Manual S lineset sizing, structural soffit clearances, and automatic NEC Article 440 breaker handoffs to the Electrical plugin.

Adjust labor, markup, and tax in the priced BOM with IECC envelope insulation included, backed by an instant IMC compliance audit with zero errors. Everything is MIT licensed on GitHub.
```

## Chapter-by-Chapter Beat Sheet

| Time | Chapter | Visual On Screen | Spoken Line |
|---|---|---|---|
| `0:00 - 0:11` | **1. One-Click IMC / Manual J Auto-Populate & Catalog Placement** | Two-Bedroom House -> `Auto-Populate HVAC` -> `2.5 Ton · 1000 CFM`, Air Handler, Heat Pump Condenser, Plenums, ERV, Exhaust -> Catalog Picker `Smart Wi-Fi Thermostat (18/8)` -> `+ Term` | "This is Pascal Plugin HVAC, an MIT plugin I built for Pascal Editor. One click sizes a complete residential or commercial system using Manual J, placing the air handler, heat pump, plenums, ERV, and smart thermostat." |
| `0:11 - 0:30` | **2. Priority #3 3D Duct Routing, Layer Isolation & 2D Floorplan** | 3D zoom & multi-angle orbit around blue supply trunk, cyan R-8 branches, violet return, green ERV, amber exhaust, copper lineset, and PVC condensate -> `Supply Branch` layer toggle -> `2D` schematic floorplan peek | "Supply trunks, R-8 branches, return drops, fresh air ducts, exhaust runs, refrigerant linesets, and condensate drains route automatically in 3D, yielding around structural framing and plumbing pipes. You can isolate any mechanical layer or flip straight into a color-matched 2D floorplan." |
| `0:30 - 0:47` | **3. 3D Air Handler, Plenum & Joist-Bay Cutaway** | Split-pane `3D Air Handler Cutaway` -> live 3D drag orbit -> `Cabinet Cover Off` -> `Cabinet Door Closed` -> `Joist-Bay & Open Air Handler` | "Next, I open the interactive 3D Air Handler Cutaway inside Pascal's split pane. Orbit around the overhead joists, evaporator A-coil, ECM blower, MERV-13 filter rack, balancing dampers, and secondary pan switch, or toggle between open and closed service doors." |
| `0:47 - 1:00` | **4. Manual J Schedule, Loads & Cross-Trade Power/Gas Handoff, Framing** | `Manual J (5)` room-by-room load & ductwork tables -> `Loads & Power/Gas` (`2.5 Ton`, `R-454B`, `3/8" / 3/4"`, NEC Art. 440 electrical handoff) -> `Framing & Soffits` | "Every room flows into a live Manual J airflow schedule, Manual S lineset sizing, structural soffit clearances, and automatic NEC Article 440 breaker handoffs to the Electrical plugin." |
| `1:00 - 1:09.6` | **5. Live Priced BOM + IECC Insulation & IMC/IECC Audit** | `BOM` live Labor (`115 $/hr`), Markup (`15%`), Tax (`8.25%`) edits with `IECC Insulation (R-20 / R-49)` -> `IMC Audit (0/0)` green pass banner | "Adjust labor, markup, and tax in the priced BOM with IECC envelope insulation included, backed by an instant IMC compliance audit with zero errors. Everything is MIT licensed on GitHub." |

## Synthesizing & Muxing Voiceover with Gemini TTS

Run:

```bash
bash scripts/add-voiceover.sh --voice Charon
```

Use `--dry-run` first to validate the exact `gemini-api tts` request offline at zero cost:

```bash
bash scripts/add-voiceover.sh --dry-run
```
