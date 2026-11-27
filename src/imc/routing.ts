/**
 * Priority #3 Trade-Aware 3D HVAC Duct & Refrigerant Lineset Routing Engine (`src/imc/routing.ts`).
 *
 * Jobsite Trade Right-of-Way Hierarchy:
 *   1. Structural (beams, columns, load-bearing headers) — inviolable
 *   2. Plumbing (DWV gravity drains, stacks, vents, water mains, equipment) — gravity first right-of-way
 *   3. HVAC (rigid supply/return trunks, branches, linesets) — yields to 1 & 2, respects NEC 110.26(E)
 *   4. Electrical — yields to 1, 2 & 3
 *
 * Framework-free: zero React, Three.js, or `@pascal-app/*` imports.
 */

import {
  type BuildingAnatomy,
  type CanonicalWall,
  type CavityBand,
  type CavityRouteResult,
  type SceneNodeLike as KernelSceneNodeLike,
  type LegalCavityGraph,
  type LevelFootprintModel,
  type OccupancyObstacle,
  type OrientedPrismY,
  TradeOccupancyGrid,
  compileBuildingAnatomy,
  compileLegalCavityGraph,
  compileLevelFootprint,
  compileLevelRoofShell,
  compareLevelsVertically as kernelCompareLevelsVertically,
  countPathElbows as kernelCountPathElbows,
  distancePointToSegment2D as kernelDistancePointToSegment2D,
  extractBaseRoomPolygons,
  extractLevelOpeningPrisms,
  extractTradeOccupancyObstacles,
  isHighestWalledLevelInBuilding,
  pointInPolygon2D as kernelPointInPolygon2D,
  polygonAreaAndCentroid as kernelPolygonAreaAndCentroid,
  polylineLengthM as kernelPolylineLengthM,
  resolveLevelBuildingId as kernelResolveLevelBuildingId,
  resolveLevelHeightM as kernelResolveLevelHeightM,
  resolveLowerWalledLevelsSummary,
  routeInLegalCavities,
  segmentIntersectsAabb3,
  segmentIntersectsOrientedPrismY,
} from '@kruschdev/pascal-mep-kernel'
import {
  type DuctFramingClearance,
  type SceneNodeLike,
  type Vec3,
  belongsToLevel,
  computeDuctFramingClearances,
  extractHvacFramingContext,
  resolveNodeLevelId,
} from './framing-interop'
import { IMC_RULE_THRESHOLDS } from './rules'
import { type DuctShape, METERS_TO_FEET, SQM_TO_SQFT, round2 } from './tables'

