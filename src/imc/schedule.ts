/**
 * Pure HVAC Load Schedule, Duct Summary, Cross-Trade Electrical/Gas Coordination,
 * and IECC Insulation Schedule (`src/imc/schedule.ts`).
 * WeakMap-memoized per scene nodes object reference.
 * Framework-free: zero React, Three.js, or `@pascal-app/*` imports.
 */

import {
  type ElectricalPowerDemand,
  type SceneNodeLike,
  getHvacEquipmentElectricalDemand,
  resolveNodeLevelId,
} from './framing-interop'
import { extractRoomPolygons, extractWallSegments, polylineLengthM, resolveLevelHeightM } from './routing'
import {
  type InsulationTakeoffResult,
  type ManualJLoadResult,
  calculateAshrae622Ventilation,
  calculateIeccInsulationTakeoff,
  calculateManualJLoad,
  sizeHvacEquipment,
} from './sizing'
import {
  type ClimateZone,
  type CodeEdition,
  type DuctMaterial,
  type DuctShape,
  type HvacDuctSystem,
  type HvacEquipmentKind,
  type HvacSystemType,
  METERS_TO_FEET,
  type OccupancyType,
  round2,
} from './tables'

export type DuctSystemSummaryRow = {
  system: HvacDuctSystem
  material: DuctMaterial
  shape: DuctShape
  sizeLabel: string
  runCount: number
  totalLengthFt: number
  maxVelocityFpm: number
}

export type HvacElectricalCoordinationRow = {
  sourceNodeId: string
  label: string
  voltage: number
  poles: 1 | 2 | 3
  breakerAmps: number
  loadVa: number
  dedicatedCircuit: boolean
  gfciRequired: boolean
  wired: boolean
  matchedElectricalDeviceId?: string
  matchedCircuitNumber?: number
}

export type HvacSchedule = {
  codeEdition: CodeEdition
  climateZone: ClimateZone
  occupancy: OccupancyType
  manualJ: ManualJLoadResult
  equipmentRec: ReturnType<typeof sizeHvacEquipment>
  ventilation: ReturnType<typeof calculateAshrae622Ventilation>
  insulation: InsulationTakeoffResult
  ductSummary: DuctSystemSummaryRow[]
  electricalCoordination: HvacElectricalCoordinationRow[]
  totalFurnaceGasBtuh: number
  installedCoolingTons: number
  installedSupplyCfm: number
  installedReturnCfm: number
  equipmentCount: number
  terminalCount: number
}

function readHvacElectricalDemand(n: SceneNodeLike): ElectricalPowerDemand | null {
  const raw = n.electricalDemand as Partial<ElectricalPowerDemand> | undefined
  if (raw && typeof raw === 'object') {
    if (raw.required === false) return null
    if (raw.required === true) {
      return {
        required: true,
        voltage: raw.voltage === 240 || raw.voltage === 208 || raw.voltage === 480 ? raw.voltage : 120,
        poles: raw.poles === 3 || raw.poles === 2 ? raw.poles : 1,
        breakerAmps: typeof raw.breakerAmps === 'number' ? raw.breakerAmps : 20,
        loadVa: typeof raw.loadVa === 'number' ? raw.loadVa : 1200,
        continuous: Boolean(raw.continuous),
        dedicatedCircuit: Boolean(raw.dedicatedCircuit),
        gfciRequired: Boolean(raw.gfciRequired),
        afciRequired: Boolean(raw.afciRequired),
        loadCategory: (raw.loadCategory ?? 'heat-pump') as ElectricalPowerDemand['loadCategory'],
        label: typeof raw.label === 'string' && raw.label ? raw.label : (n.name ?? n.id),
      }
    }
  }
  if (n.type === 'hvac:equipment' && typeof n.equipmentKind === 'string') {
    const fallback = getHvacEquipmentElectricalDemand({
      kind: n.equipmentKind as HvacEquipmentKind,
      coolingTons: typeof n.coolingTons === 'number' ? n.coolingTons : 3,
    })
    return fallback.required ? fallback : null
  }
  return null
}

/**
 * Match powered `hvac:equipment` units against same-level `electrical:device` nodes in the scene
 * (exact `mepSourceNodeId` link OR same-level dedicated circuit proximity match).
 */
