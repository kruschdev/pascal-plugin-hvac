# Agent Tools & Operations Reference (`E-016` / `E-018`)

All 8 tools are declared as pure Zod v4 schemas in `@kruschdev/pascal-plugin-hvac/agent-tools` and executed deterministically by `@kruschdev/pascal-plugin-hvac/agent-operations`.

| Tool Name | Mutation | Purpose |
|---|---|---|
| `hvac_place_equipment` | Create | Place any of the 12 HVAC equipment types with auto-computed NEC Art. 440/424 `electricalDemand`, default mount height, and gas input (`gasBtuh`). |
| `hvac_place_plenum` | Create | Place a supply plenum, return plenum, mixing box, or motorized multi-zone damper manifold. |
| `hvac_place_terminal` | Create | Place a supply register/diffuser, return/transfer grille, fresh-air hood, mini-split wall head, smart thermostat, or zone sensor. |
| `hvac_route_duct` | Create | Auto-size (ACCA Manual D) and route a 3D duct, refrigerant lineset, or gravity-sloped 3/4" condensate drain around Structural, Plumbing, and NEC 110.26(E) obstacles. Returns length, FPM velocity, clashes, and framing clearances. |
| `hvac_autopopulate` | Replace level HVAC | One-click full building HVAC design (`split-heat-pump`, `split-gas-furnace`, `mini-split-multizone`, `rooftop-package`) with sized trunks, branches, registers, returns, thermostat, lineset, condensate drain, optional ERV, and optional bath/kitchen exhaust fans. |
| `hvac_calculate_loads` | Read-only | Compute room-by-room ACCA Manual J loads, Manual S equipment sizing, ASHRAE 62.2 ventilation, IECC insulation takeoff, furnace gas load, and Electrical power coordination rows. |
| `hvac_generate_schedule` | Read-only | Generate full Manual J schedule, duct summary, framing clearance table, priced BOM (with configurable labor rate, markup %, tax %, and IECC insulation toggle), plus CSV exports. |
| `hvac_audit_imc` | Read-only | Run the per-level IMC/UMC, ACCA Manual D, IECC R403.3.1, NEC 110.26(E), NEC 440.14, and Trade-Priority audit. |

## Schema Design Note

System-dependent fields on `hvac_route_duct` (`shape`, `material`, `width`, `height`, `diameter`, `insulationR`) and equipment-dependent fields on `hvac_place_equipment` (`coolingTons`, `gasBtuh`) are intentionally `.optional()` in Zod rather than hard-defaulted, allowing `hvacAgentOperations` to select the correct material, shape, and Manual D sizing for each system type.