export type Aabb3 = {
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

export type HvacObstacle = {
  id: string
  nodeId?: string
  category: 'structural' | 'plumbing' | 'electrical-dedicated-space' | 'electrical-working-space'
  label: string
  box: Aabb3
  prism?: OrientedPrismY
}

export type DuctClashMargin = number | { horizontal: number; vertical: number }

export type WallSegment2D = {
  id: string
  start: readonly [number, number]
  end: readonly [number, number]
  lengthM: number
  thicknessM: number
  heightM: number
  ux: number
  uz: number
  nx: number
  nz: number
}

export type RoomPolygon2D = {
  id: string
  name: string
  category:
    | 'living'
    | 'bedroom'
    | 'kitchen'
    | 'bathroom'
    | 'hallway'
    | 'utility'
    | 'closet'
    | 'laundry'
    | 'office'
    | 'garage'
    | 'exterior'
    | 'attic'
    | 'other'
  polygon: ReadonlyArray<readonly [number, number]>
  centroid: readonly [number, number]
  areaSqm: number
  areaSqft: number
}

export function polylineLengthM(path: ReadonlyArray<Vec3>): number {
  return kernelPolylineLengthM(path)
}

export function countPathElbows(path: ReadonlyArray<Vec3>): { elbows90: number; elbows45: number } {
  return kernelCountPathElbows(path)
}

const wallCache = new WeakMap<Readonly<Record<string, SceneNodeLike>>, Map<string, WallSegment2D[]>>()

export function extractWallSegments(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  levelId: string | null = null,
): WallSegment2D[] {
  const key = levelId ?? '__all__'
  let byLevel = wallCache.get(nodes)
  if (!byLevel) {
    byLevel = new Map()
    wallCache.set(nodes, byLevel)
  }
  const cached = byLevel.get(key)
  if (cached) return cached

  const walls: WallSegment2D[] = []
  for (const n of Object.values(nodes)) {
    if (n.type !== 'wall' || !belongsToLevel(nodes, n, levelId)) continue
    if (!Array.isArray(n.start) || !Array.isArray(n.end)) continue
    const sx = Number(n.start[0])
    const sz = Number(n.start[1])
    const ex = Number(n.end[0])
    const ez = Number(n.end[1])
    const len = Math.hypot(ex - sx, ez - sz)
    if (len < 0.1) continue
    const ux = (ex - sx) / len
    const uz = (ez - sz) / len
    walls.push({
      id: n.id,
      start: [sx, sz],
      end: [ex, ez],
      lengthM: len,
      thicknessM: typeof n.thickness === 'number' && n.thickness > 0 ? n.thickness : 0.14,
      heightM: typeof n.height === 'number' && n.height > 0 ? n.height : 2.6,
      ux,
      uz,
      nx: -uz,
      nz: ux,
    })
  }
  byLevel.set(key, walls)
  return walls
}

export function classifyHvacRoomName(name: string): RoomPolygon2D['category'] {
  const s = name.toLowerCase()
  if (
    /bath|powder|restroom|\bwc\b|toilet|salle\s+de\s+bains?|salle\s+d['’]eau|\bsdb\b|ba[nñ]o|badezimmer/.test(s)
  ) {
    return 'bathroom'
  }
  if (/attic|combles|grenier/.test(s)) return 'attic'
  if (/garage|carport/.test(s)) return 'garage'
  if (
    /exterior|outdoor|pool|swimming|piscine|piscina|patio|deck|porch|balcon|terrasse|terrace|lanai|v[eé]randa|yard|garden|jardin|courtyard|driveway/.test(
      s,
    )
  ) {
    return 'exterior'
  }
  if (/utility|mech|furnace|local\s+tech|chaufferie/.test(s)) {
    return 'utility'
  }
  if (/closet|storage|dressing|placard|rangement|d[eé]barras|pantry|cellier/.test(s)) {
    return 'closet'
  }
  if (/laundry|mudroom|buanderie|lingerie|lavander[ií]a/.test(s)) return 'laundry'
  if (/kitchen|kicthen|cuisine|cocina|k[uü]che/.test(s)) return 'kitchen'
  if (/hall|corridor|foyer|entry|entrance|entr[eé]e|couloir|d[eé]gagement/.test(s)) return 'hallway'
  if (/office|study|den|bureau/.test(s)) return 'office'
  if (/bed|master|primary|nursery|guest|chambre|dormitorio|schlafzimmer/.test(s)) return 'bedroom'
  if (/living|great|family|dining|open|suite|conference|s[eé]jour|salon|salle\s+[aà]\s+manger|wohnzimmer/.test(s)) {
    return 'living'
  }
  return 'other'
}

export function pointInPolygon2D(
  px: number,
  pz: number,
  polygon: ReadonlyArray<readonly [number, number]>,
): boolean {
  return kernelPointInPolygon2D(px, pz, polygon)
}

export function polygonAreaAndCentroid(
  polygon: ReadonlyArray<readonly [number, number]>,
): { areaSqm: number; centroid: readonly [number, number] } {
  if (polygon.length < 3) return { areaSqm: 0, centroid: [0, 0] }
  const { areaSqM, centroid } = kernelPolygonAreaAndCentroid(polygon)
  return { areaSqm: areaSqM < 1e-4 ? 0 : areaSqM, centroid }
}

const roomPolyCache = new WeakMap<
  Readonly<Record<string, SceneNodeLike>>,
  Map<string, RoomPolygon2D[]>
>()

export function extractRoomPolygons(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  levelId: string | null = null,
): RoomPolygon2D[] {
  const key = levelId ?? '__all__'
  let byLevel = roomPolyCache.get(nodes)
  if (!byLevel) {
    byLevel = new Map()
    roomPolyCache.set(nodes, byLevel)
  }
  const cached = byLevel.get(key)
  if (cached) return cached

  const baseRooms = extractBaseRoomPolygons(
    nodes as Readonly<Record<string, KernelSceneNodeLike>>,
    levelId,
  )
  const rooms: RoomPolygon2D[] = baseRooms.map((r) => {
    const fromCat = r.rawCategory ? classifyHvacRoomName(r.rawCategory) : 'other'
    const category = fromCat !== 'other' ? fromCat : classifyHvacRoomName(r.name)
    const areaSqm = r.areaSqM < 1e-4 ? 0 : r.areaSqM
    return {
      id: r.id,
      name: r.name,
      category,
      polygon: r.polygon,
      centroid: r.centroid,
      areaSqm: round2(areaSqm),
      areaSqft: round2(areaSqm * SQM_TO_SQFT),
    }
  })
  byLevel.set(key, rooms)
  return rooms
}

export function resolveLevelHeightM(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  levelId: string | null = null,
): number {
  return kernelResolveLevelHeightM(
    nodes as Readonly<Record<string, KernelSceneNodeLike>>,
    levelId,
    { minClampM: 2.2 },
  )
}

export type XzBounds2D = {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

export function resolveLevelBuildingId(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  lvl: SceneNodeLike | undefined,
): string | null {
  return kernelResolveLevelBuildingId(
    nodes as Readonly<Record<string, KernelSceneNodeLike>>,
    lvl as KernelSceneNodeLike | undefined,
  )
}

/**
 * Compare two sibling levels vertically.
 * Prioritizes Pascal's storey ordinal (`level`) before `elevation` / `baseElevation`
 * because every Pascal level carries `baseElevation: 0` by default (additive offset above stacked base).
 */
export function compareLevelsVertically(a: SceneNodeLike | undefined, b: SceneNodeLike | undefined): number {
  return kernelCompareLevelsVertically(
    a as KernelSceneNodeLike | undefined,
    b as KernelSceneNodeLike | undefined,
  )
}

export type LowerWalledLevelsInfo = {
  cumulativeBelowHeightM: number
  lowerLevelIds: string[]
  groundLevelId: string | null
  groundWalls: WallSegment2D[]
  groundRooms: RoomPolygon2D[]
  allLowerWalls: WallSegment2D[]
}

/**
 * Resolve all walled sibling levels strictly below `levelId` in the same building (sorted lowest-first).
 * Computes `cumulativeBelowHeightM` (sum of above-grade lower storey heights) and extracts the lowest
 * walled ground-level walls/rooms so upper-story outdoor condensers sit at `worldY = 0` outside ground walls.
 */
export function resolveLowerWalledLevels(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  levelId: string | null,
): LowerWalledLevelsInfo {
  const summary = resolveLowerWalledLevelsSummary(
    nodes as Readonly<Record<string, KernelSceneNodeLike>>,
    levelId,
  )
  if (summary.lowerLevelIds.length === 0 || !summary.groundLevelId) {
    return {
      cumulativeBelowHeightM: 0,
      lowerLevelIds: [],
      groundLevelId: null,
      groundWalls: [],
      groundRooms: [],
      allLowerWalls: [],
    }
  }

  const lowerLevelIds = [...summary.lowerLevelIds]
  const allLowerWalls: WallSegment2D[] = []
  for (const lid of lowerLevelIds) {
    allLowerWalls.push(...extractWallSegments(nodes, lid))
  }
  return {
    cumulativeBelowHeightM: round2(summary.cumulativeBelowHeightM),
    lowerLevelIds,
    groundLevelId: summary.groundLevelId,
    groundWalls: extractWallSegments(nodes, summary.groundLevelId),
    groundRooms: extractRoomPolygons(nodes, summary.groundLevelId),
    allLowerWalls,
  }
}

export function distancePointToSegment2D(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): { dist: number; t: number; closestX: number; closestZ: number } {
  const dx = bx - ax
  const dz = bz - az
  const lenSq = dx * dx + dz * dz
  const dist = kernelDistancePointToSegment2D(px, pz, ax, az, bx, bz)
  if (lenSq < 1e-10) {
    return { dist, t: 0, closestX: ax, closestZ: az }
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq))
  return { dist, t, closestX: ax + dx * t, closestZ: az + dz * t }
}

const wallFootprintModelCache = new WeakMap<
  ReadonlyArray<WallSegment2D>,
  { len: number; model: LevelFootprintModel }
>()

const roomPolygonPartitionCache = new WeakMap<
  ReadonlyArray<RoomPolygon2D>,
  {
    len: number
    interiorPolygons: readonly (readonly [number, number])[][]
    outdoorPolygons: readonly (readonly [number, number])[][]
  }
>()

function getFootprintModelForWalls(walls: ReadonlyArray<WallSegment2D>): LevelFootprintModel {
  const cached = wallFootprintModelCache.get(walls)
  if (cached && cached.len === walls.length) return cached.model
  const canonicalWalls: CanonicalWall[] = walls.map((w) => ({
    id: w.id,
    levelId: null,
    start: w.start,
    end: w.end,
    lengthM: w.lengthM,
    ux: w.ux,
    uz: w.uz,
    nx: w.nx,
    nz: w.nz,
    heightM: w.heightM,
    thicknessM: w.thicknessM,
    visible: true,
    openings: [],
  }))
  const model = compileLevelFootprint({}, null, canonicalWalls)
  wallFootprintModelCache.set(walls, { len: walls.length, model })
  return model
}

function getPartitionedRoomPolygons(rooms: ReadonlyArray<RoomPolygon2D>): {
  interiorPolygons: readonly (readonly [number, number])[][]
  outdoorPolygons: readonly (readonly [number, number])[][]
} {
  const cached = roomPolygonPartitionCache.get(rooms)
  if (cached && cached.len === rooms.length) return cached
  const interiorPolygons: (readonly [number, number])[][] = []
  const outdoorPolygons: (readonly [number, number])[][] = []
  for (const r of rooms) {
    if (r.category === 'exterior') outdoorPolygons.push(r.polygon as (readonly [number, number])[])
    else interiorPolygons.push(r.polygon as (readonly [number, number])[])
  }
  const entry = { len: rooms.length, interiorPolygons, outdoorPolygons }
  roomPolygonPartitionCache.set(rooms, entry)
  return entry
}

/**
 * Strict interior enclosure test (no exterior wall-proximity padding) used for classifying
 * interior vs exterior faces of walls (e.g., ERV fresh-air intake snapping on L/U-shaped buildings).
 */
export function isPointStrictlyInsideBuilding(
  x: number,
  z: number,
  walls: ReadonlyArray<WallSegment2D>,
  rooms: ReadonlyArray<RoomPolygon2D>,
): boolean {
  const model = getFootprintModelForWalls(walls)
  const { interiorPolygons, outdoorPolygons } = getPartitionedRoomPolygons(rooms)
  return model.isPointInside(x, z, {
    precedence: 'room-first',
    wallToleranceM: 0,
    interiorPolygons,
    outdoorPolygons,
  })
}

/**
 * Building footprint enclosure predicate for duct routing & concave courtyard avoidance:
 * true if inside any non-exterior room polygon, OR enclosed by walls in all directions,
 * OR within `wallProximityM` (default 0.45m) of an actual wall segment (while still rejecting
 * explicit exterior zones like Swimming Pools / Courtyards).
 */
export function isPointInsideBuildingFootprint(
  x: number,
  z: number,
  walls: ReadonlyArray<WallSegment2D>,
  rooms: ReadonlyArray<RoomPolygon2D>,
  wallProximityM = 0.45,
): boolean {
  const model = getFootprintModelForWalls(walls)
  const { interiorPolygons, outdoorPolygons } = getPartitionedRoomPolygons(rooms)
  return model.isPointInside(x, z, {
    precedence: 'room-first',
    wallToleranceM: wallProximityM,
    interiorPolygons,
    outdoorPolygons,
  })
}

/**
 * Check whether an XZ duct segment crosses an open outdoor void (such as a concave U-shaped courtyard
 * or L-shaped front yard notch) by sampling every `stepM` meters along the segment.
 */
export function segmentCrossesOutdoorVoid(
  a: Vec3,
  b: Vec3,
  isInside: (x: number, z: number) => boolean,
  stepM = 0.5,
): boolean {
  const dx = b[0] - a[0]
  const dz = b[2] - a[2]
  const dh = Math.hypot(dx, dz)
  if (dh < 0.25) return false
  const aInside = isInside(a[0], a[2])
  const bInside = isInside(b[0], b[2])
  const steps = Math.max(2, Math.ceil(dh / Math.max(0.1, stepM)))
  for (let i = 1; i < steps; i++) {
    const t = i / steps
    const distFromA = t * dh
    const distFromB = (1 - t) * dh
    if (!aInside && distFromA <= 0.35) continue
    if (!bInside && distFromB <= 0.35) continue
    const px = a[0] + dx * t
    const pz = a[2] + dz * t
    if (!isInside(px, pz)) return true
  }
  return false
}

export function pathCrossesOutdoorVoid(
  path: ReadonlyArray<Vec3>,
  isInside: (x: number, z: number) => boolean,
  stepM = 0.5,
): boolean {
  for (let i = 1; i < path.length; i++) {
    if (segmentCrossesOutdoorVoid(path[i - 1]!, path[i]!, isInside, stepM)) return true
  }
  return false
}

export type ExteriorWallSnapCandidate = {
  wallId: string
  point: readonly [number, number]
  wallCenter: readonly [number, number]
  interiorBack: readonly [number, number]
  outwardNormal: readonly [number, number]
  dist: number
  interiorPathClear: boolean
}

/**
 * Find real exterior wall penetration points nearest to `origin` (for ERV fresh-air intakes & exhausts).
 * Classifies each wall's true exterior side by probing interior enclosure on both normals, projects
 * `origin` onto each exterior wall clamped `cornerInsetM` from corners, and offsets `outwardOffsetM`
 * along the verified outward normal.
 */
export function findNearestExteriorWallPoints(params: {
  origin: readonly [number, number]
  walls: ReadonlyArray<WallSegment2D>
  rooms: ReadonlyArray<RoomPolygon2D>
  outwardOffsetM?: number
  cornerInsetM?: number
  extraOffsetsM?: ReadonlyArray<number>
}): ExteriorWallSnapCandidate[] {
  const {
    origin,
    walls,
    rooms,
    outwardOffsetM = 0.08,
    cornerInsetM = 0.45,
    extraOffsetsM = [1.4, -1.4, 2.8, -2.8],
  } = params
  if (walls.length === 0) return []

  const isInsideFootprint = (x: number, z: number) => isPointInsideBuildingFootprint(x, z, walls, rooms)
  const results: ExteriorWallSnapCandidate[] = []

  for (const w of walls) {
    if (w.lengthM < 0.6) continue
    let plusOutVotes = 0
    let minusOutVotes = 0
    for (const frac of [0.5, 0.25, 0.75]) {
      const wx = w.start[0] + w.ux * w.lengthM * frac
      const wz = w.start[1] + w.uz * w.lengthM * frac
      for (const probeDist of [w.thicknessM / 2 + 0.35, w.thicknessM / 2 + 0.7]) {
        const plusIn = isPointStrictlyInsideBuilding(wx + w.nx * probeDist, wz + w.nz * probeDist, walls, rooms)
        const minusIn = isPointStrictlyInsideBuilding(wx - w.nx * probeDist, wz - w.nz * probeDist, walls, rooms)
        if (!plusIn && minusIn) {
          plusOutVotes += 1
          break
        }
        if (plusIn && !minusIn) {
          minusOutVotes += 1
          break
        }
      }
    }
    if (plusOutVotes === minusOutVotes) continue
    const outSign = plusOutVotes > minusOutVotes ? 1 : -1
    const outNx = w.nx * outSign
    const outNz = w.nz * outSign

    const inset = Math.min(cornerInsetM, w.lengthM * 0.25)
    const projU = (origin[0] - w.start[0]) * w.ux + (origin[1] - w.start[1]) * w.uz
    const baseU = Math.max(inset, Math.min(w.lengthM - inset, projU))

    const uCandidates = [baseU]
    for (const delta of extraOffsetsM) {
      const cu = baseU + delta
      if (cu >= inset && cu <= w.lengthM - inset) {
        uCandidates.push(cu)
      }
    }

    const backOffset = w.thicknessM / 2 + 0.14
    for (const u of uCandidates) {
      const cx = w.start[0] + w.ux * u
      const cz = w.start[1] + w.uz * u
      const px = round2(cx + outNx * outwardOffsetM)
      const pz = round2(cz + outNz * outwardOffsetM)
      const bx = round2(cx - outNx * backOffset)
      const bz = round2(cz - outNz * backOffset)
      const dist = Math.hypot(px - origin[0], pz - origin[1])
      const interiorPathClear = !segmentCrossesOutdoorVoid([origin[0], 0, origin[1]], [bx, 0, bz], isInsideFootprint, 0.5)
      results.push({
        wallId: w.id,
        point: [px, pz],
        wallCenter: [round2(cx), round2(cz)],
        interiorBack: [bx, bz],
        outwardNormal: [outNx, outNz],
        dist,
        interiorPathClear,
      })
    }
  }

  results.sort((a, b) => {
    if (a.interiorPathClear !== b.interiorPathClear) return a.interiorPathClear ? -1 : 1
    return a.dist - b.dist
  })
  return results
}

export type AtticRoofEnvelope = {
  wallH: number
  pitchRiseOver12: number
  ridgeAlongX: boolean
  center: number
  halfSpan: number
  bounds: XzBounds2D
  hasRoofAbove: boolean
  isFlatRoof: boolean
  ridgeY: number
  eaveY: number
  roofYAt: (x: number, z: number) => number
}

/**
 * Compute the pitched attic roof plane `roofYAt(x, z)` via `@kruschdev/pascal-mep-kernel`'s
 * `compileLevelRoofShell` (full cycle-safe nested `roof` parent transforms + 7 roof types,
 * tightened to explicit `roof-segment` nodes on the target or adopted wall-less roof level).
 */
export function buildAtticRoofEnvelope(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  levelId: string | null,
  bounds: XzBounds2D,
  wallH: number,
): AtticRoofEnvelope {
  const kernelNodes = nodes as Readonly<Record<string, KernelSceneNodeLike>>
  const shell = compileLevelRoofShell(kernelNodes, levelId, wallH, {
    wallBounds: bounds,
    clampOverhangToEave: true,
    footprintPadM: 0.15,
  })
  const hasRoofAbove = isHighestWalledLevelInBuilding(kernelNodes, levelId)
  const pitchRiseOver12 = shell.isFlatRoof
    ? 0
    : shell.fallbackPitchRiseOver12 > 0
      ? shell.fallbackPitchRiseOver12
      : 6

  const spanX = Math.max(0.5, bounds.maxX - bounds.minX)
  const spanZ = Math.max(0.5, bounds.maxZ - bounds.minZ)
  const ridgeAlongX = spanX >= spanZ
  const halfSpan = (ridgeAlongX ? spanZ : spanX) / 2
  const center = ridgeAlongX ? (bounds.minZ + bounds.maxZ) / 2 : (bounds.minX + bounds.maxX) / 2
  const eaveY =
    shell.segments.length > 0 ? Math.min(...shell.segments.map((s) => s.eaveY)) : wallH

  const roofYAt = (x: number, z: number): number => {
    const distFromRidge = Math.abs((ridgeAlongX ? z : x) - center)
    const fallbackY = wallH + Math.max(0, halfSpan - distFromRidge) * (pitchRiseOver12 / 12)
    const explicitY = shell.roofSurfaceY(x, z)
    if (explicitY !== null) return Math.min(fallbackY, explicitY)
    return fallbackY
  }

  return {
    wallH,
    pitchRiseOver12,
    ridgeAlongX,
    center,
    halfSpan,
    bounds,
    hasRoofAbove,
    isFlatRoof: shell.isFlatRoof,
    ridgeY: shell.maxRidgeY,
    eaveY,
    roofYAt,
  }
}

/**
 * Evaluate the minimum roof surface height across the center and all 4 XZ corners of an attic
 * equipment cabinet or plenum footprint so sloping hip/gable rafters never clip the box corners.
 */
export function minRoofYOverFootprint(
  roof: AtticRoofEnvelope,
  cx: number,
  cz: number,
  halfW: number,
  halfD: number,
): number {
  const hw = Math.max(0, halfW)
  const hd = Math.max(0, halfD)
  if (hw < 0.01 && hd < 0.01) return roof.roofYAt(cx, cz)
  return Math.min(
    roof.roofYAt(cx, cz),
    roof.roofYAt(cx - hw, cz - hd),
    roof.roofYAt(cx + hw, cz - hd),
    roof.roofYAt(cx - hw, cz + hd),
    roof.roofYAt(cx + hw, cz + hd),
  )
}

export function safeRoofCorridorHalfWidth(
  roof: AtticRoofEnvelope,
  y: number,
  halfH: number,
  clearanceM = 0.08,
): number {
  if (roof.isFlatRoof) return 0
  const slope = roof.pitchRiseOver12 / 12
  if (slope <= 1e-4) return 0
  const neededRise = y + halfH + clearanceM - roof.wallH
  if (neededRise <= 0) return roof.halfSpan
  return Math.max(0, roof.halfSpan - neededRise / slope)
}

export function pathClearOfRoof(
  path: ReadonlyArray<Vec3>,
  roof: AtticRoofEnvelope,
  halfH: number,
  clearanceM = 0.14,
  ductHalfWidthM = 0,
): boolean {
  if (!roof.hasRoofAbove) return true
  const { bounds, wallH, roofYAt } = roof
  const hw = Math.max(0, ductHalfWidthM)
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!
    const b = path[i + 1]!
    const segLen = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    if (segLen < 0.02) continue
    const steps = Math.max(4, Math.ceil(segLen / 0.45))
    for (let s = 0; s <= steps; s++) {
      const f = s / steps
      const px = a[0] + (b[0] - a[0]) * f
      const py = a[1] + (b[1] - a[1]) * f
      const pz = a[2] + (b[2] - a[2]) * f
      if (px < bounds.minX - 0.1 || px > bounds.maxX + 0.1 || pz < bounds.minZ - 0.1 || pz > bounds.maxZ + 0.1) {
        continue
      }
      if (py > wallH + 0.05) {
        const minRoofY = hw > 0.02 ? minRoofYOverFootprint(roof, px, pz, hw, hw) : roofYAt(px, pz)
        if (py + halfH > minRoofY - clearanceM) {
          return false
        }
      }
    }
  }
  return true
}

const obstacleCache = new WeakMap<
  Readonly<Record<string, SceneNodeLike>>,
  Map<string, HvacObstacle[]>
>()

function mapOccupancyCategory(
  kind: OccupancyObstacle['kind'],
  trade: OccupancyObstacle['trade'],
): HvacObstacle['category'] {
  if (kind === 'electrical-dedicated-space') return 'electrical-dedicated-space'
  if (kind === 'electrical-working-space') return 'electrical-working-space'
  if (trade === 'structural') return 'structural'
  return 'plumbing'
}

/**
 * Extract Priority #1 Structural obstacles, Priority #2 Plumbing obstacles (`plumbing:pipe-run`,
 * `plumbing:equipment`, `plumbing:manifold`), AND NEC 110.26(A)/(E) Electrical Space prisms
 * via `@kruschdev/pascal-mep-kernel`'s `extractTradeOccupancyObstacles`.
 * WeakMap-memoized per scene nodes object reference.
 */
export function extractHvacObstacles(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  levelId: string | null = null,
): HvacObstacle[] {
  const key = levelId ?? '__all__'
  let byLevel = obstacleCache.get(nodes)
  if (!byLevel) {
    byLevel = new Map()
    obstacleCache.set(nodes, byLevel)
  }
  const cached = byLevel.get(key)
  if (cached) return cached

  const rawObstacles = extractTradeOccupancyObstacles(
    nodes as Readonly<Record<string, KernelSceneNodeLike>>,
    levelId,
    {
      forTrade: 'hvac',
      includeElectricalWorkingSpace: true,
    },
  )

  const obstacles: HvacObstacle[] = []
  for (const obs of rawObstacles) {
    const category = mapOccupancyCategory(obs.kind, obs.trade)

    // Subdivide diagonal structural beams along their exact OrientedPrismY centerline into tight
    // sub-AABBs (`<id>:seg<n>`, deduplicated by `nodeId`) for backwards-compatibility (BUG-06 / HVC-05).
    if (obs.kind === 'structural-beam' && obs.prism) {
      const p = obs.prism
      const len = p.lxMax - p.lxMin
      const sx = p.centerX + p.lxMin * p.cos
      const sz = p.centerZ + p.lxMin * p.sin
      const ex = p.centerX + p.lxMax * p.cos
      const ez = p.centerZ + p.lxMax * p.sin
      const dx = Math.abs(ex - sx)
      const dz = Math.abs(ez - sz)
      if (dx > 0.2 && dz > 0.2) {
        const halfW = (p.lzMax - p.lzMin) / 2
        const steps = Math.min(8, Math.max(3, Math.ceil(len / 0.5)))
        for (let s = 0; s < steps; s++) {
          const t0 = s / steps
          const t1 = (s + 1) / steps
          const x0 = sx + (ex - sx) * t0
          const z0 = sz + (ez - sz) * t0
          const x1 = sx + (ex - sx) * t1
          const z1 = sz + (ez - sz) * t1
          obstacles.push({
            id: `${obs.nodeId}:seg${s}`,
            nodeId: obs.nodeId,
            category,
            label: obs.label,
            box: {
              minX: Math.min(x0, x1) - halfW,
              maxX: Math.max(x0, x1) + halfW,
              minY: p.yMin,
              maxY: p.yMax,
              minZ: Math.min(z0, z1) - halfW,
              maxZ: Math.max(z0, z1) + halfW,
            },
          })
        }
        continue
      }
    }

    obstacles.push({
      id: obs.id,
      nodeId: obs.nodeId,
      category,
      label: obs.label,
      box: {
        minX: obs.aabb.minX,
        minY: obs.aabb.minY,
        minZ: obs.aabb.minZ,
        maxX: obs.aabb.maxX,
        maxY: obs.aabb.maxY,
        maxZ: obs.aabb.maxZ,
      },
      ...(obs.prism ? { prism: obs.prism } : {}),
    })
  }

  byLevel.set(key, obstacles)
  return obstacles
}

export function segmentIntersectsAabb(
  a: Vec3,
  b: Vec3,
  box: Aabb3,
  margin: number | readonly [number, number, number] = 0.03,
): boolean {
  return segmentIntersectsAabb3(a, b, box, margin)
}

export function detectHvacClashes(
  path: ReadonlyArray<Vec3>,
  obstacles: ReadonlyArray<HvacObstacle>,
  ductHalfSpanM: DuctClashMargin = 0.08,
): HvacObstacle[] {
  const margin3: readonly [number, number, number] =
    typeof ductHalfSpanM === 'number'
      ? [ductHalfSpanM + 0.02, ductHalfSpanM + 0.02, ductHalfSpanM + 0.02]
      : [ductHalfSpanM.horizontal + 0.02, ductHalfSpanM.vertical + 0.02, ductHalfSpanM.horizontal + 0.02]
  const hits: HvacObstacle[] = []
  const seen = new Set<string>()
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!
    const b = path[i]!
    for (const obs of obstacles) {
      const obsKey = obs.nodeId ?? obs.id
      if (seen.has(obsKey)) continue
      const hit = obs.prism
        ? segmentIntersectsOrientedPrismY(a, b, obs.prism, margin3)
        : segmentIntersectsAabb(a, b, obs.box, margin3)
      if (hit) {
        seen.add(obsKey)
        hits.push(obs)
      }
    }
  }
  return hits
}

