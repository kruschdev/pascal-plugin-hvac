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
 * Match powered `hvac:equipment` units against same-level `electrical:device` nodes in the scene.
 * Uses two passes (explicit `mepSourceNodeId` link first, then same-level proximity with exact
 * pole & voltage compatibility) and tracks `claimedDeviceIds` so one device never wires two units.
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

  const poweredUnits: Array<{ node: SceneNodeLike; demand: ElectricalPowerDemand }> = []
  for (const n of all) {
    if (n.type !== 'hvac:equipment') continue
    const demand = readHvacElectricalDemand(n)
    if (!demand || !demand.required) continue
    poweredUnits.push({ node: n, demand })
  }

  const claimedDeviceIds = new Set<string>()
  const matchedByUnit = new Map<string, SceneNodeLike>()

  // Pass 1: Explicit `mepSourceNodeId` matches always claim their device first
  for (const { node: n } of poweredUnits) {
    for (const d of elecDevices) {
      if (claimedDeviceIds.has(d.id)) continue
      const meta = d.metadata as { mepSourceNodeId?: string } | undefined
      if (d.mepSourceNodeId === n.id || meta?.mepSourceNodeId === n.id) {
        matchedByUnit.set(n.id, d)
        claimedDeviceIds.add(d.id)
        break
      }
    }
  }

  // Pass 2: Same-level proximity fallback requiring exact pole count, voltage match, and unclaimed device
  for (const { node: n, demand } of poweredUnits) {
    if (matchedByUnit.has(n.id)) continue
    const nodeLevelId = resolveNodeLevelId(nodes, n)
    const pos = Array.isArray(n.position) && n.position.length >= 3 ? n.position : null
    if (!pos) continue

    for (const d of elecDevices) {
      if (claimedDeviceIds.has(d.id)) continue
      if (resolveNodeLevelId(nodes, d) !== nodeLevelId) continue
      const dPos = Array.isArray(d.position) && d.position.length >= 3 ? d.position : null
      if (!dPos) continue
      const dist = Math.hypot(pos[0] - dPos[0], pos[2] - dPos[2])
      const dPoles = typeof d.poles === 'number' ? d.poles : 1
      const dAmps = typeof d.breakerAmps === 'number' ? d.breakerAmps : 15
      const dVoltage = typeof d.voltage === 'number' ? d.voltage : dPoles >= 2 ? 240 : 120
      if (dist > 1.8 || dPoles !== demand.poles || dVoltage !== demand.voltage || dAmps < demand.breakerAmps) continue

      if (demand.dedicatedCircuit) {
        const isDedicatedKind = d.deviceKind === 'dedicated-240v' || dPoles >= 2
        const cktKey =
          typeof d.circuitNumber === 'number' && d.circuitNumber > 0
            ? `${String(d.panelId ?? '')}:${d.circuitNumber}`
            : null
        const isSingleLoadCircuit = cktKey !== null && (circuitDeviceCounts.get(cktKey) ?? 0) === 1
        if (!isDedicatedKind && !isSingleLoadCircuit) continue
      }

      matchedByUnit.set(n.id, d)
      claimedDeviceIds.add(d.id)
      break
    }
  }

  return poweredUnits.map(({ node: n, demand }) => {
    const matched = matchedByUnit.get(n.id)
    return {
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
    }
  })
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

  // Estimate true exterior envelope footprint per level (avoid summing interior partition walls or double-counting attic across stories)
  const levelIds = [...new Set(all.filter((n) => n.type === 'level').map((n) => n.id))]
  const activeLevelIds = levelIds.length > 0 ? levelIds : [null]
  let exteriorPerimeterLf = 0
  let topLevelFootprintSqft = 0
  let levelsWithGeometry = 0

  for (const lvlId of activeLevelIds) {
    const lvlRooms = extractRoomPolygons(nodes, lvlId)
    const lvlWalls = extractWallSegments(nodes, lvlId)
    if (lvlRooms.length === 0 && lvlWalls.length === 0) continue
    levelsWithGeometry += 1
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (const w of lvlWalls) {
      minX = Math.min(minX, w.start[0], w.end[0])
      maxX = Math.max(maxX, w.start[0], w.end[0])
      minZ = Math.min(minZ, w.start[1], w.end[1])
      maxZ = Math.max(maxZ, w.start[1], w.end[1])
    }
    for (const r of lvlRooms) {
      for (const [x, z] of r.polygon) {
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minZ = Math.min(minZ, z)
        maxZ = Math.max(maxZ, z)
      }
    }
    if (Number.isFinite(minX)) {
      const perimM = 2 * ((maxX - minX) + (maxZ - minZ))
      exteriorPerimeterLf += perimM * METERS_TO_FEET
      const lvlSqft = lvlRooms.reduce((s, r) => s + r.areaSqft, 0)
      topLevelFootprintSqft = lvlSqft > 0 ? lvlSqft : round2((maxX - minX) * (maxZ - minZ) * 10.763910417)
    }
  }
  const perimeterLf = round2(exteriorPerimeterLf)
  const exteriorWallSqft = round2(perimeterLf * (levelH * METERS_TO_FEET))
  const atticFootprintSqft =
    topLevelFootprintSqft > 0
      ? round2(topLevelFootprintSqft)
      : round2(manualJ.conditionedSqft / Math.max(1, levelsWithGeometry))
  const insulation = calculateIeccInsulationTakeoff({
    conditionedSqft: atticFootprintSqft,
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
  const totalSensible = schedule.manualJ.rooms.reduce((s, r) => s + r.coolingSensibleBtuh, 0)
  const totalLatent = schedule.manualJ.rooms.reduce((s, r) => s + r.coolingLatentBtuh, 0)
  const totalRegisters = schedule.manualJ.rooms.reduce((s, r) => s + r.recommendedRegisters, 0)
  rows.push(
    [
      `TOTAL (${schedule.manualJ.recommendedTons}-Ton System)`,
      schedule.manualJ.conditionedSqft,
      schedule.manualJ.totalHeatingBtuh,
      totalSensible,
      totalLatent,
      schedule.manualJ.totalCoolingBtuh,
      schedule.manualJ.designTotalCfm,
      totalRegisters,
    ]
      .map(csvEscape)
      .join(','),
  )
  return [header.join(','), ...rows].join('\n')
}
