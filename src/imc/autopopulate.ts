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
  extractHvacFramingContext,
  getHvacEquipmentElectricalDemand,
} from './framing-interop'
import {
  type AtticRoofEnvelope,
  type DuctClashMargin,
  type HvacObstacle,
  type XzBounds2D,
  buildAtticRoofEnvelope,
  detectHvacClashes,
  distancePointToSegment2D,
  extractHvacObstacles,
  extractRoomPolygons,
  extractWallSegments,
  findNearestExteriorWallPoints,
  isPointInsideBuildingFootprint,
  minRoofYOverFootprint,
  pathClearOfRoof,
  pointInPolygon2D,
  resolveLevelHeightM,
  resolveLowerWalledLevels,
  routeCondensateDrain,
  routeHvacDuctRun,
  safeRoofCorridorHalfWidth,
  segmentCrossesOutdoorVoid,
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
  INCHES_TO_METERS,
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
  orientation?: 'vertical' | 'horizontal'
  heightM?: number
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
  heightM?: number
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

function nearestPointOnSpine(
  spine: ReadonlyArray<Vec3>,
  x: number,
  z: number,
  fallbackY: number,
  footprintContains?: (px: number, pz: number) => boolean,
): Vec3 {
  let bestPt: Vec3 = spine[0] ?? [x, fallbackY, z]
  let bestDist = Infinity
  let bestInteriorPt: Vec3 | null = null
  let bestInteriorDist = Infinity
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
    const pt: Vec3 = [round2(px), round2(py), round2(pz)]
    if (d < bestDist) {
      bestDist = d
      bestPt = pt
    }
    if (footprintContains && d < bestInteriorDist && !segmentCrossesOutdoorVoid(pt, [x, py, z], footprintContains, 0.5)) {
      bestInteriorDist = d
      bestInteriorPt = pt
    }
  }
  return bestInteriorPt ?? bestPt
}

