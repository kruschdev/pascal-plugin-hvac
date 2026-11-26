/**
 * Pure IMC / UMC / ACCA Manual J-D-S / ASHRAE 62.2 / IECC Engineering Tables (`src/imc/tables.ts`).
 * Framework-free: zero React, Three.js, or `@pascal-app/*` imports.
 */

export const INCHES_TO_METERS = 0.0254
export const FEET_TO_METERS = 0.3048
export const METERS_TO_FEET = 3.280839895
export const SQM_TO_SQFT = 10.763910417

export type CodeEdition = 'IMC-2021' | 'UMC-2021'
export type OccupancyType = 'residential' | 'commercial'
export type ClimateZone =
  | '1A'
  | '2A'
  | '2B'
  | '3A'
  | '3B'
  | '3C'
  | '4A'
  | '4B'
  | '4C'
  | '5A'
  | '5B'
  | '6A'
  | '6B'
  | '7'

export type HvacSystemType =
  | 'split-heat-pump'
  | 'split-gas-furnace'
  | 'mini-split-multizone'
  | 'rooftop-package'

export type DuctPlenumLocation = 'attic' | 'crawlspace' | 'basement' | 'conditioned-soffit'

export type HvacEquipmentKind =
  | 'heat-pump-condenser'
  | 'ac-condenser'
  | 'air-handler'
  | 'gas-furnace-96'
  | 'gas-furnace-80'
  | 'rooftop-package-unit'
  | 'mini-split-outdoor'
  | 'mini-split-indoor'
  | 'erv-ventilator'
  | 'dehumidifier-whole-house'
  | 'bath-exhaust-fan'
  | 'range-hood'

export type HvacPlenumKind =
  | 'supply-plenum'
  | 'return-plenum'
  | 'mixing-box'
  | 'zone-damper-manifold'

export type HvacTerminalKind =
  | 'supply-floor-register'
  | 'supply-ceiling-diffuser'
  | 'supply-wall-register'
  | 'return-grille'
  | 'transfer-grille'
  | 'exhaust-grille'
  | 'fresh-air-intake'
  | 'mini-split-wall-head'
  | 'smart-thermostat'
  | 'zone-sensor'

export type HvacDuctSystem =
  | 'supply-trunk'
  | 'supply-branch'
  | 'return-trunk'
  | 'return-branch'
  | 'fresh-air-erv'
  | 'exhaust-duct'
  | 'refrigerant-lineset'
  | 'condensate-drain'

export type DuctMaterial =
  | 'galvanized-sheet'
  | 'flex-r8'
  | 'flex-r6'
  | 'ductboard'
  | 'insulated-copper'
  | 'pvc-condensate'

export type DuctShape = 'rectangular' | 'round'
export type RefrigerantType = 'R-454B' | 'R-32' | 'R-410A'

export type ClimateZoneSpec = {
  code: ClimateZone
  label: string
  /** Simplified ACCA Manual J heating load factor (BTU/hr per sq ft at R-19 baseline). */
  heatingBtuPerSqft: number
  /** Simplified ACCA Manual J cooling load factor (BTU/hr per sq ft at R-19 baseline). */
  coolingBtuPerSqft: number
  /** IECC 2021 minimum attic ceiling R-value. */
  ieccAtticR: number
  /** IECC 2021 minimum wood-frame wall cavity R-value. */
  ieccWallR: number
  /** IECC R403.3.1 minimum unconditioned attic supply duct R-value. */
  ieccAtticDuctR: number
  /** IECC R403.3.1 minimum crawlspace/basement duct R-value. */
  ieccCrawlDuctR: number
  /** True for humid zones requiring dehumidification / tighter latent load share. */
  humid: boolean
}