function cleanPath(pts: Vec3[]): Vec3[] {
  const r4 = (v: number) => Math.round(v * 10000) / 10000
  const out: Vec3[] = []
  for (const p of pts) {
    const prev = out[out.length - 1]
    if (!prev || Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]) > 0.01) {
      out.push([r4(p[0]), r4(p[1]), r4(p[2])])
    }
  }
  return out
}

export type HvacLegalCavityContext = {
  readonly anatomy: BuildingAnatomy
  readonly levelId: string | null
  readonly occupancy: TradeOccupancyGrid
  readonly graphCache: Map<string, LegalCavityGraph>
  readonly outdoorPolygons?: readonly (readonly (readonly [number, number])[])[]
  readonly interiorPolygons?: readonly (readonly (readonly [number, number])[])[]
}

/**
 * Extract all 3D door & window opening keepout prisms on a building level via
 * `@kruschdev/pascal-mep-kernel`'s `compileBuildingAnatomy` + `extractLevelOpeningPrisms`.
 */
export function extractHvacOpeningPrisms(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  levelId: string | null = null,
) {
  const anatomy = compileBuildingAnatomy(nodes as Readonly<Record<string, KernelSceneNodeLike>>)
  return extractLevelOpeningPrisms(anatomy.getWalls(levelId))
}

/**
 * Compile (or reuse) a shared Layer 2 `HvacLegalCavityContext` holding WeakMap-cached
 * `BuildingAnatomy`, a mutable `TradeOccupancyGrid` for cross-trade & dual-wing reservation,
 * and a per-context `LegalCavityGraph` cache (`INV-MEP-06`, `INV-MEP-07`).
 */
export function createHvacLegalCavityContext(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  levelId: string | null = null,
  opts: {
    readonly anatomy?: BuildingAnatomy
    readonly occupancy?: TradeOccupancyGrid
    readonly rooms?: ReadonlyArray<RoomPolygon2D>
  } = {},
): HvacLegalCavityContext {
  const kernelNodes = nodes as Readonly<Record<string, KernelSceneNodeLike>>
  const anatomy = opts.anatomy ?? compileBuildingAnatomy(kernelNodes)
  const occupancy =
    opts.occupancy ??
    anatomy.createOccupancyGrid(levelId, {
      forTrade: 'hvac',
      includeElectricalWorkingSpace: true,
    })
  const rooms = opts.rooms ?? extractRoomPolygons(nodes, levelId)
  const { interiorPolygons, outdoorPolygons } = getPartitionedRoomPolygons(rooms)
  return {
    anatomy,
    levelId,
    occupancy,
    graphCache: new Map<string, LegalCavityGraph>(),
    ...(outdoorPolygons.length > 0 ? { outdoorPolygons } : {}),
    ...(interiorPolygons.length > 0 ? { interiorPolygons } : {}),
  }
}

export type RouteHvacViaLegalCavityParams = {
  /** Scene nodes (used to compile `BuildingAnatomy` when `cavityContext`/`anatomy` is omitted). */
  nodes?: Readonly<Record<string, SceneNodeLike>>
  levelId?: string | null
  /** Optional pre-compiled Layer 2 context for zero-recompilation multi-run batching & reservations. */
  cavityContext?: HvacLegalCavityContext
  anatomy?: BuildingAnatomy
  graph?: LegalCavityGraph
  occupancy?: TradeOccupancyGrid
  from: Vec3
  to: Vec3
  /** Routing physics mode: `'orthogonal'` for HVAC ducts/linesets, `'gravity-slope'` for condensate drains. */
  mode?: 'orthogonal' | 'gravity-slope'
  ductHalfSpanM?: DuctClashMargin
  clearanceM?: number
  plenumLocation?: 'attic' | 'conditioned-soffit' | 'crawlspace' | 'basement'
  allowedBands?: readonly CavityBand[]
  atticElevationM?: number
  flatSoffitMarginM?: number
  roofClearanceM?: number
  minSlopeInPerFt?: number
  preferWallFollowing?: boolean
  reserveOnCommit?: boolean
  runId?: string
  ignoreObstacleNodeIds?: ReadonlySet<string>
  extraObstacles?: ReadonlyArray<HvacObstacle>
  outdoorPolygons?: readonly (readonly (readonly [number, number])[])[]
  interiorPolygons?: readonly (readonly (readonly [number, number])[])[]
}

let nextHvacCavityRunSeq = 1

