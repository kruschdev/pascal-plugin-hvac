/**
 * One-Click IMC / ACCA Manual J-D-S HVAC Auto-Population Planner (`src/imc/autopopulate.ts`).
 *
 * Scans live Pascal rooms, walls, and Priority #1/#2 obstacles (Structural, Plumbing, NEC 110.26(E))
 * to generate a complete, code-compliant 3D HVAC network:
 *   - Room-by-room ACCA Manual J heating/cooling load & tonnage sizing
 *   - Air handler / condensing gas furnace + outdoor heat pump / AC condenser (or multi-zone mini-split / RTU)
 *   - Supply & Return Plenums + sized rectangular main trunks + ACCA Manual D round branches
 *   - Supply registers/diffusers, central return grille, bedroom transfer grilles, smart thermostat
 *   - Insulated refrigerant lineset + gravity-sloped 3/4" PVC condensate drain (IMC 307.2)
 *   - Optional ASHRAE 62.2 ERV + bath/kitchen exhaust fans & ducts
 *   - Standardized `electricalDemand` metadata for automatic `@kruschdev/pascal-plugin-electrical` breaker allocation
 *
 * Framework-free: zero React, Three.js, or `@pascal-app/*` imports.
 */

import {
  type ElectricalPowerDemand,
  type SceneNodeLike,
  type Vec3,
  getHvacEquipmentElectricalDemand,
} from './framing-interop'
import {
  type HvacObstacle,
  detectHvacClashes,
  extractHvacObstacles,
  extractRoomPolygons,
  extractWallSegments,
  pointInPolygon2D,
  resolveLevelHeightM,
  routeCondensateDrain,
  routeHvacDuctRun,
} from './routing'
import {
  calculateAshrae622Ventilation,
  calculateManualJLoad,
  sizeDuctForCfm,
  sizeHvacEquipment,
} from './sizing'
import {
  CLIMATE_ZONES,
  type ClimateZone,
  type CodeEdition,
  type DuctMaterial,
  type DuctPlenumLocation,
  type DuctShape,
  HVAC_EQUIPMENT_SPECS,
  HVAC_TERMINAL_SPECS,
  type HvacDuctSystem,
  type HvacEquipmentKind,
  type HvacPlenumKind,
  type HvacSystemType,
  type HvacTerminalKind,
  type OccupancyType,
  type RefrigerantType,
  round2,
} from './tables'

export type HvacAutoPopulateOptions = {
  levelId?: string | null
  codeEdition?: CodeEdition
  occupancy?: OccupancyType
  climateZone?: ClimateZone
  systemType?: HvacSystemType
  plenumLocation?: DuctPlenumLocation
  refrigerant?: RefrigerantType
  wallR?: number
  atticR?: number
  includeErv?: boolean
  includeExhaustFans?: boolean
}

export type PlannedHvacEquipmentSpec = {
  id: string
  name: string
  equipmentKind: HvacEquipmentKind
  position: Vec3
  rotation: number
  roomName: string
  coolingTons: number
  heatingBtuh: number
  gasBtuh: number
  airflowCfm: number
  seer2: number
  hspf2: number
  refrigerant: RefrigerantType
  hasSecondaryDrainPan: boolean
  hasFloatSwitch: boolean
  hasDisconnectWithinSight: boolean
  electricalDemand: ElectricalPowerDemand
}

export type PlannedHvacPlenumSpec = {
  id: string
  name: string
  plenumKind: HvacPlenumKind
  position: Vec3
  rotation: number
  widthIn: number
  heightIn: number
  depthIn: number
  airflowCfm: number
  staticPressureInWg: number
  insulationR: number
}

export type PlannedHvacTerminalSpec = {
  id: string
  name: string
  terminalKind: HvacTerminalKind
  position: Vec3
  rotation: number
  roomName: string
  designCfm: number
  neckSizeIn: number
  throwFt: number
}

export type PlannedHvacDuctRunSpec = {
  id: string
  name: string
  system: HvacDuctSystem
  shape: DuctShape
  material: DuctMaterial
  width: number
  height: number
  diameter: number
  path: Vec3[]
  airflowCfm: number
  velocityFpm: number
  frictionRateInWgPer100Ft: number
  insulationR: number
  sourceNodeId?: string
  targetNodeId?: string
  showFramingClearances: boolean
}

export type HvacAutoPopulatePlan = {
  levelId: string | null
  codeEdition: CodeEdition
  climateZone: ClimateZone
  systemType: HvacSystemType
  plenumLocation: DuctPlenumLocation
  load: ReturnType<typeof calculateManualJLoad>
  equipmentSpec: ReturnType<typeof sizeHvacEquipment>
  ventilation: ReturnType<typeof calculateAshrae622Ventilation>
  equipment: PlannedHvacEquipmentSpec[]
  plenums: PlannedHvacPlenumSpec[]
  terminals: PlannedHvacTerminalSpec[]
  ductRuns: PlannedHvacDuctRunSpec[]
  summary: string
}

function nearestPointOnSpine(spine: ReadonlyArray<Vec3>, x: number, z: number, fallbackY: number): Vec3 {
  let bestPt: Vec3 = spine[0] ?? [x, fallbackY, z]
  let bestDist = Infinity
  for (let i = 1; i < spine.length; i++) {
    const a = spine[i - 1]!
    const b = spine[i]!
    const dx = b[0] - a[0]
    const dz = b[2] - a[2]
    const lenSq = dx * dx + dz * dz
    if (lenSq < 1e-4) continue
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[2]) * dz) / lenSq))
    const px = a[0] + dx * t
    const py = a[1] + (b[1] - a[1]) * t
    const pz = a[2] + dz * t
    const d = Math.hypot(x - px, z - pz)
    if (d < bestDist) {
      bestDist = d
      bestPt = [round2(px), round2(py), round2(pz)]
    }
  }
  return bestPt
}

function sceneBounds(
  walls: ReadonlyArray<{ start: readonly [number, number]; end: readonly [number, number] }>,
  rooms: ReadonlyArray<{ polygon: ReadonlyArray<readonly [number, number]> }>,
) {
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const w of walls) {
    minX = Math.min(minX, w.start[0], w.end[0])
    maxX = Math.max(maxX, w.start[0], w.end[0])
    minZ = Math.min(minZ, w.start[1], w.end[1])
    maxZ = Math.max(maxZ, w.start[1], w.end[1])
  }
  for (const r of rooms) {
    for (const [x, z] of r.polygon) {
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minZ = Math.min(minZ, z)
      maxZ = Math.max(maxZ, z)
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, maxX: 10, minZ: 0, maxZ: 8, cx: 5, cz: 4 }
  return { minX, maxX, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 }
}

function minClearanceToObstaclesXZ(
  x: number,
  z: number,
  obstacles: ReadonlyArray<HvacObstacle>,
): number {
  let minDist = Infinity
  for (const obs of obstacles) {
    const dx = x < obs.box.minX ? obs.box.minX - x : x > obs.box.maxX ? x - obs.box.maxX : 0
    const dz = z < obs.box.minZ ? obs.box.minZ - z : z > obs.box.maxZ ? z - obs.box.maxZ : 0
    const d = Math.hypot(dx, dz)
    if (d < minDist) minDist = d
  }
  return minDist
}

function isInsideWithMargin(
  x: number,
  z: number,
  poly: ReadonlyArray<readonly [number, number]>,
  margin = 0.22,
): boolean {
  return (
    pointInPolygon2D(x, z, poly) &&
    pointInPolygon2D(x + margin, z, poly) &&
    pointInPolygon2D(x - margin, z, poly) &&
    pointInPolygon2D(x, z + margin, poly) &&
    pointInPolygon2D(x, z - margin, poly)
  )
}