export const CLIMATE_ZONES: Readonly<Record<ClimateZone, ClimateZoneSpec>> = {
  '1A': { code: '1A', label: 'Very Hot-Humid (Miami)', heatingBtuPerSqft: 15, coolingBtuPerSqft: 35, ieccAtticR: 30, ieccWallR: 13, ieccAtticDuctR: 8, ieccCrawlDuctR: 6, humid: true },
  '2A': { code: '2A', label: 'Hot-Humid (Houston)', heatingBtuPerSqft: 20, coolingBtuPerSqft: 30, ieccAtticR: 38, ieccWallR: 13, ieccAtticDuctR: 8, ieccCrawlDuctR: 6, humid: true },
  '2B': { code: '2B', label: 'Hot-Dry (Phoenix)', heatingBtuPerSqft: 20, coolingBtuPerSqft: 32, ieccAtticR: 38, ieccWallR: 13, ieccAtticDuctR: 8, ieccCrawlDuctR: 6, humid: false },
  '3A': { code: '3A', label: 'Warm-Humid (Atlanta)', heatingBtuPerSqft: 25, coolingBtuPerSqft: 25, ieccAtticR: 38, ieccWallR: 20, ieccAtticDuctR: 8, ieccCrawlDuctR: 6, humid: true },
  '3B': { code: '3B', label: 'Warm-Dry (Las Vegas)', heatingBtuPerSqft: 22, coolingBtuPerSqft: 28, ieccAtticR: 38, ieccWallR: 20, ieccAtticDuctR: 8, ieccCrawlDuctR: 6, humid: false },
  '3C': { code: '3C', label: 'Warm-Marine (San Francisco)', heatingBtuPerSqft: 22, coolingBtuPerSqft: 20, ieccAtticR: 38, ieccWallR: 20, ieccAtticDuctR: 8, ieccCrawlDuctR: 6, humid: false },
  '4A': { code: '4A', label: 'Mixed-Humid (DC / Nashville)', heatingBtuPerSqft: 30, coolingBtuPerSqft: 22, ieccAtticR: 49, ieccWallR: 20, ieccAtticDuctR: 8, ieccCrawlDuctR: 6, humid: true },
  '4B': { code: '4B', label: 'Mixed-Dry (Albuquerque)', heatingBtuPerSqft: 28, coolingBtuPerSqft: 25, ieccAtticR: 49, ieccWallR: 20, ieccAtticDuctR: 8, ieccCrawlDuctR: 6, humid: false },
  '4C': { code: '4C', label: 'Mixed-Marine (Seattle)', heatingBtuPerSqft: 28, coolingBtuPerSqft: 18, ieccAtticR: 49, ieccWallR: 20, ieccAtticDuctR: 8, ieccCrawlDuctR: 6, humid: false },
  '5A': { code: '5A', label: 'Cool-Humid (Chicago)', heatingBtuPerSqft: 35, coolingBtuPerSqft: 20, ieccAtticR: 49, ieccWallR: 20, ieccAtticDuctR: 8, ieccCrawlDuctR: 6, humid: true },
  '5B': { code: '5B', label: 'Cool-Dry (Denver)', heatingBtuPerSqft: 32, coolingBtuPerSqft: 22, ieccAtticR: 49, ieccWallR: 20, ieccAtticDuctR: 8, ieccCrawlDuctR: 6, humid: false },
  '6A': { code: '6A', label: 'Cold-Humid (Minneapolis)', heatingBtuPerSqft: 40, coolingBtuPerSqft: 18, ieccAtticR: 60, ieccWallR: 20, ieccAtticDuctR: 8, ieccCrawlDuctR: 6, humid: true },
  '6B': { code: '6B', label: 'Cold-Dry (Helena)', heatingBtuPerSqft: 38, coolingBtuPerSqft: 18, ieccAtticR: 60, ieccWallR: 20, ieccAtticDuctR: 8, ieccCrawlDuctR: 6, humid: false },
  '7': { code: '7', label: 'Very Cold (Duluth)', heatingBtuPerSqft: 45, coolingBtuPerSqft: 15, ieccAtticR: 60, ieccWallR: 21, ieccAtticDuctR: 8, ieccCrawlDuctR: 6, humid: false },
}

/** Standard round duct trade diameters (inches) per ACCA Manual D. */
export const ROUND_DUCT_SIZES_IN = [4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 22, 24] as const

/** ACCA Manual D residential & commercial maximum recommended duct velocities (FPM). */
export const MAX_DUCT_VELOCITY_FPM: Readonly<
  Record<
    OccupancyType,
    {
      supplyTrunk: number
      supplyBranch: number
      returnTrunk: number
      returnBranch: number
      exhaust: number
      freshAir: number
    }
  >
> = {
  residential: {
    supplyTrunk: 900,
    supplyBranch: 700,
    returnTrunk: 700,
    returnBranch: 600,
    exhaust: 800,
    freshAir: 700,
  },
  commercial: {
    supplyTrunk: 1400,
    supplyBranch: 1000,
    returnTrunk: 1100,
    returnBranch: 900,
    exhaust: 1200,
    freshAir: 1000,
  },
}

/** Refrigerant lineset trade sizing by nominal cooling tonnage (R-454B / R-32 / R-410A, <= 50 ft equivalent). */
export const REFRIGERANT_LINESET_TABLE: ReadonlyArray<{
  maxTons: number
  liquidIn: string
  suctionIn: string
  maxEquivLengthFt: number
}> = [
  { maxTons: 2.0, liquidIn: '3/8"', suctionIn: '3/4"', maxEquivLengthFt: 50 },
  { maxTons: 3.0, liquidIn: '3/8"', suctionIn: '3/4"', maxEquivLengthFt: 50 },
  { maxTons: 4.0, liquidIn: '3/8"', suctionIn: '7/8"', maxEquivLengthFt: 50 },
  { maxTons: 5.0, liquidIn: '3/8"', suctionIn: '1-1/8"', maxEquivLengthFt: 50 },
  { maxTons: 10.0, liquidIn: '1/2"', suctionIn: '1-3/8"', maxEquivLengthFt: 75 },
  { maxTons: 20.0, liquidIn: '5/8"', suctionIn: '1-5/8"', maxEquivLengthFt: 100 },
]