export function buildHvacElectricalCoordination(
  nodes: Readonly<Record<string, SceneNodeLike>>,
): HvacElectricalCoordinationRow[] {
  const all = Object.values(nodes)
  const elecDevices = all.filter((n) => n.type === 'electrical:device')

  const circuitDeviceCounts = new Map<string, number>()
  for (const d of elecDevices) {
    if (typeof d.circuitNumber === 'number' && d.circuitNumber > 0) {
      const key = `${String(d.panelId ?? '')}:${d.circuitNumber}`
      circuitDeviceCounts.set(key, (circuitDeviceCounts.get(key) ?? 0) + 1)
    }
  }

  const rows: HvacElectricalCoordinationRow[] = []
  for (const n of all) {
    if (n.type !== 'hvac:equipment') continue
    const demand = readHvacElectricalDemand(n)
    if (!demand || !demand.required) continue

    const nodeLevelId = resolveNodeLevelId(nodes, n)
    const pos = Array.isArray(n.position) && n.position.length >= 3 ? n.position : null
    let matched: SceneNodeLike | undefined

    for (const d of elecDevices) {
      const meta = d.metadata as { mepSourceNodeId?: string } | undefined
      if (d.mepSourceNodeId === n.id || meta?.mepSourceNodeId === n.id) {
        matched = d
        break
      }
      if (resolveNodeLevelId(nodes, d) !== nodeLevelId) continue
      const dPos = Array.isArray(d.position) && d.position.length >= 3 ? d.position : null
      if (!pos || !dPos) continue
      const dist = Math.hypot(pos[0] - dPos[0], pos[2] - dPos[2])
      const dPoles = typeof d.poles === 'number' ? d.poles : 1
      const dAmps = typeof d.breakerAmps === 'number' ? d.breakerAmps : 15
      if (dist > 1.8 || dPoles < demand.poles || dAmps < demand.breakerAmps) continue

      if (demand.dedicatedCircuit) {
        const isDedicatedKind = d.deviceKind === 'dedicated-240v' || dPoles >= 2
        const cktKey =
          typeof d.circuitNumber === 'number' && d.circuitNumber > 0
            ? `${String(d.panelId ?? '')}:${d.circuitNumber}`
            : null
        const isSingleLoad = cktKey !== null && (circuitDeviceCounts.get(cktKey) ?? 0) === 1
        if (!isDedicatedKind && !isSingleLoad) continue
      }
      matched = d
      break
    }

    rows.push({
      sourceNodeId: n.id,
      label: demand.label,
      voltage: demand.voltage,
      poles: demand.poles,
      breakerAmps: demand.breakerAmps,
      loadVa: demand.loadVa,
      dedicatedCircuit: demand.dedicatedCircuit,
      gfciRequired: demand.gfciRequired,
      wired: Boolean(matched),
      matchedElectricalDeviceId: matched?.id,
      matchedCircuitNumber: typeof matched?.circuitNumber === 'number' ? matched.circuitNumber : undefined,
    })
  }
  return rows
}

const scheduleCache = new WeakMap<
  Readonly<Record<string, SceneNodeLike>>,
  Map<string, HvacSchedule>
>()