/**
 * Pick an equipment placement spot near `basePos` that stays well clear of existing
 * Priority #1 Structural columns, Priority #2 Plumbing equipment/manifolds/pipes,
 * and NEC 110.26(A)/(E) electrical panel spaces so HVAC never drops on top of a water heater,
 * invades a panel's working space, or escapes its target room polygon.
 */
function findClearMechanicalSpot(
  baseX: number,
  baseZ: number,
  obstacles: ReadonlyArray<HvacObstacle>,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  minClearanceM = 0.85,
  compactRings = false,
  insidePolygon?: ReadonlyArray<readonly [number, number]>,
): [number, number] {
  const baseInside = !insidePolygon || pointInPolygon2D(baseX, baseZ, insidePolygon)
  if (obstacles.length === 0 && baseInside) return [round2(baseX), round2(baseZ)]
  const rings: ReadonlyArray<readonly [number, number]> = compactRings
    ? [
        [0, 0],
        [0.35, 0],
        [-0.35, 0],
        [0, 0.35],
        [0, -0.35],
        [0.45, 0],
        [-0.45, 0],
        [0, 0.45],
        [0, -0.45],
        [0.65, 0.55],
        [-0.65, 0.55],
        [0.65, -0.55],
        [-0.65, -0.55],
        [0.95, 0],
        [-0.95, 0],
        [0, 0.95],
        [0, -0.95],
        [1.25, 0.85],
        [-1.25, 0.85],
        [1.25, -0.85],
        [-1.25, -0.85],
      ]
    : [
        [0, 0],
        [0.55, 0],
        [-0.55, 0],
        [0, 0.55],
        [0, -0.55],
        [0.85, 0],
        [-0.85, 0],
        [0, 0.85],
        [0, -0.85],
        [0.85, 0.65],
        [-0.85, 0.65],
        [0.85, -0.65],
        [-0.85, -0.65],
        [1.1, 0],
        [-1.1, 0],
        [0, 1.1],
        [0, -1.1],
        [1.3, 1.1],
        [-1.3, 1.1],
        [1.3, -1.1],
        [-1.3, -1.1],
        [2.0, 0],
        [-2.0, 0],
        [0, 2.0],
        [0, -2.0],
        [2.2, 1.6],
        [-2.2, 1.6],
        [2.2, -1.6],
        [-2.2, -1.6],
      ]

  const evalPass = (requireMargin: boolean): { spot: [number, number] | null; clear: number; met: boolean } => {
    let best: [number, number] | null = null
    let bestClear = -1
    for (const [ox, oz] of rings) {
      const cx = round2(baseX + ox)
      const cz = round2(baseZ + oz)
      if (!insidePolygon) {
        if (cx < bounds.minX + 0.35 || cx > bounds.maxX - 0.35 || cz < bounds.minZ + 0.35 || cz > bounds.maxZ - 0.35) {
          continue
        }
      } else {
        const ok = requireMargin ? isInsideWithMargin(cx, cz, insidePolygon, 0.22) : pointInPolygon2D(cx, cz, insidePolygon)
        if (!ok) continue
      }
      const clear = minClearanceToObstaclesXZ(cx, cz, obstacles)
      if (clear >= minClearanceM) return { spot: [cx, cz], clear, met: true }
      if (clear > bestClear) {
        bestClear = clear
        best = [cx, cz]
      }
    }
    return { spot: best, clear: bestClear, met: false }
  }

  if (insidePolygon) {
    const withMargin = evalPass(true)
    if (withMargin.met && withMargin.spot) return withMargin.spot
    const strict = evalPass(false)
    if (strict.met && strict.spot) return strict.spot
    if (withMargin.spot && withMargin.clear >= strict.clear - 0.05) return withMargin.spot
    if (strict.spot) return strict.spot
  } else {
    const res = evalPass(false)
    if (res.spot) return res.spot
  }
  return [round2(baseX), round2(baseZ)]
}

function findWallTuckedCornerSpot(
  room: { polygon: ReadonlyArray<readonly [number, number]>; centroid: readonly [number, number] },
  obstacles: ReadonlyArray<HvacObstacle>,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  insetM = 0.48,
  minClearanceM = 1.1,
  preferNearPt?: readonly [number, number] | null,
): [number, number] {
  const poly = room.polygon
  const candidates: Array<readonly [number, number]> = []

  // Gather corner-inset and wall-mid-inset candidates strictly inside the room so mechanical equipment
  // tucks neatly against walls/corners instead of floating in the middle of living spaces.
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % poly.length]!
    // Corner candidate inset toward room centroid
    const dxC = room.centroid[0] - a[0]
    const dzC = room.centroid[1] - a[1]
    const lenC = Math.hypot(dxC, dzC)
    if (lenC > insetM * 1.15) {
      candidates.push([round2(a[0] + (dxC / lenC) * insetM), round2(a[1] + (dzC / lenC) * insetM)])
    }
    // Wall midpoint candidate inset toward room centroid
    const mx = (a[0] + b[0]) / 2
    const mz = (a[1] + b[1]) / 2
    const dxM = room.centroid[0] - mx
    const dzM = room.centroid[1] - mz
    const lenM = Math.hypot(dxM, dzM)
    if (lenM > insetM * 1.1) {
      candidates.push([round2(mx + (dxM / lenM) * insetM), round2(mz + (dzM / lenM) * insetM)])
    }
  }

  let best: [number, number] | null = null
  let bestScore = -Infinity
  for (const [cx, cz] of candidates) {
    if (!isInsideWithMargin(cx, cz, poly, 0.24)) continue
    if (cx < bounds.minX + 0.3 || cx > bounds.maxX - 0.3 || cz < bounds.minZ + 0.3 || cz > bounds.maxZ - 0.3) continue
    const clear = minClearanceToObstaclesXZ(cx, cz, obstacles)
    const prefPenalty = preferNearPt ? Math.hypot(cx - preferNearPt[0], cz - preferNearPt[1]) * 1.5 : 0
    const score = (clear >= minClearanceM ? 100 : clear * 60) + Math.min(2.0, clear) * 10 - prefPenalty
    if (score > bestScore) {
      bestScore = score
      best = [cx, cz]
    }
  }

  if (best && minClearanceToObstaclesXZ(best[0], best[1], obstacles) >= minClearanceM * 0.75) {
    return best
  }
  const fallbackBase = best ?? room.centroid
  return findClearMechanicalSpot(fallbackBase[0], fallbackBase[1], obstacles, bounds, minClearanceM, false, poly)
}

function snapPointToRoomWall(
  room: { polygon: ReadonlyArray<readonly [number, number]>; centroid: readonly [number, number] },
  walls: ReadonlyArray<{
    start: readonly [number, number]
    end: readonly [number, number]
    lengthM: number
    thicknessM: number
    ux: number
    uz: number
    nx: number
    nz: number
  }>,
  y: number,
  insetM = 0.06,
): { position: Vec3; rotation: number } {
  let bestPos: Vec3 = [round2(room.centroid[0]), round2(y), round2(room.centroid[1])]
  let bestRot = 0
  let bestScore = -Infinity

  for (const w of walls) {
    if (w.lengthM < 0.8) continue
    // Sample midpoint along each wall and check whether the inward face lands inside the target room
    for (const frac of [0.5, 0.35, 0.65]) {
      const wx = w.start[0] + w.ux * w.lengthM * frac
      const wz = w.start[1] + w.uz * w.lengthM * frac
      const offset = w.thicknessM / 2 + insetM
      for (const sign of [1, -1] as const) {
        const px = round2(wx + w.nx * sign * offset)
        const pz = round2(wz + w.nz * sign * offset)
        if (!pointInPolygon2D(px, pz, room.polygon)) continue
        const distToCentroid = Math.hypot(px - room.centroid[0], pz - room.centroid[1])
        // Prefer interior partition walls (other side is also inside the building) and spots close to room center
        const otherX = wx - w.nx * sign * (w.thicknessM / 2 + 0.35)
        const otherZ = wz - w.nz * sign * (w.thicknessM / 2 + 0.35)
        const isInteriorWall = !pointInPolygon2D(otherX, otherZ, room.polygon) && w.lengthM >= 1.2
        const score = (isInteriorWall ? 20 : 0) + (frac === 0.5 ? 4 : 0) - distToCentroid
        if (score > bestScore) {
          bestScore = score
          bestPos = [px, round2(y), pz]
          bestRot = round2(Math.atan2(w.nx * sign, w.nz * sign))
        }
      }
    }
  }

  return { position: bestPos, rotation: bestRot }
}