export type EquipmentNominalSpec = {
  kind: HvacEquipmentKind
  label: string
  dimensionsM: readonly [number, number, number] // [width, height, depth]
  isOutdoor: boolean
  needsCondensate: boolean
  usesFuelGas: boolean
  defaultMountY: number
}

export const HVAC_EQUIPMENT_SPECS: Readonly<Record<HvacEquipmentKind, EquipmentNominalSpec>> = {
  'heat-pump-condenser': {
    kind: 'heat-pump-condenser',
    label: 'Split Heat Pump Condenser',
    dimensionsM: [0.84, 0.92, 0.84],
    isOutdoor: true,
    needsCondensate: false,
    usesFuelGas: false,
    defaultMountY: 0,
  },
  'ac-condenser': {
    kind: 'ac-condenser',
    label: 'Split AC Condenser',
    dimensionsM: [0.80, 0.86, 0.80],
    isOutdoor: true,
    needsCondensate: false,
    usesFuelGas: false,
    defaultMountY: 0,
  },
  'air-handler': {
    kind: 'air-handler',
    label: 'Electric Air Handler w/ A-Coil',
    dimensionsM: [0.56, 1.38, 0.56],
    isOutdoor: false,
    needsCondensate: true,
    usesFuelGas: false,
    defaultMountY: 0,
  },
  'gas-furnace-96': {
    kind: 'gas-furnace-96',
    label: '96% AFUE Condensing Gas Furnace + Coil',
    dimensionsM: [0.54, 1.42, 0.72],
    isOutdoor: false,
    needsCondensate: true,
    usesFuelGas: true,
    defaultMountY: 0,
  },
  'gas-furnace-80': {
    kind: 'gas-furnace-80',
    label: '80% AFUE Gas Furnace + Evaporator Coil',
    dimensionsM: [0.54, 1.42, 0.72],
    isOutdoor: false,
    needsCondensate: true,
    usesFuelGas: true,
    defaultMountY: 0,
  },
  'rooftop-package-unit': {
    kind: 'rooftop-package-unit',
    label: 'Packaged Rooftop Unit (RTU)',
    dimensionsM: [1.55, 1.05, 1.15],
    isOutdoor: true,
    needsCondensate: true,
    usesFuelGas: false,
    defaultMountY: 0,
  },
  'mini-split-outdoor': {
    kind: 'mini-split-outdoor',
    label: 'Inverter Mini-Split Outdoor Heat Pump',
    dimensionsM: [0.92, 0.78, 0.36],
    isOutdoor: true,
    needsCondensate: false,
    usesFuelGas: false,
    defaultMountY: 0,
  },
  'mini-split-indoor': {
    kind: 'mini-split-indoor',
    label: 'Ductless Mini-Split Wall Head',
    dimensionsM: [0.88, 0.30, 0.24],
    isOutdoor: false,
    needsCondensate: true,
    usesFuelGas: false,
    defaultMountY: 2.15,
  },
  'erv-ventilator': {
    kind: 'erv-ventilator',
    label: 'Energy Recovery Ventilator (ERV)',
    dimensionsM: [0.64, 0.52, 0.44],
    isOutdoor: false,
    needsCondensate: false,
    usesFuelGas: false,
    defaultMountY: 1.85,
  },
  'dehumidifier-whole-house': {
    kind: 'dehumidifier-whole-house',
    label: 'Whole-House Ducted Dehumidifier',
    dimensionsM: [0.56, 0.42, 0.38],
    isOutdoor: false,
    needsCondensate: true,
    usesFuelGas: false,
    defaultMountY: 1.6,
  },
  'bath-exhaust-fan': {
    kind: 'bath-exhaust-fan',
    label: 'Bath Exhaust Fan (80 CFM Ultra-Quiet)',
    dimensionsM: [0.30, 0.18, 0.30],
    isOutdoor: false,
    needsCondensate: false,
    usesFuelGas: false,
    defaultMountY: 2.55,
  },
  'range-hood': {
    kind: 'range-hood',
    label: 'Kitchen Range Exhaust Hood (250 CFM)',
    dimensionsM: [0.76, 0.32, 0.50],
    isOutdoor: false,
    needsCondensate: false,
    usesFuelGas: false,
    defaultMountY: 1.78,
  },
}

