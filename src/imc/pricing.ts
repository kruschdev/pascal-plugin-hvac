/**
 * Pure Priced HVAC & IECC Insulation BOM Takeoff & CSV Export (`src/imc/pricing.ts`).
 * Framework-free: zero React, Three.js, or `@pascal-app/*` imports.
 */

import type { SceneNodeLike } from './framing-interop'
import { type HvacSchedule, buildHvacSchedule } from './schedule'
import {
  type ClimateZone,
  type CodeEdition,
  type DuctMaterial,
  type HvacEquipmentKind,
  type HvacPlenumKind,
  type HvacTerminalKind,
  type OccupancyType,
  round2,
} from './tables'

export type HvacPricingOptions = {
  laborRateUsd?: number
  materialMarkupPct?: number
  salesTaxPct?: number
  codeEdition?: CodeEdition
  climateZone?: ClimateZone
  occupancy?: OccupancyType
  includeInsulation?: boolean
  /** Optional precomputed schedule to avoid redundant scene scans. */
  schedule?: HvacSchedule
}

export type HvacBomLine = {
  category: 'Equipment' | 'Plenums' | 'Ductwork & Linesets' | 'Terminals & Controls' | 'Fittings & Accessories' | 'IECC Insulation'
  item: string
  unit: string
  quantity: number
  unitMaterialUsd: number
  materialUsd: number
  laborHours: number
  laborUsd: number
  totalUsd: number
}

export type HvacBomResult = {
  lines: HvacBomLine[]
  subtotalMaterialUsd: number
  markupUsd: number
  taxUsd: number
  subtotalLaborUsd: number
  totalLaborHours: number
  grandTotalUsd: number
}

const EQUIPMENT_PRICES: Readonly<Record<HvacEquipmentKind, { mat: number; hrs: number; label: string }>> = {
  'heat-pump-condenser': { mat: 2850, hrs: 8.0, label: 'Split Heat Pump Condenser (SEER2)' },
  'ac-condenser': { mat: 2250, hrs: 7.5, label: 'Split AC Condenser (SEER2)' },
  'air-handler': { mat: 1850, hrs: 7.0, label: 'Variable-Speed Air Handler w/ A-Coil & Heat Kit' },
  'gas-furnace-96': { mat: 2450, hrs: 9.0, label: '96% AFUE Condensing Gas Furnace + Evaporator Coil' },
  'gas-furnace-80': { mat: 1950, hrs: 8.0, label: '80% AFUE Gas Furnace + Evaporator Coil' },
  'rooftop-package-unit': { mat: 5400, hrs: 14.0, label: 'Packaged Rooftop Unit (RTU) + Curb' },
  'mini-split-outdoor': { mat: 2400, hrs: 6.5, label: 'Inverter Multi-Zone Mini-Split Outdoor Heat Pump' },
  'mini-split-indoor': { mat: 680, hrs: 3.0, label: 'Ductless Mini-Split Wall Evaporator Head' },
  'erv-ventilator': { mat: 1150, hrs: 4.5, label: 'ASHRAE 62.2 Energy Recovery Ventilator (ERV)' },
  'dehumidifier-whole-house': { mat: 1650, hrs: 4.0, label: 'Whole-House Ducted Dehumidifier' },
  'bath-exhaust-fan': { mat: 145, hrs: 1.5, label: 'Ultra-Quiet Bath Exhaust Fan (80 CFM)' },
  'range-hood': { mat: 320, hrs: 2.5, label: 'Vented Kitchen Range Exhaust Hood' },
}

const PLENUM_PRICES: Readonly<Record<HvacPlenumKind, { mat: number; hrs: number; label: string }>> = {
  'supply-plenum': { mat: 195, hrs: 2.0, label: 'Insulated Sheet-Metal Supply Plenum' },
  'return-plenum': { mat: 185, hrs: 2.0, label: 'Insulated Sheet-Metal Return Plenum + Filter Rack' },
  'mixing-box': { mat: 240, hrs: 2.5, label: 'Outdoor Air / Return Mixing Box' },
  'zone-damper-manifold': { mat: 540, hrs: 3.5, label: 'Motorized Multi-Zone Damper Trunk Manifold' },
}