function polygonListSignature(
  polys?: readonly (readonly (readonly [number, number])[])[],
): string {
  if (!polys || polys.length === 0) return '0'
  let acc = `${polys.length}:`
  for (let i = 0; i < polys.length; i++) {
    const p = polys[i]!
    acc += `${p.length}@`
    for (let j = 0; j < p.length; j++) {
      const pt = p[j]!
      acc += `${Math.round(pt[0] * 1000) / 1000},${Math.round(pt[1] * 1000) / 1000}`
      if (j + 1 < p.length) acc += ','
    }
    acc += ';'
  }
  return acc
}

/**
 * Layer 2 — Route an HVAC duct, exhaust, refrigerant lineset (`mode: 'orthogonal'`) or
 * gravity-sloped condensate drain (`mode: 'gravity-slope'`) through legal building cavities
 * compiled via `compileLegalCavityGraph` + `routeInLegalCavities` (`trade: 'hvac'`),
 * backed by `TradeOccupancyGrid` (`INV-MEP-06`, `INV-MEP-07`).
 */
export function routeHvacViaLegalCavity(params: RouteHvacViaLegalCavityParams): CavityRouteResult {
  const mode = params.mode ?? 'orthogonal'
  const levelId = params.levelId !== undefined ? params.levelId : (params.cavityContext?.levelId ?? null)
  const sameContextLevel = params.cavityContext !== undefined && levelId === params.cavityContext.levelId
  const kernelNodes = params.nodes as Readonly<Record<string, KernelSceneNodeLike>> | undefined

  const anatomy =
    params.anatomy ??
    params.cavityContext?.anatomy ??
    (kernelNodes ? compileBuildingAnatomy(kernelNodes) : compileBuildingAnatomy({}))

  const baseOccupancy =
    params.occupancy ??
    (sameContextLevel ? params.cavityContext?.occupancy : undefined) ??
    anatomy.createOccupancyGrid(levelId, {
      forTrade: 'hvac',
      includeElectricalWorkingSpace: true,
    })

  let effectiveOccupancy = baseOccupancy
  if (params.extraObstacles && params.extraObstacles.length > 0) {
    const existingKeys = new Set<string>()
    for (const obs of baseOccupancy.obstacles) {
      existingKeys.add(obs.id)
      existingKeys.add(obs.nodeId)
    }
    const missing = params.extraObstacles.filter(
      (o) => !existingKeys.has(o.id) && !(o.nodeId && existingKeys.has(o.nodeId)),
    )
    if (missing.length > 0) {
      effectiveOccupancy = new TradeOccupancyGrid(baseOccupancy.obstacles)
      for (const obs of missing) {
        effectiveOccupancy.reserveBox({
          id: obs.id,
          nodeId: obs.nodeId ?? obs.id,
          trade: obs.category === 'plumbing' ? 'plumbing' : obs.category === 'structural' ? 'structural' : 'electrical',
          kind:
            obs.category === 'electrical-dedicated-space'
              ? 'electrical-dedicated-space'
              : obs.category === 'electrical-working-space'
                ? 'electrical-working-space'
                : obs.category === 'plumbing'
                  ? 'plumbing-equipment'
                  : 'structural-beam',
          aabb: obs.box,
          ...(obs.prism ? { prism: obs.prism } : {}),
          label: obs.label,
        })
      }
    }
  }

  const defaultHalf = mode === 'gravity-slope' ? 0.02 : 0.08
  const halfXZ =
    params.ductHalfSpanM === undefined
      ? defaultHalf
      : typeof params.ductHalfSpanM === 'number'
        ? params.ductHalfSpanM
        : params.ductHalfSpanM.horizontal
  const halfY =
    params.ductHalfSpanM === undefined
      ? defaultHalf
      : typeof params.ductHalfSpanM === 'number'
        ? params.ductHalfSpanM
        : params.ductHalfSpanM.vertical
  const clearanceM = params.clearanceM ?? 0.02
  const roofClearanceM = params.roofClearanceM ?? (mode === 'gravity-slope' ? 0.06 : 0.14)

  let outdoorPolygons =
    params.outdoorPolygons ?? (sameContextLevel ? params.cavityContext?.outdoorPolygons : undefined)
  let interiorPolygons =
    params.interiorPolygons ?? (sameContextLevel ? params.cavityContext?.interiorPolygons : undefined)
  if (!outdoorPolygons && !interiorPolygons && params.nodes) {
    const rooms = extractRoomPolygons(params.nodes, levelId)
    const part = getPartitionedRoomPolygons(rooms)
    if (part.outdoorPolygons.length > 0) outdoorPolygons = part.outdoorPolygons
    if (part.interiorPolygons.length > 0) interiorPolygons = part.interiorPolygons
  }

  const includeSubFloorLayer =
    mode === 'gravity-slope' ||
    params.plenumLocation === 'crawlspace' ||
    params.plenumLocation === 'basement' ||
    params.from[1] < 0 ||
    params.to[1] < 0

  let graph = params.graph
  if (!graph) {
    const cache = params.cavityContext?.graphCache
    const levelKey = levelId ?? '__all__'
    const cacheKey = `${levelKey}|${round2(halfXZ)}|${round2(halfY)}|${params.atticElevationM !== undefined ? round2(params.atticElevationM) : 'auto'}|${params.flatSoffitMarginM !== undefined ? round2(params.flatSoffitMarginM) : 'auto'}|${round2(roofClearanceM)}|${includeSubFloorLayer ? 1 : 0}|${polygonListSignature(interiorPolygons)}|${polygonListSignature(outdoorPolygons)}`
    graph = cache?.get(cacheKey)
    if (!graph) {
      graph = compileLegalCavityGraph(anatomy, levelId, {
        roofClearanceM,
        halfY,
        halfXZ,
        ...(params.atticElevationM !== undefined ? { atticElevationM: params.atticElevationM } : {}),
        ...(params.flatSoffitMarginM !== undefined ? { flatSoffitMarginM: params.flatSoffitMarginM } : {}),
        includeSubFloorLayer,
        ...(outdoorPolygons ? { outdoorPolygons } : {}),
        ...(interiorPolygons ? { interiorPolygons } : {}),
      })
      cache?.set(cacheKey, graph)
    }
  }

  const levelH = graph.levelHeightM
  let allowedBands: readonly CavityBand[]
  if (params.allowedBands && params.allowedBands.length > 0) {
    allowedBands = params.allowedBands
  } else if (mode === 'gravity-slope') {
    allowedBands =
      params.from[1] >= levelH - 0.1
        ? (['attic', 'overhead-plenum', 'top-plate', 'mid-wall', 'under-sill'] as const)
        : (['overhead-plenum', 'mid-wall', 'under-sill', 'under-slab', 'crawlspace'] as const)
  } else if (params.plenumLocation === 'crawlspace' || params.plenumLocation === 'basement') {
    allowedBands = graph.bandsPresent.has('under-slab') || graph.bandsPresent.has('crawlspace')
      ? (['under-slab', 'crawlspace'] as const)
      : (['under-slab', 'crawlspace', 'under-sill', 'mid-wall'] as const)
  } else if (params.plenumLocation === 'conditioned-soffit') {
    allowedBands = graph.bandsPresent.has('overhead-plenum')
      ? (['overhead-plenum'] as const)
      : (['overhead-plenum', 'top-plate', 'mid-wall'] as const)
  } else if (graph.atticY !== null) {
    allowedBands = graph.bandsPresent.has('attic') || graph.bandsPresent.has('overhead-plenum')
      ? (['attic', 'overhead-plenum'] as const)
      : (['attic', 'overhead-plenum', 'top-plate', 'mid-wall'] as const)
  } else {
    allowedBands = graph.bandsPresent.has('overhead-plenum')
      ? (['overhead-plenum'] as const)
      : (['overhead-plenum', 'top-plate', 'mid-wall'] as const)
  }

  const minSlopeInPerFt =
    mode === 'gravity-slope'
      ? Math.max(
          IMC_RULE_THRESHOLDS.condensateMinSlopePlacementInPerFt,
          params.minSlopeInPerFt ?? 0.25,
        )
      : undefined

  const shouldReserve = params.reserveOnCommit === true
  const reserveDirectly = shouldReserve && effectiveOccupancy === baseOccupancy
  const resolvedRunId = params.runId ?? (shouldReserve ? `hvac-cavity-${nextHvacCavityRunSeq++}` : undefined)

  const result = routeInLegalCavities({
    anatomy,
    graph,
    occupancy: effectiveOccupancy,
    request: {
      trade: 'hvac',
      from: params.from,
      to: params.to,
      halfXZ,
      halfY,
      clearanceM,
      allowedBands,
      mode,
      ...(minSlopeInPerFt !== undefined ? { minSlopeInPerFt } : {}),
      roofClearanceM,
      ...(params.preferWallFollowing !== undefined ? { preferWallFollowing: params.preferWallFollowing } : {}),
      reserveOnCommit: reserveDirectly,
      ...(resolvedRunId !== undefined ? { runId: resolvedRunId } : {}),
      ...(params.ignoreObstacleNodeIds ? { ignoreObstacleNodeIds: params.ignoreObstacleNodeIds } : {}),
    },
  })

  if (shouldReserve && effectiveOccupancy !== baseOccupancy && result.path.length >= 2) {
    const reservationId = baseOccupancy.reserveRun({
      runId: resolvedRunId ?? `hvac-cavity-${nextHvacCavityRunSeq++}`,
      trade: 'hvac',
      path: result.path,
      halfXZ,
      halfY,
      clearanceM,
    })
    return { ...result, reservationId }
  }

  return result
}

/**
 * Route an HVAC duct, exhaust run, or refrigerant lineset in the target plenum plane (`attic` / `crawlspace` / `basement`),
 * automatically detouring around Priority #1 Structural, Priority #2 Plumbing, and NEC 110.26(E) panel columns,
 * while staying within `xzBounds` (when provided) and strictly beneath `roofEnvelope` (when routing in an attic).
 * When `cavityContext` is supplied, also evaluates Layer 2 legal-cavity routing (`routeHvacViaLegalCavity`)
 * and prefers it whenever it eliminates structural, plumbing, courtyard, or roof clashes.
 */