function sceneBounds(
  walls: ReadonlyArray<{ start: readonly [number, number]; end: readonly [number, number] }>,
  rooms: ReadonlyArray<{ category?: string; polygon: ReadonlyArray<readonly [number, number]> }>,
) {
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  // When walls span a 2D footprint (> 0.5m in both X and Z), derive building bounds strictly
  // from walled geometry so outdoor pools, patios, decks, and yards never inflate the envelope (VIS-06),
  // while guarding single/collinear wall scenes from degenerate zero-width clamping (R2-HVC-03).
  for (const w of walls) {
    minX = Math.min(minX, w.start[0], w.end[0])
    maxX = Math.max(maxX, w.start[0], w.end[0])
    minZ = Math.min(minZ, w.start[1], w.end[1])
    maxZ = Math.max(maxZ, w.start[1], w.end[1])
  }
  if (Number.isFinite(minX) && maxX - minX > 0.5 && maxZ - minZ > 0.5) {
    return { minX, maxX, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 }
  }
  const interiorRooms = rooms.filter((r) => r.category !== 'exterior')
  const srcRooms = interiorRooms.length > 0 ? interiorRooms : rooms
  for (const r of srcRooms) {
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

function clampToSpan(val: number, lo: number, hi: number): number {
  if (hi < lo) return round2((lo + hi) / 2)
  return round2(Math.max(lo, Math.min(hi, val)))
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

function findClearSpotForRiser(params: {
  baseX: number
  baseZ: number
  y0: number
  y1: number
  clashSpan: DuctClashMargin
  obstacles: ReadonlyArray<HvacObstacle>
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number }
  minFloorClearanceM?: number
  insidePolygon?: ReadonlyArray<readonly [number, number]>
  excludePolygons?: ReadonlyArray<ReadonlyArray<readonly [number, number]>>
  floorObstacles?: ReadonlyArray<HvacObstacle>
  roofConstraint?: {
    roof: AtticRoofEnvelope
    requiredTopY: number
    preferRidgeWeight?: number
    footprintHalfW?: number
    footprintHalfD?: number
  }
}): { spot: [number, number]; riserClashes: number; floorClear: number; foundValid: boolean } {
  const {
    baseX,
    baseZ,
    y0,
    y1,
    clashSpan,
    obstacles,
    bounds,
    minFloorClearanceM = 0.35,
    insidePolygon,
    excludePolygons,
    floorObstacles = obstacles,
    roofConstraint,
  } = params

  const hasValidWallSpan = bounds.maxX - bounds.minX > 0.35 && bounds.maxZ - bounds.minZ > 0.35
  const inWallEnvelope = (x: number, z: number, inset: number): boolean =>
    !hasValidWallSpan ||
    (x >= bounds.minX + inset && x <= bounds.maxX - inset && z >= bounds.minZ + inset && z <= bounds.maxZ - inset)

  const candSet: Array<readonly [number, number]> = [[round2(baseX), round2(baseZ)]]
  for (const r of [0.35, 0.55, 0.78, 1.05, 1.4, 1.85, 2.4, 3.1]) {
    candSet.push(
      [round2(baseX + r), round2(baseZ)],
      [round2(baseX - r), round2(baseZ)],
      [round2(baseX), round2(baseZ + r)],
      [round2(baseX), round2(baseZ - r)],
      [round2(baseX + r * 0.75), round2(baseZ + r * 0.75)],
      [round2(baseX - r * 0.75), round2(baseZ + r * 0.75)],
      [round2(baseX + r * 0.75), round2(baseZ - r * 0.75)],
      [round2(baseX - r * 0.75), round2(baseZ - r * 0.75)],
    )
  }

  if (insidePolygon && insidePolygon.length >= 3) {
    let pMinX = Infinity
    let pMaxX = -Infinity
    let pMinZ = Infinity
    let pMaxZ = -Infinity
    for (const [px, pz] of insidePolygon) {
      if (px < pMinX) pMinX = px
      if (px > pMaxX) pMaxX = px
      if (pz < pMinZ) pMinZ = pz
      if (pz > pMaxZ) pMaxZ = pz
    }
    const steps = 5
    for (let ix = 1; ix <= steps; ix++) {
      for (let iz = 1; iz <= steps; iz++) {
        const gx = round2(pMinX + ((pMaxX - pMinX) * ix) / (steps + 1))
        const gz = round2(pMinZ + ((pMaxZ - pMinZ) * iz) / (steps + 1))
        candSet.push([gx, gz])
      }
    }
  }

  // When searching for attic placement under a pitched roof, sample along the ridge centerline
  // AND a 5x5 interior grid so asymmetric hip/multi-segment roofs find the true highest peak.
  if (roofConstraint?.roof.hasRoofAbove) {
    const r = roofConstraint.roof
    const ridgeSteps = 9
    for (let i = 1; i <= ridgeSteps; i++) {
      const frac = i / (ridgeSteps + 1)
      if (r.ridgeAlongX) {
        const rx = round2(bounds.minX + 0.45 + (bounds.maxX - bounds.minX - 0.9) * frac)
        candSet.push([rx, round2(r.center)])
      } else {
        const rz = round2(bounds.minZ + 0.45 + (bounds.maxZ - bounds.minZ - 0.9) * frac)
        candSet.push([round2(r.center), rz])
      }
    }
    const gridSteps = 5
    const spanX = bounds.maxX - bounds.minX
    const spanZ = bounds.maxZ - bounds.minZ
    if (spanX > 1.0 && spanZ > 1.0) {
      for (let ix = 1; ix <= gridSteps; ix++) {
        for (let iz = 1; iz <= gridSteps; iz++) {
          candSet.push([
            round2(bounds.minX + (spanX * ix) / (gridSteps + 1)),
            round2(bounds.minZ + (spanZ * iz) / (gridSteps + 1)),
          ])
        }
      }
    }
  }

  let bestSpot: [number, number] = [
    hasValidWallSpan ? clampToSpan(baseX, bounds.minX + 0.15, bounds.maxX - 0.15) : round2(baseX),
    hasValidWallSpan ? clampToSpan(baseZ, bounds.minZ + 0.15, bounds.maxZ - 0.15) : round2(baseZ),
  ]
  let bestClashes = Infinity
  let bestClear = -1
  let bestScore = -Infinity
  const seen = new Set<string>()

  for (const [cx, cz] of candSet) {
    const key = `${cx},${cz}`
    if (seen.has(key)) continue
    seen.add(key)

    let hasMargin = true
    if (insidePolygon) {
      if (!pointInPolygon2D(cx, cz, insidePolygon)) continue
      if (!inWallEnvelope(cx, cz, 0.15)) continue
      hasMargin = isInsideWithMargin(cx, cz, insidePolygon, 0.18)
    } else if (!inWallEnvelope(cx, cz, 0.25)) {
      continue
    }

    if (excludePolygons && excludePolygons.length > 0 && excludePolygons.some((ep) => pointInPolygon2D(cx, cz, ep))) {
      continue
    }

    if (roofConstraint && roofConstraint.roof.hasRoofAbove) {
      const roofClearY = minRoofYOverFootprint(
        roofConstraint.roof,
        cx,
        cz,
        roofConstraint.footprintHalfW ?? 0,
        roofConstraint.footprintHalfD ?? 0,
      )
      if (roofClearY < roofConstraint.requiredTopY) continue
    }

    const riserClashes = detectHvacClashes(
      [
        [cx, y0, cz],
        [cx, y1, cz],
      ],
      obstacles,
      clashSpan,
    ).length
    const floorClear = minClearanceToObstaclesXZ(cx, cz, floorObstacles)
    const distPen = Math.hypot(cx - baseX, cz - baseZ) * 4
    const ridgePen =
      roofConstraint && roofConstraint.roof.hasRoofAbove
        ? Math.abs((roofConstraint.roof.ridgeAlongX ? cz : cx) - roofConstraint.roof.center) *
          (roofConstraint.preferRidgeWeight ?? 22)
        : 0
    const score =
      (riserClashes === 0 ? 1000 : -riserClashes * 220) +
      (floorClear >= minFloorClearanceM ? 100 : floorClear * 80) +
      Math.min(1.5, floorClear) * 8 +
      (hasMargin ? 12 : 0) -
      distPen -
      ridgePen

    if (score > bestScore) {
      bestScore = score
      bestSpot = [cx, cz]
      bestClashes = riserClashes
      bestClear = floorClear
    }
  }

  const foundValid = Number.isFinite(bestClashes)
  if (!foundValid) {
    const fallback = findClearMechanicalSpot(baseX, baseZ, floorObstacles, bounds, minFloorClearanceM, true, insidePolygon)
    bestSpot = [
      hasValidWallSpan ? clampToSpan(fallback[0], bounds.minX + 0.15, bounds.maxX - 0.15) : fallback[0],
      hasValidWallSpan ? clampToSpan(fallback[1], bounds.minZ + 0.15, bounds.maxZ - 0.15) : fallback[1],
    ]
    bestClashes = detectHvacClashes(
      [
        [bestSpot[0], y0, bestSpot[1]],
        [bestSpot[0], y1, bestSpot[1]],
      ],
      obstacles,
      clashSpan,
    ).length
    bestClear = minClearanceToObstaclesXZ(bestSpot[0], bestSpot[1], floorObstacles)
  }

  return { spot: bestSpot, riserClashes: bestClashes, floorClear: bestClear, foundValid }
}

function findWallTuckedCornerSpot(
  room: { polygon: ReadonlyArray<readonly [number, number]>; centroid: readonly [number, number] },
  obstacles: ReadonlyArray<HvacObstacle>,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  insetM = 0.48,
  minClearanceM = 1.1,
  preferNearPt?: readonly [number, number] | null,
  riserCheck?: { y0: number; y1: number; clashSpan: DuctClashMargin; allObstacles: ReadonlyArray<HvacObstacle> },
): { spot: [number, number]; riserClashes: number; floorClear: number } {
  const poly = room.polygon
  const candidates: Array<readonly [number, number]> = []

  // Gather corner-inset, wall-mid-inset, quarter-wall-inset, and interior candidates strictly inside the room
  // so mechanical equipment tucks neatly against walls/corners while clearing plumbing equipment & headers.
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % poly.length]!
    const dxC = room.centroid[0] - a[0]
    const dzC = room.centroid[1] - a[1]
    const lenC = Math.hypot(dxC, dzC)
    if (lenC > insetM * 1.15) {
      candidates.push([round2(a[0] + (dxC / lenC) * insetM), round2(a[1] + (dzC / lenC) * insetM)])
    }
    for (const frac of [0.5, 0.25, 0.75]) {
      const mx = a[0] + (b[0] - a[0]) * frac
      const mz = a[1] + (b[1] - a[1]) * frac
      const dxM = room.centroid[0] - mx
      const dzM = room.centroid[1] - mz
      const lenM = Math.hypot(dxM, dzM)
      if (lenM > insetM * 1.1) {
        candidates.push([round2(mx + (dxM / lenM) * insetM), round2(mz + (dzM / lenM) * insetM)])
      }
    }
  }
  candidates.push([round2(room.centroid[0]), round2(room.centroid[1])])

  const evalRiser = (cx: number, cz: number): number =>
    riserCheck
      ? detectHvacClashes(
          [
            [cx, riserCheck.y0, cz],
            [cx, riserCheck.y1, cz],
          ],
          riserCheck.allObstacles,
          riserCheck.clashSpan,
        ).length
      : 0

  let best: [number, number] | null = null
  let bestScore = -Infinity
  let bestRiserClashes = Infinity
  let bestFloorClear = -1
  for (const [cx, cz] of candidates) {
    if (!isInsideWithMargin(cx, cz, poly, 0.24)) continue
    if (cx < bounds.minX + 0.3 || cx > bounds.maxX - 0.3 || cz < bounds.minZ + 0.3 || cz > bounds.maxZ - 0.3) continue
    const clear = minClearanceToObstaclesXZ(cx, cz, obstacles)
    const rClashes = evalRiser(cx, cz)
    const prefPenalty = preferNearPt ? Math.hypot(cx - preferNearPt[0], cz - preferNearPt[1]) * 1.5 : 0
    const score =
      (rClashes === 0 ? 500 : -rClashes * 200) +
      (clear >= minClearanceM ? 100 : clear * 60) +
      Math.min(2.0, clear) * 10 -
      prefPenalty
    if (score > bestScore) {
      bestScore = score
      best = [cx, cz]
      bestRiserClashes = rClashes
      bestFloorClear = clear
    }
  }

  if (best && bestRiserClashes === 0 && bestFloorClear >= minClearanceM * 0.75) {
    return { spot: best, riserClashes: bestRiserClashes, floorClear: bestFloorClear }
  }
  const fallbackBase = best ?? room.centroid
  if (riserCheck) {
    const res = findClearSpotForRiser({
      baseX: fallbackBase[0],
      baseZ: fallbackBase[1],
      y0: riserCheck.y0,
      y1: riserCheck.y1,
      clashSpan: riserCheck.clashSpan,
      obstacles: riserCheck.allObstacles,
      bounds,
      minFloorClearanceM: minClearanceM,
      insidePolygon: poly,
      floorObstacles: obstacles,
    })
    if (best && bestRiserClashes < res.riserClashes) {
      return { spot: best, riserClashes: bestRiserClashes, floorClear: bestFloorClear }
    }
    return res
  }
  const fb = findClearMechanicalSpot(fallbackBase[0], fallbackBase[1], obstacles, bounds, minClearanceM, false, poly)
  return { spot: fb, riserClashes: 0, floorClear: minClearanceToObstaclesXZ(fb[0], fb[1], obstacles) }
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
  const framingCtx = extractHvacFramingContext(nodes, levelId)
  const ceilingJoistClearM = framingCtx.framingPresent
    ? round2(Math.max(0.18, Math.min(0.42, framingCtx.joistDepthIn * INCHES_TO_METERS)))
    : 0.2
  const lowerLevels = resolveLowerWalledLevels(nodes, levelId)
  const bounds = sceneBounds(walls, rawRooms)
  const indoorBounds: XzBounds2D = {
    minX: bounds.maxX - bounds.minX > 0.35 ? round2(bounds.minX + 0.15) : round2(bounds.minX),
    maxX: bounds.maxX - bounds.minX > 0.35 ? round2(bounds.maxX - 0.15) : round2(bounds.maxX),
    minZ: bounds.maxZ - bounds.minZ > 0.35 ? round2(bounds.minZ + 0.15) : round2(bounds.minZ),
    maxZ: bounds.maxZ - bounds.minZ > 0.35 ? round2(bounds.maxZ - 0.15) : round2(bounds.maxZ),
  }
  const hasFootprintGeometry = walls.length >= 3 || rawRooms.some((r) => r.category !== 'exterior')
  const footprintContains = hasFootprintGeometry
    ? (x: number, z: number) => isPointInsideBuildingFootprint(x, z, walls, rawRooms)
    : undefined
  const interiorCorridorSpines = (() => {
    const xs: number[] = []
    const zs: number[] = []
    const pushDedup = (arr: number[], v: number) => {
      const rv = round2(v)
      if (!arr.some((e) => Math.abs(e - rv) < 0.25)) arr.push(rv)
    }
    for (const r of rawRooms) {
      if (r.category === 'exterior') continue
      pushDedup(xs, clampToSpan(r.centroid[0], indoorBounds.minX, indoorBounds.maxX))
      pushDedup(zs, clampToSpan(r.centroid[1], indoorBounds.minZ, indoorBounds.maxZ))
    }
    for (const w of walls) {
      const mx = (w.start[0] + w.end[0]) / 2
      const mz = (w.start[1] + w.end[1]) / 2
      pushDedup(xs, clampToSpan(mx, indoorBounds.minX, indoorBounds.maxX))
      pushDedup(zs, clampToSpan(mz, indoorBounds.minZ, indoorBounds.maxZ))
    }
    return { xs, zs }
  })()
  const roofEnvelope = buildAtticRoofEnvelope(nodes, levelId, bounds, levelH)
  const atticRoof = plenumLocation === 'attic' && roofEnvelope.hasRoofAbove ? roofEnvelope : undefined
  const ridgeCenterX = roofEnvelope.ridgeAlongX ? bounds.cx : roofEnvelope.center
  const ridgeCenterZ = roofEnvelope.ridgeAlongX ? roofEnvelope.center : bounds.cz
  const ridgePeakY = roofEnvelope.roofYAt(ridgeCenterX, ridgeCenterZ)

  const wallMinX = bounds.maxX - bounds.minX > 0.65 ? round2(bounds.minX + 0.3) : round2(bounds.cx)
  const wallMaxX = bounds.maxX - bounds.minX > 0.65 ? round2(bounds.maxX - 0.3) : round2(bounds.cx)
  const wallMinZ = bounds.maxZ - bounds.minZ > 0.65 ? round2(bounds.minZ + 0.3) : round2(bounds.cz)
  const wallMaxZ = bounds.maxZ - bounds.minZ > 0.65 ? round2(bounds.maxZ - 0.3) : round2(bounds.cz)

  const maxPlenumYFor = (halfV: number): number | undefined => {
    if (systemType === 'rooftop-package') {
      return round2(levelH - Math.max(0.14, halfV + 0.06))
    }
    if (plenumLocation === 'conditioned-soffit' || (plenumLocation === 'attic' && !roofEnvelope.hasRoofAbove)) {
      return round2(levelH - Math.max(0.08, halfV + 0.04))
    }
    if (plenumLocation === 'crawlspace' || plenumLocation === 'basement') {
      return round2(-Math.max(0.1, halfV + 0.04))
    }
    if (atticRoof) {
      const soffitCap = round2(levelH - Math.max(0.08, halfV + 0.04))
      return round2(Math.max(soffitCap, ridgePeakY - halfV - 0.1))
    }
    return undefined
  }

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

  // Pre-size supply & return trunks so AHU placement, vertical plenum risers, and return grille clearance
  // account for the true rectangular duct half-spans against Priority #1 headers & Priority #2 plumbing.
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
  const supplyHalfX = Math.max(0.12, (supplyTrunkSize.widthIn * 0.0254) / 2)
  const supplyHalfV = Math.max(0.05, (supplyTrunkSize.heightIn * 0.0254) / 2)
  const supplyClashSpan = { horizontal: supplyHalfX, vertical: supplyHalfV }
  const retHalfX = Math.max(0.12, (returnTrunkSize.widthIn * 0.0254) / 2)
  const retHalfV = Math.max(0.05, (returnTrunkSize.heightIn * 0.0254) / 2)
  const retClashSpan = { horizontal: retHalfX, vertical: retHalfV }
  const supplyPlenumH = Math.max(0.2, supplyTrunkSize.heightIn * 0.0254)
  const retPlenumH = Math.max(0.2, returnTrunkSize.heightIn * 0.0254)

  const hasOverheadSlabPlumbing = obstacles.some(
    (o) => o.category === 'plumbing' && o.box.maxY >= levelH - 0.35 && o.box.minY <= levelH,
  )
  const useTrueAtticPlenum = plenumLocation === 'attic' && roofEnvelope.hasRoofAbove && systemType !== 'rooftop-package'
  // Elevate attic trunks & branches clear above ceiling joists/tie beams (default 0.20m or structural joistDepthIn)
  // while still clamping strictly beneath ridgePeakY - halfV - 0.10 below.
  let plenumY = useTrueAtticPlenum
    ? round2(levelH + ceilingJoistClearM + supplyHalfV + 0.04)
    : systemType === 'rooftop-package'
      ? round2(levelH - Math.max(0.28, supplyHalfV + 0.12))
      : plenumLocation === 'conditioned-soffit' || plenumLocation === 'attic'
        ? hasOverheadSlabPlumbing
          ? round2(Math.max(2.35, levelH - 0.54))
          : round2(levelH - Math.max(0.22, supplyHalfV + 0.08))
        : round2(Math.min(-0.26, maxPlenumYFor(supplyHalfV) ?? -0.26))
  let retPlenumY = useTrueAtticPlenum
    ? round2(Math.max(plenumY + 0.24, levelH + ceilingJoistClearM + retHalfV + 0.08))
    : systemType === 'rooftop-package'
      ? round2(Math.min(plenumY - 0.16, levelH - Math.max(0.34, retHalfV + 0.14)))
      : round2(plenumY - 0.24)

  if (atticRoof) {
    // Sample multiple points along the ridge centerline so multi-wing/L/U roofs whose AABB center
    // sits over a lower porch or courtyard still find the true main-wing attic headroom, while clamping
    // strictly beneath the 4-corner footprint roof height so ceiling-joist elevation boost never clips rafters.
    let bestSupRoofY = minRoofYOverFootprint(atticRoof, ridgeCenterX, ridgeCenterZ, supplyHalfX, supplyHalfX)
    let bestRetRoofY = minRoofYOverFootprint(atticRoof, ridgeCenterX, ridgeCenterZ, retHalfX, retHalfX)
    for (const frac of [0.2, 0.35, 0.65, 0.8]) {
      const sx = atticRoof.ridgeAlongX
        ? round2(bounds.minX + (bounds.maxX - bounds.minX) * frac)
        : ridgeCenterX
      const sz = atticRoof.ridgeAlongX
        ? ridgeCenterZ
        : round2(bounds.minZ + (bounds.maxZ - bounds.minZ) * frac)
      const sy = minRoofYOverFootprint(atticRoof, sx, sz, supplyHalfX, supplyHalfX)
      const ry = minRoofYOverFootprint(atticRoof, sx, sz, retHalfX, retHalfX)
      if (sy > bestSupRoofY) bestSupRoofY = sy
      if (ry > bestRetRoofY) bestRetRoofY = ry
    }
    const ridgeSupCap = round2(bestSupRoofY - supplyHalfV - 0.14)
    const ridgeRetCap = round2(bestRetRoofY - retHalfV - 0.14)
    if (ridgeSupCap <= levelH + 0.05) {
      plenumY = round2(levelH - Math.max(0.18, supplyHalfV + 0.06))
    } else if (plenumY > ridgeSupCap) {
      plenumY = ridgeSupCap
    }
    if (ridgeRetCap <= levelH + 0.05) {
      retPlenumY = round2(levelH - Math.max(0.24, retHalfV + 0.08))
    } else if (retPlenumY > ridgeRetCap) {
      retPlenumY = ridgeRetCap
    }
  }

  // 1. Place Primary Mechanical Equipment (Indoor Air Handler/Furnace + Outdoor Condenser)
  // Prefer a dedicated Utility/Mechanical/Laundry/Garage room that actually has clash-free floor & riser clearance
  // away from Priority #1 headers/columns and Priority #2 water heaters/manifolds; when no floor mechanical room
  // fits cleanly and plenumLocation is 'attic', mount the Air Handler & ERV on an Attic Mechanical Platform
  // (IMC 307.2.3 secondary pan + SS2) along the ridge centerline with verified roof-rafter clearance.
  const wetCoreRoom =
    rooms.find((r) => r.category === 'kitchen') ??
    rooms.find((r) => r.category === 'bathroom') ??
    rooms.find((r) => r.category === 'hallway') ??
    null

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
  const floorLevelObstacles = obstacles.filter((o) => o.box.minY < 1.85)
  const atticLevelObstacles = obstacles.filter((o) => o.box.maxY >= atticPlatformY - 0.05)

  const dedicatedMechCandidates = rooms
    .filter((r) => r.category === 'utility' || r.category === 'laundry' || r.category === 'garage')
    .sort((a, b) => {
      const rank = (r: (typeof rooms)[number]) =>
        r.category === 'garage' ? 2 : r.areaSqft >= 28 ? 3 : 1
      const dr = rank(b) - rank(a)
      if (dr !== 0) return dr
      return b.areaSqft - a.areaSqft
    })

  const canMountInAttic =
    plenumLocation === 'attic' &&
    roofEnvelope.hasRoofAbove &&
    (systemType === 'split-heat-pump' || systemType === 'split-gas-furnace')

  let chosenDedicatedRoom: (typeof rooms)[number] | null = null
  let chosenFloorSpot: [number, number] | null = null
  let bestFallbackDedicated: {
    room: (typeof rooms)[number]
    spot: [number, number]
    riserClashes: number
    floorClear: number
  } | null = null

  const supplyPlenumMidOffset = 0.05 + 1.38 + supplyPlenumH / 2
  const ahuMinFloorClear = Math.max(0.72, supplyHalfX + 0.34)
  for (const candRoom of dedicatedMechCandidates) {
    const evalRes = findWallTuckedCornerSpot(
      candRoom,
      floorLevelObstacles,
      bounds,
      0.48,
      Math.max(1.1, ahuMinFloorClear),
      preferServicePt,
      {
        y0: supplyPlenumMidOffset,
        y1: plenumY,
        clashSpan: supplyClashSpan,
        allObstacles: obstacles,
      },
    )
    if (
      !bestFallbackDedicated ||
      evalRes.riserClashes < bestFallbackDedicated.riserClashes ||
      (evalRes.riserClashes === bestFallbackDedicated.riserClashes &&
        evalRes.floorClear > bestFallbackDedicated.floorClear)
    ) {
      bestFallbackDedicated = { room: candRoom, ...evalRes }
    }
    if (evalRes.riserClashes === 0 && evalRes.floorClear >= 0.72) {
      chosenDedicatedRoom = candRoom
      chosenFloorSpot = evalRes.spot
      break
    }
  }

  // Evaluate attic headroom under pitched roof (VIS-01 / 4-corner footprint clearance):
  // Verify ALL 4 XZ corners of the AHU + supply/return plenum boxes clear the sloping roof plane by >= 14 cm;
  // switch to horizontal low-profile attic orientation (0.52m tall) or fall back to indoor floor if not.
  const ridgeSpanM = roofEnvelope.ridgeAlongX ? bounds.maxX - bounds.minX : bounds.maxZ - bounds.minZ
  const supplyPlenumHalfW = Math.max(0.35, (supplyTrunkSize.widthIn * INCHES_TO_METERS) / 2)
  const retPlenumHalfW = Math.max(0.35, (returnTrunkSize.widthIn * INCHES_TO_METERS) / 2)
  // Top of vertical AHU supply plenum: pos[1] + heightM = atticPlatformY + 1.43 + supplyPlenumH * 1.5
  const vertAtticRequiredRoofY =
    atticPlatformY + 1.43 + Math.max(0.45, supplyPlenumH * 1.5) + 0.14
  const horizAtticRequiredRoofY = atticPlatformY + 0.52 + 0.14
  const horizPlenumRequiredRoofY =
    atticPlatformY + 0.05 + Math.max(0.45, Math.max(supplyPlenumH, retPlenumH) * 1.5) + 0.14
  let isAtticMountedAhu = !chosenDedicatedRoom && canMountInAttic
  let isHorizontalAtticAhu = false

  let clearX: number | null = null
  let clearZ: number | null = null

  if (isAtticMountedAhu) {
    const ridgeInset = Math.min(1.1, Math.max(0.45, ridgeSpanM * 0.15))
    const ridgeBaseX = roofEnvelope.ridgeAlongX
      ? clampToSpan(preferServicePt[0], bounds.minX + ridgeInset, bounds.maxX - ridgeInset)
      : round2(roofEnvelope.center)
    const ridgeBaseZ = roofEnvelope.ridgeAlongX
      ? round2(roofEnvelope.center)
      : clampToSpan(preferServicePt[1], bounds.minZ + ridgeInset, bounds.maxZ - ridgeInset)

    const tryAtticMode = (
      requiredRoofY: number,
      topCheckY: number,
      gableInsetM = 0.45,
      footprintHalfW = supplyPlenumHalfW,
      footprintHalfD = 0.35,
    ): [number, number] | null => {
      const searchBounds =
        gableInsetM > 0.5 && ridgeSpanM > gableInsetM * 2 + 0.3
          ? roofEnvelope.ridgeAlongX
            ? {
                ...bounds,
                minX: round2(bounds.minX + gableInsetM),
                maxX: round2(bounds.maxX - gableInsetM),
              }
            : {
                ...bounds,
                minZ: round2(bounds.minZ + gableInsetM),
                maxZ: round2(bounds.maxZ - gableInsetM),
              }
          : bounds
      const baseSearchX = roofEnvelope.ridgeAlongX
        ? clampToSpan(ridgeBaseX, searchBounds.minX, searchBounds.maxX)
        : ridgeBaseX
      const baseSearchZ = roofEnvelope.ridgeAlongX
        ? ridgeBaseZ
        : clampToSpan(ridgeBaseZ, searchBounds.minZ, searchBounds.maxZ)
      const res = findClearSpotForRiser({
        baseX: baseSearchX,
        baseZ: baseSearchZ,
        y0: atticPlatformY,
        y1: Math.max(plenumY, topCheckY),
        clashSpan: supplyClashSpan,
        obstacles,
        bounds: searchBounds,
        minFloorClearanceM: 0.95,
        floorObstacles: atticLevelObstacles,
        roofConstraint: atticRoof
          ? {
              roof: atticRoof,
              requiredTopY: requiredRoofY,
              preferRidgeWeight: 30,
              footprintHalfW,
              footprintHalfD,
            }
          : undefined,
      })
      if (
        res.foundValid &&
        (!atticRoof ||
          minRoofYOverFootprint(atticRoof, res.spot[0], res.spot[1], footprintHalfW, footprintHalfD) >= requiredRoofY)
      ) {
        return res.spot
      }
      return null
    }

    const vertSpot = tryAtticMode(
      vertAtticRequiredRoofY,
      round2(atticPlatformY + supplyPlenumMidOffset),
      0.45,
      supplyPlenumHalfW,
      0.38,
    )
    if (vertSpot) {
      ;[clearX, clearZ] = vertSpot
      isHorizontalAtticAhu = false
    } else {
      const horizReqY = Math.max(horizAtticRequiredRoofY, horizPlenumRequiredRoofY)
      // Horizontal cabinet (1.32m) + end-mounted supply & return plenums span ~1.0m along the ridge axis
      const horizFootprintHalfX = roofEnvelope.ridgeAlongX
        ? Math.max(1.05, 0.66 + Math.max(supplyPlenumHalfW, retPlenumHalfW))
        : Math.max(0.36, supplyPlenumHalfW)
      const horizFootprintHalfZ = roofEnvelope.ridgeAlongX
        ? Math.max(0.36, supplyPlenumHalfW)
        : Math.max(1.05, 0.66 + Math.max(supplyPlenumHalfW, retPlenumHalfW))
      const horizSpot =
        ridgeSpanM >= 2.8
          ? tryAtticMode(
              horizReqY,
              round2(atticPlatformY + 0.52),
              1.2,
              horizFootprintHalfX,
              horizFootprintHalfZ,
            )
          : null
      if (horizSpot) {
        ;[clearX, clearZ] = horizSpot
        isHorizontalAtticAhu = true
      } else {
        // Insufficient attic headroom even for horizontal low-profile unit -> mount indoors on floor
        isAtticMountedAhu = false
        isHorizontalAtticAhu = false
      }
    }
  }

  const mechRoom =
    chosenDedicatedRoom ??
    (!isAtticMountedAhu ? bestFallbackDedicated?.room : null) ??
    rooms.find((r) => r.category === 'hallway') ??
    wetCoreRoom ??
    rooms[0]!

  if (clearX === null || clearZ === null) {
    if (chosenFloorSpot) {
      ;[clearX, clearZ] = chosenFloorSpot
    } else if (bestFallbackDedicated) {
      ;[clearX, clearZ] = bestFallbackDedicated.spot
    } else {
      const fallbackRes = findWallTuckedCornerSpot(
        mechRoom,
        floorLevelObstacles,
        bounds,
        0.48,
        1.1,
        preferServicePt,
        {
          y0: supplyPlenumMidOffset,
          y1: plenumY,
          clashSpan: supplyClashSpan,
          allObstacles: obstacles,
        },
      )
      ;[clearX, clearZ] = fallbackRes.spot
    }
  }

  const indoorPos: Vec3 = [
    clampToSpan(clearX, indoorBounds.minX, indoorBounds.maxX),
    isAtticMountedAhu ? atticPlatformY : 0,
    clampToSpan(clearZ, indoorBounds.minZ, indoorBounds.maxZ),
  ]
  const indoorRoomLabel = isAtticMountedAhu ? 'Attic Mechanical Platform' : mechRoom.name
  const horizAlongX = roofEnvelope.ridgeAlongX
  const horizDischargeSign = horizAlongX
    ? bounds.maxX - indoorPos[0] >= indoorPos[0] - bounds.minX
      ? 1
      : -1
    : bounds.maxZ - indoorPos[2] >= indoorPos[2] - bounds.minZ
      ? 1
      : -1
  // Three.js Y-rotation maps local +X (supply-out) -> (cos r, 0, -sin r):
  // +X => 0, -X => PI, +Z => -PI/2, -Z => +PI/2 so supply/return plenums match CAD ports exactly!
  const indoorRotation = isHorizontalAtticAhu
    ? horizAlongX
      ? horizDischargeSign === 1
        ? 0
        : round2(Math.PI)
      : horizDischargeSign === 1
        ? round2(-Math.PI / 2)
        : round2(Math.PI / 2)
    : 0

  // Place outdoor condenser on an exterior wall outside the building footprint, maintaining >= 1.2m
  // ignition-source clearance from any exterior fuel-gas meter/regulator vent (IFGC / NFPA 54).
  // On upper stories (`cumulativeBelowHeightM > 0.1`), ground the condenser at grade (`y = -cumulativeBelowHeightM`)
  // strictly outside the union of active-level AND ground-level wall footprints, preferring an exterior wall
  // where the active story aligns with the ground floor so the unit never floats over a 1-story roof (VIS-V3-03).
  const isUpperStory = lowerLevels.cumulativeBelowHeightM > 0.1
  const gradeY = isUpperStory ? round2(-lowerLevels.cumulativeBelowHeightM) : 0
  const groundBounds = isUpperStory
    ? sceneBounds(lowerLevels.groundWalls, lowerLevels.groundRooms)
    : bounds
  const unionBounds = (() => {
    if (!isUpperStory) return bounds
    let minX = Math.min(bounds.minX, groundBounds.minX)
    let maxX = Math.max(bounds.maxX, groundBounds.maxX)
    let minZ = Math.min(bounds.minZ, groundBounds.minZ)
    let maxZ = Math.max(bounds.maxZ, groundBounds.maxZ)
    for (const w of lowerLevels.allLowerWalls) {
      minX = Math.min(minX, w.start[0], w.end[0])
      maxX = Math.max(maxX, w.start[0], w.end[0])
      minZ = Math.min(minZ, w.start[1], w.end[1])
      maxZ = Math.max(maxZ, w.start[1], w.end[1])
    }
    return { minX, maxX, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 }
  })()

  const groundObstacles = isUpperStory && lowerLevels.groundLevelId
    ? extractHvacObstacles(nodes, lowerLevels.groundLevelId)
    : []
  const allExtPlumbingObstacles = [...obstacles, ...groundObstacles].filter((o) => o.category === 'plumbing')

  type OutdoorSide = 'west' | 'east' | 'north' | 'south'
  let outdoorSide: OutdoorSide
  let outdoorX: number
  let outdoorZ: number

  if (isUpperStory) {
    const overlapMinZ = Math.max(bounds.minZ, groundBounds.minZ)
    const overlapMaxZ = Math.min(bounds.maxZ, groundBounds.maxZ)
    const spanMinZ = overlapMaxZ - overlapMinZ >= 0.8 ? overlapMinZ + 0.4 : groundBounds.minZ + 0.4
    const spanMaxZ = overlapMaxZ - overlapMinZ >= 0.8 ? overlapMaxZ - 0.4 : groundBounds.maxZ - 0.4
    const overlapMinX = Math.max(bounds.minX, groundBounds.minX)
    const overlapMaxX = Math.min(bounds.maxX, groundBounds.maxX)
    const spanMinX = overlapMaxX - overlapMinX >= 0.8 ? overlapMinX + 0.4 : groundBounds.minX + 0.4
    const spanMaxX = overlapMaxX - overlapMinX >= 0.8 ? overlapMaxX - 0.4 : groundBounds.maxX - 0.4

    const pickClearAlongAxis = (
      baseCoord: number,
      lo: number,
      hi: number,
      wallCoord: number,
      axis: 'z' | 'x',
    ): number => {
      const relevant = allExtPlumbingObstacles.filter((o) => {
        const oc = axis === 'z' ? (o.box.minX + o.box.maxX) / 2 : (o.box.minZ + o.box.maxZ) / 2
        return Math.abs(oc - wallCoord) <= 1.5
      })
      const isClear = (v: number): boolean =>
        relevant.every((o) => {
          const ov = axis === 'z' ? (o.box.minZ + o.box.maxZ) / 2 : (o.box.minX + o.box.maxX) / 2
          return Math.abs(v - ov) >= 1.2
        })
      const primary = clampToSpan(baseCoord, lo, hi)
      if (isClear(primary)) return primary
      for (const d of [1.4, -1.4, 2.2, -2.2]) {
        const cand = round2(primary + d)
        if (cand >= lo && cand <= hi && isClear(cand)) return cand
      }
      return primary
    }

    const sideSpecs: Array<{
      side: OutdoorSide
      x: number
      z: number
      alignedGap: number
      score: number
    }> = [
      (() => {
        const x = round2(unionBounds.minX - 0.95)
        const z = pickClearAlongAxis(indoorPos[2], spanMinZ, spanMaxZ, unionBounds.minX, 'z')
        const alignedGap = Math.abs(bounds.minX - unionBounds.minX)
        const dist = Math.hypot(x - indoorPos[0], z - indoorPos[2])
        return {
          side: 'west' as const,
          x,
          z,
          alignedGap,
          score: (alignedGap <= 0.35 ? 100 : -alignedGap * 25) - dist * 3 + 2,
        }
      })(),
      (() => {
        const x = round2(unionBounds.maxX + 0.95)
        const z = pickClearAlongAxis(indoorPos[2], spanMinZ, spanMaxZ, unionBounds.maxX, 'z')
        const alignedGap = Math.abs(bounds.maxX - unionBounds.maxX)
        const dist = Math.hypot(x - indoorPos[0], z - indoorPos[2])
        return {
          side: 'east' as const,
          x,
          z,
          alignedGap,
          score: (alignedGap <= 0.35 ? 100 : -alignedGap * 25) - dist * 3 + 2,
        }
      })(),
      (() => {
        const x = pickClearAlongAxis(indoorPos[0], spanMinX, spanMaxX, unionBounds.minZ, 'x')
        const z = round2(unionBounds.minZ - 0.95)
        const alignedGap = Math.abs(bounds.minZ - unionBounds.minZ)
        const dist = Math.hypot(x - indoorPos[0], z - indoorPos[2])
        return {
          side: 'north' as const,
          x,
          z,
          alignedGap,
          score: (alignedGap <= 0.35 ? 100 : -alignedGap * 25) - dist * 3,
        }
      })(),
      (() => {
        const x = pickClearAlongAxis(indoorPos[0], spanMinX, spanMaxX, unionBounds.maxZ, 'x')
        const z = round2(unionBounds.maxZ + 0.95)
        const alignedGap = Math.abs(bounds.maxZ - unionBounds.maxZ)
        const dist = Math.hypot(x - indoorPos[0], z - indoorPos[2])
        return {
          side: 'south' as const,
          x,
          z,
          alignedGap,
          score: (alignedGap <= 0.35 ? 100 : -alignedGap * 25) - dist * 3,
        }
      })(),
    ]
    sideSpecs.sort((a, b) => b.score - a.score)
    const chosenSide = sideSpecs[0]!
    outdoorSide = chosenSide.side
    outdoorX = chosenSide.x
    outdoorZ = chosenSide.z
  } else {
    const outdoorOnWest = Math.abs(indoorPos[0] - bounds.minX) < Math.abs(bounds.maxX - indoorPos[0])
    outdoorSide = outdoorOnWest ? 'west' : 'east'
    outdoorX = round2(outdoorOnWest ? bounds.minX - 0.95 : bounds.maxX + 0.95)
    const extWallObstacles = allExtPlumbingObstacles.filter(
      (o) => Math.abs((o.box.minX + o.box.maxX) / 2 - (outdoorOnWest ? bounds.minX : bounds.maxX)) <= 1.5,
    )
    outdoorZ = clampToSpan(indoorPos[2], bounds.minZ + 0.4, bounds.maxZ - 0.4)
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
  }
  const outdoorOnWest = outdoorSide === 'west'
  const outdoorOutDx = outdoorSide === 'west' ? -1 : outdoorSide === 'east' ? 1 : 0
  const outdoorOutDz = outdoorSide === 'north' ? -1 : outdoorSide === 'south' ? 1 : 0
  const outdoorRotation =
    outdoorSide === 'east'
      ? 0
      : outdoorSide === 'west'
        ? round2(Math.PI)
        : outdoorSide === 'north'
          ? round2(Math.PI / 2)
          : round2(-Math.PI / 2)
  const outdoorPos: Vec3 = [outdoorX, gradeY, outdoorZ]

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
      rotation: indoorRotation,
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
      ...(isHorizontalAtticAhu ? { orientation: 'horizontal' as const, heightM: 0.52 } : {}),
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
      rotation: outdoorRotation,
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
    // Route inside the building to a header-free exterior wall exit (preferring low-wall y = 0.35m below
    // window sills/door headers on ground stories, or header-clear vertical drop flush along the exterior wall
    // to `gradeY + 0.35` on upper stories), verifying ZERO structural beam/header clashes across the full path.
    const outDir = outdoorOutDx !== 0 ? outdoorOutDx : Math.abs(indoorPos[0] - bounds.minX) < Math.abs(bounds.maxX - indoorPos[0]) ? -1 : 1
    const coilTakeoffY = isHorizontalAtticAhu ? round2(indoorPos[1] + 0.28) : round2(indoorPos[1] + 0.95)
    const coilHighY = isHorizontalAtticAhu ? round2(indoorPos[1] + 0.4) : round2(indoorPos[1] + 1.25)
    const linesetFaces: ReadonlyArray<Vec3> = [
      [round2(indoorPos[0] + outDir * 0.22), coilTakeoffY, indoorPos[2]],
      [indoorPos[0], coilTakeoffY, round2(indoorPos[2] + 0.24)],
      [indoorPos[0], coilTakeoffY, round2(indoorPos[2] - 0.24)],
      [round2(indoorPos[0] - outDir * 0.22), coilTakeoffY, indoorPos[2]],
      [round2(indoorPos[0] + outDir * 0.22), coilHighY, indoorPos[2]],
    ]
    const linesetMaxY = maxPlenumYFor(0.03)
    const linesetPlenumY = useTrueAtticPlenum
      ? round2(Math.min(levelH + ceilingJoistClearM + 0.06, linesetMaxY ?? levelH + ceilingJoistClearM + 0.06))
      : plenumLocation === 'attic' || plenumLocation === 'conditioned-soffit'
        ? round2(Math.min(levelH - 0.18, linesetMaxY ?? levelH - 0.18))
        : round2(Math.min(-0.18, linesetMaxY ?? -0.18))
    const wallEdgeX = outdoorSide === 'west' ? unionBounds.minX : outdoorSide === 'east' ? unionBounds.maxX : outdoorPos[0]
    const wallEdgeZ = outdoorSide === 'north' ? unionBounds.minZ : outdoorSide === 'south' ? unionBounds.maxZ : outdoorPos[2]
    const linesetCondStubPt: Vec3 = [
      round2(outdoorPos[0] - outdoorOutDx * 0.35),
      round2(gradeY + 0.35),
      round2(outdoorPos[2] - outdoorOutDz * 0.35),
    ]
    const clampLinesetExitY = (wx: number, wz: number, desiredY: number): number => {
      const soffitExit = round2(Math.min(levelH - 0.18, desiredY))
      if (!atticRoof) return desiredY
      const cx = clampToSpan(wx, bounds.minX, bounds.maxX)
      const cz = clampToSpan(wz, bounds.minZ, bounds.maxZ)
      const cap = atticRoof.roofYAt(cx, cz) - 0.13
      if (cap <= levelH + 0.05) return soffitExit
      return round2(Math.min(desiredY, cap))
    }

    const dedupPathPts = (pts: ReadonlyArray<Vec3>): Vec3[] => {
      const dedup: Vec3[] = []
      for (const p of pts) {
        const prev = dedup[dedup.length - 1]
        if (!prev || Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]) > 0.01) {
          dedup.push(p)
        }
      }
      return dedup
    }

    const buildLinesetCand = (fromFace: Vec3, exitAlong: number, rawExitY: number, wallStandoffM: number) => {
      const dropX = outdoorOutDx !== 0 ? round2(wallEdgeX + outdoorOutDx * wallStandoffM) : round2(exitAlong)
      const dropZ = outdoorOutDz !== 0 ? round2(wallEdgeZ + outdoorOutDz * wallStandoffM) : round2(exitAlong)
      const exitY = rawExitY <= 0.6 ? round2(rawExitY) : clampLinesetExitY(dropX, dropZ, rawExitY)
      const insidePt: Vec3 = [
        outdoorOutDx !== 0
          ? clampToSpan(wallEdgeX - outdoorOutDx * 0.14, indoorBounds.minX, indoorBounds.maxX)
          : clampToSpan(exitAlong, indoorBounds.minX, indoorBounds.maxX),
        exitY,
        outdoorOutDz !== 0
          ? clampToSpan(wallEdgeZ - outdoorOutDz * 0.14, indoorBounds.minZ, indoorBounds.maxZ)
          : clampToSpan(exitAlong, indoorBounds.minZ, indoorBounds.maxZ),
      ]
      const exitPt: Vec3 = [dropX, exitY, dropZ]
      const dropBottomPt: Vec3 = [dropX, round2(gradeY + 0.35), dropZ]
      const gradeCornerPt: Vec3 =
        outdoorOutDx !== 0
          ? [dropX, round2(gradeY + 0.35), outdoorPos[2]]
          : [outdoorPos[0], round2(gradeY + 0.35), dropZ]

      const innerRoute = routeHvacDuctRun({
        from: fromFace,
        to: insidePt,
        plenumY: linesetPlenumY,
        maxPlenumY: linesetMaxY,
        ductHalfSpanM: 0.03,
        allowDiagonalBranch: false,
        obstacles,
        xzBounds: indoorBounds,
        roofEnvelope: atticRoof,
        footprintContains,
        interiorCorridorSpines,
      })
      const path = dedupPathPts([...innerRoute.path, exitPt, dropBottomPt, gradeCornerPt, linesetCondStubPt])
      const clashes = detectHvacClashes(path, obstacles, 0.03)
      const roofOk = !atticRoof || pathClearOfRoof(path, atticRoof, 0.03, 0.08)
      return { path, clashes, roofOk }
    }

    const baseAlong = outdoorOutDx !== 0 ? outdoorPos[2] : outdoorPos[0]
    const alongLo = outdoorOutDx !== 0 ? wallMinZ : wallMinX
    const alongHi = outdoorOutDx !== 0 ? wallMaxZ : wallMaxX
    const highExitY = clampLinesetExitY(
      outdoorOutDx !== 0 ? round2(wallEdgeX + outdoorOutDx * 0.16) : outdoorPos[0],
      outdoorOutDz !== 0 ? round2(wallEdgeZ + outdoorOutDz * 0.16) : outdoorPos[2],
      linesetPlenumY,
    )
    // Ground-story units prefer low-wall exit (y = 0.35m below window sills & door headers);
    // upper-story units try flush wall exit at highExitY and low-above-floor y = 0.35m (below upper headers).
    const exitElevations = isUpperStory
      ? [highExitY, 0.35, round2(Math.max(0.35, levelH - 0.18))]
      : [0.35, highExitY, round2(Math.max(0.35, levelH - 0.18))]

    let linesetRoute = buildLinesetCand(linesetFaces[0]!, baseAlong, exitElevations[0]!, 0.16)
    const isLinesetBetter = (
      cand: { clashes: HvacObstacle[]; roofOk: boolean },
      cur: { clashes: HvacObstacle[]; roofOk: boolean },
    ) => (!cur.roofOk && cand.roofOk) || (cand.roofOk === cur.roofOk && cand.clashes.length < cur.clashes.length)

    if (linesetRoute.clashes.length > 0 || !linesetRoute.roofOk) {
      // Collect lateral exit coordinates that step cleanly past any structural headers on the chosen exterior wall
      const alongCandidates: number[] = [baseAlong]
      const pushAlong = (v: number) => {
        const cv = clampToSpan(v, alongLo, alongHi)
        if (!alongCandidates.some((e) => Math.abs(e - cv) < 0.12)) alongCandidates.push(cv)
      }
      for (const obs of obstacles) {
        if (obs.category !== 'structural') continue
        const nearWall =
          outdoorOutDx !== 0
            ? obs.box.minX <= wallEdgeX + 0.45 && obs.box.maxX >= wallEdgeX - 0.45
            : obs.box.minZ <= wallEdgeZ + 0.45 && obs.box.maxZ >= wallEdgeZ - 0.45
        if (!nearWall) continue
        if (outdoorOutDx !== 0) {
          pushAlong(obs.box.minZ - 0.24)
          pushAlong(obs.box.maxZ + 0.24)
        } else {
          pushAlong(obs.box.minX - 0.24)
          pushAlong(obs.box.maxX + 0.24)
        }
      }
      for (const d of [0.85, -0.85, 1.65, -1.65, 2.6, -2.6, 3.8, -3.8]) {
        pushAlong(baseAlong + d)
      }

      // First try alternate exit elevations & lateral shifts along the exterior wall with standard standoff (0.16m),
      // then wider standoff (0.28m) to clear deep commercial steel headers (e.g. W14x48) if needed, and alternate coil faces.
      outerLineset: for (const standoff of [0.16, 0.28]) {
        for (const along of alongCandidates) {
          for (const ey of exitElevations) {
            for (let fi = 0; fi < linesetFaces.length; fi++) {
              if (standoff === 0.16 && along === baseAlong && ey === exitElevations[0] && fi === 0) continue
              const cand = buildLinesetCand(linesetFaces[fi]!, along, ey, standoff)
              if (isLinesetBetter(cand, linesetRoute)) {
                linesetRoute = cand
                if (linesetRoute.clashes.length === 0 && linesetRoute.roofOk) break outerLineset
              }
              // Only test secondary coil faces at the primary exit & first few lateral shifts for speed
              if (along !== baseAlong && fi >= 1) break
            }
          }
        }
      }
    }
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
    // Clamp all exterior wall discharge targets strictly to walled building spans (HVA-BUG-02).
    const condY = round2(indoorPos[1] + (isAtticMountedAhu ? 0.06 : 0.95))
    const condFaces: ReadonlyArray<Vec3> = [
      [round2(indoorPos[0] + outDir * 0.25), condY, round2(indoorPos[2] + 0.1)],
      [indoorPos[0], condY, round2(indoorPos[2] + 0.28)],
      [indoorPos[0], condY, round2(indoorPos[2] - 0.28)],
      [round2(indoorPos[0] - outDir * 0.25), condY, round2(indoorPos[2] + 0.1)],
    ]
    const primaryExtX = round2(outdoorOnWest ? bounds.minX - 0.15 : bounds.maxX + 0.15)
    const oppExtX = round2(outdoorOnWest ? bounds.maxX + 0.15 : bounds.minX - 0.15)
    const rawCondTargets: Vec3[] = []
    const pushCondTarget = (tx: number, tz: number) => {
      const pt: Vec3 = [round2(tx), 0.05, round2(tz)]
      if (!rawCondTargets.some((e) => Math.abs(e[0] - pt[0]) < 0.05 && Math.abs(e[2] - pt[2]) < 0.05)) {
        rawCondTargets.push(pt)
      }
    }
    const addSideWallCond = (wx: number) => {
      pushCondTarget(wx, clampToSpan(indoorPos[2] + 0.4, wallMinZ, wallMaxZ))
      for (const dz of [-1.2, 1.8, -2.6, 3.4]) {
        const cz = round2(indoorPos[2] + dz)
        if (cz >= wallMinZ && cz <= wallMaxZ) pushCondTarget(wx, cz)
      }
    }
    const addNorthSouthCond = () => {
      const clampedX = clampToSpan(indoorPos[0], wallMinX, wallMaxX)
      pushCondTarget(clampedX, round2(bounds.minZ - 0.15))
      pushCondTarget(clampedX, round2(bounds.maxZ + 0.15))
    }
    // Prefer gable-end walls first in attic mode so sloped runs never clip low eave rafters
    if (isAtticMountedAhu && atticRoof && !atticRoof.ridgeAlongX) {
      addNorthSouthCond()
      addSideWallCond(primaryExtX)
      pushCondTarget(oppExtX, clampToSpan(indoorPos[2] + 0.4, wallMinZ, wallMaxZ))
    } else {
      addSideWallCond(primaryExtX)
      addNorthSouthCond()
      pushCondTarget(oppExtX, clampToSpan(indoorPos[2] + 0.4, wallMinZ, wallMaxZ))
    }
    const condExitTargets: ReadonlyArray<Vec3> = rawCondTargets
    let condRoute = routeCondensateDrain({
      from: condFaces[0]!,
      to: condExitTargets[0]!,
      obstacles,
      roofEnvelope: atticRoof,
    })
    if (condRoute.clashes.length > 0) {
      outerCond: for (let cfi = 0; cfi < condFaces.length; cfi++) {
        for (let cti = 0; cti < condExitTargets.length; cti++) {
          if (cfi === 0 && cti === 0) continue
          const cand = routeCondensateDrain({
            from: condFaces[cfi]!,
            to: condExitTargets[cti]!,
            obstacles,
            roofEnvelope: atticRoof,
          })
          if (cand.clashes.length < condRoute.clashes.length) {
            condRoute = cand
            if (cand.clashes.length === 0) break outerCond
          }
        }
      }
    }
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
    // Anchor RTU strictly on top of the flat roof deck (clearing any structural flat-roof joist band, VIS-V3-10)
    // and ensure concave L/U commercial buildings place the RTU over an actual roofed wing.
    const overheadRoofBeamTopY = obstacles.reduce((maxY, o) => {
      if (o.category === 'structural' && o.box.minY >= levelH - 0.08 && o.box.maxY > levelH + 0.05 && o.box.maxY <= levelH + 0.7) {
        return Math.max(maxY, o.box.maxY)
      }
      return maxY
    }, 0)
    const hasRoofJoistDeck = framingCtx.framingPresent || overheadRoofBeamTopY > levelH + 0.05
    const rtuBaseY = hasRoofJoistDeck
      ? round2(
          Math.max(
            levelH + 0.3,
            overheadRoofBeamTopY > 0 ? overheadRoofBeamTopY + 0.02 : 0,
            framingCtx.framingPresent ? levelH + framingCtx.joistDepthIn * INCHES_TO_METERS + 0.02 : 0,
          ),
        )
      : round2(levelH + 0.03)

    let rtuSeedX = bounds.cx
    let rtuSeedZ = bounds.cz
    if (footprintContains && !footprintContains(rtuSeedX, rtuSeedZ)) {
      const largestRoom = rooms
        .filter((r) => r.category !== 'exterior')
        .sort((a, b) => b.areaSqm - a.areaSqm)[0]
      if (largestRoom) {
        rtuSeedX = largestRoom.centroid[0]
        rtuSeedZ = largestRoom.centroid[1]
      }
    }
    const [rtuX, rtuZ] = findClearMechanicalSpot(rtuSeedX, rtuSeedZ, obstacles, bounds, 0.75)
    rtuPos = [
      clampToSpan(rtuX, indoorBounds.minX, indoorBounds.maxX),
      rtuBaseY,
      clampToSpan(rtuZ, indoorBounds.minZ, indoorBounds.maxZ),
    ]
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

    // Sloped 3/4" PVC RTU Condensate Drain routed ON TOP of the flat roof deck (never slicing through
    // roof joists below rtuBaseY) toward the nearest perimeter roof-edge scupper strictly inside walls (VIS-V3-10 / VIS-04).
    const rtuCondSlopeInPerFt = 0.15
    const rtuCondSlopeRatio = rtuCondSlopeInPerFt / 12
    const scupperInsetX = bounds.maxX - bounds.minX > 0.7 ? 0.25 : 0.15
    const scupperInsetZ = bounds.maxZ - bounds.minZ > 0.7 ? 0.25 : 0.15
    const rtuCondStartX = clampToSpan(rtuPos[0] + 0.45, indoorBounds.minX, indoorBounds.maxX)
    const rtuCondStartZ = rtuPos[2]

    const candidateScuppersXZ: Array<readonly [number, number]> = []
    const pushScupperXZ = (tx: number, tz: number) => {
      const cx = clampToSpan(tx, bounds.minX + scupperInsetX, bounds.maxX - scupperInsetX)
      const cz = clampToSpan(tz, bounds.minZ + scupperInsetZ, bounds.maxZ - scupperInsetZ)
      if (footprintContains && !footprintContains(cx, cz)) return
      if (!candidateScuppersXZ.some((e) => Math.abs(e[0] - cx) < 0.08 && Math.abs(e[1] - cz) < 0.08)) {
        candidateScuppersXZ.push([cx, cz])
      }
    }
    if (walls.length > 0) {
      const extSnaps = findNearestExteriorWallPoints({
        origin: [rtuCondStartX, rtuCondStartZ],
        walls,
        rooms: rawRooms,
        outwardOffsetM: 0.08,
        cornerInsetM: 0.35,
        extraOffsetsM: [],
      })
      for (const snap of extSnaps.slice(0, 4)) {
        pushScupperXZ(snap.interiorBack[0], snap.interiorBack[1])
      }
    }
    const aabbEdgeScuppers: Array<readonly [number, number]> = [
      [bounds.maxX - scupperInsetX, rtuPos[2]],
      [bounds.minX + scupperInsetX, rtuPos[2]],
      [rtuPos[0], bounds.minZ + scupperInsetZ],
      [rtuPos[0], bounds.maxZ - scupperInsetZ],
    ]
    aabbEdgeScuppers.sort(
      (a, b) =>
        Math.hypot(a[0] - rtuCondStartX, a[1] - rtuCondStartZ) -
        Math.hypot(b[0] - rtuCondStartX, b[1] - rtuCondStartZ),
    )
    for (const [ex, ez] of aabbEdgeScuppers) pushScupperXZ(ex, ez)
    if (wetCoreRoom) pushScupperXZ(wetCoreRoom.centroid[0], wetCoreRoom.centroid[1])
    if (candidateScuppersXZ.length === 0) {
      candidateScuppersXZ.push([
        clampToSpan(bounds.maxX - scupperInsetX, indoorBounds.minX, indoorBounds.maxX),
        rtuPos[2],
      ])
    }

    const nearestTargetXZ = candidateScuppersXZ[0]!
    const nearestRunM = Math.abs(nearestTargetXZ[0] - rtuCondStartX) + Math.abs(nearestTargetXZ[1] - rtuCondStartZ)
    const desiredStartOffset = Math.max(0.04, Math.min(0.22, nearestRunM * rtuCondSlopeRatio + 0.015))
    const rtuCondStartY = round2(rtuBaseY + desiredStartOffset)
    const rtuCondFrom: Vec3 = [rtuCondStartX, rtuCondStartY, rtuCondStartZ]

    const rtuCondTargetList: Vec3[] = candidateScuppersXZ.map(([cx, cz]) => {
      const runM = Math.abs(cx - rtuCondFrom[0]) + Math.abs(cz - rtuCondFrom[2])
      const targetY = round2(Math.max(rtuBaseY + 0.01, rtuCondFrom[1] - Math.max(0.03, runM * rtuCondSlopeRatio)))
      return [cx, targetY, cz]
    })

    let rtuCondRoute = routeCondensateDrain({
      from: rtuCondFrom,
      to: rtuCondTargetList[0]!,
      obstacles,
      xzBounds: indoorBounds,
      slopeInPerFt: rtuCondSlopeInPerFt,
      footprintContains,
    })
    if (rtuCondRoute.clashes.length > 0) {
      for (let ti = 1; ti < rtuCondTargetList.length; ti++) {
        const cand = routeCondensateDrain({
          from: rtuCondFrom,
          to: rtuCondTargetList[ti]!,
          obstacles,
          xzBounds: indoorBounds,
          slopeInPerFt: rtuCondSlopeInPerFt,
          footprintContains,
        })
        if (cand.clashes.length < rtuCondRoute.clashes.length) {
          rtuCondRoute = cand
          if (cand.clashes.length === 0) break
        }
      }
    }
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
      rotation: outdoorRotation,
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

  const effectiveDuctR = (path: ReadonlyArray<Vec3>): number =>
    path.some((p) => p[1] > levelH - 0.02) ? Math.max(ductR, zoneMeta.ieccAtticDuctR) : ductR

  if (systemType === 'mini-split-multizone') {
    const msMaxY = maxPlenumYFor(0.03)
    const msPlenumY = useTrueAtticPlenum
      ? round2(Math.min(levelH + ceilingJoistClearM + 0.06, msMaxY ?? levelH + ceilingJoistClearM + 0.06))
      : plenumLocation === 'attic' || plenumLocation === 'conditioned-soffit'
        ? round2(Math.min(levelH - 0.18, msMaxY ?? levelH - 0.18))
        : round2(Math.min(-0.18, msMaxY ?? -0.18))
    for (const { loadRow, room } of conditionedRooms) {
      if (
        room.category === 'bathroom' ||
        room.category === 'hallway' ||
        room.category === 'utility' ||
        room.category === 'closet'
      ) {
        continue
      }
      const headId = nextTermId()
      const [headX, headZ] = findClearMechanicalSpot(room.centroid[0], room.centroid[1], obstacles, bounds, 0.42, true)
      const headPos: Vec3 = [
        clampToSpan(headX, indoorBounds.minX, indoorBounds.maxX),
        round2(Math.min(levelH - 0.35, 2.15)),
        clampToSpan(headZ, indoorBounds.minZ, indoorBounds.maxZ),
      ]
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
        from: [
          round2(outdoorPos[0] - outdoorOutDx * 0.25),
          round2(gradeY + 0.45),
          round2(outdoorPos[2] - outdoorOutDz * 0.25),
        ],
        to: headPos,
        plenumY: msPlenumY,
        maxPlenumY: msMaxY,
        ductHalfSpanM: 0.03,
        allowDiagonalBranch: true,
        obstacles,
        roofEnvelope: atticRoof,
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
    const supplyPlenumId = nextPlId()
    const supplyPlenumW = Math.max(0.2, supplyTrunkSize.widthIn * 0.0254)
    const retPlenumW = Math.max(0.2, returnTrunkSize.widthIn * 0.0254)
    // Seat vertical split-system supply plenum flush on top of air handler/furnace cabinet (0.05m pan + 1.38m = 1.43m);
    // for horizontal attic low-profile AHU, attach flush to horizontal discharge face along ridge axis;
    // for rooftop-package, anchor both supply and return curb drop plenums directly below the RTU curb.
    const supplyPlenumPos: Vec3 =
      systemType === 'rooftop-package' && rtuPos
        ? [
            clampToSpan(rtuPos[0] + 0.32, indoorBounds.minX, indoorBounds.maxX),
            round2(levelH - Math.max(0.32, supplyPlenumH + 0.1)),
            rtuPos[2],
          ]
        : isHorizontalAtticAhu
          ? horizAlongX
            ? [
                clampToSpan(
                  Math.round((indoorPos[0] + horizDischargeSign * (0.66 + supplyPlenumW / 2)) * 10000) / 10000,
                  indoorBounds.minX,
                  indoorBounds.maxX,
                ),
                Math.round((indoorPos[1] + 0.05 + supplyPlenumH / 2) * 10000) / 10000,
                indoorPos[2],
              ]
            : [
                indoorPos[0],
                Math.round((indoorPos[1] + 0.05 + supplyPlenumH / 2) * 10000) / 10000,
                clampToSpan(
                  Math.round((indoorPos[2] + horizDischargeSign * (0.66 + supplyPlenumW / 2)) * 10000) / 10000,
                  indoorBounds.minZ,
                  indoorBounds.maxZ,
                ),
              ]
          : [indoorPos[0], Math.round((indoorPos[1] + 0.05 + 1.38 + supplyPlenumH / 2) * 10000) / 10000, indoorPos[2]]
    plenums.push({
      id: supplyPlenumId,
      name: `Supply Plenum (${supplyTrunkSize.widthIn}"x${supplyTrunkSize.heightIn}")`,
      plenumKind: 'supply-plenum',
      position: supplyPlenumPos,
      rotation: isHorizontalAtticAhu ? indoorRotation : 0,
      widthIn: supplyTrunkSize.widthIn,
      heightIn: supplyTrunkSize.heightIn,
      depthIn: 24,
      airflowCfm: load.designTotalCfm,
      staticPressureInWg: 0.25,
      insulationR: ductR,
      heightM: round2(supplyPlenumH),
    })

    const returnPlenumId = nextPlId()
    let returnPlenumPos: Vec3
    if (systemType === 'rooftop-package' && rtuPos) {
      returnPlenumPos = [
        clampToSpan(rtuPos[0] - 0.38, indoorBounds.minX, indoorBounds.maxX),
        round2(levelH - Math.max(0.34, retPlenumH + 0.1)),
        rtuPos[2],
      ]
    } else if (isHorizontalAtticAhu) {
      const retY = Math.round((indoorPos[1] + 0.05 + retPlenumH / 2) * 10000) / 10000
      const retOff = 0.66 + retPlenumW / 2
      const rx = horizAlongX
        ? clampToSpan(indoorPos[0] - horizDischargeSign * retOff, indoorBounds.minX, indoorBounds.maxX)
        : indoorPos[0]
      const rz = horizAlongX
        ? indoorPos[2]
        : clampToSpan(indoorPos[2] - horizDischargeSign * retOff, indoorBounds.minZ, indoorBounds.maxZ)
      returnPlenumPos = [rx, retY, rz]
    } else {
      // Side-return drop offset beside the air handler/furnace cabinet & supply plenum so the vertical
      // return trunk never pierces the cabinet or blue supply plenum (VIS-01).
      // Hard-reject out-of-bounds candidates so return plenums never protrude past exterior walls (HVA-BUG-05).
      const cabScale = load.recommendedTons >= 4 ? 1.12 : load.recommendedTons <= 2 ? 0.92 : 1.0
      const cabHalfX = Math.max((0.54 * cabScale) / 2, (supplyTrunkSize.widthIn * 0.0254) / 2)
      const cabHalfZ = Math.max((indoorKind === 'air-handler' ? 0.56 : 0.72) / 2, (24 * 0.0254) / 2)
      const retHalfM = (returnTrunkSize.widthIn * 0.0254) / 2
      const lateralOffsetX = round2(cabHalfX + retHalfM + 0.08)
      const lateralOffsetZ = round2(cabHalfZ + retHalfM + 0.08)
      const sideCandidates: Array<readonly [number, number]> = [
        [round2(indoorPos[0] - lateralOffsetX), indoorPos[2]],
        [round2(indoorPos[0] + lateralOffsetX), indoorPos[2]],
        [indoorPos[0], round2(indoorPos[2] + lateralOffsetZ)],
        [indoorPos[0], round2(indoorPos[2] - lateralOffsetZ)],
        // Extended side & diagonal clear offsets (still strictly outside cabinet footprint)
        [round2(indoorPos[0] - lateralOffsetX), round2(indoorPos[2] + lateralOffsetZ)],
        [round2(indoorPos[0] + lateralOffsetX), round2(indoorPos[2] + lateralOffsetZ)],
        [round2(indoorPos[0] - lateralOffsetX), round2(indoorPos[2] - lateralOffsetZ)],
        [round2(indoorPos[0] + lateralOffsetX), round2(indoorPos[2] - lateralOffsetZ)],
        [round2(indoorPos[0] - lateralOffsetX - 0.45), indoorPos[2]],
        [round2(indoorPos[0] + lateralOffsetX + 0.45), indoorPos[2]],
        [indoorPos[0], round2(indoorPos[2] + lateralOffsetZ + 0.45)],
        [indoorPos[0], round2(indoorPos[2] - lateralOffsetZ - 0.45)],
      ]
      const retPlenumBaseY = isAtticMountedAhu ? round2(atticPlatformY + 0.25) : 0.25
      let bestDrop: readonly [number, number] | null = null
      let bestScore = -Infinity
      for (let si = 0; si < sideCandidates.length; si++) {
        const [cx, cz] = sideCandidates[si]!
        const inBounds =
          cx >= indoorBounds.minX && cx <= indoorBounds.maxX && cz >= indoorBounds.minZ && cz <= indoorBounds.maxZ
        if (!inBounds) continue
        if (isAtticMountedAhu && atticRoof) {
          const minRetRoofY = minRoofYOverFootprint(atticRoof, cx, cz, retPlenumW / 2, 0.32)
          if (retPlenumBaseY + Math.max(0.45, retPlenumH) > minRetRoofY - 0.14) continue
        }
        const inRoom = pointInPolygon2D(cx, cz, mechRoom.polygon)
        const inAnyIndoorRoom =
          rawRooms.length === 0 ||
          rooms.some((r) => r.category !== 'exterior' && pointInPolygon2D(cx, cz, r.polygon))
        const dropClashes = detectHvacClashes(
          [
            [cx, retPlenumY, cz],
            [cx, retPlenumBaseY, cz],
          ],
          obstacles,
          retClashSpan,
        ).length
        const clear = Math.min(2.0, minClearanceToObstaclesXZ(cx, cz, isAtticMountedAhu ? atticLevelObstacles : floorLevelObstacles))
        const primaryBonus = si < 4 ? 12 : 0
        const score =
          (inAnyIndoorRoom ? 0 : -1500) +
          (dropClashes === 0 ? 200 : -dropClashes * 80) +
          (inRoom ? 20 : 0) +
          primaryBonus +
          clear
        if (score > bestScore) {
          bestScore = score
          bestDrop = [cx, cz]
        }
      }
      if (!bestDrop) {
        // Fallback strictly inside walled bounds toward building center
        const fbX = clampToSpan(
          indoorPos[0] + (indoorPos[0] <= bounds.cx ? lateralOffsetX : -lateralOffsetX),
          indoorBounds.minX,
          indoorBounds.maxX,
        )
        const fbZ = clampToSpan(indoorPos[2], indoorBounds.minZ, indoorBounds.maxZ)
        bestDrop = [fbX, fbZ]
      }
      returnPlenumPos = [bestDrop[0], retPlenumBaseY, bestDrop[1]]
    }
    plenums.push({
      id: returnPlenumId,
      name: `Return Plenum (${returnTrunkSize.widthIn}"x${returnTrunkSize.heightIn}")`,
      plenumKind: 'return-plenum',
      position: returnPlenumPos,
      rotation: isHorizontalAtticAhu ? indoorRotation : 0,
      widthIn: returnTrunkSize.widthIn,
      heightIn: returnTrunkSize.heightIn,
      depthIn: 24,
      airflowCfm: load.designTotalCfm,
      staticPressureInWg: -0.2,
      insulationR: ductR,
      heightM: round2(retPlenumH),
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

    const supplyMaxY = maxPlenumYFor(supplyHalfV)
    const rawTrunkX = clampToSpan(furthestRoom.room.centroid[0], indoorBounds.minX, indoorBounds.maxX)
    const rawTrunkZ = clampToSpan(furthestRoom.room.centroid[1], indoorBounds.minZ, indoorBounds.maxZ)
    let trunkBaseX = rawTrunkX
    let trunkBaseZ = rawTrunkZ
    if (atticRoof && plenumY > levelH + 0.05) {
      // Keep main attic supply trunk inside the safe inner ridge corridor so it never pokes through sloped rafters (VIS-01),
      // without pulling the trunk endpoint out into an open concave U/L courtyard (VIS-V3-04).
      const corrHalf = Math.min(atticRoof.halfSpan * 0.55, safeRoofCorridorHalfWidth(atticRoof, plenumY, supplyHalfV, 0.1))
      const corrLo = atticRoof.center - corrHalf
      const corrHi = atticRoof.center + corrHalf
      const candX = atticRoof.ridgeAlongX
        ? trunkBaseX
        : clampToSpan(trunkBaseX, Math.max(indoorBounds.minX, corrLo), Math.min(indoorBounds.maxX, corrHi))
      const candZ = atticRoof.ridgeAlongX
        ? clampToSpan(trunkBaseZ, Math.max(indoorBounds.minZ, corrLo), Math.min(indoorBounds.maxZ, corrHi))
        : trunkBaseZ
      if (!footprintContains || footprintContains(candX, candZ)) {
        trunkBaseX = candX
        trunkBaseZ = candZ
      }
    }

    const trunkEndRes = findClearSpotForRiser({
      baseX: trunkBaseX,
      baseZ: trunkBaseZ,
      y0: plenumY,
      y1: plenumY,
      clashSpan: supplyClashSpan,
      obstacles,
      bounds,
      minFloorClearanceM: Math.max(0.45, supplyHalfX + 0.12),
      insidePolygon:
        footprintContains && !footprintContains(bounds.cx, bounds.cz) ? furthestRoom.room.polygon : undefined,
      floorObstacles: plenumLocation === 'attic' ? atticLevelObstacles : obstacles,
      roofConstraint:
        atticRoof && plenumY > levelH + 0.05
          ? { roof: atticRoof, requiredTopY: plenumY + supplyHalfV + 0.1, preferRidgeWeight: 20 }
          : undefined,
    })
    const [trunkEndX, trunkEndZ] = trunkEndRes.spot
    let trunkRoute = routeHvacDuctRun({
      from: supplyPlenumPos,
      to: [trunkEndX, plenumY, trunkEndZ],
      plenumY,
      maxPlenumY: supplyMaxY,
      ductHalfSpanM: supplyClashSpan,
      allowDiagonalBranch: false,
      obstacles,
      xzBounds: indoorBounds,
      roofEnvelope: atticRoof,
      footprintContains,
      interiorCorridorSpines,
    })
    if (trunkRoute.clashes.length > 0 && plenumLocation === 'attic') {
      for (const [dy, dx, dz] of [
        [0.4, 0, 0],
        [0.75, 0, 0],
        [0, 0.55, 0],
        [0, -0.55, 0],
        [0, 0, 0.55],
        [0, 0, -0.55],
      ] as const) {
        const candY = supplyMaxY !== undefined ? Math.min(round2(plenumY + dy), supplyMaxY) : round2(plenumY + dy)
        const candX = clampToSpan(trunkEndX + dx, indoorBounds.minX, indoorBounds.maxX)
        const candZ = clampToSpan(trunkEndZ + dz, indoorBounds.minZ, indoorBounds.maxZ)
        if (footprintContains && !footprintContains(candX, candZ)) continue
        if (atticRoof && candY > levelH + 0.05 && candY + supplyHalfV > atticRoof.roofYAt(candX, candZ) - 0.1) {
          continue
        }
        const cand = routeHvacDuctRun({
          from: supplyPlenumPos,
          to: [candX, candY, candZ],
          plenumY: candY,
          maxPlenumY: supplyMaxY,
          ductHalfSpanM: supplyClashSpan,
          allowDiagonalBranch: false,
          obstacles,
          xzBounds: indoorBounds,
          roofEnvelope: atticRoof,
          footprintContains,
          interiorCorridorSpines,
        })
        if (cand.clashes.length < trunkRoute.clashes.length) {
          trunkRoute = cand
          if (cand.clashes.length === 0) break
        }
      }
    }
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
      supplyTermKind === 'supply-ceiling-diffuser' ? round2(levelH - 0.04) : HVAC_TERMINAL_SPECS[supplyTermKind].defaultMountY

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
      const branchHalfSpan = Math.max(0.08, (branchSized.diameterIn * 0.0254) / 2)
      const branchMaxY = maxPlenumYFor(branchHalfSpan)

      for (let i = 0; i < regCount; i++) {
        const offsetX = regCount === 1 ? 0 : (i - (regCount - 1) / 2) * 1.4
        const regRes = findClearSpotForRiser({
          baseX: room.centroid[0] + offsetX,
          baseZ: room.centroid[1],
          y0: termY,
          y1: plenumY,
          clashSpan: branchHalfSpan,
          obstacles,
          bounds,
          minFloorClearanceM: Math.max(0.32, branchHalfSpan + 0.1),
          insidePolygon: room.polygon,
        })
        const [regX, regZ] = regRes.spot
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

        const tapPt = nearestPointOnSpine(trunkRoute.path, regPos[0], regPos[2], plenumY, footprintContains)
        const branchPlenumY =
          branchMaxY !== undefined ? Math.min(plenumY, branchMaxY) : plenumY
        const branchRoute = routeHvacDuctRun({
          from: tapPt,
          to: regPos,
          plenumY: branchPlenumY,
          maxPlenumY: branchMaxY,
          ductHalfSpanM: branchHalfSpan,
          allowDiagonalBranch: true,
          obstacles,
          xzBounds: indoorBounds,
          roofEnvelope: atticRoof,
          footprintContains,
          interiorCorridorSpines,
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
          position: [
            clampToSpan(room.centroid[0] - 0.6, indoorBounds.minX, indoorBounds.maxX),
            round2(Math.min(levelH - 0.3, 2.25)),
            clampToSpan(room.centroid[1], indoorBounds.minZ, indoorBounds.maxZ),
          ],
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
    const prohibitedReturnRooms = rooms.filter((r) => prohibitedReturnCats.has(r.category) && r.category !== 'attic')
    const prohibitedReturnPolygons = prohibitedReturnRooms.map((r) => r.polygon)
    const eligibleReturnRooms = rooms
      .filter((r) => !prohibitedReturnCats.has(r.category))
      .sort((a, b) => {
        const rank = (r: (typeof rooms)[number]) => (r.category === 'hallway' ? 3 : r.category === 'living' ? 2 : 1)
        return rank(b) - rank(a)
      })
    const isSynthesizedCorridor = eligibleReturnRooms.length === 0
    const returnCandidates: Array<{
      name: string
      polygon: ReadonlyArray<readonly [number, number]>
      centroid: readonly [number, number]
    }> =
      eligibleReturnRooms.length > 0
        ? eligibleReturnRooms
        : [
            {
              name: 'Common Corridor',
              polygon: [
                [indoorBounds.minX, indoorBounds.minZ],
                [indoorBounds.maxX, indoorBounds.minZ],
                [indoorBounds.maxX, indoorBounds.maxZ],
                [indoorBounds.minX, indoorBounds.maxZ],
              ] as const,
              centroid: [
                round2((indoorBounds.minX + indoorBounds.maxX) / 2),
                round2((indoorBounds.minZ + indoorBounds.maxZ) / 2),
              ] as const,
            },
          ]

    const retGrilleY =
      plenumLocation === 'attic' || systemType === 'rooftop-package'
        ? round2(levelH - 0.04)
        : round2(Math.min(levelH - 0.35, 2.2))
    const retMinClear = Math.max(0.42, retClashSpan.horizontal + 0.08)
    const retMaxY = maxPlenumYFor(retHalfV)
    const retCeilingObstacles =
      plenumLocation === 'attic'
        ? obstacles.filter((o) => o.box.maxY >= retGrilleY - retClashSpan.vertical - 0.05)
        : obstacles
    const isInsideProhibitedOverlap = (px: number, pz: number): boolean =>
      prohibitedReturnRooms.some((pr) => pointInPolygon2D(px, pz, pr.polygon))
    const isClearOfProhibitedCorridorMargin = (px: number, pz: number): boolean => {
      if (isInsideProhibitedOverlap(px, pz)) return false
      const m = 0.08
      return (
        !isInsideProhibitedOverlap(px + m, pz) &&
        !isInsideProhibitedOverlap(px - m, pz) &&
        !isInsideProhibitedOverlap(px, pz + m) &&
        !isInsideProhibitedOverlap(px, pz - m)
      )
    }

    let chosenRetRoom = returnCandidates[0]!
    let chosenRetPos: Vec3 = [
      clampToSpan(chosenRetRoom.centroid[0], indoorBounds.minX, indoorBounds.maxX),
      retGrilleY,
      clampToSpan(chosenRetRoom.centroid[1], indoorBounds.minZ, indoorBounds.maxZ),
    ]
    let chosenRetRoute: ReturnType<typeof routeHvacDuctRun> | null = null
    let chosenInProhibited = true
    let hasValidReturnSpot = !isSynthesizedCorridor

    for (const candRoom of returnCandidates) {
      let retBaseX = candRoom.centroid[0]
      let retBaseZ = pointInPolygon2D(retBaseX, candRoom.centroid[1] + 0.35, candRoom.polygon)
        ? candRoom.centroid[1] + 0.35
        : candRoom.centroid[1]
      let spotRes = findClearSpotForRiser({
        baseX: retBaseX,
        baseZ: retBaseZ,
        y0: retGrilleY,
        y1: retPlenumY,
        clashSpan: retClashSpan,
        obstacles,
        bounds,
        minFloorClearanceM: retMinClear,
        insidePolygon: candRoom.polygon,
        excludePolygons: prohibitedReturnPolygons,
        floorObstacles: retCeilingObstacles,
      })

      // For partially-zoned houses (R2-HVC-02), if the center & 5x5 coarse grid missed an
      // off-center unzoned hallway/living pocket inside indoorBounds, probe a denser 9x9 grid.
      if (isSynthesizedCorridor && (!spotRes.foundValid || !isClearOfProhibitedCorridorMargin(spotRes.spot[0], spotRes.spot[1]))) {
        const spanX = indoorBounds.maxX - indoorBounds.minX
        const spanZ = indoorBounds.maxZ - indoorBounds.minZ
        if (spanX > 0.25 && spanZ > 0.25) {
          let seedSpot: [number, number] | null = null
          let bestSeedDist = Infinity
          const steps = 9
          for (let ix = 1; ix <= steps; ix++) {
            for (let iz = 1; iz <= steps; iz++) {
              const gx = round2(indoorBounds.minX + (spanX * ix) / (steps + 1))
              const gz = round2(indoorBounds.minZ + (spanZ * iz) / (steps + 1))
              if (!isClearOfProhibitedCorridorMargin(gx, gz)) continue
              const dist = Math.hypot(gx - candRoom.centroid[0], gz - candRoom.centroid[1])
              if (dist < bestSeedDist) {
                bestSeedDist = dist
                seedSpot = [gx, gz]
              }
            }
          }
          if (seedSpot) {
            retBaseX = seedSpot[0]
            retBaseZ = seedSpot[1]
            spotRes = findClearSpotForRiser({
              baseX: retBaseX,
              baseZ: retBaseZ,
              y0: retGrilleY,
              y1: retPlenumY,
              clashSpan: retClashSpan,
              obstacles,
              bounds,
              minFloorClearanceM: retMinClear,
              insidePolygon: candRoom.polygon,
              excludePolygons: prohibitedReturnPolygons,
              floorObstacles: retCeilingObstacles,
            })
          }
        }
      }

      const candPos: Vec3 = [spotRes.spot[0], retGrilleY, spotRes.spot[1]]
      const inProhibited = isSynthesizedCorridor
        ? !spotRes.foundValid || !isClearOfProhibitedCorridorMargin(candPos[0], candPos[2])
        : isInsideProhibitedOverlap(candPos[0], candPos[2])
      if (isSynthesizedCorridor && inProhibited) continue

      const candRoute = routeHvacDuctRun({
        from: candPos,
        to: returnPlenumPos,
        plenumY: retMaxY !== undefined ? Math.min(retPlenumY, retMaxY) : retPlenumY,
        maxPlenumY: retMaxY,
        ductHalfSpanM: retClashSpan,
        allowDiagonalBranch: false,
        obstacles,
        xzBounds: indoorBounds,
        roofEnvelope: atticRoof,
        footprintContains,
        interiorCorridorSpines,
      })
      const better =
        !chosenRetRoute ||
        (chosenInProhibited && !inProhibited) ||
        (chosenInProhibited === inProhibited && candRoute.clashes.length < chosenRetRoute.clashes.length)
      if (better) {
        chosenRetRoom = candRoom
        chosenRetPos = candPos
        chosenRetRoute = candRoute
        chosenInProhibited = inProhibited
        hasValidReturnSpot = true
      }
      if (!inProhibited && candRoute.clashes.length === 0) break
    }

    if (hasValidReturnSpot) {
      const retGrilleId = nextTermId()
      terminals.push({
        id: retGrilleId,
        name: `Central Return Air Grille (${load.designTotalCfm} CFM)`,
        terminalKind: 'return-grille',
        position: chosenRetPos,
        rotation: 0,
        roomName: chosenRetRoom.name,
        designCfm: load.designTotalCfm,
        neckSizeIn: returnTrunkSize.diameterIn,
        throwFt: 0,
      })
      const retPath: Vec3[] = [...(chosenRetRoute?.path ?? [chosenRetPos, returnPlenumPos])]
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
    position: [
      clampToSpan(statSnap.position[0], indoorBounds.minX, indoorBounds.maxX),
      statSnap.position[1],
      clampToSpan(statSnap.position[2], indoorBounds.minZ, indoorBounds.maxZ),
    ],
    rotation: statSnap.rotation,
    roomName: statRoom.name,
    designCfm: 0,
    neckSizeIn: 0,
    throwFt: 0,
  })

  // Helper to clamp exterior wall penetration height strictly below roof rafters or upper-story floor slab (VIS-01 / HVA-BUG-03 / R2-HVC-03)
  const clampExteriorExitY = (wx: number, wz: number, desiredY: number, halfSpan: number): number => {
    const soffitExitY = round2(Math.min(levelH - Math.max(0.18, halfSpan + 0.08), desiredY))
    if (!roofEnvelope.hasRoofAbove || (!useTrueAtticPlenum && (plenumLocation === 'attic' || plenumLocation === 'conditioned-soffit'))) {
      return soffitExitY
    }
    if (!atticRoof) return desiredY
    const wallX = clampToSpan(wx, bounds.minX, bounds.maxX)
    const wallZ = clampToSpan(wz, bounds.minZ, bounds.maxZ)
    const roofCap = atticRoof.roofYAt(wallX, wallZ) - halfSpan - 0.1
    if (roofCap <= levelH + 0.05) return soffitExitY
    return round2(Math.min(desiredY, roofCap))
  }

  // 4. Optional ASHRAE 62.2 ERV Fresh-Air Ventilator & Duct
  if (includeErv) {
    const ervId = nextEqId()
    // Size ERV duct BEFORE clash-routing & riser placement so margins match audited diameter (HVA-CON-01)
    const ervDuct = sizeDuctForCfm({
      cfm: ventilation.continuousFreshAirCfm,
      shape: 'round',
      material: 'galvanized-sheet',
      occupancy,
    })
    const ervHalfSpan = Math.max(0.08, (ervDuct.diameterIn * 0.0254) / 2)
    const ervMaxY = maxPlenumYFor(ervHalfSpan)
    const ervObstacles: HvacObstacle[] = [
      ...obstacles,
      {
        id: indoorId,
        nodeId: indoorId,
        category: 'structural',
        label: 'Primary Air Handler / Furnace Cabinet',
        box: {
          minX: indoorPos[0] - (isHorizontalAtticAhu && roofEnvelope.ridgeAlongX ? 0.72 : 0.34),
          maxX: indoorPos[0] + (isHorizontalAtticAhu && roofEnvelope.ridgeAlongX ? 0.72 : 0.34),
          minY: indoorPos[1],
          maxY: indoorPos[1] + (isHorizontalAtticAhu ? 0.56 : 1.85),
          minZ: indoorPos[2] - (isHorizontalAtticAhu && !roofEnvelope.ridgeAlongX ? 0.72 : 0.38),
          maxZ: indoorPos[2] + (isHorizontalAtticAhu && !roofEnvelope.ridgeAlongX ? 0.72 : 0.38),
        },
      },
    ]
    const ervBaseOffsets: ReadonlyArray<readonly [number, number]> = isAtticMountedAhu
      ? roofEnvelope.ridgeAlongX
        ? [
            [1.6, 0],
            [-1.6, 0],
            [1.1, 0],
            [-1.1, 0],
            [0.85, 0.45],
            [-0.85, 0.45],
            [0.85, -0.45],
            [-0.85, -0.45],
          ]
        : [
            [0, 1.6],
            [0, -1.6],
            [0, 1.1],
            [0, -1.1],
            [0.45, 0.85],
            [-0.45, 0.85],
            [0.45, -0.85],
            [-0.45, -0.85],
          ]
      : [
          [0.85, 0.45],
          [-0.85, 0.45],
          [0.85, -0.45],
          [-0.85, -0.45],
          [0, 0.85],
          [0, -0.85],
          [0.85, 0],
          [-0.85, 0],
        ]

    let ervInAttic = isAtticMountedAhu
    const atticErvMountY = round2(atticPlatformY + 0.04)
    const indoorErvMountY = round2(Math.min(levelH - 0.55, 1.85))
    const ervAtticReqRoofY = atticErvMountY + 0.6 + 0.14

    let ervBaseX = indoorPos[0]
    let ervBaseZ = indoorPos[2]
    for (const [ox, oz] of ervBaseOffsets) {
      const tx = round2(indoorPos[0] + ox)
      const tz = round2(indoorPos[2] + oz)
      if (ervInAttic || isInsideWithMargin(tx, tz, mechRoom.polygon, 0.22)) {
        if (tx >= bounds.minX + 0.4 && tx <= bounds.maxX - 0.4 && tz >= bounds.minZ + 0.4 && tz <= bounds.maxZ - 0.4) {
          if (!ervInAttic || !atticRoof || minRoofYOverFootprint(atticRoof, tx, tz, 0.34, 0.24) >= ervAtticReqRoofY) {
            ervBaseX = tx
            ervBaseZ = tz
            break
          }
        }
      }
    }

    let ervMountY = ervInAttic ? atticErvMountY : indoorErvMountY
    let ervPlenumY = round2(plenumY + 0.14)
    if (ervMaxY !== undefined) ervPlenumY = Math.min(ervPlenumY, ervMaxY)

    let ervSpotRes = findClearSpotForRiser({
      baseX: ervBaseX,
      baseZ: ervBaseZ,
      y0: ervMountY,
      y1: ervPlenumY,
      clashSpan: ervHalfSpan,
      obstacles: ervObstacles,
      bounds,
      minFloorClearanceM: 0.65,
      insidePolygon: ervInAttic ? undefined : mechRoom.polygon,
      floorObstacles: ervInAttic ? [...atticLevelObstacles, ervObstacles[ervObstacles.length - 1]!] : ervObstacles,
      roofConstraint:
        ervInAttic && atticRoof
          ? {
              roof: atticRoof,
              requiredTopY: ervAtticReqRoofY,
              preferRidgeWeight: 28,
              footprintHalfW: 0.34,
              footprintHalfD: 0.24,
            }
          : undefined,
    })
    if (
      ervInAttic &&
      atticRoof &&
      (!ervSpotRes.foundValid || minRoofYOverFootprint(atticRoof, ervSpotRes.spot[0], ervSpotRes.spot[1], 0.34, 0.24) < ervAtticReqRoofY)
    ) {
      ervInAttic = false
      ervMountY = indoorErvMountY
      ervSpotRes = findClearSpotForRiser({
        baseX: mechRoom.centroid[0],
        baseZ: mechRoom.centroid[1],
        y0: ervMountY,
        y1: ervPlenumY,
        clashSpan: ervHalfSpan,
        obstacles: ervObstacles,
        bounds,
        minFloorClearanceM: 0.65,
        insidePolygon: mechRoom.polygon,
        floorObstacles: ervObstacles,
      })
    }
    const [ervX, ervZ] = ervSpotRes.spot
    const ervPos: Vec3 = [
      clampToSpan(ervX, indoorBounds.minX, indoorBounds.maxX),
      ervMountY,
      clampToSpan(ervZ, indoorBounds.minZ, indoorBounds.maxZ),
    ]
    equipment.push({
      id: ervId,
      name: `ASHRAE 62.2 ERV (${ventilation.recommendedErvCfm} CFM)`,
      equipmentKind: 'erv-ventilator',
      position: ervPos,
      rotation: 0,
      roomName: ervInAttic ? 'Attic Mechanical Platform' : mechRoom.name,
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
      heightM: 0.52,
      electricalDemand: getHvacEquipmentElectricalDemand({ kind: 'erv-ventilator', occupancy }),
    })

    const intakeId = nextTermId()
    const intakeOnWest = Math.abs(ervPos[0] - bounds.minX) <= Math.abs(bounds.maxX - ervPos[0])
    const primaryIntakeX = round2(intakeOnWest ? bounds.minX - 0.08 : bounds.maxX + 0.08)
    const oppIntakeX = round2(intakeOnWest ? bounds.maxX + 0.08 : bounds.minX - 0.08)
    // Gate high/upper attic intake elevations strictly on useTrueAtticPlenum (HVA-BUG-03)
    const baseIntakeY =
      useTrueAtticPlenum && ervInAttic
        ? round2(levelH + ceilingJoistClearM + 0.06)
        : round2(Math.min(levelH - 0.35, 2.1))
    const highIntakeY = useTrueAtticPlenum
      ? round2(Math.max(baseIntakeY, levelH + ceilingJoistClearM + 0.14))
      : round2(Math.min(levelH - 0.25, 2.25))
    const upperIntakeY = useTrueAtticPlenum
      ? round2(levelH + ceilingJoistClearM + 0.42)
      : round2(Math.min(levelH - 0.55, 1.85))

    const minDistToActualWall = (x: number, z: number): number => {
      if (walls.length === 0) return 0
      let best = Infinity
      for (const w of walls) {
        const { dist } = distancePointToSegment2D(x, z, w.start[0], w.start[1], w.end[0], w.end[1])
        if (dist < best) best = dist
      }
      return best
    }

    type IntakeCandidate = {
      intakePos: Vec3
      interiorBack: Vec3
      outwardNormal: readonly [number, number]
    }
    // Snap fresh-air intake hood FIRST onto verified real exterior walls (VIS-V3-04 Part A)
    // so L/U-shaped footprints never float an intake hood out in an open yard; discard any synthetic
    // AABB candidate that isn't within 0.25m of an actual wall segment!
    const intakeCandidates: IntakeCandidate[] = []
    const pushIntake = (
      ix: number,
      rawY: number,
      iz: number,
      backX: number,
      backZ: number,
      outNormal: readonly [number, number],
      isSyntheticAabb = false,
    ) => {
      if (isSyntheticAabb && walls.length > 0 && minDistToActualWall(ix, iz) > 0.25) return
      const iy = clampExteriorExitY(ix, iz, rawY, ervHalfSpan)
      const pt: Vec3 = [round2(ix), iy, round2(iz)]
      if (
        !intakeCandidates.some(
          (e) =>
            Math.abs(e.intakePos[0] - pt[0]) < 0.05 &&
            Math.abs(e.intakePos[1] - pt[1]) < 0.05 &&
            Math.abs(e.intakePos[2] - pt[2]) < 0.05,
        )
      ) {
        intakeCandidates.push({
          intakePos: pt,
          interiorBack: [
            clampToSpan(backX, indoorBounds.minX, indoorBounds.maxX),
            iy,
            clampToSpan(backZ, indoorBounds.minZ, indoorBounds.maxZ),
          ],
          outwardNormal: outNormal,
        })
      }
    }

    const realWallIntakes = findNearestExteriorWallPoints({
      origin: [ervPos[0], ervPos[2]],
      walls,
      rooms: rawRooms,
      outwardOffsetM: 0.08,
      cornerInsetM: 0.45,
      extraOffsetsM: [1.4, -1.4, 2.8, -2.8],
    })
    for (const rw of realWallIntakes) {
      pushIntake(rw.point[0], baseIntakeY, rw.point[1], rw.interiorBack[0], rw.interiorBack[1], rw.outwardNormal, false)
      pushIntake(rw.point[0], highIntakeY, rw.point[1], rw.interiorBack[0], rw.interiorBack[1], rw.outwardNormal, false)
      pushIntake(rw.point[0], upperIntakeY, rw.point[1], rw.interiorBack[0], rw.interiorBack[1], rw.outwardNormal, false)
    }

    const clampedErvZ = clampToSpan(ervPos[2], wallMinZ, wallMaxZ)
    const clampedErvX = clampToSpan(ervPos[0], wallMinX, wallMaxX)
    const addSideWallIntakes = () => {
      const pSign = intakeOnWest ? -1 : 1
      const pBackX = intakeOnWest ? bounds.minX + 0.18 : bounds.maxX - 0.18
      const oBackX = intakeOnWest ? bounds.maxX - 0.18 : bounds.minX + 0.18
      pushIntake(primaryIntakeX, baseIntakeY, clampedErvZ, pBackX, clampedErvZ, [pSign, 0], true)
      pushIntake(primaryIntakeX, highIntakeY, clampedErvZ, pBackX, clampedErvZ, [pSign, 0], true)
      pushIntake(primaryIntakeX, upperIntakeY, clampedErvZ, pBackX, clampedErvZ, [pSign, 0], true)
      for (const dz of [1.4, -1.4, 2.8, -2.8]) {
        const cz = round2(ervPos[2] + dz)
        if (cz >= wallMinZ && cz <= wallMaxZ) {
          pushIntake(primaryIntakeX, highIntakeY, cz, pBackX, cz, [pSign, 0], true)
        }
      }
      pushIntake(oppIntakeX, highIntakeY, clampedErvZ, oBackX, clampedErvZ, [-pSign, 0], true)
      pushIntake(oppIntakeX, upperIntakeY, clampedErvZ, oBackX, clampedErvZ, [-pSign, 0], true)
    }
    const addNorthSouthIntakes = () => {
      pushIntake(clampedErvX, highIntakeY, round2(bounds.minZ - 0.08), clampedErvX, bounds.minZ + 0.18, [0, -1], true)
      pushIntake(clampedErvX, highIntakeY, round2(bounds.maxZ + 0.08), clampedErvX, bounds.maxZ - 0.18, [0, 1], true)
      pushIntake(clampedErvX, upperIntakeY, round2(bounds.minZ - 0.08), clampedErvX, bounds.minZ + 0.18, [0, -1], true)
      pushIntake(clampedErvX, upperIntakeY, round2(bounds.maxZ + 0.08), clampedErvX, bounds.maxZ - 0.18, [0, 1], true)
    }
    if (atticRoof && !atticRoof.ridgeAlongX) {
      addNorthSouthIntakes()
      addSideWallIntakes()
    } else {
      addSideWallIntakes()
      addNorthSouthIntakes()
    }
    if (intakeCandidates.length === 0) {
      // Degenerate single/collinear-wall fallback
      const pSign = intakeOnWest ? -1 : 1
      const pBackX = intakeOnWest ? bounds.minX + 0.18 : bounds.maxX - 0.18
      pushIntake(primaryIntakeX, baseIntakeY, clampedErvZ, pBackX, clampedErvZ, [pSign, 0], false)
    }

    const routeErvCandidate = (cand: IntakeCandidate) => {
      // Route strictly inside the building envelope between the interior back of the intake wall
      // and the ERV cabinet, then prepend the perpendicular wall-penetration stub to intakePos.
      const inner = routeHvacDuctRun({
        from: cand.interiorBack,
        to: ervPos,
        plenumY: ervPlenumY,
        maxPlenumY: ervMaxY,
        ductHalfSpanM: ervHalfSpan,
        allowDiagonalBranch: false,
        obstacles,
        xzBounds: indoorBounds,
        roofEnvelope: atticRoof,
        footprintContains,
        interiorCorridorSpines,
      })
      const fullPath: Vec3[] = [cand.intakePos]
      for (const p of inner.path) {
        const prev = fullPath[fullPath.length - 1]!
        if (Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]) > 0.01) {
          fullPath.push(p)
        }
      }
      return { path: fullPath, clashes: detectHvacClashes(fullPath, obstacles, ervHalfSpan) }
    }

    let chosenIntake = intakeCandidates[0]!
    let ervRoute = routeErvCandidate(chosenIntake)
    if (ervRoute.clashes.length > 0) {
      for (let ii = 1; ii < intakeCandidates.length; ii++) {
        const candIn = intakeCandidates[ii]!
        const candRoute = routeErvCandidate(candIn)
        if (candRoute.clashes.length < ervRoute.clashes.length) {
          chosenIntake = candIn
          ervRoute = candRoute
          if (candRoute.clashes.length === 0) break
        }
      }
    }
    const intakePos = chosenIntake.intakePos
    const intakeRotation = round2(Math.atan2(chosenIntake.outwardNormal[0], chosenIntake.outwardNormal[1]))
    terminals.push({
      id: intakeId,
      name: `Fresh Air Intake Hood (${ventilation.continuousFreshAirCfm} CFM)`,
      terminalKind: 'fresh-air-intake',
      position: intakePos,
      rotation: intakeRotation,
      roomName: 'Exterior',
      designCfm: ventilation.continuousFreshAirCfm,
      neckSizeIn: 6,
      throwFt: 0,
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
      insulationR: effectiveDuctR(ervRoute.path),
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
        // Size bath exhaust duct BEFORE clash-routing & riser placement so margins match audited diameter (HVA-CON-01)
        const exSized = sizeDuctForCfm({ cfm: 80, shape: 'round', material: 'galvanized-sheet', occupancy })
        const exHalfSpan = Math.max(0.06, (exSized.diameterIn * 0.0254) / 2)
        const exMaxY = maxPlenumYFor(exHalfSpan)
        const exCappedBelowSlab =
          plenumLocation === 'conditioned-soffit' || !roofEnvelope.hasRoofAbove || systemType === 'rooftop-package'
        const exSoffitCapY = round2(levelH - Math.max(0.16, exHalfSpan + 0.06))
        const fanY = systemType === 'rooftop-package' ? round2(levelH - 0.18) : round2(levelH - 0.05)
        const rawExPlenumY = exCappedBelowSlab ? exSoffitCapY : round2(levelH + ceilingJoistClearM + exHalfSpan + 0.04)
        const exPlenumY = exCappedBelowSlab
          ? rawExPlenumY
          : exMaxY !== undefined && plenumLocation === 'attic'
            ? Math.min(rawExPlenumY, exMaxY)
            : rawExPlenumY
        const fanRes = findClearSpotForRiser({
          baseX: room.centroid[0],
          baseZ: room.centroid[1],
          y0: fanY,
          y1: exPlenumY,
          clashSpan: exHalfSpan,
          obstacles,
          bounds,
          minFloorClearanceM: 0.35,
          insidePolygon: room.polygon,
        })
        const [fanX, fanZ] = fanRes.spot
        const fanPos: Vec3 = [fanX, fanY, fanZ]
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
          heightM: 0.18,
          electricalDemand: getHvacEquipmentElectricalDemand({ kind: 'bath-exhaust-fan', occupancy }),
        })
        const cFanX = clampToSpan(fanX, wallMinX, wallMaxX)
        const cFanZ = clampToSpan(fanZ, wallMinZ, wallMaxZ)
        const rawBathTargets: Vec3[] = []
        if (walls.length > 0) {
          const bathWallSnaps = findNearestExteriorWallPoints({
            origin: [fanX, fanZ],
            walls,
            rooms: rawRooms,
            outwardOffsetM: 0.1,
            cornerInsetM: 0.35,
            extraOffsetsM: [],
          })
          for (const snap of bathWallSnaps.slice(0, 4)) {
            rawBathTargets.push([
              snap.point[0],
              clampExteriorExitY(snap.point[0], snap.point[1], exPlenumY, exHalfSpan),
              snap.point[1],
            ])
          }
        }
        if (rawBathTargets.length === 0) {
          rawBathTargets.push(
            [cFanX, clampExteriorExitY(cFanX, bounds.minZ - 0.1, exPlenumY, exHalfSpan), round2(bounds.minZ - 0.1)],
            [cFanX, clampExteriorExitY(cFanX, bounds.maxZ + 0.1, exPlenumY, exHalfSpan), round2(bounds.maxZ + 0.1)],
            [round2(bounds.minX - 0.1), clampExteriorExitY(bounds.minX - 0.1, cFanZ, exPlenumY, exHalfSpan), cFanZ],
            [round2(bounds.maxX + 0.1), clampExteriorExitY(bounds.maxX + 0.1, cFanZ, exPlenumY, exHalfSpan), cFanZ],
          )
          rawBathTargets.sort(
            (a, b) =>
              Math.hypot(a[0] - fanX, a[2] - fanZ) - Math.hypot(b[0] - fanX, b[2] - fanZ),
          )
        }
        const exRouteMaxY = exCappedBelowSlab
          ? exSoffitCapY
          : exMaxY !== undefined && exMaxY > 0
            ? exMaxY
            : undefined
        let exRoute = routeHvacDuctRun({
          from: fanPos,
          to: rawBathTargets[0]!,
          plenumY: exPlenumY,
          maxPlenumY: exRouteMaxY,
          ductHalfSpanM: exHalfSpan,
          allowDiagonalBranch: false,
          obstacles,
          roofEnvelope: atticRoof,
          footprintContains,
          interiorCorridorSpines,
        })
        if (exRoute.clashes.length > 0) {
          for (let ei = 1; ei < rawBathTargets.length; ei++) {
            const cand = routeHvacDuctRun({
              from: fanPos,
              to: rawBathTargets[ei]!,
              plenumY: exPlenumY,
              maxPlenumY: exRouteMaxY,
              ductHalfSpanM: exHalfSpan,
              allowDiagonalBranch: false,
              obstacles,
              roofEnvelope: atticRoof,
              footprintContains,
              interiorCorridorSpines,
            })
            if (cand.clashes.length < exRoute.clashes.length) {
              exRoute = cand
              if (cand.clashes.length === 0) break
            }
          }
        }
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
          insulationR: effectiveDuctR(exRoute.path),
          sourceNodeId: fanId,
          showFramingClearances: true,
        })
      } else if (room.category === 'kitchen') {
        const hoodId = nextEqId()
        const hoodCfm = Math.max(250, ventilation.kitchenExhaustCfm)
        const hoodSized = sizeDuctForCfm({
          cfm: hoodCfm,
          shape: 'round',
          material: 'galvanized-sheet',
          occupancy,
        })
        const hoodDiam = Math.max(6, hoodSized.diameterIn)
        const hoodHalfSpan = Math.max(0.08, (hoodDiam * 0.0254) / 2)
        const hoodMaxY = maxPlenumYFor(hoodHalfSpan)
        const hoodCappedBelowSlab =
          plenumLocation === 'conditioned-soffit' || !roofEnvelope.hasRoofAbove || systemType === 'rooftop-package'
        const hoodSoffitCapY = round2(levelH - Math.max(0.16, hoodHalfSpan + 0.06))
        const hoodY = round2(Math.min(levelH - 0.5, 1.78))
        const rawHoodPlenumY = hoodCappedBelowSlab
          ? hoodSoffitCapY
          : round2(levelH + ceilingJoistClearM + hoodHalfSpan + 0.04)
        const hoodPlenumY = hoodCappedBelowSlab
          ? rawHoodPlenumY
          : hoodMaxY !== undefined && plenumLocation === 'attic'
            ? Math.min(rawHoodPlenumY, hoodMaxY)
            : rawHoodPlenumY
        const hoodRes = findClearSpotForRiser({
          baseX: room.centroid[0],
          baseZ: room.centroid[1],
          y0: round2(hoodY + 0.25),
          y1: hoodPlenumY,
          clashSpan: hoodHalfSpan,
          obstacles,
          bounds,
          minFloorClearanceM: 0.35,
          insidePolygon: room.polygon,
        })
        const [hoodX, hoodZ] = hoodRes.spot
        const hoodPos: Vec3 = [hoodX, hoodY, hoodZ]
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
        const hoodFrom: Vec3 = [hoodPos[0], round2(hoodPos[1] + 0.25), hoodPos[2]]
        const cHoodX = clampToSpan(hoodX, wallMinX, wallMaxX)
        const cHoodZ = clampToSpan(hoodZ, wallMinZ, wallMaxZ)
        const hoodTargets: Vec3[] = []
        if (walls.length > 0) {
          const hoodWallSnaps = findNearestExteriorWallPoints({
            origin: [hoodX, hoodZ],
            walls,
            rooms: rawRooms,
            outwardOffsetM: 0.1,
            cornerInsetM: 0.35,
            extraOffsetsM: [],
          })
          for (const snap of hoodWallSnaps.slice(0, 4)) {
            hoodTargets.push([
              snap.point[0],
              clampExteriorExitY(snap.point[0], snap.point[1], hoodPlenumY, hoodHalfSpan),
              snap.point[1],
            ])
          }
        }
        if (hoodTargets.length === 0) {
          hoodTargets.push(
            [cHoodX, clampExteriorExitY(cHoodX, bounds.minZ - 0.1, hoodPlenumY, hoodHalfSpan), round2(bounds.minZ - 0.1)],
            [cHoodX, clampExteriorExitY(cHoodX, bounds.maxZ + 0.1, hoodPlenumY, hoodHalfSpan), round2(bounds.maxZ + 0.1)],
            [round2(bounds.minX - 0.1), clampExteriorExitY(bounds.minX - 0.1, cHoodZ, hoodPlenumY, hoodHalfSpan), cHoodZ],
            [round2(bounds.maxX + 0.1), clampExteriorExitY(bounds.maxX + 0.1, cHoodZ, hoodPlenumY, hoodHalfSpan), cHoodZ],
          )
          hoodTargets.sort(
            (a, b) =>
              Math.hypot(a[0] - hoodX, a[2] - hoodZ) - Math.hypot(b[0] - hoodX, b[2] - hoodZ),
          )
        }
        const hoodRouteMaxY = hoodCappedBelowSlab
          ? hoodSoffitCapY
          : hoodMaxY !== undefined && hoodMaxY > 0
            ? hoodMaxY
            : undefined
        let hoodRoute = routeHvacDuctRun({
          from: hoodFrom,
          to: hoodTargets[0]!,
          plenumY: hoodPlenumY,
          maxPlenumY: hoodRouteMaxY,
          ductHalfSpanM: hoodHalfSpan,
          allowDiagonalBranch: false,
          obstacles,
          roofEnvelope: atticRoof,
          footprintContains,
          interiorCorridorSpines,
        })
        if (hoodRoute.clashes.length > 0) {
          for (let hi = 1; hi < hoodTargets.length; hi++) {
            const cand = routeHvacDuctRun({
              from: hoodFrom,
              to: hoodTargets[hi]!,
              plenumY: hoodPlenumY,
              maxPlenumY: hoodRouteMaxY,
              ductHalfSpanM: hoodHalfSpan,
              allowDiagonalBranch: false,
              obstacles,
              roofEnvelope: atticRoof,
              footprintContains,
              interiorCorridorSpines,
            })
            if (cand.clashes.length < hoodRoute.clashes.length) {
              hoodRoute = cand
              if (cand.clashes.length === 0) break
            }
          }
        }
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
          insulationR: effectiveDuctR(hoodRoute.path),
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