const TERMINAL_PRICES: Readonly<Record<HvacTerminalKind, { mat: number; hrs: number; label: string }>> = {
  'supply-floor-register': { mat: 28, hrs: 0.4, label: '4x10 Steel Floor Supply Register + Boot' },
  'supply-ceiling-diffuser': { mat: 36, hrs: 0.5, label: 'Ceiling 4-Way Diffuser + Insulated Boot' },
  'supply-wall-register': { mat: 32, hrs: 0.45, label: 'High-Sidewall Supply Register + Stack Boot' },
  'return-grille': { mat: 78, hrs: 0.75, label: 'Filter-Back Return Air Grille + Plenum Box' },
  'transfer-grille': { mat: 42, hrs: 0.5, label: 'Bedroom Return Air Transfer Grille' },
  'exhaust-grille': { mat: 24, hrs: 0.35, label: 'Exhaust Air Grille' },
  'fresh-air-intake': { mat: 48, hrs: 0.75, label: 'Exterior Weatherproof Fresh-Air Intake Hood' },
  'mini-split-wall-head': { mat: 680, hrs: 3.0, label: 'Mini-Split Wall Head + Mounting Plate' },
  'smart-thermostat': { mat: 215, hrs: 1.25, label: 'Smart Wi-Fi Heat Pump Thermostat + 18/8 Wire' },
  'zone-sensor': { mat: 55, hrs: 0.35, label: 'Remote Room Temperature / RH Sensor' },
}

function ductUnitPricing(material: DuctMaterial, isRect: boolean): {
  unit: string
  unitFt: number
  matPerUnit: number
  hrsPer100Ft: number
} {
  if (material === 'insulated-copper') return { unit: '25 ft coil', unitFt: 25, matPerUnit: 185, hrsPer100Ft: 9.0 }
  if (material === 'pvc-condensate') return { unit: '10 ft stick', unitFt: 10, matPerUnit: 10, hrsPer100Ft: 4.0 }
  if (material === 'flex-r8') return { unit: '25 ft bag', unitFt: 25, matPerUnit: 68, hrsPer100Ft: 5.5 }
  if (material === 'flex-r6') return { unit: '25 ft bag', unitFt: 25, matPerUnit: 54, hrsPer100Ft: 5.0 }
  if (material === 'ductboard') return { unit: '40 sq ft', unitFt: 10, matPerUnit: 95, hrsPer100Ft: 11.0 }
  return isRect
    ? { unit: '5 ft section', unitFt: 5, matPerUnit: 72, hrsPer100Ft: 14.0 }
    : { unit: '5 ft pipe', unitFt: 5, matPerUnit: 32, hrsPer100Ft: 8.5 }
}