export function routeHvacDuctRun(params: {
  from: Vec3
  to: Vec3
  plenumY: number
  maxPlenumY?: number
  ductHalfSpanM?: DuctClashMargin
  allowDiagonalBranch?: boolean
  obstacles?: ReadonlyArray<HvacObstacle>
  xzBounds?: XzBounds2D
  roofEnvelope?: AtticRoofEnvelope
  footprintContains?: (x: number, z: number) => boolean
  interiorCorridorSpines?: { xs?: ReadonlyArray<number>; zs?: ReadonlyArray<number> }
  cavityContext?: HvacLegalCavityContext
  plenumLocation?: 'attic' | 'conditioned-soffit' | 'crawlspace' | 'basement'
  reserveOnCommit?: boolean
  runId?: string
}): {
  path: Vec3[]
  lengthFt: number
  detoured: boolean
  clashes: HvacObstacle[]
} {
  const {
    from,
    to,
    plenumY,
    maxPlenumY,
    ductHalfSpanM = 0.08,
    allowDiagonalBranch = false,
    obstacles = [],
    xzBounds,
    roofEnvelope,
    footprintContains,
    interiorCorridorSpines,
    cavityContext,
    plenumLocation,
    reserveOnCommit,
    runId,
  } = params

  const ductHalfH = typeof ductHalfSpanM === 'number' ? ductHalfSpanM : ductHalfSpanM.horizontal
  const ductHalfV = typeof ductHalfSpanM === 'number' ? ductHalfSpanM : ductHalfSpanM.vertical
  const hClear = ductHalfH + 0.06
  const vClear = ductHalfV + 0.06

  // Broad-phase XZ spatial filter to eliminate irrelevant obstacles on large buildings (HVA-OPT-01)
  const padXZ = 4.5 + hClear
  const broadMinX = Math.min(from[0], to[0]) - padXZ
  const broadMaxX = Math.max(from[0], to[0]) + padXZ
  const broadMinZ = Math.min(from[2], to[2]) - padXZ
  const broadMaxZ = Math.max(from[2], to[2]) + padXZ
  const localObstacles =
    obstacles.length > 0
      ? obstacles.filter(
          (o) =>
            o.box.maxX >= broadMinX &&
            o.box.minX <= broadMaxX &&
            o.box.maxZ >= broadMinZ &&
            o.box.minZ <= broadMaxZ,
        )
      : obstacles

  const checkClashes = (cand: ReadonlyArray<Vec3>): HvacObstacle[] => {
    if (localObstacles.length === obstacles.length) {
      return detectHvacClashes(cand, localObstacles, ductHalfSpanM)
    }
    let withinBroad = true
    for (const p of cand) {
      if (
        p[0] < broadMinX + hClear ||
        p[0] > broadMaxX - hClear ||
        p[2] < broadMinZ + hClear ||
        p[2] > broadMaxZ - hClear
      ) {
        withinBroad = false
        break
      }
    }
    return detectHvacClashes(cand, withinBroad ? localObstacles : obstacles, ductHalfSpanM)
  }

  // Irreducible lower bound: obstacles overlapping fixed `from` or `to` endpoints cannot be removed by any route.
  const endpointHitKeys = new Set<string>()
  if (localObstacles.length > 0) {
    for (const hit of detectHvacClashes([from, from], localObstacles, ductHalfSpanM)) {
      endpointHitKeys.add(hit.nodeId ?? hit.id)
    }
    for (const hit of detectHvacClashes([to, to], localObstacles, ductHalfSpanM)) {
      endpointHitKeys.add(hit.nodeId ?? hit.id)
    }
  }
  const irreducibleEndpointClashes = endpointHitKeys.size

  const clampY = (rawY: number): number =>
    maxPlenumY !== undefined ? Math.min(rawY, maxPlenumY) : rawY

  const dedupYs = (rawYs: ReadonlyArray<number>): number[] => {
    const out: number[] = []
    const seen = new Set<number>()
    for (const raw of rawYs) {
      const cy = Math.round(clampY(raw) * 10000) / 10000
      if (!seen.has(cy)) {
        seen.add(cy)
        out.push(cy)
      }
    }
    return out
  }

  const fromInBounds =
    !xzBounds ||
    (from[0] >= xzBounds.minX && from[0] <= xzBounds.maxX && from[2] >= xzBounds.minZ && from[2] <= xzBounds.maxZ)
  const toInBounds =
    !xzBounds ||
    (to[0] >= xzBounds.minX && to[0] <= xzBounds.maxX && to[2] >= xzBounds.minZ && to[2] <= xzBounds.maxZ)

  const withinXzBounds = (cand: ReadonlyArray<Vec3>): boolean => {
    if (!xzBounds) return true
    for (let i = 0; i < cand.length; i++) {
      if (i === 0 && !fromInBounds) continue
      if (i === cand.length - 1 && !toInBounds) continue
      const p = cand[i]!
      if (p[0] < xzBounds.minX || p[0] > xzBounds.maxX || p[2] < xzBounds.minZ || p[2] > xzBounds.maxZ) {
        return false
      }
    }
    return true
  }

  const hasPitchedRoof = Boolean(roofEnvelope?.hasRoofAbove)
  const roofSoffitY = roofEnvelope ? round2(roofEnvelope.wallH - Math.max(0.12, ductHalfV + 0.1)) : plenumY
  const roofClearMarginM = 0.14

  const isRoofOk = (cand: ReadonlyArray<Vec3>): boolean =>
    !hasPitchedRoof || !roofEnvelope
      ? true
      : pathClearOfRoof(cand, roofEnvelope, ductHalfV, roofClearMarginM, ductHalfH)

  const stepUnderRoof = (pts: Vec3[], y: number): Vec3[] => {
    if (!hasPitchedRoof || !roofEnvelope || y <= roofEnvelope.wallH + 0.05) return pts
    if (pathClearOfRoof(pts, roofEnvelope, ductHalfV, roofClearMarginM, ductHalfH)) return pts

    const safeHalf = safeRoofCorridorHalfWidth(roofEnvelope, y, ductHalfV, roofClearMarginM + 0.02)
    const lo = roofEnvelope.center - safeHalf
    const hi = roofEnvelope.center + safeHalf
    const alongX = roofEnvelope.ridgeAlongX
    const fromPerp = alongX ? from[2] : from[0]
    const toPerp = alongX ? to[2] : to[0]

    const safeEndY = (pt: Vec3): number => {
      const minRoofY =
        ductHalfH > 0.02
          ? minRoofYOverFootprint(roofEnvelope, pt[0], pt[2], ductHalfH, ductHalfH)
          : roofEnvelope.roofYAt(pt[0], pt[2])
      const cap = minRoofY - ductHalfV - roofClearMarginM
      if (cap <= roofEnvelope.wallH + 0.05) return Math.min(y, roofSoffitY)
      return Math.min(y, round2(cap))
    }

    const fromSafeY = safeEndY(from)
    const toSafeY = safeEndY(to)

    const dropToSoffit = (rawPts: Vec3[], targetY: number): Vec3[] =>
      cleanPath(
        rawPts.map((p, idx) =>
          idx === 0 || idx === rawPts.length - 1 ? p : ([p[0], Math.min(p[1], targetY), p[2]] as Vec3),
        ),
      )

    // If corridor has no width at y, or both ends sit outside the same eave side, route cleanly at soffit/safe height
    if (safeHalf < 0.15 || (fromPerp < lo && toPerp < lo) || (fromPerp > hi && toPerp > hi)) {
      return dropToSoffit(pts, Math.min(fromSafeY, toSafeY, roofSoffitY))
    }

    const clampPerp = (v: number): number => {
      let c = Math.max(lo, Math.min(hi, v))
      if (xzBounds) {
        c = alongX
          ? Math.max(xzBounds.minZ, Math.min(xzBounds.maxZ, c))
          : Math.max(xzBounds.minX, Math.min(xzBounds.maxX, c))
      }
      return round2(c)
    }

    const fCorr = clampPerp(fromPerp)
    const tCorr = clampPerp(toPerp)
    const out: Vec3[] = [from]
    if (Math.abs(fromPerp - fCorr) > 0.02) {
      out.push([from[0], fromSafeY, from[2]])
      out.push(alongX ? [from[0], fromSafeY, fCorr] : [fCorr, fromSafeY, from[2]])
      out.push(alongX ? [from[0], y, fCorr] : [fCorr, y, from[2]])
    } else {
      out.push([from[0], y, from[2]])
    }

    // Clamp ONLY attic-elevation intermediate waypoints into the safe ridge corridor;
    // skip low-elevation dogleg/riser intermediate points so paths never plunge back down into room height.
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i]!
      if (p[1] <= roofEnvelope.wallH + 0.05) continue
      const px = alongX ? p[0] : clampPerp(p[0])
      const pz = alongX ? clampPerp(p[2]) : p[2]
      out.push([px, y, pz])
    }

    if (Math.abs(toPerp - tCorr) > 0.02) {
      out.push(alongX ? [to[0], y, tCorr] : [tCorr, y, to[2]])
      out.push(alongX ? [to[0], toSafeY, tCorr] : [tCorr, toSafeY, to[2]])
      out.push([to[0], toSafeY, to[2]])
    } else {
      out.push([to[0], y, to[2]])
    }
    out.push(to)
    const stepped = cleanPath(out)
    if (pathClearOfRoof(stepped, roofEnvelope, ductHalfV, roofClearMarginM, ductHalfH)) {
      return stepped
    }

    // 4-sided hip / multi-segment roof safeguard: when the ridge-axis eave slopes down steeply
    // (e.g. front/back hip eave), pull the attic run inward along the ridge axis toward the safe hip interior
    // before rising above wallH, or drop cleanly to conditioned soffit height so no duct clips hip rafters.
    const hipCenterAlong = alongX
      ? (roofEnvelope.bounds.minX + roofEnvelope.bounds.maxX) / 2
      : (roofEnvelope.bounds.minZ + roofEnvelope.bounds.maxZ) / 2
    const pullTowardHipInterior = (pt: Vec3): Vec3 => {
      let cx = alongX ? pt[0] : clampPerp(pt[0])
      let cz = alongX ? clampPerp(pt[2]) : pt[2]
      for (let step = 0; step < 12; step++) {
        const minR =
          ductHalfH > 0.02
            ? minRoofYOverFootprint(roofEnvelope, cx, cz, ductHalfH, ductHalfH)
            : roofEnvelope.roofYAt(cx, cz)
        if (minR >= y + ductHalfV + roofClearMarginM) break
        if (alongX) {
          cx = round2(cx + (hipCenterAlong - cx) * 0.28)
        } else {
          cz = round2(cz + (hipCenterAlong - cz) * 0.28)
        }
        if (xzBounds) {
          cx = Math.max(xzBounds.minX, Math.min(xzBounds.maxX, cx))
          cz = Math.max(xzBounds.minZ, Math.min(xzBounds.maxZ, cz))
        }
      }
      return [cx, y, cz]
    }
    const fIn = pullTowardHipInterior(from)
    const tIn = pullTowardHipInterior(to)
    const hipCandidates: Vec3[][] = [
      cleanPath([
        from,
        [from[0], roofSoffitY, from[2]],
        [fIn[0], roofSoffitY, from[2]],
        [fIn[0], roofSoffitY, fIn[2]],
        fIn,
        [tIn[0], y, fIn[2]],
        tIn,
        [tIn[0], roofSoffitY, tIn[2]],
        [to[0], roofSoffitY, tIn[2]],
        [to[0], roofSoffitY, to[2]],
        to,
      ]),
      cleanPath([
        from,
        [from[0], roofSoffitY, from[2]],
        [from[0], roofSoffitY, fIn[2]],
        [fIn[0], roofSoffitY, fIn[2]],
        fIn,
        [fIn[0], y, tIn[2]],
        tIn,
        [tIn[0], roofSoffitY, tIn[2]],
        [tIn[0], roofSoffitY, to[2]],
        [to[0], roofSoffitY, to[2]],
        to,
      ]),
    ]
    for (const hc of hipCandidates) {
      if (
        withinXzBounds(hc) &&
        pathClearOfRoof(hc, roofEnvelope, ductHalfV, roofClearMarginM, ductHalfH) &&
        (!footprintContains || !pathCrossesOutdoorVoid(hc, footprintContains, 0.5))
      ) {
        return hc
      }
    }
    // Guaranteed hip/flat-roof-safe fallback: stay strictly below ceiling height (`roofSoffitY`)
    return dropToSoffit(pts, roofSoffitY)
  }

  const buildCandAtY = (mode: 'x' | 'z' | 'diag' | 'ux' | 'uz', offsetM: number, rawY: number): Vec3[] => {
    const y = clampY(rawY)
    const sP: Vec3 = [from[0], y, from[2]]
    const eP: Vec3 = [to[0], y, to[2]]
    let raw: Vec3[]
    if (mode === 'ux') {
      raw = cleanPath([from, sP, [from[0] + offsetM, y, from[2]], [from[0] + offsetM, y, to[2]], eP, to])
    } else if (mode === 'uz') {
      raw = cleanPath([from, sP, [from[0], y, from[2] + offsetM], [to[0], y, from[2] + offsetM], eP, to])
    } else if (mode === 'diag') {
      if (Math.abs(offsetM) < 1e-4) raw = cleanPath([from, sP, eP, to])
      else {
        const mx = (from[0] + to[0]) / 2 + offsetM
        const mz = (from[2] + to[2]) / 2 - offsetM
        raw = cleanPath([from, sP, [mx, y, mz], eP, to])
      }
    } else if (mode === 'x') {
      raw = cleanPath([from, sP, [to[0] + offsetM, y, from[2] + offsetM], eP, to])
    } else {
      raw = cleanPath([from, sP, [from[0] + offsetM, y, to[2] + offsetM], eP, to])
    }
    return stepUnderRoof(raw, y)
  }

  const buildCand = (mode: 'x' | 'z' | 'diag' | 'ux' | 'uz', offsetM = 0, yOffset = 0): Vec3[] =>
    buildCandAtY(mode, offsetM, plenumY + yOffset)

  const buildDogleg = (
    sx: number,
    sz: number,
    ex: number,
    ez: number,
    y: number,
    mode: 'x' | 'z' | 'diag',
  ): Vec3[] => {
    const pts: Vec3[] = [from]
    if (Math.hypot(sx - from[0], sz - from[2]) > 0.02) {
      pts.push([sx, from[1], sz])
    }
    pts.push([sx, y, sz])
    if (mode === 'x') {
      pts.push([ex, y, sz])
    } else if (mode === 'z') {
      pts.push([sx, y, ez])
    }
    pts.push([ex, y, ez])
    if (Math.hypot(ex - to[0], ez - to[2]) > 0.02) {
      pts.push([ex, to[1], ez])
    }
    pts.push(to)
    return stepUnderRoof(cleanPath(pts), y)
  }

  const isFootprintOk = (cand: ReadonlyArray<Vec3>): boolean =>
    !footprintContains ? true : !pathCrossesOutdoorVoid(cand, footprintContains, 0.5)

  const seenPaths = new Set<string>()
  const pathKey = (cand: ReadonlyArray<Vec3>): string =>
    cand.map((p) => `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)},${Math.round(p[2] * 100)}`).join(';')

  const primary = buildCand(allowDiagonalBranch ? 'diag' : 'x', 0, 0)
  seenPaths.add(pathKey(primary))
  let bestPath = primary
  let bestClashes = checkClashes(primary)
  let bestRoofOk = isRoofOk(primary)
  let bestInBounds = withinXzBounds(primary)
  let bestFootprintOk = isFootprintOk(primary)
  let detoured = false

  const isDone = (): boolean =>
    bestRoofOk && bestInBounds && bestFootprintOk && bestClashes.length <= irreducibleEndpointClashes

  const tryCandidate = (cand: Vec3[]): boolean => {
    const candInBounds = withinXzBounds(cand)
    if (xzBounds && !candInBounds) return false
    const key = pathKey(cand)
    if (seenPaths.has(key)) return false
    seenPaths.add(key)

    const candFootprintOk = isFootprintOk(cand)
    if (bestFootprintOk && !candFootprintOk) return false
    const candRoofOk = isRoofOk(cand)
    if (bestFootprintOk === candFootprintOk && bestRoofOk && !candRoofOk) return false
    const c = checkClashes(cand)
    const better =
      (!bestInBounds && candInBounds) ||
      (candInBounds === bestInBounds && !bestFootprintOk && candFootprintOk) ||
      (candInBounds === bestInBounds && candFootprintOk === bestFootprintOk && !bestRoofOk && candRoofOk) ||
      (candInBounds === bestInBounds &&
        candFootprintOk === bestFootprintOk &&
        candRoofOk === bestRoofOk &&
        c.length < bestClashes.length)
    if (better) {
      bestPath = cand
      bestClashes = c
      bestRoofOk = candRoofOk
      bestInBounds = candInBounds
      bestFootprintOk = candFootprintOk
      detoured = true
      if (isDone()) return true
    }
    return false
  }

  if (!isDone()) {
    // When primary crosses a concave outdoor void (e.g. U-shaped courtyard or L-notch),
    // immediately try the alternative L-bend AND 2-bend / 3-bend interior wing corridor spines first!
    if (footprintContains && !bestFootprintOk) {
      const baseY = clampY(plenumY)
      const spineYs = dedupYs([
        plenumY,
        ...(hasPitchedRoof ? [roofSoffitY] : []),
        plenumY + 0.35,
        plenumY - 0.18,
      ])
      const spineZs: number[] = []
      const spineXs: number[] = []
      const pushUnique = (arr: number[], v: number) => {
        const rv = round2(v)
        if (!arr.some((e) => Math.abs(e - rv) < 0.2)) arr.push(rv)
      }
      if (interiorCorridorSpines?.zs) {
        for (const z of interiorCorridorSpines.zs) pushUnique(spineZs, z)
      }
      if (interiorCorridorSpines?.xs) {
        for (const x of interiorCorridorSpines.xs) pushUnique(spineXs, x)
      }
      if (xzBounds) {
        const steps = 7
        for (let i = 1; i <= steps; i++) {
          const frac = i / (steps + 1)
          pushUnique(spineZs, xzBounds.minZ + (xzBounds.maxZ - xzBounds.minZ) * frac)
          pushUnique(spineXs, xzBounds.minX + (xzBounds.maxX - xzBounds.minX) * frac)
        }
      }
      const midZ = (from[2] + to[2]) / 2
      const midX = (from[0] + to[0]) / 2
      spineZs.sort((a, b) => Math.abs(a - midZ) - Math.abs(b - midZ))
      spineXs.sort((a, b) => Math.abs(a - midX) - Math.abs(b - midX))

      // Try alternative L-bends first at baseY
      tryCandidate(buildCandAtY('z', 0, baseY))
      if (!isDone()) tryCandidate(buildCandAtY('x', 0, baseY))

      // 2-bend interior wing corridor detours: route via connecting Z spine or X spine
      if (!isDone()) {
        for (const y of spineYs) {
          for (const sz of spineZs) {
            const cand = stepUnderRoof(
              cleanPath([from, [from[0], y, from[2]], [from[0], y, sz], [to[0], y, sz], [to[0], y, to[2]], to]),
              y,
            )
            if (tryCandidate(cand)) break
          }
          if (isDone()) break
          for (const sx of spineXs) {
            const cand = stepUnderRoof(
              cleanPath([from, [from[0], y, from[2]], [sx, y, from[2]], [sx, y, to[2]], [to[0], y, to[2]], to]),
              y,
            )
            if (tryCandidate(cand)) break
          }
          if (isDone()) break
        }
      }

      // 3-bend stepped corridor detours (handles offset/stepped U or S wings when 2-bend isn't enough)
      if (!bestFootprintOk) {
        const compactXs = spineXs.slice(0, 6)
        const compactZs = spineZs.slice(0, 6)
        for (const y of spineYs.slice(0, 2)) {
          for (const sx of compactXs) {
            for (const sz of compactZs) {
              const c1 = stepUnderRoof(
                cleanPath([
                  from,
                  [from[0], y, from[2]],
                  [from[0], y, sz],
                  [sx, y, sz],
                  [sx, y, to[2]],
                  [to[0], y, to[2]],
                  to,
                ]),
                y,
              )
              if (tryCandidate(c1)) break
              const c2 = stepUnderRoof(
                cleanPath([
                  from,
                  [from[0], y, from[2]],
                  [sx, y, from[2]],
                  [sx, y, sz],
                  [to[0], y, sz],
                  [to[0], y, to[2]],
                  to,
                ]),
                y,
              )
              if (tryCandidate(c2)) break
            }
            if (isDone()) break
          }
          if (isDone()) break
        }
      }
    }

    const candidates: Vec3[][] = isDone()
      ? []
      : [
          buildCand('z', 0, 0),
          buildCand('x', 0, 0),
      // Elevation hops first so attic trunks & branches step cleanly over Priority #2 DWV vents
      // and structural headers (conditioned-soffit & crawlspace runs clamp to maxPlenumY and also try downward clearances)
      buildCand('diag', 0, 0.35),
      buildCand('x', 0, 0.35),
      buildCand('z', 0, 0.35),
      buildCand('diag', 0, 0.55),
      buildCand('x', 0, 0.55),
      buildCand('z', 0, 0.55),
      buildCand('x', 0, 0.85),
      buildCand('z', 0, 0.85),
      buildCand('x', 0, 1.15),
      buildCand('z', 0, 1.15),
      buildCand('x', 0, 0.28),
      buildCand('z', 0, 0.28),
      buildCand('x', 0, -0.18),
      buildCand('z', 0, -0.18),
      buildCand('x', 0, -0.32),
      buildCand('z', 0, -0.32),
          ...(hasPitchedRoof
            ? [
                buildCandAtY(allowDiagonalBranch ? 'diag' : 'x', 0, roofSoffitY),
                buildCandAtY('z', 0, roofSoffitY),
                buildCandAtY('x', 0, roofSoffitY),
                buildCandAtY('x', 0, roofSoffitY - 0.16),
                buildCandAtY('z', 0, roofSoffitY - 0.16),
                buildCandAtY('x', 0, roofSoffitY - 0.32),
                buildCandAtY('z', 0, roofSoffitY - 0.32),
                buildCandAtY('ux', 0.65, roofSoffitY),
                buildCandAtY('ux', -0.65, roofSoffitY),
                buildCandAtY('uz', 0.65, roofSoffitY),
                buildCandAtY('uz', -0.65, roofSoffitY),
              ]
            : []),
      buildCand('ux', 0.65, 0),
      buildCand('ux', -0.65, 0),
      buildCand('uz', 0.65, 0),
      buildCand('uz', -0.65, 0),
      buildCand('x', 0.65, 0),
      buildCand('x', -0.65, 0),
      buildCand('z', 0.65, 0),
      buildCand('z', -0.65, 0),
      buildCand('ux', 0.65, 0.35),
      buildCand('ux', -0.65, 0.35),
      buildCand('uz', 0.65, 0.35),
      buildCand('uz', -0.65, 0.35),
      buildCand('ux', 0.85, -0.25),
      buildCand('ux', -0.85, -0.25),
      buildCand('uz', 0.85, -0.25),
      buildCand('uz', -0.85, -0.25),
      buildCand('ux', 1.1, 0),
      buildCand('ux', -1.1, 0),
      buildCand('uz', 1.1, 0),
      buildCand('uz', -1.1, 0),
      buildCand('ux', 1.6, 0.35),
      buildCand('ux', -1.6, 0.35),
      buildCand('uz', 1.6, 0.35),
      buildCand('uz', -1.6, 0.35),
      buildCand('ux', 2.4, 0.55),
      buildCand('ux', -2.4, 0.55),
      buildCand('uz', 2.4, 0.55),
      buildCand('uz', -2.4, 0.55),
      buildCand('ux', 3.5, 0.55),
      buildCand('ux', -3.5, 0.55),
      buildCand('uz', 3.5, 0.55),
      buildCand('uz', -3.5, 0.55),
      buildCand('ux', 2.2, -0.25),
      buildCand('ux', -2.2, -0.25),
      buildCand('uz', 2.2, -0.25),
      buildCand('uz', -2.2, -0.25),
      buildCand('x', 0, -0.44),
      buildCand('z', 0, -0.44),
      buildCand('ux', 1.2, -0.44),
      buildCand('ux', -1.2, -0.44),
      buildCand('uz', 1.2, -0.44),
      buildCand('uz', -1.2, -0.44),
      buildCand('ux', 2.2, -0.44),
      buildCand('ux', -2.2, -0.44),
      buildCand('uz', 2.2, -0.44),
      buildCand('uz', -2.2, -0.44),
      buildCand('diag', 0.85, 0),
      buildCand('diag', -0.85, 0),
      buildCand('diag', 0.85, 0.35),
      buildCand('diag', -0.85, 0.35),
      buildCand('diag', 1.4, 0.55),
      buildCand('diag', -1.4, 0.55),
    ]
    for (const cand of candidates) {
      if (tryCandidate(cand)) break
    }

    // Obstacle-hugging plenum bypasses (clear exact AABB bounds of blocking headers, vents, or equipment)
    if (!isDone()) {
      const basePlenumY = Math.round(clampY(plenumY) * 10000) / 10000
      const initialBlockers = bestClashes.slice(0, 6)
      for (const obs of initialBlockers) {
        const yAbove = Math.max(plenumY, obs.box.maxY + vClear)
        const yBelow = maxPlenumY !== undefined ? obs.box.minY - vClear : undefined
        const yVals = dedupYs([
          plenumY,
          yAbove,
          ...(yBelow !== undefined ? [yBelow] : []),
          ...(hasPitchedRoof ? [roofSoffitY, roofSoffitY - 0.28] : []),
          plenumY + 0.55,
        ])
        const bypassXs = [obs.box.minX - hClear, obs.box.maxX + hClear]
        const bypassZs = [obs.box.minZ - hClear, obs.box.maxZ + hClear]
        for (const y of yVals) {
          if (y !== basePlenumY) {
            if (tryCandidate(stepUnderRoof(cleanPath([from, [from[0], y, from[2]], [to[0], y, from[2]], [to[0], y, to[2]], to]), y))) break
            if (tryCandidate(stepUnderRoof(cleanPath([from, [from[0], y, from[2]], [from[0], y, to[2]], [to[0], y, to[2]], to]), y))) break
          }
          for (const bx of bypassXs) {
            if (
              tryCandidate(
                stepUnderRoof(
                  cleanPath([
                    from,
                    [from[0], y, from[2]],
                    [bx, y, from[2]],
                    [bx, y, to[2]],
                    [to[0], y, to[2]],
                    to,
                  ]),
                  y,
                ),
              )
            ) {
              break
            }
          }
          if (isDone()) break
          for (const bz of bypassZs) {
            if (
              tryCandidate(
                stepUnderRoof(
                  cleanPath([
                    from,
                    [from[0], y, from[2]],
                    [from[0], y, bz],
                    [to[0], y, bz],
                    [to[0], y, to[2]],
                    to,
                  ]),
                  y,
                ),
              )
            ) {
              break
            }
          }
          if (isDone()) break
        }
        if (isDone()) break
      }
    }

    // Start/End vertical riser dogleg bypasses: step laterally at takeoff/landing elevation
    // before rising or dropping vertically to dodge overhead door headers, DWV vents, or adjacent water heaters.
    if (!isDone()) {
      const riserOffsets: ReadonlyArray<readonly [number, number]> = [
        [0.55, 0],
        [-0.55, 0],
        [0, 0.55],
        [0, -0.55],
        [0.95, 0],
        [-0.95, 0],
        [0, 0.95],
        [0, -0.95],
        [0.75, 0.75],
        [-0.75, 0.75],
        [0.75, -0.75],
        [-0.75, -0.75],
        [1.4, 0],
        [-1.4, 0],
        [0, 1.4],
        [0, -1.4],
      ]
      const riserYs = dedupYs([plenumY, plenumY + 0.45, plenumY + 0.85, ...(hasPitchedRoof ? [roofSoffitY] : [])])
      const beforeDoglegClashes = bestClashes.length
      const beforeDoglegRoofOk = bestRoofOk
      // 1. Offset start riser
      for (const y of riserYs) {
        for (const [dx, dz] of riserOffsets) {
          if (tryCandidate(buildDogleg(from[0] + dx, from[2] + dz, to[0], to[2], y, 'x'))) break
          if (tryCandidate(buildDogleg(from[0] + dx, from[2] + dz, to[0], to[2], y, 'z'))) break
        }
        if (isDone()) break
      }
      // 2. Offset end riser
      if (!isDone()) {
        for (const y of riserYs) {
          for (const [dx, dz] of riserOffsets) {
            if (tryCandidate(buildDogleg(from[0], from[2], to[0] + dx, to[2] + dz, y, 'x'))) break
            if (tryCandidate(buildDogleg(from[0], from[2], to[0] + dx, to[2] + dz, y, 'z'))) break
          }
          if (isDone()) break
        }
      }
      // 3. Offset both start and end risers only if pass 1 or pass 2 made progress (HVA-OPT-01)
      const doglegMadeProgress =
        bestClashes.length < beforeDoglegClashes || (!beforeDoglegRoofOk && bestRoofOk)
      if (!isDone() && doglegMadeProgress) {
        const compactRiser: ReadonlyArray<readonly [number, number]> = [
          [0.65, 0],
          [-0.65, 0],
          [0, 0.65],
          [0, -0.65],
          [1.1, 0],
          [-1.1, 0],
          [0, 1.1],
          [0, -1.1],
        ]
        const compactYs = dedupYs([plenumY, plenumY + 0.55])
        for (const y of compactYs) {
          for (const [sdx, sdz] of compactRiser) {
            for (const [edx, edz] of compactRiser) {
              if (tryCandidate(buildDogleg(from[0] + sdx, from[2] + sdz, to[0] + edx, to[2] + edz, y, 'x'))) break
              if (tryCandidate(buildDogleg(from[0] + sdx, from[2] + sdz, to[0] + edx, to[2] + edz, y, 'z'))) break
            }
            if (isDone()) break
          }
          if (isDone()) break
        }
      }
    }

    // Layer 2 Legal-Space-First Cavity Rescue: invoked when structured high-plenum sweeps still have
    // structural, plumbing, courtyard, or roof clashes (`INV-MEP-06`, `INV-MEP-07`).
    if (!isDone() && cavityContext) {
      const lvlH = cavityContext.anatomy.getLevelHeightM(cavityContext.levelId)
      const effPlenumLoc: 'attic' | 'conditioned-soffit' | 'crawlspace' | 'basement' =
        plenumLocation === 'crawlspace' || plenumLocation === 'basement'
          ? plenumLocation
          : plenumY < -0.05
            ? 'crawlspace'
            : (maxPlenumY !== undefined && maxPlenumY <= lvlH + 0.05) || plenumLocation === 'conditioned-soffit'
              ? 'conditioned-soffit'
              : 'attic'
      const targetCavityY = clampY(plenumY)
      const flatSoffitMarginM =
        effPlenumLoc === 'conditioned-soffit' && targetCavityY < lvlH && targetCavityY > 0.5
          ? Math.max(0.08, Math.ceil((lvlH - targetCavityY) * 1000) / 1000)
          : maxPlenumY !== undefined && maxPlenumY < lvlH && maxPlenumY > 0.5
            ? Math.max(0.08, Math.ceil((lvlH - maxPlenumY) * 1000) / 1000)
            : undefined
      const atticElevationM =
        effPlenumLoc === 'attic' && targetCavityY > lvlH + 0.05 ? targetCavityY : undefined

      const cavityRes = routeHvacViaLegalCavity({
        cavityContext,
        from,
        to,
        mode: 'orthogonal',
        ductHalfSpanM,
        clearanceM: 0.02,
        plenumLocation: effPlenumLoc,
        atticElevationM,
        flatSoffitMarginM,
        roofClearanceM: roofClearMarginM,
        reserveOnCommit: false,
        extraObstacles: localObstacles,
      })

      if (cavityRes.path.length >= 2) {
        const withinMaxY = (pts: ReadonlyArray<Vec3>): boolean =>
          maxPlenumY === undefined ||
          pts.every((p, idx) => idx === 0 || idx === pts.length - 1 || p[1] <= maxPlenumY + 1e-4)

        const rawCavity = cleanPath([...cavityRes.path])
        if (withinMaxY(rawCavity)) {
          tryCandidate(rawCavity)
        }
        if (!isDone() && hasPitchedRoof) {
          const stepped = stepUnderRoof(rawCavity, clampY(plenumY))
          if (withinMaxY(stepped)) tryCandidate(stepped)
        }
        if (!isDone() && (xzBounds || maxPlenumY !== undefined)) {
          const clamped = cleanPath(
            rawCavity.map((p, idx) => {
              if (idx === 0 || idx === rawCavity.length - 1) return p
              const cx = xzBounds ? Math.max(xzBounds.minX, Math.min(xzBounds.maxX, p[0])) : p[0]
              const cy = maxPlenumY !== undefined ? Math.min(maxPlenumY, p[1]) : p[1]
              const cz = xzBounds ? Math.max(xzBounds.minZ, Math.min(xzBounds.maxZ, p[2])) : p[2]
              return [cx, cy, cz] as Vec3
            }),
          )
          tryCandidate(clamped)
          if (!isDone() && hasPitchedRoof) {
            const steppedClamped = stepUnderRoof(clamped, clampY(plenumY))
            if (withinMaxY(steppedClamped)) tryCandidate(steppedClamped)
          }
        }
      }
    }
  }

  if (reserveOnCommit === true && cavityContext && bestPath.length >= 2) {
    cavityContext.occupancy.reserveRun({
      runId: runId ?? `hvac-duct-${Math.round(from[0] * 100)}_${Math.round(to[0] * 100)}`,
      trade: 'hvac',
      path: bestPath,
      halfXZ: ductHalfH,
      halfY: ductHalfV,
      clearanceM: 0.02,
    })
  }

  return {
    path: bestPath,
    lengthFt: round2(polylineLengthM(bestPath) * METERS_TO_FEET),
    detoured,
    clashes: bestClashes,
  }
}