export type TerminalNominalSpec = {
  kind: HvacTerminalKind
  label: string
  dimensionsM: readonly [number, number, number]
  defaultMountY: number
  defaultNeckIn: number
  defaultCfm: number
}

export const HVAC_TERMINAL_SPECS: Readonly<Record<HvacTerminalKind, TerminalNominalSpec>> = {
  'supply-floor-register': {
    kind: 'supply-floor-register',
    label: '4x10 Floor Supply Register',
    dimensionsM: [0.28, 0.04, 0.14],
    defaultMountY: 0.02,
    defaultNeckIn: 6,
    defaultCfm: 110,
  },
  'supply-ceiling-diffuser': {
    kind: 'supply-ceiling-diffuser',
    label: 'Ceiling 4-Way Supply Diffuser',
    dimensionsM: [0.32, 0.06, 0.32],
    defaultMountY: 2.58,
    defaultNeckIn: 6,
    defaultCfm: 115,
  },
  'supply-wall-register': {
    kind: 'supply-wall-register',
    label: 'High-Sidewall Supply Register',
    dimensionsM: [0.30, 0.16, 0.06],
    defaultMountY: 2.25,
    defaultNeckIn: 6,
    defaultCfm: 110,
  },
  'return-grille': {
    kind: 'return-grille',
    label: 'Filter-Back Return Air Grille',
    dimensionsM: [0.56, 0.56, 0.08],
    defaultMountY: 2.15,
    defaultNeckIn: 14,
    defaultCfm: 600,
  },
  'transfer-grille': {
    kind: 'transfer-grille',
    label: 'Bedroom Return Transfer Grille',
    dimensionsM: [0.36, 0.16, 0.06],
    defaultMountY: 2.25,
    defaultNeckIn: 8,
    defaultCfm: 120,
  },
  'exhaust-grille': {
    kind: 'exhaust-grille',
    label: 'Bath / Utility Exhaust Grille',
    dimensionsM: [0.26, 0.05, 0.26],
    defaultMountY: 2.58,
    defaultNeckIn: 4,
    defaultCfm: 80,
  },
  'fresh-air-intake': {
    kind: 'fresh-air-intake',
    label: 'Exterior Fresh-Air Intake Hood (ASHRAE 62.2)',
    dimensionsM: [0.22, 0.22, 0.14],
    defaultMountY: 2.1,
    defaultNeckIn: 6,
    defaultCfm: 80,
  },
  'mini-split-wall-head': {
    kind: 'mini-split-wall-head',
    label: 'Mini-Split Wall Evaporator Head',
    dimensionsM: [0.88, 0.30, 0.24],
    defaultMountY: 2.15,
    defaultNeckIn: 0,
    defaultCfm: 280,
  },
  'smart-thermostat': {
    kind: 'smart-thermostat',
    label: 'Smart Programmable Thermostat (18/8)',
    dimensionsM: [0.13, 0.10, 0.03],
    defaultMountY: 1.52,
    defaultNeckIn: 0,
    defaultCfm: 0,
  },
  'zone-sensor': {
    kind: 'zone-sensor',
    label: 'Remote Room Temperature / RH Sensor',
    dimensionsM: [0.06, 0.06, 0.02],
    defaultMountY: 1.52,
    defaultNeckIn: 0,
    defaultCfm: 0,
  },
}

/** Color coding across 3D view, 2D floorplan, and left-rail System Legend. */
export const HVAC_SYSTEM_COLORS: Readonly<
  Record<HvacDuctSystem, { label: string; hex: string; num: number; dash2d: boolean }>
> = {
  'supply-trunk': { label: 'Supply Trunk', hex: '#0284c7', num: 0x0284c7, dash2d: false },
  'supply-branch': { label: 'Supply Branch', hex: '#38bdf8', num: 0x38bdf8, dash2d: false },
  'return-trunk': { label: 'Return Trunk', hex: '#7c3aed', num: 0x7c3aed, dash2d: true },
  'return-branch': { label: 'Return Branch', hex: '#a78bfa', num: 0xa78bfa, dash2d: true },
  'fresh-air-erv': { label: 'Fresh Air / ERV', hex: '#10b981', num: 0x10b981, dash2d: false },
  'exhaust-duct': { label: 'Exhaust Duct', hex: '#f59e0b', num: 0xf59e0b, dash2d: true },
  'refrigerant-lineset': { label: 'Refrigerant Lineset', hex: '#ea580c', num: 0xea580c, dash2d: false },
  'condensate-drain': { label: 'Condensate (3/4" PVC)', hex: '#06b6d4', num: 0x06b6d4, dash2d: true },
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}