export function buildHvacSchedule(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  options: {
    codeEdition?: CodeEdition
    climateZone?: ClimateZone
    occupancy?: OccupancyType
    systemType?: HvacSystemType
  } = {},
): HvacSchedule {
  const {
    codeEdition = 'IMC-2021',
    climateZone = '4A',
    occupancy = 'residential',
    systemType = 'split-heat-pump',
  } = options
  const cacheKey = `${codeEdition}|${climateZone}|${occupancy}|${systemType}`
  let byKey = scheduleCache.get(nodes)
  if (!byKey) {
    byKey = new Map()
    scheduleCache.set(nodes, byKey)
  }
  const cached = byKey.get(cacheKey)
  if (cached) return cached

  const all = Object.values(nodes)
  const rooms = extractRoomPolygons(nodes, null)
  const walls = extractWallSegments(nodes, null)
  const levelH = resolveLevelHeightM(nodes, null)

  const manualJ = calculateManualJLoad({
    rooms: rooms.map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category,
      areaSqft: r.areaSqft,
      ceilingHeightFt: round2(levelH * METERS_TO_FEET),
    })),
    climateZone,
    occupancy,
  })

  const equipmentRec = sizeHvacEquipment({
    coolingTons: manualJ.recommendedTons,
    heatingBtuh: manualJ.totalHeatingBtuh,
    systemType,
    climateZone,
  })

  const bedrooms = Math.max(1, rooms.filter((r) => r.category === 'bedroom').length)
  const bathrooms = rooms.filter((r) => r.category === 'bathroom').length
  const hasKitchen = rooms.some((r) => r.category === 'kitchen')
  const ventilation = calculateAshrae622Ventilation({
    conditionedSqft: Math.max(400, manualJ.conditionedSqft),
    bedrooms,
    bathrooms,
    hasKitchen,
  })

  const perimeterLf = round2(walls.reduce((s, w) => s + w.lengthM * METERS_TO_FEET, 0))
  const exteriorWallSqft = round2(perimeterLf * (levelH * METERS_TO_FEET))
  const insulation = calculateIeccInsulationTakeoff({
    conditionedSqft: manualJ.conditionedSqft,
    exteriorWallSqft,
    perimeterLf,
    climateZone,
  })

  const ductMap = new Map<string, DuctSystemSummaryRow>()
  let totalFurnaceGasBtuh = 0
  let installedCoolingTons = 0
  let installedSupplyCfm = 0
  let installedReturnCfm = 0
  let equipmentCount = 0
  let terminalCount = 0

  for (const n of all) {
    if (n.type === 'hvac:equipment') {
      equipmentCount += 1
      if (typeof n.gasBtuh === 'number' && n.gasBtuh > 0) totalFurnaceGasBtuh += n.gasBtuh
      const k = String(n.equipmentKind ?? '')
      if (
        (k === 'heat-pump-condenser' || k === 'ac-condenser' || k === 'rooftop-package-unit' || k === 'mini-split-outdoor') &&
        typeof n.coolingTons === 'number'
      ) {
        installedCoolingTons += n.coolingTons
      }
    } else if (n.type === 'hvac:terminal') {
      terminalCount += 1
      const tk = String(n.terminalKind ?? '')
      const cfm = typeof n.designCfm === 'number' ? n.designCfm : 0
      if (tk.startsWith('supply-') || tk === 'mini-split-wall-head') installedSupplyCfm += cfm
      if (tk === 'return-grille') installedReturnCfm += cfm
    } else if (n.type === 'hvac:duct-run') {
      const system = (n.system as HvacDuctSystem) || 'supply-branch'
      const material = (n.material as DuctMaterial) || 'galvanized-sheet'
      const shape = (n.shape as DuctShape) || 'round'
      const sizeLabel =
        shape === 'rectangular'
          ? `${Number(n.width ?? 14)}"x${Number(n.height ?? 8)}"`
          : `${Number(n.diameter ?? 6)}" dia`
      const path = Array.isArray(n.path) ? (n.path as ReadonlyArray<readonly [number, number, number]>) : []
      const lengthFt = polylineLengthM(path) * METERS_TO_FEET
      const vel = typeof n.velocityFpm === 'number' ? n.velocityFpm : 0
      const key = `${system}|${material}|${shape}|${sizeLabel}`
      const existing = ductMap.get(key)
      if (existing) {
        existing.runCount += 1
        existing.totalLengthFt = round2(existing.totalLengthFt + lengthFt)
        existing.maxVelocityFpm = Math.max(existing.maxVelocityFpm, vel)
      } else {
        ductMap.set(key, {
          system,
          material,
          shape,
          sizeLabel,
          runCount: 1,
          totalLengthFt: round2(lengthFt),
          maxVelocityFpm: vel,
        })
      }
    }
  }

  const result: HvacSchedule = {
    codeEdition,
    climateZone,
    occupancy,
    manualJ,
    equipmentRec,
    ventilation,
    insulation,
    ductSummary: [...ductMap.values()].sort((a, b) => a.system.localeCompare(b.system)),
    electricalCoordination: buildHvacElectricalCoordination(nodes),
    totalFurnaceGasBtuh,
    installedCoolingTons: round2(installedCoolingTons),
    installedSupplyCfm,
    installedReturnCfm,
    equipmentCount,
    terminalCount,
  }
  byKey.set(cacheKey, result)
  return result
}

function csvEscape(v: string | number): string {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function formatHvacScheduleCsv(schedule: HvacSchedule): string {
  const header = ['Room', 'Area (sq ft)', 'Heating (BTU/h)', 'Cooling Sensible', 'Cooling Latent', 'Cooling Total', 'Design CFM', 'Registers']
  const rows = schedule.manualJ.rooms.map((r) =>
    [r.roomName, r.areaSqft, r.heatingBtuh, r.coolingSensibleBtuh, r.coolingLatentBtuh, r.coolingTotalBtuh, r.designCfm, r.recommendedRegisters]
      .map(csvEscape)
      .join(','),
  )
  return [header.join(','), ...rows].join('\n')
}