/**
 * Measure gravity slope on a condensate drain polyline (IMC 307.2.1 requires >= 1/8"/ft downward fall).
 */
export function measureCondensateSlope(path: ReadonlyArray<Vec3>): {
  hasUphillSegment: boolean
  horizontalDistFt: number
  overallSlopeInPerFt: number
} {
  let hasUphillSegment = false
  let horizM = 0
  let totalDropM = 0
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!
    const b = path[i]!
    const dy = b[1] - a[1]
    const dh = Math.hypot(b[0] - a[0], b[2] - a[2])
    if (dy > 0.002) hasUphillSegment = true
    if (dh >= 0.05) {
      horizM += dh
      totalDropM += a[1] - b[1]
    }
  }
  const horizontalDistFt = round2(horizM * METERS_TO_FEET)
  const overallSlopeInPerFt = horizM > 0.05 ? round2((totalDropM / horizM) * 12) : 0
  return { hasUphillSegment, horizontalDistFt, overallSlopeInPerFt }
}

/**
 * Route a gravity-sloped 3/4" PVC condensate drain (IMC 307.2.1 >= 1/8"/ft slope) from evaporator coil to exterior/drain.
 * Attic units (`from[1] >= 2.2m`) run sloped across the attic plenum to the exterior wall before dropping vertically
 * so pipes never drop through the middle of living spaces.
 */