export function buildHvacBom(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  options: HvacPricingOptions = {},
): HvacBomResult {
  const {
    laborRateUsd = 120,
    materialMarkupPct = 0,
    salesTaxPct = 0,
    codeEdition = 'IMC-2021',
    climateZone = '4A',
    occupancy = 'residential',
    includeInsulation = false,
  } = options
  const schedule = options.schedule ?? buildHvacSchedule(nodes, { codeEdition, climateZone, occupancy })
  const all = Object.values(nodes)
  const lines: HvacBomLine[] = []

  const addLine = (
    category: HvacBomLine['category'],
    item: string,
    unit: string,
    quantity: number,
    unitMaterialUsd: number,
    laborHours: number,
  ) => {
    if (quantity <= 0) return
    const mat = round2(quantity * unitMaterialUsd)
    const hrs = round2(laborHours)
    const lab = round2(hrs * laborRateUsd)
    lines.push({
      category,
      item,
      unit,
      quantity,
      unitMaterialUsd: round2(unitMaterialUsd),
      materialUsd: mat,
      laborHours: hrs,
      laborUsd: lab,
      totalUsd: round2(mat + lab),
    })
  }

  // 1. Equipment
  const eqCounts = new Map<HvacEquipmentKind, number>()
  for (const n of all) {
    if (n.type !== 'hvac:equipment') continue
    const k = (n.equipmentKind as HvacEquipmentKind) || 'air-handler'
    eqCounts.set(k, (eqCounts.get(k) ?? 0) + 1)
  }
  for (const [k, qty] of eqCounts) {
    const p = EQUIPMENT_PRICES[k] ?? { mat: 1200, hrs: 5.0, label: k }
    addLine('Equipment', p.label, 'ea', qty, p.mat, qty * p.hrs)
  }

  // 2. Plenums
  const plCounts = new Map<HvacPlenumKind, number>()
  for (const n of all) {
    if (n.type !== 'hvac:plenum') continue
    const k = (n.plenumKind as HvacPlenumKind) || 'supply-plenum'
    plCounts.set(k, (plCounts.get(k) ?? 0) + 1)
  }
  for (const [k, qty] of plCounts) {
    const p = PLENUM_PRICES[k] ?? { mat: 195, hrs: 2.0, label: k }
    addLine('Plenums', p.label, 'ea', qty, p.mat, qty * p.hrs)
  }

  // 3. Ductwork & Linesets (with 10% waste)
  let totalDuctFt = 0
  let branchCount = 0
  for (const row of schedule.ductSummary) {
    const billedFt = row.totalLengthFt * 1.1
    totalDuctFt += billedFt
    if (row.system === 'supply-branch' || row.system === 'return-branch') branchCount += row.runCount
    const p = ductUnitPricing(row.material, row.shape === 'rectangular')
    const qty = Math.max(1, Math.ceil(billedFt / p.unitFt))
    addLine(
      'Ductwork & Linesets',
      `${row.sizeLabel} ${row.material} (${row.system})`,
      p.unit,
      qty,
      p.matPerUnit,
      (billedFt / 100) * p.hrsPer100Ft,
    )
  }

  // 4. Terminals & Controls
  const termCounts = new Map<HvacTerminalKind, number>()
  for (const n of all) {
    if (n.type !== 'hvac:terminal') continue
    const k = (n.terminalKind as HvacTerminalKind) || 'supply-ceiling-diffuser'
    termCounts.set(k, (termCounts.get(k) ?? 0) + 1)
  }
  for (const [k, qty] of termCounts) {
    const p = TERMINAL_PRICES[k] ?? { mat: 35, hrs: 0.5, label: k }
    addLine('Terminals & Controls', p.label, 'ea', qty, p.mat, qty * p.hrs)
  }

  // 5. Fittings, Takeoffs, Mastic, Hangers, Pad, Secondary Pan & Float Switch
  if (totalDuctFt > 0 || eqCounts.size > 0) {
    const takeoffs = Math.max(branchCount, 2)
    const hangers = Math.ceil(totalDuctFt / 4)
    const masticGal = Math.max(1, Math.ceil(totalDuctFt / 50))
    const hasOutdoor =
      (eqCounts.get('heat-pump-condenser') ?? 0) +
        (eqCounts.get('ac-condenser') ?? 0) +
        (eqCounts.get('mini-split-outdoor') ?? 0) >
      0
    addLine('Fittings & Accessories', 'Start Collars & Manual Balancing Dampers', 'ea', takeoffs, 14, takeoffs * 0.15)
    addLine('Fittings & Accessories', 'UL-181 Mastic Sealant & Foil Tape', 'gal', masticGal, 28, masticGal * 0.35)
    addLine('Fittings & Accessories', 'Duct Straps, Saddle Hangers & Screws', 'ea', hangers, 2.2, hangers * 0.04)
    if (hasOutdoor) {
      addLine('Fittings & Accessories', 'Composite Condenser Pad, Whip & 60A Disconnect', 'ea', 1, 145, 1.5)
    }
    addLine('Fittings & Accessories', 'Secondary Condensate Pan, P-Trap & SS2 Float Switch', 'ea', 1, 95, 1.0)
  }

  // 6. Optional IECC Building Envelope & Insulation Takeoff (from ClimaCore)
  if (includeInsulation && schedule.insulation.wallBattRolls > 0) {
    const ins = schedule.insulation
    addLine('IECC Insulation', `Exterior Wall Batts (${ins.wallRValue})`, 'roll', ins.wallBattRolls, 42, ins.wallBattRolls * 0.25)
    addLine('IECC Insulation', `Attic Blown-In Cellulose (${ins.atticRValue})`, 'bag', ins.blownInBags, 18, ins.blownInBags * 0.12)
    addLine('IECC Insulation', 'Rim-Joist Closed-Cell Spray Foam Kits (600 bd-ft)', 'kit', ins.sprayFoamKits, 640, ins.sprayFoamKits * 2.5)
    addLine('IECC Insulation', 'Envelope Air-Sealing Foam Cans & Acoustic Caulk', 'ea', ins.expandingFoamCans + ins.acousticCaulkTubes, 9.5, 2.0)
  }

  const subtotalMaterialUsd = round2(lines.reduce((s, l) => s + l.materialUsd, 0))
  const subtotalLaborUsd = round2(lines.reduce((s, l) => s + l.laborUsd, 0))
  const totalLaborHours = round2(lines.reduce((s, l) => s + l.laborHours, 0))
  const markupUsd = round2(subtotalMaterialUsd * (materialMarkupPct / 100))
  const taxUsd = round2((subtotalMaterialUsd + markupUsd) * (salesTaxPct / 100))
  const grandTotalUsd = round2(subtotalMaterialUsd + markupUsd + taxUsd + subtotalLaborUsd)

  return {
    lines,
    subtotalMaterialUsd,
    markupUsd,
    taxUsd,
    subtotalLaborUsd,
    totalLaborHours,
    grandTotalUsd,
  }
}