/**
 * Generate a complete IMC / ACCA Manual J-D-S HVAC layout plan from live Pascal geometry.
 */
export function planHvacAutoPopulate(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  options: HvacAutoPopulateOptions = {},
): HvacAutoPopulatePlan {
  const all = Object.values(nodes)
  const levelId = options.levelId ?? all.find((n) => n.type === 'level')?.id ?? null
  const codeEdition: CodeEdition = options.codeEdition ?? 'IMC-2021'
  const occupancy: OccupancyType = options.occupancy ?? 'residential'
  const climateZone: ClimateZone = options.climateZone ?? '4A'
  const systemType: HvacSystemType = options.systemType ?? 'split-heat-pump'
  const plenumLocation: DuctPlenumLocation = options.plenumLocation ?? 'attic'
  const refrigerant: RefrigerantType = options.refrigerant ?? 'R-454B'
  const includeErv = options.includeErv ?? true
  const includeExhaustFans = options.includeExhaustFans ?? true

  const zoneMeta = CLIMATE_ZONES[climateZone] ?? CLIMATE_ZONES['4A']
  const wallR = options.wallR ?? zoneMeta.ieccWallR
  const atticR = options.atticR ?? zoneMeta.ieccAtticR
  const ductR = plenumLocation === 'attic' ? zoneMeta.ieccAtticDuctR : zoneMeta.ieccCrawlDuctR

  const walls = extractWallSegments(nodes, levelId)
  const rawRooms = extractRoomPolygons(nodes, levelId)
  const levelH = resolveLevelHeightM(nodes, levelId)
  const obstacles = extractHvacObstacles(nodes, levelId)
  const bounds = sceneBounds(walls, rawRooms)

  // Synthesize a fallback room if scene has walls/bounds without explicit room polygons
  const rooms =
    rawRooms.length > 0
      ? rawRooms
      : [
          {
            id: 'room_default',
            name: 'Main Conditioned Zone',
            category: 'living' as const,
            polygon: [
              [bounds.minX, bounds.minZ],
              [bounds.maxX, bounds.minZ],
              [bounds.maxX, bounds.maxZ],
              [bounds.minX, bounds.maxZ],
            ] as const,
            centroid: [bounds.cx, bounds.cz] as const,
            areaSqm: Math.max(40, (bounds.maxX - bounds.minX) * (bounds.maxZ - bounds.minZ)),
            areaSqft: round2(Math.max(40, (bounds.maxX - bounds.minX) * (bounds.maxZ - bounds.minZ)) * 10.7639),
          },
        ]

  const load = calculateManualJLoad({
    rooms: rooms.map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category,
      areaSqft: r.areaSqft,
      ceilingHeightFt: round2(levelH * 3.28084),
    })),
    climateZone,
    occupancy,
    wallR,
    atticR,
  })

  const equipmentSpec = sizeHvacEquipment({
    coolingTons: load.recommendedTons,
    heatingBtuh: load.totalHeatingBtuh,
    systemType,
    refrigerant,
    climateZone,
  })

  const bedrooms = Math.max(1, rooms.filter((r) => r.category === 'bedroom').length)
  const bathrooms = rooms.filter((r) => r.category === 'bathroom').length
  const hasKitchen = rooms.some((r) => r.category === 'kitchen')
  const ventilation = calculateAshrae622Ventilation({
    conditionedSqft: Math.max(400, load.conditionedSqft),
    bedrooms,
    bathrooms,
    hasKitchen,
  })

  const equipment: PlannedHvacEquipmentSpec[] = []
  const plenums: PlannedHvacPlenumSpec[] = []
  const terminals: PlannedHvacTerminalSpec[] = []
  const ductRuns: PlannedHvacDuctRunSpec[] = []

  const seq = { eq: 1, pl: 1, term: 1, duct: 1 }
  const allocId = (prefix: string, key: keyof typeof seq) => {
    while (nodes[`${prefix}_${seq[key]}`]) seq[key] += 1
    return `${prefix}_${seq[key]++}`
  }

  const nextEqId = () => allocId('hvaceq_auto', 'eq')
  const nextPlId = () => allocId('hvacpl_auto', 'pl')
  const nextTermId = () => allocId('hvacterm_auto', 'term')
  const nextDuctId = () => allocId('hvacduct_auto', 'duct')

  // 1. Place Primary Mechanical Equipment (Indoor Air Handler/Furnace + Outdoor Condenser)
  // Prefer a dedicated Utility/Mechanical/Laundry/Garage room; when none exists and plenumLocation is 'attic',
  // mount the Air Handler & ERV realistically on an Attic Mechanical Platform (IMC 307.2.3 secondary pan + SS2)
  // above the wet/service core so living rooms stay completely unobstructed and synchronized with Plumbing.
  const dedicatedMechRoom =
    rooms.find((r) => r.category === 'utility' || r.category === 'laundry' || r.category === 'garage') ?? null
  const isAtticMountedAhu =
    !dedicatedMechRoom &&
    plenumLocation === 'attic' &&
    (systemType === 'split-heat-pump' || systemType === 'split-gas-furnace')

  const wetCoreRoom =
    rooms.find((r) => r.category === 'kitchen') ??
    rooms.find((r) => r.category === 'bathroom') ??
    rooms.find((r) => r.category === 'hallway') ??
    null
  const mechRoom =
    dedicatedMechRoom ??
    rooms.find((r) => r.category === 'hallway') ??
    wetCoreRoom ??
    rooms[0]!

  // Cross-trade synchronicity: align near existing plumbing water-heater/service core (offset >= 1.1m clear)
  const existingWh = obstacles.find(
    (o) => o.category === 'plumbing' && /water.?heater|wh_|manifold|tank/i.test(`${o.label} ${o.nodeId}`),
  )
  const preferServicePt: readonly [number, number] = existingWh
    ? [(existingWh.box.minX + existingWh.box.maxX) / 2, (existingWh.box.minZ + existingWh.box.maxZ) / 2]
    : wetCoreRoom
      ? wetCoreRoom.centroid
      : [bounds.maxX - 0.8, bounds.cz]

  const atticPlatformY = round2(levelH + 0.08)
  const [clearX, clearZ] = isAtticMountedAhu
    ? findClearMechanicalSpot(
        preferServicePt[0],
        preferServicePt[1],
        obstacles,
        bounds,
        1.1,
        false,
        wetCoreRoom?.polygon ?? mechRoom.polygon,
      )
    : findWallTuckedCornerSpot(mechRoom, obstacles, bounds, 0.48, 1.1, preferServicePt)

  const indoorPos: Vec3 = [clearX, isAtticMountedAhu ? atticPlatformY : 0, clearZ]
  const indoorRoomLabel = isAtticMountedAhu ? 'Attic Mechanical Platform' : mechRoom.name
  // Place outdoor condenser on the nearest exterior side wall to the mechanical core, maintaining >= 1.2m
  // ignition-source clearance from any exterior fuel-gas meter/regulator vent (IFGC / NFPA 54).
  const outdoorOnWest = Math.abs(indoorPos[0] - bounds.minX) < Math.abs(bounds.maxX - indoorPos[0])
  const outdoorX = round2(outdoorOnWest ? bounds.minX - 0.95 : bounds.maxX + 0.95)
  const extWallObstacles = obstacles.filter(
    (o) =>
      o.category === 'plumbing' &&
      Math.abs((o.box.minX + o.box.maxX) / 2 - (outdoorOnWest ? bounds.minX : bounds.maxX)) <= 1.5,
  )
  let outdoorZ = round2(indoorPos[2])
  const isOutdoorClear = (tz: number): boolean =>
    extWallObstacles.every((o) => Math.abs(tz - (o.box.minZ + o.box.maxZ) / 2) >= 1.2)
  if (!isOutdoorClear(outdoorZ)) {
    for (const dz of [1.4, -1.4, 2.2, -2.2]) {
      const candZ = round2(indoorPos[2] + dz)
      if (candZ >= bounds.minZ + 0.4 && candZ <= bounds.maxZ - 0.4 && isOutdoorClear(candZ)) {
        outdoorZ = candZ
        break
      }
    }
  }
  const outdoorPos: Vec3 = [outdoorX, 0, outdoorZ]
  const hasOverheadSlabPlumbing = obstacles.some(
    (o) => o.category === 'plumbing' && o.box.maxY >= levelH - 0.35 && o.box.minY <= levelH,
  )
  const plenumY =
    plenumLocation === 'attic'
      ? round2(levelH + 0.28)
      : plenumLocation === 'conditioned-soffit'
        ? hasOverheadSlabPlumbing
          ? round2(Math.max(2.35, levelH - 0.54))
          : round2(levelH - 0.22)
        : -0.26

  const indoorKind: HvacEquipmentKind =
    systemType === 'split-gas-furnace'
      ? 'gas-furnace-96'
      : systemType === 'mini-split-multizone'
        ? 'mini-split-outdoor'
        : systemType === 'rooftop-package'
          ? 'rooftop-package-unit'
          : 'air-handler'

  const indoorId = nextEqId()
  let outdoorId = indoorId
  let rtuPos: Vec3 | null = null

  if (systemType === 'split-heat-pump' || systemType === 'split-gas-furnace') {
    const heatStripKw =
      systemType === 'split-heat-pump'
        ? load.recommendedTons <= 2.5
          ? 5
          : load.recommendedTons <= 3.5
            ? 10
            : load.recommendedTons <= 5.0
              ? 15
              : 20
        : 0
    equipment.push({
      id: indoorId,
      name: `${HVAC_EQUIPMENT_SPECS[indoorKind].label} (${load.recommendedTons}-Ton)`,
      equipmentKind: indoorKind,
      position: indoorPos,
      rotation: 0,
      roomName: indoorRoomLabel,
      coolingTons: load.recommendedTons,
      heatingBtuh: equipmentSpec.heatingOutputBtuh,
      gasBtuh: equipmentSpec.furnaceInputBtuh,
      airflowCfm: load.designTotalCfm,
      seer2: equipmentSpec.minSeer2,
      hspf2: systemType === 'split-heat-pump' ? equipmentSpec.minHspf2 : 0,
      refrigerant,
      hasSecondaryDrainPan: true,
      hasFloatSwitch: true,
      hasDisconnectWithinSight: true,
      electricalDemand: getHvacEquipmentElectricalDemand({
        kind: indoorKind,
        coolingTons: load.recommendedTons,
        heatStripKw,
        occupancy,
      }),
    })

    const outdoorKind: HvacEquipmentKind =
      systemType === 'split-gas-furnace' ? 'ac-condenser' : 'heat-pump-condenser'
    outdoorId = nextEqId()
    equipment.push({
      id: outdoorId,
      name: `${HVAC_EQUIPMENT_SPECS[outdoorKind].label} (${load.recommendedTons}-Ton, ${equipmentSpec.minSeer2} SEER2)`,
      equipmentKind: outdoorKind,
      position: outdoorPos,
      rotation: 0,
      roomName: 'Exterior Pad',
      coolingTons: load.recommendedTons,
      heatingBtuh: systemType === 'split-heat-pump' ? equipmentSpec.heatingOutputBtuh : 0,
      gasBtuh: 0,
      airflowCfm: 0,
      seer2: equipmentSpec.minSeer2,
      hspf2: systemType === 'split-heat-pump' ? equipmentSpec.minHspf2 : 0,
      refrigerant,
      hasSecondaryDrainPan: false,
      hasFloatSwitch: false,
      hasDisconnectWithinSight: true,
      electricalDemand: getHvacEquipmentElectricalDemand({
        kind: outdoorKind,
        coolingTons: load.recommendedTons,
        occupancy,
      }),
    })

    // Insulated Copper Refrigerant Lineset (Indoor Coil -> Outdoor Condenser)
    const linesetRoute = routeHvacDuctRun({
      from: [round2(indoorPos[0] + (outdoorOnWest ? -0.22 : 0.22)), round2(indoorPos[1] + 0.95), indoorPos[2]],
      to: [round2(outdoorPos[0] + (outdoorOnWest ? 0.35 : -0.35)), 0.35, outdoorPos[2]],
      plenumY: plenumLocation === 'attic' ? round2(levelH + 0.12) : -0.18,
      ductHalfSpanM: 0.03,
      allowDiagonalBranch: false,
      obstacles,
    })
    ductRuns.push({
      id: nextDuctId(),
      name: `Refrigerant Lineset (${equipmentSpec.liquidLineIn} / ${equipmentSpec.suctionLineIn} ${refrigerant})`,
      system: 'refrigerant-lineset',
      shape: 'round',
      material: 'insulated-copper',
      width: 2,
      height: 2,
      diameter: 2,
      path: linesetRoute.path,
      airflowCfm: 0,
      velocityFpm: 0,
      frictionRateInWgPer100Ft: 0,
      insulationR: 4,
      sourceNodeId: indoorId,
      targetNodeId: outdoorId,
      showFramingClearances: true,
    })

    // Sloped 3/4" PVC Condensate Drain (IMC 307.2)
    const condExitPos: Vec3 = [
      round2(outdoorOnWest ? bounds.minX - 0.15 : bounds.maxX + 0.15),
      0.05,
      round2(indoorPos[2] + 0.4),
    ]
    const condRoute = routeCondensateDrain({
      from: [
        round2(indoorPos[0] + (outdoorOnWest ? -0.25 : 0.25)),
        round2(indoorPos[1] + (isAtticMountedAhu ? 0.08 : 0.95)),
        indoorPos[2] + 0.1,
      ],
      to: condExitPos,
      obstacles,
    })
    ductRuns.push({
      id: nextDuctId(),
      name: '3/4" PVC Condensate Drain (IMC 307.2)',
      system: 'condensate-drain',
      shape: 'round',
      material: 'pvc-condensate',
      width: 0.75,
      height: 0.75,
      diameter: 0.75,
      path: condRoute.path,
      airflowCfm: 0,
      velocityFpm: 0,
      frictionRateInWgPer100Ft: 0,
      insulationR: 0,
      sourceNodeId: indoorId,
      showFramingClearances: true,
    })
  } else if (systemType === 'rooftop-package') {
    const [rtuX, rtuZ] = findClearMechanicalSpot(bounds.cx, bounds.cz, obstacles, bounds, 0.75)
    rtuPos = [rtuX, round2(levelH + 0.15), rtuZ]
    equipment.push({
      id: indoorId,
      name: `Packaged RTU (${load.recommendedTons}-Ton)`,
      equipmentKind: 'rooftop-package-unit',
      position: rtuPos,
      rotation: 0,
      roomName: 'Roof Curb',
      coolingTons: load.recommendedTons,
      heatingBtuh: equipmentSpec.heatingOutputBtuh,
      gasBtuh: 0,
      airflowCfm: load.designTotalCfm,
      seer2: equipmentSpec.minSeer2,
      hspf2: equipmentSpec.minHspf2,
      refrigerant,
      hasSecondaryDrainPan: true,
      hasFloatSwitch: true,
      hasDisconnectWithinSight: true,
      electricalDemand: getHvacEquipmentElectricalDemand({
        kind: 'rooftop-package-unit',
        coolingTons: load.recommendedTons,
        occupancy,
      }),
    })

    // Sloped 3/4" PVC RTU Condensate Drain from roof curb to roof edge/exterior (IMC 307.2)
    const rtuCondFrom: Vec3 = [round2(rtuPos[0] + 0.45), round2(rtuPos[1] + 0.15), rtuPos[2]]
    const rtuCondTo: Vec3 = [round2(bounds.maxX + 0.15), 0.05, rtuPos[2]]
    const rtuCondRoute = routeCondensateDrain({
      from: rtuCondFrom,
      to: rtuCondTo,
      obstacles,
    })
    ductRuns.push({
      id: nextDuctId(),
      name: '3/4" PVC RTU Condensate Drain (IMC 307.2)',
      system: 'condensate-drain',
      shape: 'round',
      material: 'pvc-condensate',
      width: 0.75,
      height: 0.75,
      diameter: 0.75,
      path: rtuCondRoute.path,
      airflowCfm: 0,
      velocityFpm: 0,
      frictionRateInWgPer100Ft: 0,
      insulationR: 0,
      sourceNodeId: indoorId,
      showFramingClearances: true,
    })
  } else {
    // Ductless multi-zone mini-split outdoor unit
    equipment.push({
      id: indoorId,
      name: `Multi-Zone Mini-Split Outdoor (${load.recommendedTons}-Ton)`,
      equipmentKind: 'mini-split-outdoor',
      position: outdoorPos,
      rotation: 0,
      roomName: 'Exterior Pad',
      coolingTons: load.recommendedTons,
      heatingBtuh: equipmentSpec.heatingOutputBtuh,
      gasBtuh: 0,
      airflowCfm: 0,
      seer2: Math.max(18, equipmentSpec.minSeer2),
      hspf2: Math.max(9.5, equipmentSpec.minHspf2),
      refrigerant,
      hasSecondaryDrainPan: false,
      hasFloatSwitch: false,
      hasDisconnectWithinSight: true,
      electricalDemand: getHvacEquipmentElectricalDemand({
        kind: 'mini-split-outdoor',
        coolingTons: load.recommendedTons,
        occupancy,
      }),
    })
  }

  // 2. Ducted Supply/Return Plenums, Main Trunks, Branches, & Terminals (or Mini-Split Wall Heads)
  const conditionedRooms = load.rooms
    .map((rr) => ({
      loadRow: rr,
      room: rooms.find((r) => r.id === rr.roomId)!,
    }))
    .filter((entry) => Boolean(entry.room))

  let omittedReturnNote = ''

  const maxPlenumY = plenumLocation === 'conditioned-soffit' ? round2(levelH - 0.08) : undefined
  const effectiveDuctR = (path: ReadonlyArray<Vec3>): number =>
    path.some((p) => p[1] > levelH - 0.02) ? Math.max(ductR, zoneMeta.ieccAtticDuctR) : ductR

  if (systemType === 'mini-split-multizone') {
    for (const { loadRow, room } of conditionedRooms) {
      if (room.category === 'bathroom' || room.category === 'hallway' || room.category === 'utility') continue
      const headId = nextTermId()
      const [headX, headZ] = findClearMechanicalSpot(room.centroid[0], room.centroid[1], obstacles, bounds, 0.42, true)
      const headPos: Vec3 = [headX, round2(Math.min(levelH - 0.35, 2.15)), headZ]
      terminals.push({
        id: headId,
        name: `${room.name} Mini-Split Head (${loadRow.designCfm} CFM)`,
        terminalKind: 'mini-split-wall-head',
        position: headPos,
        rotation: 0,
        roomName: room.name,
        designCfm: loadRow.designCfm,
        neckSizeIn: 0,
        throwFt: 18,
      })
      const lineRoute = routeHvacDuctRun({
        from: [round2(outdoorPos[0] + (outdoorOnWest ? 0.25 : -0.25)), 0.45, outdoorPos[2]],
        to: headPos,
        plenumY: round2(levelH + 0.12),
        maxPlenumY,
        ductHalfSpanM: 0.03,
        allowDiagonalBranch: true,
        obstacles,
      })
      ductRuns.push({
        id: nextDuctId(),
        name: `Mini-Split Lineset (${room.name})`,
        system: 'refrigerant-lineset',
        shape: 'round',
        material: 'insulated-copper',
        width: 2,
        height: 2,
        diameter: 2,
        path: lineRoute.path,
        airflowCfm: 0,
        velocityFpm: 0,
        frictionRateInWgPer100Ft: 0,
        insulationR: 4,
        sourceNodeId: indoorId,
        targetNodeId: headId,
        showFramingClearances: true,
      })
    }
  } else {
    // Ducted Supply & Return Plenums + ACCA Manual D Trunks + Branches
    const supplyTrunkSize = sizeDuctForCfm({
      cfm: load.designTotalCfm,
      shape: 'rectangular',
      material: 'galvanized-sheet',
      isTrunk: true,
      isReturn: false,
      occupancy,
      maxHeightIn: occupancy === 'commercial' ? 12 : 8,
    })
    const returnTrunkSize = sizeDuctForCfm({
      cfm: load.designTotalCfm,
      shape: 'rectangular',
      material: 'galvanized-sheet',
      isTrunk: true,
      isReturn: true,
      occupancy,
      maxHeightIn: occupancy === 'commercial' ? 14 : 10,
    })

    const supplyPlenumId = nextPlId()
    const supplyPlenumH = Math.max(0.2, supplyTrunkSize.heightIn * 0.0254)
    // Seat split-system supply plenum flush on top of air handler/furnace cabinet (pan 0.05m + cabinet 1.38m = 1.43m);
    // for rooftop-package, anchor both supply and return curb drop plenums directly below the RTU curb.
    const supplyPlenumPos: Vec3 =
      systemType === 'rooftop-package' && rtuPos
        ? [round2(rtuPos[0] + 0.32), round2(levelH - 0.15), rtuPos[2]]
        : [indoorPos[0], Math.round((indoorPos[1] + 0.05 + 1.38 + supplyPlenumH / 2) * 10000) / 10000, indoorPos[2]]
    plenums.push({
      id: supplyPlenumId,
      name: `Supply Plenum (${supplyTrunkSize.widthIn}"x${supplyTrunkSize.heightIn}")`,
      plenumKind: 'supply-plenum',
      position: supplyPlenumPos,
      rotation: 0,
      widthIn: supplyTrunkSize.widthIn,
      heightIn: supplyTrunkSize.heightIn,
      depthIn: 24,
      airflowCfm: load.designTotalCfm,
      staticPressureInWg: 0.25,
      insulationR: ductR,
    })

    const returnPlenumId = nextPlId()
    let returnPlenumPos: Vec3
    if (systemType === 'rooftop-package' && rtuPos) {
      returnPlenumPos = [round2(rtuPos[0] - 0.38), round2(levelH - 0.15), rtuPos[2]]
    } else {
      // Side-return drop offset beside the air handler/furnace cabinet & supply plenum so the vertical
      // return trunk never pierces the cabinet or blue supply plenum.
      const cabScale = load.recommendedTons >= 4 ? 1.12 : load.recommendedTons <= 2 ? 0.92 : 1.0
      const cabHalfX = Math.max((0.54 * cabScale) / 2, (supplyTrunkSize.widthIn * 0.0254) / 2)
      const cabHalfZ = Math.max((indoorKind === 'air-handler' ? 0.56 : 0.72) / 2, (24 * 0.0254) / 2)
      const retHalfM = (returnTrunkSize.widthIn * 0.0254) / 2
      const lateralOffsetX = round2(cabHalfX + retHalfM + 0.08)
      const lateralOffsetZ = round2(cabHalfZ + retHalfM + 0.08)
      const retPlenumYPreview = round2(plenumY + (plenumLocation === 'attic' ? 0.24 : -0.24))
      const retClashSpan = {
        horizontal: Math.max(0.12, retHalfM),
        vertical: Math.max(0.05, (returnTrunkSize.heightIn * 0.0254) / 2),
      }
      const sideCandidates: ReadonlyArray<readonly [number, number]> = [
        [round2(indoorPos[0] - lateralOffsetX), indoorPos[2]],
        [round2(indoorPos[0] + lateralOffsetX), indoorPos[2]],
        [indoorPos[0], round2(indoorPos[2] + lateralOffsetZ)],
        [indoorPos[0], round2(indoorPos[2] - lateralOffsetZ)],
      ]
      const retPlenumBaseY = isAtticMountedAhu ? round2(atticPlatformY + 0.25) : 0.25
      let bestDrop: readonly [number, number] = sideCandidates[0]!
      let bestScore = -Infinity
      for (const [cx, cz] of sideCandidates) {
        const inRoom = pointInPolygon2D(cx, cz, mechRoom.polygon)
        const inBounds =
          cx >= bounds.minX + 0.15 &&
          cx <= bounds.maxX - 0.15 &&
          cz >= bounds.minZ + 0.15 &&
          cz <= bounds.maxZ - 0.15
        const dropClashes = detectHvacClashes(
          [
            [cx, retPlenumYPreview, cz],
            [cx, retPlenumBaseY, cz],
          ],
          obstacles,
          retClashSpan,
        ).length
        const clear = Math.min(2.0, minClearanceToObstaclesXZ(cx, cz, obstacles))
        const score = (dropClashes === 0 ? 100 : -dropClashes * 50) + (inRoom ? 20 : 0) + (inBounds ? 10 : 0) + clear
        if (score > bestScore) {
          bestScore = score
          bestDrop = [cx, cz]
        }
      }
      returnPlenumPos = [bestDrop[0], retPlenumBaseY, bestDrop[1]]
    }
    plenums.push({
      id: returnPlenumId,
      name: `Return Plenum (${returnTrunkSize.widthIn}"x${returnTrunkSize.heightIn}")`,
      plenumKind: 'return-plenum',
      position: returnPlenumPos,
      rotation: 0,
      widthIn: returnTrunkSize.widthIn,
      heightIn: returnTrunkSize.heightIn,
      depthIn: 24,
      airflowCfm: load.designTotalCfm,
      staticPressureInWg: -0.2,
      insulationR: ductR,
    })

    // Main Supply Trunk Spine from Supply Plenum to furthest conditioned room
    const furthestRoom = conditionedRooms.reduce(
      (far, entry) => {
        const dFar = Math.hypot(far.room.centroid[0] - supplyPlenumPos[0], far.room.centroid[1] - supplyPlenumPos[2])
        const dCur = Math.hypot(entry.room.centroid[0] - supplyPlenumPos[0], entry.room.centroid[1] - supplyPlenumPos[2])
        return dCur > dFar ? entry : far
      },
      conditionedRooms[0] ?? { room: rooms[0]!, loadRow: { designCfm: load.designTotalCfm } },
    )

    const [trunkEndX, trunkEndZ] = findClearMechanicalSpot(
      furthestRoom.room.centroid[0],
      furthestRoom.room.centroid[1],
      obstacles,
      bounds,
      Math.max(0.45, (supplyTrunkSize.widthIn * 0.0254) / 2 + 0.12),
      true,
    )
    const trunkRoute = routeHvacDuctRun({
      from: supplyPlenumPos,
      to: [trunkEndX, plenumY, trunkEndZ],
      plenumY,
      maxPlenumY,
      ductHalfSpanM: {
        horizontal: Math.max(0.12, (supplyTrunkSize.widthIn * 0.0254) / 2),
        vertical: Math.max(0.05, (supplyTrunkSize.heightIn * 0.0254) / 2),
      },
      allowDiagonalBranch: false,
      obstacles,
    })
    const supplyTrunkId = nextDuctId()
    ductRuns.push({
      id: supplyTrunkId,
      name: `${supplyTrunkSize.widthIn}"x${supplyTrunkSize.heightIn}" Main Supply Trunk (${load.designTotalCfm} CFM)`,
      system: 'supply-trunk',
      shape: 'rectangular',
      material: 'galvanized-sheet',
      width: supplyTrunkSize.widthIn,
      height: supplyTrunkSize.heightIn,
      diameter: supplyTrunkSize.diameterIn,
      path: trunkRoute.path,
      airflowCfm: load.designTotalCfm,
      velocityFpm: supplyTrunkSize.velocityFpm,
      frictionRateInWgPer100Ft: supplyTrunkSize.frictionRateInWgPer100Ft,
      insulationR: effectiveDuctR(trunkRoute.path),
      sourceNodeId: supplyPlenumId,
      showFramingClearances: true,
    })

    const supplyTermKind: HvacTerminalKind =
      plenumLocation === 'attic' || plenumLocation === 'conditioned-soffit'
        ? 'supply-ceiling-diffuser'
        : 'supply-floor-register'
    const termY =
      supplyTermKind === 'supply-ceiling-diffuser' ? round2(levelH - 0.03) : HVAC_TERMINAL_SPECS[supplyTermKind].defaultMountY

    // Place room supply registers + tap Manual D round branches from nearest trunk spine point
    for (const { loadRow, room } of conditionedRooms) {
      const regCount = loadRow.recommendedRegisters
      const cfmEach = Math.max(40, Math.round(loadRow.designCfm / regCount))
      const branchSized = sizeDuctForCfm({
        cfm: cfmEach,
        shape: 'round',
        material: ductR >= 8 ? 'flex-r8' : 'flex-r6',
        isTrunk: false,
        isReturn: false,
        occupancy,
      })

      for (let i = 0; i < regCount; i++) {
        const offsetX = regCount === 1 ? 0 : (i - (regCount - 1) / 2) * 1.4
        const [regX, regZ] = findClearMechanicalSpot(room.centroid[0] + offsetX, room.centroid[1], obstacles, bounds, 0.32, true)
        const regPos: Vec3 = [regX, termY, regZ]
        const termId = nextTermId()
        terminals.push({
          id: termId,
          name: `${room.name} Supply ${regCount > 1 ? `#${i + 1} ` : ''}(${cfmEach} CFM)`,
          terminalKind: supplyTermKind,
          position: regPos,
          rotation: 0,
          roomName: room.name,
          designCfm: cfmEach,
          neckSizeIn: branchSized.diameterIn,
          throwFt: Math.min(16, Math.max(6, Math.round(cfmEach / 12))),
        })

        const tapPt = nearestPointOnSpine(trunkRoute.path, regPos[0], regPos[2], plenumY)
        const branchRoute = routeHvacDuctRun({
          from: tapPt,
          to: regPos,
          plenumY,
          maxPlenumY,
          ductHalfSpanM: Math.max(0.08, (branchSized.diameterIn * 0.0254) / 2),
          allowDiagonalBranch: true,
          obstacles,
        })
        ductRuns.push({
          id: nextDuctId(),
          name: `${branchSized.diameterIn}" Supply Branch (${room.name}, ${cfmEach} CFM)`,
          system: 'supply-branch',
          shape: 'round',
          material: ductR >= 8 ? 'flex-r8' : 'flex-r6',
          width: branchSized.diameterIn,
          height: branchSized.diameterIn,
          diameter: branchSized.diameterIn,
          path: branchRoute.path,
          airflowCfm: cfmEach,
          velocityFpm: branchSized.velocityFpm,
          frictionRateInWgPer100Ft: branchSized.frictionRateInWgPer100Ft,
          insulationR: effectiveDuctR(branchRoute.path),
          sourceNodeId: supplyTrunkId,
          targetNodeId: termId,
          showFramingClearances: true,
        })
      }

      // Bedroom transfer grille for closed-door pressure relief (Manual D)
      if (room.category === 'bedroom') {
        terminals.push({
          id: nextTermId(),
          name: `${room.name} Return Transfer Grille`,
          terminalKind: 'transfer-grille',
          position: [round2(room.centroid[0] - 0.6), round2(Math.min(levelH - 0.3, 2.25)), round2(room.centroid[1])],
          rotation: 0,
          roomName: room.name,
          designCfm: loadRow.designCfm,
          neckSizeIn: 8,
          throwFt: 0,
        })
      }
    }

    // Central Return Grille + Return Trunk back to Return Plenum (IMC 601 / IMC 601.5 / IRC M1602.2)
    // Prohibited return-air zones: bathrooms, garages, kitchens, utility/closets, attics, and exterior spaces.
    const prohibitedReturnCats = new Set(['bathroom', 'garage', 'kitchen', 'utility', 'closet', 'exterior', 'attic'])
    const eligibleReturnRooms = rooms.filter((r) => !prohibitedReturnCats.has(r.category))
    const returnRoom =
      eligibleReturnRooms.find((r) => r.category === 'hallway') ??
      eligibleReturnRooms.find((r) => r.category === 'living') ??
      eligibleReturnRooms[0] ??
      null
    if (returnRoom) {
      const retGrilleId = nextTermId()
      const retBaseX = returnRoom.centroid[0]
      const retBaseZ = pointInPolygon2D(retBaseX, returnRoom.centroid[1] + 0.35, returnRoom.polygon)
        ? returnRoom.centroid[1] + 0.35
        : returnRoom.centroid[1]
      const [rgX, rgZ] = findClearMechanicalSpot(
        retBaseX,
        retBaseZ,
        obstacles,
        bounds,
        0.38,
        true,
        returnRoom.polygon,
      )
      const retGrillePos: Vec3 = [
        rgX,
        isAtticMountedAhu ? round2(levelH - 0.03) : round2(Math.min(levelH - 0.35, 2.2)),
        rgZ,
      ]
      terminals.push({
        id: retGrilleId,
        name: `Central Return Air Grille (${load.designTotalCfm} CFM)`,
        terminalKind: 'return-grille',
        position: retGrillePos,
        rotation: 0,
        roomName: returnRoom.name,
        designCfm: load.designTotalCfm,
        neckSizeIn: returnTrunkSize.diameterIn,
        throwFt: 0,
      })
      const retClashSpan = {
        horizontal: Math.max(0.12, (returnTrunkSize.widthIn * 0.0254) / 2),
        vertical: Math.max(0.05, (returnTrunkSize.heightIn * 0.0254) / 2),
      }
      const retRoute = routeHvacDuctRun({
        from: retGrillePos,
        to: returnPlenumPos,
        plenumY: round2(plenumY + (plenumLocation === 'attic' ? 0.24 : -0.24)),
        maxPlenumY,
        ductHalfSpanM: retClashSpan,
        allowDiagonalBranch: false,
        obstacles,
      })
      const retPath: Vec3[] = [...retRoute.path]
      if (systemType !== 'rooftop-package') {
        const bootEntry: Vec3 = [indoorPos[0], returnPlenumPos[1], indoorPos[2]]
        const lastPt = retPath[retPath.length - 1]
        if (
          lastPt &&
          Math.hypot(bootEntry[0] - lastPt[0], bootEntry[2] - lastPt[2]) > 0.05 &&
          detectHvacClashes([lastPt, bootEntry], obstacles, retClashSpan).length === 0
        ) {
          retPath.push(bootEntry)
        }
      }
      ductRuns.push({
        id: nextDuctId(),
        name: `${returnTrunkSize.widthIn}"x${returnTrunkSize.heightIn}" Return Air Trunk (${load.designTotalCfm} CFM)`,
        system: 'return-trunk',
        shape: 'rectangular',
        material: 'galvanized-sheet',
        width: returnTrunkSize.widthIn,
        height: returnTrunkSize.heightIn,
        diameter: returnTrunkSize.diameterIn,
        path: retPath,
        airflowCfm: load.designTotalCfm,
        velocityFpm: returnTrunkSize.velocityFpm,
        frictionRateInWgPer100Ft: returnTrunkSize.frictionRateInWgPer100Ft,
        insulationR: effectiveDuctR(retPath),
        sourceNodeId: retGrilleId,
        targetNodeId: returnPlenumId,
        showFramingClearances: true,
      })
    } else {
      omittedReturnNote = ' Warning: no habitable room available for IMC 601.5 return air grille.'
    }
  }

  // 3. Smart Thermostat in Hallway / Living Room (snapped flush onto an interior partition wall)
  const statRoom =
    rooms.find((r) => r.category === 'hallway') ??
    rooms.find((r) => r.category === 'living') ??
    rooms[0]!
  const statSnap = snapPointToRoomWall(statRoom, walls, 1.52, 0.05)
  terminals.push({
    id: nextTermId(),
    name: `Smart Thermostat (${equipmentSpec.thermostatCable})`,
    terminalKind: 'smart-thermostat',
    position: statSnap.position,
    rotation: statSnap.rotation,
    roomName: statRoom.name,
    designCfm: 0,
    neckSizeIn: 0,
    throwFt: 0,
  })

  // 4. Optional ASHRAE 62.2 ERV Fresh-Air Ventilator & Duct
  if (includeErv) {
    const ervId = nextEqId()
    const ervObstacles: HvacObstacle[] = [
      ...obstacles,
      {
        id: indoorId,
        nodeId: indoorId,
        category: 'structural',
        label: 'Primary Air Handler / Furnace Cabinet',
        box: {
          minX: indoorPos[0] - 0.34,
          maxX: indoorPos[0] + 0.34,
          minY: indoorPos[1],
          maxY: indoorPos[1] + 1.85,
          minZ: indoorPos[2] - 0.38,
          maxZ: indoorPos[2] + 0.38,
        },
      },
    ]
    const ervBaseOffsets: ReadonlyArray<readonly [number, number]> = [
      [0.85, 0.45],
      [-0.85, 0.45],
      [0.85, -0.45],
      [-0.85, -0.45],
      [0, 0.85],
      [0, -0.85],
      [0.85, 0],
      [-0.85, 0],
    ]
    let ervBaseX = indoorPos[0]
    let ervBaseZ = indoorPos[2]
    for (const [ox, oz] of ervBaseOffsets) {
      const tx = round2(indoorPos[0] + ox)
      const tz = round2(indoorPos[2] + oz)
      if (isAtticMountedAhu || isInsideWithMargin(tx, tz, mechRoom.polygon, 0.22)) {
        if (tx >= bounds.minX + 0.4 && tx <= bounds.maxX - 0.4 && tz >= bounds.minZ + 0.4 && tz <= bounds.maxZ - 0.4) {
          ervBaseX = tx
          ervBaseZ = tz
          break
        }
      }
    }
    const [ervX, ervZ] = findClearMechanicalSpot(
      ervBaseX,
      ervBaseZ,
      ervObstacles,
      bounds,
      0.65,
      true,
      isAtticMountedAhu ? undefined : mechRoom.polygon,
    )
    const ervPos: Vec3 = [
      ervX,
      isAtticMountedAhu ? round2(atticPlatformY + 0.12) : round2(Math.min(levelH - 0.55, 1.85)),
      ervZ,
    ]
    equipment.push({
      id: ervId,
      name: `ASHRAE 62.2 ERV (${ventilation.recommendedErvCfm} CFM)`,
      equipmentKind: 'erv-ventilator',
      position: ervPos,
      rotation: 0,
      roomName: indoorRoomLabel,
      coolingTons: 0,
      heatingBtuh: 0,
      gasBtuh: 0,
      airflowCfm: ventilation.recommendedErvCfm,
      seer2: 0,
      hspf2: 0,
      refrigerant,
      hasSecondaryDrainPan: false,
      hasFloatSwitch: false,
      hasDisconnectWithinSight: true,
      electricalDemand: getHvacEquipmentElectricalDemand({ kind: 'erv-ventilator', occupancy }),
    })

    const intakeId = nextTermId()
    const intakeOnWest = Math.abs(ervPos[0] - bounds.minX) <= Math.abs(bounds.maxX - ervPos[0])
    const intakePos: Vec3 = [
      round2(intakeOnWest ? bounds.minX - 0.08 : bounds.maxX + 0.08),
      isAtticMountedAhu ? round2(levelH + 0.25) : 2.1,
      round2(ervPos[2]),
    ]
    terminals.push({
      id: intakeId,
      name: `Fresh Air Intake Hood (${ventilation.continuousFreshAirCfm} CFM)`,
      terminalKind: 'fresh-air-intake',
      position: intakePos,
      rotation: 0,
      roomName: 'Exterior',
      designCfm: ventilation.continuousFreshAirCfm,
      neckSizeIn: 6,
      throwFt: 0,
    })

    const ervDuct = sizeDuctForCfm({
      cfm: ventilation.continuousFreshAirCfm,
      shape: 'round',
      material: 'galvanized-sheet',
      occupancy,
    })
    const ervRoute = routeHvacDuctRun({
      from: intakePos,
      to: ervPos,
      plenumY: round2(plenumY + 0.14),
      ductHalfSpanM: 0.08,
      allowDiagonalBranch: false,
      obstacles,
    })
    ductRuns.push({
      id: nextDuctId(),
      name: `${ervDuct.diameterIn}" ERV Fresh-Air Duct (${ventilation.continuousFreshAirCfm} CFM)`,
      system: 'fresh-air-erv',
      shape: 'round',
      material: 'galvanized-sheet',
      width: ervDuct.diameterIn,
      height: ervDuct.diameterIn,
      diameter: ervDuct.diameterIn,
      path: ervRoute.path,
      airflowCfm: ventilation.continuousFreshAirCfm,
      velocityFpm: ervDuct.velocityFpm,
      frictionRateInWgPer100Ft: ervDuct.frictionRateInWgPer100Ft,
      insulationR: ductR,
      sourceNodeId: intakeId,
      targetNodeId: ervId,
      showFramingClearances: true,
    })
  }

  // 5. Optional Bath & Kitchen Spot Exhaust Fans + Rigid Exterior Ducts (IMC 403.3 / 501.3)
  if (includeExhaustFans) {
    for (const room of rooms) {
      if (room.category === 'bathroom') {
        const fanId = nextEqId()
        const [fanX, fanZ] = findClearMechanicalSpot(room.centroid[0], room.centroid[1], obstacles, bounds, 0.35, true)
        const fanPos: Vec3 = [fanX, round2(levelH - 0.05), fanZ]
        equipment.push({
          id: fanId,
          name: `${room.name} Exhaust Fan (80 CFM)`,
          equipmentKind: 'bath-exhaust-fan',
          position: fanPos,
          rotation: 0,
          roomName: room.name,
          coolingTons: 0,
          heatingBtuh: 0,
          gasBtuh: 0,
          airflowCfm: 80,
          seer2: 0,
          hspf2: 0,
          refrigerant,
          hasSecondaryDrainPan: false,
          hasFloatSwitch: false,
          hasDisconnectWithinSight: true,
          electricalDemand: getHvacEquipmentElectricalDemand({ kind: 'bath-exhaust-fan', occupancy }),
        })
        const exRoute = routeHvacDuctRun({
          from: fanPos,
          to: [fanX, round2(levelH + 0.3), round2(bounds.minZ - 0.1)],
          plenumY: round2(levelH + 0.3),
          ductHalfSpanM: 0.06,
          allowDiagonalBranch: false,
          obstacles,
        })
        const exSized = sizeDuctForCfm({ cfm: 80, shape: 'round', material: 'galvanized-sheet', occupancy })
        ductRuns.push({
          id: nextDuctId(),
          name: `${exSized.diameterIn}" Bath Exhaust Duct (${room.name})`,
          system: 'exhaust-duct',
          shape: 'round',
          material: 'galvanized-sheet',
          width: exSized.diameterIn,
          height: exSized.diameterIn,
          diameter: exSized.diameterIn,
          path: exRoute.path,
          airflowCfm: 80,
          velocityFpm: exSized.velocityFpm,
          frictionRateInWgPer100Ft: exSized.frictionRateInWgPer100Ft,
          insulationR: ductR,
          sourceNodeId: fanId,
          showFramingClearances: true,
        })
      } else if (room.category === 'kitchen') {
        const hoodId = nextEqId()
        const [hoodX, hoodZ] = findClearMechanicalSpot(room.centroid[0], room.centroid[1], obstacles, bounds, 0.35, true)
        const hoodPos: Vec3 = [hoodX, round2(Math.min(levelH - 0.5, 1.78)), hoodZ]
        const hoodCfm = Math.max(250, ventilation.kitchenExhaustCfm)
        equipment.push({
          id: hoodId,
          name: `${room.name} Range Exhaust Hood (${hoodCfm} CFM)`,
          equipmentKind: 'range-hood',
          position: hoodPos,
          rotation: 0,
          roomName: room.name,
          coolingTons: 0,
          heatingBtuh: 0,
          gasBtuh: 0,
          airflowCfm: hoodCfm,
          seer2: 0,
          hspf2: 0,
          refrigerant,
          hasSecondaryDrainPan: false,
          hasFloatSwitch: false,
          hasDisconnectWithinSight: true,
          electricalDemand: getHvacEquipmentElectricalDemand({ kind: 'range-hood', occupancy }),
        })
        const hoodSized = sizeDuctForCfm({
          cfm: hoodCfm,
          shape: 'round',
          material: 'galvanized-sheet',
          occupancy,
        })
        const hoodDiam = Math.max(6, hoodSized.diameterIn)
        const hoodRoute = routeHvacDuctRun({
          from: [hoodPos[0], round2(hoodPos[1] + 0.25), hoodPos[2]],
          to: [round2(room.centroid[0]), round2(levelH + 0.34), round2(bounds.minZ - 0.1)],
          plenumY: round2(levelH + 0.34),
          ductHalfSpanM: Math.max(0.08, (hoodDiam * 0.0254) / 2),
          allowDiagonalBranch: false,
          obstacles,
        })
        ductRuns.push({
          id: nextDuctId(),
          name: `${hoodDiam}" Rigid Kitchen Range Hood Exhaust (IMC 505.4)`,
          system: 'exhaust-duct',
          shape: 'round',
          material: 'galvanized-sheet',
          width: hoodDiam,
          height: hoodDiam,
          diameter: hoodDiam,
          path: hoodRoute.path,
          airflowCfm: hoodCfm,
          velocityFpm: hoodSized.velocityFpm,
          frictionRateInWgPer100Ft: hoodSized.frictionRateInWgPer100Ft,
          insulationR: ductR,
          sourceNodeId: hoodId,
          showFramingClearances: true,
        })
      }
    }
  }

  return {
    levelId,
    codeEdition,
    climateZone,
    systemType,
    plenumLocation,
    load,
    equipmentSpec,
    ventilation,
    equipment,
    plenums,
    terminals,
    ductRuns,
    summary: `Auto-populated ${load.recommendedTons}-Ton ${systemType} (${load.designTotalCfm} CFM, Climate Zone ${climateZone}): ${equipment.length} equipment, ${plenums.length} plenums, ${terminals.length} terminals, ${ductRuns.length} duct/lineset runs.${omittedReturnNote}`,
  }
}