export function routeCondensateDrain(params: {
  from: Vec3
  to: Vec3
  obstacles?: ReadonlyArray<HvacObstacle>
  xzBounds?: XzBounds2D
  roofEnvelope?: AtticRoofEnvelope
  slopeInPerFt?: number
  footprintContains?: (x: number, z: number) => boolean
  cavityContext?: HvacLegalCavityContext
  reserveOnCommit?: boolean
  runId?: string
}): {
  path: Vec3[]
  slopeInPerFt: number
  lengthFt: number
  detoured: boolean
  clashes: HvacObstacle[]
} {
  const {
    from,
    to,
    obstacles = [],
    xzBounds,
    roofEnvelope,
    footprintContains,
    cavityContext,
    reserveOnCommit,
    runId,
  } = params
  const minPlacementSlope = IMC_RULE_THRESHOLDS.condensateMinSlopePlacementInPerFt
  const slopeInPerFt =
    typeof params.slopeInPerFt === 'number' && Number.isFinite(params.slopeInPerFt)
      ? Math.max(Math.max(0.13, minPlacementSlope), Math.min(1.0, params.slopeInPerFt))
      : 0.25
  const slopeRatio = slopeInPerFt / 12
  const isAtticStart = from[1] >= 2.2
  const horizEstimateM = Math.abs(to[0] - from[0]) + Math.abs(to[2] - from[2])
  const minRunStartY = to[1] + horizEstimateM * slopeRatio + 0.02
  const startY = isAtticStart
    ? from[1]
    : from[1] > to[1] + 0.05
      ? Math.min(from[1], Math.max(0.25, minRunStartY))
      : from[1]

  // Broad-phase spatial filter (HVA-OPT-01)
  const padXZ = 4.5 + 0.16
  const broadMinX = Math.min(from[0], to[0]) - padXZ
  const broadMaxX = Math.max(from[0], to[0]) + padXZ
  const broadMinZ = Math.min(from[2], to[2]) - padXZ
  const broadMaxZ = Math.max(from[2], to[2]) + padXZ
  const localObstacles =
    obstacles.length > 0
      ? obstacles.filter(
          (o) =>
            o.box.maxX >= broadMinX &&
            o.box.minX <= broadMaxX &&
            o.box.maxZ >= broadMinZ &&
            o.box.minZ <= broadMaxZ,
        )
      : obstacles

  const checkClashes = (cand: ReadonlyArray<Vec3>): HvacObstacle[] => {
    if (localObstacles.length === obstacles.length) return detectHvacClashes(cand, localObstacles, 0.02)
    let withinBroad = true
    for (const p of cand) {
      if (
        p[0] < broadMinX + 0.16 ||
        p[0] > broadMaxX - 0.16 ||
        p[2] < broadMinZ + 0.16 ||
        p[2] > broadMaxZ - 0.16
      ) {
        withinBroad = false
        break
      }
    }
    return detectHvacClashes(cand, withinBroad ? localObstacles : obstacles, 0.02)
  }

  const endpointHitKeys = new Set<string>()
  if (localObstacles.length > 0) {
    for (const hit of detectHvacClashes([from, from], localObstacles, 0.02)) {
      endpointHitKeys.add(hit.nodeId ?? hit.id)
    }
    for (const hit of detectHvacClashes([to, to], localObstacles, 0.02)) {
      endpointHitKeys.add(hit.nodeId ?? hit.id)
    }
  }
  const irreducibleEndpointClashes = endpointHitKeys.size

  const fromInBounds =
    !xzBounds ||
    (from[0] >= xzBounds.minX && from[0] <= xzBounds.maxX && from[2] >= xzBounds.minZ && from[2] <= xzBounds.maxZ)
  const toInBounds =
    !xzBounds ||
    (to[0] >= xzBounds.minX && to[0] <= xzBounds.maxX && to[2] >= xzBounds.minZ && to[2] <= xzBounds.maxZ)

  const withinXzBounds = (cand: ReadonlyArray<Vec3>): boolean => {
    if (!xzBounds) return true
    for (let i = 0; i < cand.length; i++) {
      if (i === 0 && !fromInBounds) continue
      if (i === cand.length - 1 && !toInBounds) continue
      const p = cand[i]!
      if (p[0] < xzBounds.minX || p[0] > xzBounds.maxX || p[2] < xzBounds.minZ || p[2] > xzBounds.maxZ) {
        return false
      }
    }
    return true
  }

  const isRoofOk = (cand: ReadonlyArray<Vec3>): boolean =>
    !roofEnvelope?.hasRoofAbove ? true : pathClearOfRoof(cand, roofEnvelope, 0.015, 0.06)

  const buildSlopedWithProfile = (
    waypoints: ReadonlyArray<readonly [number, number]>,
    runStartY: number,
    dropAtEnd: boolean,
    customSlopeRatio = slopeRatio,
  ): Vec3[] => {
    const pts: Vec3[] = [from]
    if (from[1] > runStartY + 0.02) pts.push([from[0], runStartY, from[2]])
    let cx = from[0]
    let cz = from[2]
    let cy = Math.min(from[1], runStartY)
    for (let i = 0; i < waypoints.length; i++) {
      const [wx, wz] = waypoints[i]!
      const leg = Math.hypot(wx - cx, wz - cz)
      const isLast = i === waypoints.length - 1
      if (!isLast && leg < 0.12) continue
      cy -= leg * customSlopeRatio
      if (isLast) {
        if (dropAtEnd && cy > to[1] + 0.05) {
          // Run sloped overhead/elevated to exterior termination X/Z, then drop vertically down exterior wall
          pts.push([wx, cy, wz])
          pts.push([wx, to[1], wz])
        } else {
          const finalY = to[1] <= cy ? to[1] : cy
          pts.push([wx, finalY, wz])
        }
      } else {
        pts.push([wx, cy, wz])
      }
      cx = wx
      cz = wz
    }
    return cleanPath(pts)
  }

  const buildSloped = (waypoints: ReadonlyArray<readonly [number, number]>): Vec3[] =>
    buildSlopedWithProfile(waypoints, startY, isAtticStart)

  const isFootprintOk = (cand: ReadonlyArray<Vec3>): boolean =>
    !footprintContains ? true : !pathCrossesOutdoorVoid(cand, footprintContains, 0.5)

  const primary = buildSloped([
    [to[0], from[2]],
    [to[0], to[2]],
  ])
  let best = primary
  let clashes = checkClashes(primary)
  let bestRoofOk = isRoofOk(primary)
  let bestInBounds = withinXzBounds(primary)
  let bestFootprintOk = isFootprintOk(primary)
  let detoured = false

  const isDone = (): boolean =>
    bestRoofOk && bestInBounds && bestFootprintOk && clashes.length <= irreducibleEndpointClashes

  if (!isDone()) {
    // Layer 2 gravity-slope legal-cavity candidate (`mode: 'gravity-slope'`, IMC 307.2.1)
    if (cavityContext) {
      const cavityCond = routeHvacViaLegalCavity({
        cavityContext,
        from,
        to,
        mode: 'gravity-slope',
        ductHalfSpanM: 0.02,
        clearanceM: 0.02,
        minSlopeInPerFt: slopeInPerFt,
        roofClearanceM: 0.06,
        reserveOnCommit: false,
        extraObstacles: localObstacles,
      })
      if (cavityCond.path.length >= 2) {
        const cand = cleanPath([...cavityCond.path])
        const candInBounds = withinXzBounds(cand)
        if (!xzBounds || candInBounds) {
          const candFootprintOk = isFootprintOk(cand)
          const candRoofOk = isRoofOk(cand)
          const c = checkClashes(cand)
          const better =
            (!bestInBounds && candInBounds) ||
            (candInBounds === bestInBounds && !bestFootprintOk && candFootprintOk) ||
            (candInBounds === bestInBounds && candFootprintOk === bestFootprintOk && !bestRoofOk && candRoofOk) ||
            (candInBounds === bestInBounds &&
              candFootprintOk === bestFootprintOk &&
              candRoofOk === bestRoofOk &&
              c.length < clashes.length)
          if (better) {
            const slopeCheck = measureCondensateSlope(cand)
            if (
              !slopeCheck.hasUphillSegment &&
              (slopeCheck.horizontalDistFt < 1.0 || slopeCheck.overallSlopeInPerFt >= minPlacementSlope)
            ) {
              best = cand
              clashes = c
              bestRoofOk = candRoofOk
              bestInBounds = candInBounds
              bestFootprintOk = candFootprintOk
              detoured = true
            }
          }
        }
      }
    }
  }

  if (!isDone()) {
    const waypointSets: Array<ReadonlyArray<readonly [number, number]>> = [
      [
        [from[0], to[2]],
        [to[0], to[2]],
      ],
      [
        [to[0], from[2]],
        [to[0], to[2]],
      ],
    ]
    for (const d of [0.45, -0.45, 0.85, -0.85, 1.35, -1.35, 2.1, -2.1, 3.0, -3.0, 4.2, -4.2]) {
      waypointSets.push([
        [from[0], from[2] + d],
        [to[0], from[2] + d],
        [to[0], to[2]],
      ])
      waypointSets.push([
        [from[0] + d, from[2]],
        [from[0] + d, to[2]],
        [to[0], to[2]],
      ])
    }
    // Obstacle-hugging lateral bypasses around blocking plumbing equipment (water heater, expansion tank),
    // floor-level dryer vents, or wide structural door/window headers
    for (const obs of clashes.slice(0, 6)) {
      const bzLo = round2(obs.box.minZ - 0.14)
      const bzHi = round2(obs.box.maxZ + 0.14)
      const bxLo = round2(obs.box.minX - 0.14)
      const bxHi = round2(obs.box.maxX + 0.14)
      waypointSets.push(
        [
          [from[0], bzLo],
          [to[0], bzLo],
          [to[0], to[2]],
        ],
        [
          [from[0], bzHi],
          [to[0], bzHi],
          [to[0], to[2]],
        ],
        [
          [bxLo, from[2]],
          [bxLo, to[2]],
          [to[0], to[2]],
        ],
        [
          [bxHi, from[2]],
          [bxHi, to[2]],
          [to[0], to[2]],
        ],
        [
          [bxLo, from[2]],
          [bxLo, bzLo],
          [to[0], bzLo],
          [to[0], to[2]],
        ],
        [
          [bxHi, from[2]],
          [bxHi, bzHi],
          [to[0], bzHi],
          [to[0], to[2]],
        ],
      )
    }

    const profiles: Array<{ runY: number; dropAtEnd: boolean; slopeRatio?: number }> = [
      { runY: startY, dropAtEnd: isAtticStart },
    ]
    if (roofEnvelope?.hasRoofAbove && isAtticStart && from[1] > roofEnvelope.wallH - 0.04) {
      // Roof-safe attic drop profile: pitch down below eave ceiling height before approaching exterior eaves
      const soffitRunY = round2(Math.min(from[1], roofEnvelope.wallH - 0.06))
      if (soffitRunY > to[1] + 0.08) {
        profiles.push({ runY: soffitRunY, dropAtEnd: true })
      }
      const steeperRatio = Math.max(slopeRatio, (from[1] - (roofEnvelope.wallH - 0.06)) / Math.max(0.8, horizEstimateM * 0.75))
      if (steeperRatio > slopeRatio + 0.005) {
        profiles.push({ runY: from[1], dropAtEnd: true, slopeRatio: steeperRatio })
      }
    }
    if (!isAtticStart && from[1] > startY + 0.12) {
      // High-start gravity profile: slope gently from coil pan height over low obstacles (e.g., dryer vents,
      // floor pipes, valves) and drop vertically at the exterior discharge wall.
      profiles.push({ runY: from[1], dropAtEnd: true })
      const midY = round2((from[1] + startY) / 2)
      if (midY > startY + 0.1 && midY < from[1] - 0.1) {
        profiles.push({ runY: midY, dropAtEnd: true })
      }
    }

    for (const prof of profiles) {
      for (const wp of waypointSets) {
        const cand = buildSlopedWithProfile(wp, prof.runY, prof.dropAtEnd, prof.slopeRatio ?? slopeRatio)
        const candInBounds = withinXzBounds(cand)
        if (xzBounds && !candInBounds) continue
        const candFootprintOk = isFootprintOk(cand)
        if (bestFootprintOk && !candFootprintOk) continue
        const candRoofOk = isRoofOk(cand)
        if (bestFootprintOk === candFootprintOk && bestRoofOk && !candRoofOk) continue
        const c = checkClashes(cand)
        const better =
          (!bestInBounds && candInBounds) ||
          (candInBounds === bestInBounds && !bestFootprintOk && candFootprintOk) ||
          (candInBounds === bestInBounds && candFootprintOk === bestFootprintOk && !bestRoofOk && candRoofOk) ||
          (candInBounds === bestInBounds &&
            candFootprintOk === bestFootprintOk &&
            candRoofOk === bestRoofOk &&
            c.length < clashes.length)
        if (better) {
          const slopeCheck = measureCondensateSlope(cand)
          if (!slopeCheck.hasUphillSegment && (slopeCheck.horizontalDistFt < 1.0 || slopeCheck.overallSlopeInPerFt >= minPlacementSlope)) {
            best = cand
            clashes = c
            bestRoofOk = candRoofOk
            bestInBounds = candInBounds
            bestFootprintOk = candFootprintOk
            detoured = true
            if (isDone()) break
          }
        }
      }
      if (isDone()) break
    }
  }

  if (reserveOnCommit === true && cavityContext && best.length >= 2) {
    cavityContext.occupancy.reserveRun({
      runId: runId ?? `hvac-condensate-${Math.round(from[0] * 100)}_${Math.round(to[0] * 100)}`,
      trade: 'hvac',
      path: best,
      halfXZ: 0.02,
      halfY: 0.02,
      clearanceM: 0.02,
    })
  }

  return {
    path: best,
    slopeInPerFt,
    lengthFt: round2(polylineLengthM(best) * METERS_TO_FEET),
    detoured,
    clashes,
  }
}