function csvEscape(v: string | number): string {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function formatHvacBomCsv(bom: HvacBomResult): string {
  const header = ['Category', 'Item', 'Unit', 'Qty', 'Unit Material ($)', 'Material ($)', 'Labor (hrs)', 'Labor ($)', 'Total ($)']
  const rows = bom.lines.map((l) =>
    [
      l.category,
      l.item,
      l.unit,
      l.quantity,
      l.unitMaterialUsd.toFixed(2),
      l.materialUsd.toFixed(2),
      l.laborHours.toFixed(2),
      l.laborUsd.toFixed(2),
      l.totalUsd.toFixed(2),
    ]
      .map(csvEscape)
      .join(','),
  )
  rows.push(['Summary', 'Material Subtotal', '', '', '', bom.subtotalMaterialUsd.toFixed(2), '', '', bom.subtotalMaterialUsd.toFixed(2)].join(','))
  if (bom.markupUsd > 0) {
    rows.push(['Summary', 'Material Markup', '', '', '', bom.markupUsd.toFixed(2), '', '', bom.markupUsd.toFixed(2)].join(','))
  }
  if (bom.taxUsd > 0) {
    rows.push(['Summary', 'Sales Tax', '', '', '', bom.taxUsd.toFixed(2), '', '', bom.taxUsd.toFixed(2)].join(','))
  }
  rows.push(['Summary', 'Labor Subtotal', '', '', '', '', bom.totalLaborHours.toFixed(2), bom.subtotalLaborUsd.toFixed(2), bom.subtotalLaborUsd.toFixed(2)].join(','))
  rows.push(['Summary', 'Grand Total', '', '', '', (bom.subtotalMaterialUsd + bom.markupUsd + bom.taxUsd).toFixed(2), bom.totalLaborHours.toFixed(2), bom.subtotalLaborUsd.toFixed(2), bom.grandTotalUsd.toFixed(2)].join(','))
  return [header.join(','), ...rows].join('\n')
}
