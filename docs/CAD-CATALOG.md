# 3D CAD Catalog (`@kruschdev/pascal-plugin-hvac/cad`)

I authored all **42 procedural Three.js 3D CAD parts** clean-room under the MIT license with zero external mesh dependencies. Run `bun run export:cad` to export every part as a binary `.glb` asset at `assets/cad/<id>.glb`. Every slug below matches `HVAC_CAD_CATALOG` in `src/cad/catalog.ts` 1:1.

## Inventory by Category (42 Total)

### 1. Heat Pumps, Furnaces & Mechanical Equipment (12)

| Slug (`id`) | Title | Code Reference |
|---|---|---|
| `equip-heat-pump-condenser` | 3-Ton Split Heat Pump Condenser (SEER2) | ACCA Manual S / NEC 440 |
| `equip-ac-condenser` | 3-Ton Split AC Condenser (SEER2) | ACCA Manual S / NEC 440 |
| `equip-air-handler` | Variable-Speed Air Handler w/ A-Coil | IMC 307 / NEC 424 |
| `equip-gas-furnace-96` | 96% AFUE Condensing Gas Furnace + Coil | IMC 918 / IFGC 402 |
| `equip-gas-furnace-80` | 80% AFUE Gas Furnace + Evaporator Coil | IMC 918 / IFGC 402 |
| `equip-rooftop-rtu` | Commercial Packaged Rooftop Unit (RTU) | IMC 306.5 / NEC 440 |
| `equip-mini-split-outdoor` | Inverter Multi-Zone Mini-Split Outdoor Unit | ACCA Manual S / NEC 440 |
| `equip-mini-split-indoor` | Ductless Mini-Split Wall Evaporator Head | IMC 307 / 1107 |
| `equip-erv-ventilator` | ASHRAE 62.2 Energy Recovery Ventilator (ERV) | ASHRAE 62.2 / IMC 403 |
| `equip-whole-house-dehumidifier` | Whole-House Ducted Dehumidifier | IMC 307.2 |
| `equip-bath-exhaust-fan` | 80 CFM Ultra-Quiet Bath Exhaust Fan | IMC Table 403.3.1.1 |
| `equip-range-hood` | Vented Kitchen Range Exhaust Hood (250 CFM) | IMC 505.4 |

### 2. Plenums & Zone Damper Manifolds (4)

| Slug (`id`) | Title | Code Reference |
|---|---|---|
| `plenum-supply` | Insulated Sheet-Metal Supply Plenum | IMC 603 / Manual D |
| `plenum-return` | Insulated Return Air Plenum & Filter Box | IMC 601 / Manual D |
| `plenum-mixing-box` | Fresh-Air / Return Mixing Box | ASHRAE 62.2 / IMC 403 |
| `plenum-zone-damper-manifold` | Motorized Multi-Zone Damper Trunk Manifold | ACCA Manual Zr |

### 3. Registers, Grilles & Smart Controls (10)

| Slug (`id`) | Title | Code Reference |
|---|---|---|
| `term-supply-floor-register` | 4x10 Steel Floor Supply Register + Boot | ACCA Manual T |
| `term-supply-ceiling-diffuser` | Ceiling 4-Way Supply Diffuser + Collar | ACCA Manual T |
| `term-supply-wall-register` | High-Sidewall Supply Register | ACCA Manual T |
| `term-return-grille` | Filter-Back Central Return Air Grille | IMC 601 / Manual D |
| `term-transfer-grille` | Bedroom Return Air Transfer Grille | ACCA Manual D |
| `term-exhaust-grille` | Bath / Utility Ceiling Exhaust Grille | IMC 403.3 |
| `term-fresh-air-intake` | Exterior Weatherproof Fresh-Air Intake Hood | ASHRAE 62.2 |
| `term-mini-split-head` | Ductless Mini-Split Wall Head | ACCA Manual T |
| `term-smart-thermostat` | Smart Wi-Fi Heat Pump Thermostat (18/8) | IECC R403.1 |
| `term-zone-sensor` | Remote Room Temperature / Humidity Sensor | ACCA Manual Zr |

### 4. Duct Fittings, Boots & Transitions (9)

| Slug (`id`) | Title | Code Reference |
|---|---|---|
| `fit-rect-elbow-90` | Rectangular Galvanized 90 deg Trunk Elbow | SMACNA / Manual D |
| `fit-rect-transition` | Sheet-Metal Trunk Transition Reducer | SMACNA / Manual D |
| `fit-round-wye` | Galvanized 45 deg Round Duct Wye Branch | ACCA Manual D |
| `fit-start-collar-damper` | Takeoff Start Collar w/ Manual Balancing Damper | ACCA Manual D |
| `fit-end-boot-floor` | 4x10 Floor Register Straight End Boot | SMACNA |
| `fit-ceiling-register-box` | R-8 Insulated Ceiling Diffuser Register Box | IECC R403.3.1 |
| `fit-zone-damper-round` | Motorized 24V Round Zone Damper | ACCA Manual Zr |
| `fit-flex-duct-r8` | R-8 Insulated Flexible Branch Duct Section | IECC R403.3.1 / IMC 603.6 |
| `fit-roof-jack-cap` | Roof Exhaust Vent Jack w/ Backdraft Damper | IMC 501.3 |

### 5. Lineset, Condensate & Electrical Accessories (5)

| Slug (`id`) | Title | Code Reference |
|---|---|---|
| `acc-condenser-pad` | Composite Condenser Equipment Pad (36x36) | IMC 304.10 |
| `acc-disconnect-60a` | 60A Non-Fused Weatherproof AC Disconnect | NEC 440.14 |
| `acc-lineset-insulated` | Insulated Copper Refrigerant Lineset Pair | IMC 1107 / IECC R403.4 |
| `acc-condensate-trap-ss2` | 3/4" PVC Condensate P-Trap & SS2 Float Switch | IMC 307.2.3 |
| `acc-merv13-filter-rack` | MERV-13 4" Media Air Cleaner Filter Rack | ASHRAE 62.2 |

### 6. Air Handler & Joist-Bay Cutaway Assemblies (2)

| Slug (`id`) | Title | Code Reference |
|---|---|---|
| `assembly-air-handler-joist-cutaway` | 3D Air Handler, Supply/Return Plenum & Joist-Bay Cutaway | IMC 307 / Manual D / IRC R502.8 |
| `assembly-air-handler-open-plenum` | 3D Air Handler Cover-Off Evaporator A-Coil & Blower View | IMC 306 / 307 |