const sceneClearancesCache = new WeakMap<
  Readonly<Record<string, SceneNodeLike>>,
  DuctFramingClearance[]
>()

/**
 * Shared WeakMap-memoized helper collecting all framing penetrations & dropped-soffit chases
 * across every `hvac:duct-run` in the scene.
 */
export function collectSceneFramingClearances(
  nodes: Readonly<Record<string, SceneNodeLike>>,
): DuctFramingClearance[] {
  const cached = sceneClearancesCache.get(nodes)
  if (cached) return cached

  const out: DuctFramingClearance[] = []
  for (const n of Object.values(nodes)) {
    if (n.type !== 'hvac:duct-run' || !Array.isArray(n.path)) continue
    const lvlId = resolveNodeLevelId(nodes, n)
    const walls = extractWallSegments(nodes, lvlId)
    const framingContext = extractHvacFramingContext(nodes, lvlId)
    out.push(
      ...computeDuctFramingClearances({
        ductRunId: n.id,
        path: n.path as ReadonlyArray<Vec3>,
        shape: (n.shape as DuctShape) || 'round',
        widthIn: typeof n.width === 'number' ? n.width : 14,
        heightIn: typeof n.height === 'number' ? n.height : 8,
        diameterIn: typeof n.diameter === 'number' ? n.diameter : 6,
        walls,
        framingContext,
      }),
    )
  }
  sceneClearancesCache.set(nodes, out)
  return out
}
