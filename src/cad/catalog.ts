/**
 * 42-Model Clean-Room MIT 3D HVAC CAD Catalog Registry (`src/cad/catalog.ts`).
 * Editor-free and React-free: zero React or `@pascal-app/editor` imports.
 */

import type { Group } from 'three'
import type { HvacEquipmentKind, HvacPlenumKind, HvacTerminalKind } from '../imc/tables'
import { type HvacFittingCadKind, buildDuctRunCad, buildHvacFittingCad } from './ducts'
import { buildHvacEquipmentCad } from './equipment'
import { buildHvacPlenumCad, buildWiredAirHandlerCutawayCad } from './plenum-cutaway'
import { buildHvacTerminalCad } from './terminals'

export type HvacCadCategory =
  | 'Heat Pumps, Furnaces & Mechanical Equipment'
  | 'Plenums & Zone Damper Manifolds'
  | 'Registers, Grilles & Smart Controls'
  | 'Duct Fittings, Boots & Transitions'
  | 'Lineset, Condensate & Electrical Accessories'
  | 'Air Handler & Joist-Bay Cutaway Assemblies'

export type HvacCadPartEntry = {
  id: string
  category: HvacCadCategory
  title: string
  codeRef: string
  build: () => Group
}

const eqEntry = (id: string, kind: HvacEquipmentKind, title: string, codeRef: string): HvacCadPartEntry => ({
  id,
  category: 'Heat Pumps, Furnaces & Mechanical Equipment',
  title,
  codeRef,
  build: () => buildHvacEquipmentCad({ equipmentKind: kind }),
})

const plEntry = (id: string, kind: HvacPlenumKind, title: string, codeRef: string): HvacCadPartEntry => ({
  id,
  category: 'Plenums & Zone Damper Manifolds',
  title,
  codeRef,
  build: () => buildHvacPlenumCad({ plenumKind: kind }),
})

const termEntry = (id: string, kind: HvacTerminalKind, title: string, codeRef: string): HvacCadPartEntry => ({
  id,
  category: 'Registers, Grilles & Smart Controls',
  title,
  codeRef,
  build: () => buildHvacTerminalCad({ terminalKind: kind }),
})

const fitEntry = (
  id: string,
  kind: HvacFittingCadKind,
  category: HvacCadCategory,
  title: string,
  codeRef: string,
): HvacCadPartEntry => ({
  id,
  category,
  title,
  codeRef,
  build: () => buildHvacFittingCad(kind),
})

export const HVAC_CAD_CATALOG: readonly HvacCadPartEntry[] = [
  // Category 1: Equipment (12)
  eqEntry('equip-heat-pump-condenser', 'heat-pump-condenser', '3-Ton Split Heat Pump Condenser (SEER2)', 'ACCA Manual S / NEC 440'),
  eqEntry('equip-ac-condenser', 'ac-condenser', '3-Ton Split AC Condenser (SEER2)', 'ACCA Manual S / NEC 440'),
  eqEntry('equip-air-handler', 'air-handler', 'Variable-Speed Air Handler w/ A-Coil', 'IMC 307 / NEC 424'),
  eqEntry('equip-gas-furnace-96', 'gas-furnace-96', '96% AFUE Condensing Gas Furnace + Coil', 'IMC 918 / IFGC 402'),
  eqEntry('equip-gas-furnace-80', 'gas-furnace-80', '80% AFUE Gas Furnace + Evaporator Coil', 'IMC 918 / IFGC 402'),
  eqEntry('equip-rooftop-rtu', 'rooftop-package-unit', 'Commercial Packaged Rooftop Unit (RTU)', 'IMC 306.5 / NEC 440'),
  eqEntry('equip-mini-split-outdoor', 'mini-split-outdoor', 'Inverter Multi-Zone Mini-Split Outdoor Unit', 'ACCA Manual S / NEC 440'),
  eqEntry('equip-mini-split-indoor', 'mini-split-indoor', 'Ductless Mini-Split Wall Evaporator Head', 'IMC 307 / 1107'),
  eqEntry('equip-erv-ventilator', 'erv-ventilator', 'ASHRAE 62.2 Energy Recovery Ventilator (ERV)', 'ASHRAE 62.2 / IMC 403'),
  eqEntry('equip-whole-house-dehumidifier', 'dehumidifier-whole-house', 'Whole-House Ducted Dehumidifier', 'IMC 307.2'),
  eqEntry('equip-bath-exhaust-fan', 'bath-exhaust-fan', '80 CFM Ultra-Quiet Bath Exhaust Fan', 'IMC Table 403.3.1.1'),
  eqEntry('equip-range-hood', 'range-hood', 'Vented Kitchen Range Exhaust Hood (250 CFM)', 'IMC 505.4'),

  // Category 2: Plenums & Zone Dampers (4)
  plEntry('plenum-supply', 'supply-plenum', 'Insulated Sheet-Metal Supply Plenum', 'IMC 603 / Manual D'),
  plEntry('plenum-return', 'return-plenum', 'Insulated Return Air Plenum & Filter Box', 'IMC 601 / Manual D'),
  plEntry('plenum-mixing-box', 'mixing-box', 'Fresh-Air / Return Mixing Box', 'ASHRAE 62.2 / IMC 403'),
  plEntry('plenum-zone-damper-manifold', 'zone-damper-manifold', 'Motorized Multi-Zone Damper Trunk Manifold', 'ACCA Manual Zr'),

  // Category 3: Registers, Grilles & Smart Controls (10)
  termEntry('term-supply-floor-register', 'supply-floor-register', '4x10 Steel Floor Supply Register + Boot', 'ACCA Manual T'),
  termEntry('term-supply-ceiling-diffuser', 'supply-ceiling-diffuser', 'Ceiling 4-Way Supply Diffuser + Collar', 'ACCA Manual T'),
  termEntry('term-supply-wall-register', 'supply-wall-register', 'High-Sidewall Supply Register', 'ACCA Manual T'),
  termEntry('term-return-grille', 'return-grille', 'Filter-Back Central Return Air Grille', 'IMC 601 / Manual D'),
  termEntry('term-transfer-grille', 'transfer-grille', 'Bedroom Return Air Transfer Grille', 'ACCA Manual D'),
  termEntry('term-exhaust-grille', 'exhaust-grille', 'Bath / Utility Ceiling Exhaust Grille', 'IMC 403.3'),
  termEntry('term-fresh-air-intake', 'fresh-air-intake', 'Exterior Weatherproof Fresh-Air Intake Hood', 'ASHRAE 62.2'),
  termEntry('term-mini-split-head', 'mini-split-wall-head', 'Ductless Mini-Split Wall Head', 'ACCA Manual T'),
  termEntry('term-smart-thermostat', 'smart-thermostat', 'Smart Wi-Fi Heat Pump Thermostat (18/8)', 'IECC R403.1'),
  termEntry('term-zone-sensor', 'zone-sensor', 'Remote Room Temperature / Humidity Sensor', 'ACCA Manual Zr'),

  // Category 4: Duct Fittings, Boots & Transitions (9)
  fitEntry('fit-rect-elbow-90', 'rect-elbow-90', 'Duct Fittings, Boots & Transitions', 'Rectangular Galvanized 90° Trunk Elbow', 'SMACNA / Manual D'),
  fitEntry('fit-rect-transition', 'rect-transition-reducer', 'Duct Fittings, Boots & Transitions', 'Sheet-Metal Trunk Transition Reducer', 'SMACNA / Manual D'),
  fitEntry('fit-round-wye', 'round-wye-branch', 'Duct Fittings, Boots & Transitions', 'Galvanized 45° Round Duct Wye Branch', 'ACCA Manual D'),
  fitEntry('fit-start-collar-damper', 'start-collar-damper', 'Duct Fittings, Boots & Transitions', 'Takeoff Start Collar w/ Manual Balancing Damper', 'ACCA Manual D'),
  fitEntry('fit-end-boot-floor', 'end-boot-floor', 'Duct Fittings, Boots & Transitions', '4x10 Floor Register Straight End Boot', 'SMACNA'),
  fitEntry('fit-ceiling-register-box', 'ceiling-register-box', 'Duct Fittings, Boots & Transitions', 'R-8 Insulated Ceiling Diffuser Register Box', 'IECC R403.3.1'),
  fitEntry('fit-zone-damper-round', 'zone-damper-round', 'Duct Fittings, Boots & Transitions', 'Motorized 24V Round Zone Damper', 'ACCA Manual Zr'),
  fitEntry('fit-flex-duct-r8', 'flex-duct-coil', 'Duct Fittings, Boots & Transitions', 'R-8 Insulated Flexible Branch Duct Section', 'IECC R403.3.1 / IMC 603.6'),
  fitEntry('fit-roof-jack-cap', 'roof-jack-vent-cap', 'Duct Fittings, Boots & Transitions', 'Roof Exhaust Vent Jack w/ Backdraft Damper', 'IMC 501.3'),

  // Category 5: Lineset, Condensate & Electrical Accessories (5)
  fitEntry('acc-condenser-pad', 'condenser-pad', 'Lineset, Condensate & Electrical Accessories', 'Composite Condenser Equipment Pad (36x36)', 'IMC 304.10'),
  fitEntry('acc-disconnect-60a', 'ac-disconnect-box', 'Lineset, Condensate & Electrical Accessories', '60A Non-Fused Weatherproof AC Disconnect', 'NEC 440.14'),
  fitEntry('acc-lineset-insulated', 'lineset-port-kit', 'Lineset, Condensate & Electrical Accessories', 'Insulated Copper Refrigerant Lineset Pair', 'IMC 1107 / IECC R403.4'),
  fitEntry('acc-condensate-trap-ss2', 'condensate-p-trap-ss2', 'Lineset, Condensate & Electrical Accessories', '3/4" PVC Condensate P-Trap & SS2 Float Switch', 'IMC 307.2.3'),
  fitEntry('acc-merv13-filter-rack', 'merv13-filter-rack', 'Lineset, Condensate & Electrical Accessories', 'MERV-13 4" Media Air Cleaner Filter Rack', 'ASHRAE 62.2'),

  // Category 6: Air Handler & Joist-Bay Cutaway Assemblies (2)
  {
    id: 'assembly-air-handler-joist-cutaway',
    category: 'Air Handler & Joist-Bay Cutaway Assemblies',
    title: '3D Air Handler, Supply/Return Plenum & Joist-Bay Cutaway',
    codeRef: 'IMC 307 / Manual D / IRC R502.8',
    build: () => buildWiredAirHandlerCutawayCad({ coolingTons: 3, viewMode: 'joist-bay-cutaway' }),
  },
  {
    id: 'assembly-air-handler-open-plenum',
    category: 'Air Handler & Joist-Bay Cutaway Assemblies',
    title: '3D Air Handler Cover-Off Evaporator A-Coil & Blower View',
    codeRef: 'IMC 306 / 307',
    build: () => buildWiredAirHandlerCutawayCad({ coolingTons: 3, viewMode: 'open-plenum' }),
  },
] as const

export function buildHvacCadPart(partId: string): Group | null {
  const entry = HVAC_CAD_CATALOG.find((p) => p.id === partId)
  return entry ? entry.build() : null
}

export { buildDuctRunCad }
