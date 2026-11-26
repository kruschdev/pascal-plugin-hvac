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
  type DuctFramingClearance,
  type SceneNodeLike,
  type Vec3,
  belongsToLevel,
  computeDuctFramingClearances,
  extractHvacFramingContext,
  resolveNodeLevelId,
} from './framing-interop'
import { type DuctShape, INCHES_TO_METERS, METERS_TO_FEET, SQM_TO_SQFT, round2 } from './tables'

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
  let total = 0
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!
    const b = path[i]!
    total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
  }
  return total
}

export function countPathElbows(path: ReadonlyArray<Vec3>): { elbows90: number; elbows45: number } {
  let elbows90 = 0
  let elbows45 = 0
  for (let i = 1; i < path.length - 1; i++) {
    const a = path[i - 1]!
    const b = path[i]!
    const c = path[i + 1]!
    const v1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const
    const v2 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]] as const
    const l1 = Math.hypot(v1[0], v1[1], v1[2])
    const l2 = Math.hypot(v2[0], v2[1], v2[2])
    if (l1 < 1e-4 || l2 < 1e-4) continue
    const dot = Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]) / (l1 * l2)))
    const deg = (Math.acos(dot) * 180) / Math.PI
    if (deg >= 68) elbows90 += 1
    else if (deg >= 25) elbows45 += 1
  }
  return { elbows90, elbows45 }
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
  if (polygon.length < 3) return false
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i]!
    const [xj, zj] = polygon[j]!
    const intersects = zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi + 1e-12) + xi
    if (intersects) inside = !inside
  }
  return inside
}

export function polygonAreaAndCentroid(
  polygon: ReadonlyArray<readonly [number, number]>,
): { areaSqm: number; centroid: readonly [number, number] } {
  if (polygon.length < 3) return { areaSqm: 0, centroid: [0, 0] }
  let signed = 0
  let cx = 0
  let cz = 0
  for (let i = 0; i < polygon.length; i++) {
    const [x0, z0] = polygon[i]!
    const [x1, z1] = polygon[(i + 1) % polygon.length]!
    const cross = x0 * z1 - x1 * z0
    signed += cross
    cx += (x0 + x1) * cross
    cz += (z0 + z1) * cross
  }
  const area = Math.abs(signed) * 0.5
  if (area < 1e-4) {
    const avgX = polygon.reduce((s, p) => s + p[0], 0) / polygon.length
    const avgZ = polygon.reduce((s, p) => s + p[1], 0) / polygon.length
    return { areaSqm: 0, centroid: [avgX, avgZ] }
  }
  return { areaSqm: area, centroid: [cx / (3 * signed), cz / (3 * signed)] }
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

  const rooms: RoomPolygon2D[] = []
  for (const n of Object.values(nodes)) {
    if ((n.type !== 'zone' && n.type !== 'room') || !belongsToLevel(nodes, n, levelId)) continue
    const rawPoly = Array.isArray(n.polygon) ? n.polygon : null
    if (!rawPoly || rawPoly.length < 3) continue
    const poly = rawPoly.map((p) => [Number(p[0]), Number(p[1])] as const)
    const { areaSqm, centroid } = polygonAreaAndCentroid(poly)
    const label = typeof n.name === 'string' && n.name.trim() ? n.name.trim() : n.id
    const rawCat = typeof n.category === 'string' ? n.category.trim() : ''
    const fromCat = rawCat ? classifyHvacRoomName(rawCat) : 'other'
    const category = fromCat !== 'other' ? fromCat : classifyHvacRoomName(label)
    rooms.push({
      id: n.id,
      name: label,
      category,
      polygon: poly,
      centroid,
      areaSqm: round2(areaSqm),
      areaSqft: round2(areaSqm * SQM_TO_SQFT),
    })
  }
  byLevel.set(key, rooms)
  return rooms
}

export function resolveLevelHeightM(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  levelId: string | null = null,
): number {
  let maxExplicitWallH = 0
  for (const n of Object.values(nodes)) {
    if (n.type !== 'wall' || !belongsToLevel(nodes, n, levelId)) continue
    if (typeof n.height === 'number' && Number.isFinite(n.height) && n.height > 1.5) {
      if (n.height > maxExplicitWallH) maxExplicitWallH = n.height
    }
  }
  // Align with Structural roof-deck resolution: tallest explicit wall (> 1.5m) wins first
  // so perimeter walls match the true physical roof deck even when level.height differs;
  // never average short interior partitions with tall perimeter walls.
  if (maxExplicitWallH > 0) return Math.max(2.2, maxExplicitWallH)
  const lvl = levelId ? nodes[levelId] : Object.values(nodes).find((n) => n.type === 'level')
  const explicitLevelH =
    typeof lvl?.height === 'number' && Number.isFinite(lvl.height) && lvl.height > 1.5
      ? lvl.height
      : null
  if (explicitLevelH !== null) return Math.max(2.2, explicitLevelH)
  return 2.7
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
  if (!lvl) return null
  if (typeof lvl.parentId === 'string' && nodes[lvl.parentId]?.type === 'building') {
    return lvl.parentId
  }
  for (const n of Object.values(nodes)) {
    if (n.type === 'building' && Array.isArray(n.children) && n.children.includes(lvl.id)) {
      return n.id
    }
  }
  return typeof lvl.parentId === 'string' ? lvl.parentId : null
}

/**
 * Compare two sibling levels vertically.
 * Prioritizes Pascal's storey ordinal (`level` / `levelSortOrder`) before `elevation` / `baseElevation`
 * because every Pascal level carries `baseElevation: 0` by default (additive offset above stacked base).
 */
export function compareLevelsVertically(a: SceneNodeLike | undefined, b: SceneNodeLike | undefined): number {
  const primary = (l: SceneNodeLike | undefined): number => {
    if (!l) return 0
    if (typeof l.level === 'number' && Number.isFinite(l.level)) return l.level
    if (typeof l.levelSortOrder === 'number' && Number.isFinite(l.levelSortOrder)) return l.levelSortOrder
    if (typeof l.elevation === 'number' && Number.isFinite(l.elevation)) return l.elevation
    if (typeof l.baseElevation === 'number' && Number.isFinite(l.baseElevation)) return l.baseElevation
    return 0
  }
  const secondary = (l: SceneNodeLike | undefined): number => {
    if (!l) return 0
    if (typeof l.elevation === 'number' && Number.isFinite(l.elevation)) return l.elevation
    if (typeof l.baseElevation === 'number' && Number.isFinite(l.baseElevation)) return l.baseElevation
    return 0
  }
  const dp = primary(a) - primary(b)
  if (Math.abs(dp) > 1e-6) return dp
  return secondary(a) - secondary(b)
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
  const empty: LowerWalledLevelsInfo = {
    cumulativeBelowHeightM: 0,
    lowerLevelIds: [],
    groundLevelId: null,
    groundWalls: [],
    groundRooms: [],
    allLowerWalls: [],
  }
  if (!levelId) return empty
  const curLvl = nodes[levelId]
  if (!curLvl || curLvl.type !== 'level') return empty

  const all = Object.values(nodes)
  const curBldg = resolveLevelBuildingId(nodes, curLvl)
  const siblingLower = all
    .filter((o) => {
      if (o.type !== 'level' || o.id === curLvl.id) return false
      const oBldg = resolveLevelBuildingId(nodes, o)
      if (curBldg && oBldg && curBldg !== oBldg) return false
      if (compareLevelsVertically(o, curLvl) >= 0) return false
      // Exclude below-grade basements from elevating ground/upper floors above grade
      const isBasement =
        (typeof o.level === 'number' && o.level < 0) ||
        (typeof o.baseElevation === 'number' && o.baseElevation < -0.5) ||
        (typeof o.elevation === 'number' && o.elevation < -0.5)
      if (isBasement) return false
      return all.some((w) => w.type === 'wall' && belongsToLevel(nodes, w, o.id))
    })
    .sort((a, b) => compareLevelsVertically(a, b))

  if (siblingLower.length === 0) return empty

  let cumulativeBelowHeightM = 0
  const lowerLevelIds: string[] = []
  const allLowerWalls: WallSegment2D[] = []
  for (const lower of siblingLower) {
    lowerLevelIds.push(lower.id)
    cumulativeBelowHeightM += resolveLevelHeightM(nodes, lower.id)
    allLowerWalls.push(...extractWallSegments(nodes, lower.id))
  }
  const groundLevelId = siblingLower[0]!.id
  return {
    cumulativeBelowHeightM: round2(cumulativeBelowHeightM),
    lowerLevelIds,
    groundLevelId,
    groundWalls: extractWallSegments(nodes, groundLevelId),
    groundRooms: extractRoomPolygons(nodes, groundLevelId),
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
  if (lenSq < 1e-10) {
    return { dist: Math.hypot(px - ax, pz - az), t: 0, closestX: ax, closestZ: az }
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq))
  const closestX = ax + dx * t
  const closestZ = az + dz * t
  return { dist: Math.hypot(px - closestX, pz - closestZ), t, closestX, closestZ }
}

// 8 ray directions (4 near-cardinal + 4 near-diagonal) with tiny angular jitter so rays never
// run collinearly along axis-aligned wall segments.
const ENCLOSURE_RAYS: ReadonlyArray<readonly [number, number]> = [
  [Math.cos(0.0017), Math.sin(0.0017)],
  [Math.cos(Math.PI / 4 + 0.0019), Math.sin(Math.PI / 4 + 0.0019)],
  [Math.cos(Math.PI / 2 + 0.0023), Math.sin(Math.PI / 2 + 0.0023)],
  [Math.cos((3 * Math.PI) / 4 + 0.0029), Math.sin((3 * Math.PI) / 4 + 0.0029)],
  [Math.cos(Math.PI + 0.0031), Math.sin(Math.PI + 0.0031)],
  [Math.cos((5 * Math.PI) / 4 + 0.0037), Math.sin((5 * Math.PI) / 4 + 0.0037)],
  [Math.cos((3 * Math.PI) / 2 + 0.0041), Math.sin((3 * Math.PI) / 2 + 0.0041)],
  [Math.cos((7 * Math.PI) / 4 + 0.0043), Math.sin((7 * Math.PI) / 4 + 0.0043)],
]

function rayHitsSegment2D(
  ox: number,
  oz: number,
  rdx: number,
  rdz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  extM = 0.05,
): boolean {
  const sdx = bx - ax
  const sdz = bz - az
  const len = Math.hypot(sdx, sdz)
  if (len < 1e-6) return false
  const padT = extM / len
  const denom = rdx * sdz - rdz * sdx
  if (Math.abs(denom) < 1e-10) return false
  const qx = ax - ox
  const qz = az - oz
  const t = (qx * sdz - qz * sdx) / denom
  if (t < -1e-4) return false
  const u = (qx * rdz - qz * rdx) / denom
  return u >= -padT && u <= 1 + padT
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
  let inInteriorRoom = false
  let inExteriorRoom = false
  for (const r of rooms) {
    if (!pointInPolygon2D(x, z, r.polygon)) continue
    if (r.category === 'exterior') inExteriorRoom = true
    else inInteriorRoom = true
  }
  if (inInteriorRoom) return true
  if (inExteriorRoom) return false

  if (walls.length >= 3) {
    for (const [rdx, rdz] of ENCLOSURE_RAYS) {
      let hit = false
      for (const w of walls) {
        if (rayHitsSegment2D(x, z, rdx, rdz, w.start[0], w.start[1], w.end[0], w.end[1], 0.05)) {
          hit = true
          break
        }
      }
      if (!hit) return false
    }
    return true
  }

  return rooms.length === 0
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
  let inInteriorRoom = false
  let inExteriorRoom = false
  for (const r of rooms) {
    if (!pointInPolygon2D(x, z, r.polygon)) continue
    if (r.category === 'exterior') inExteriorRoom = true
    else inInteriorRoom = true
  }
  if (inInteriorRoom) return true
  if (inExteriorRoom) return false

  if (walls.length >= 3) {
    if (wallProximityM > 0) {
      for (const w of walls) {
        const { dist } = distancePointToSegment2D(x, z, w.start[0], w.start[1], w.end[0], w.end[1])
        if (dist <= wallProximityM) return true
      }
    }
    for (const [rdx, rdz] of ENCLOSURE_RAYS) {
      let hit = false
      for (const w of walls) {
        if (rayHitsSegment2D(x, z, rdx, rdz, w.start[0], w.start[1], w.end[0], w.end[1], 0.05)) {
          hit = true
          break
        }
      }
      if (!hit) return false
    }
    return true
  }

  return rooms.length === 0
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
  roofYAt: (x: number, z: number) => number
}

/**
 * Compute the pitched attic roof plane `roofYAt(x, z)` matching structural gable geometry
 * (and tightening to any explicit `roof-segment` nodes on the target level).
 */
export function buildAtticRoofEnvelope(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  levelId: string | null,
  bounds: XzBounds2D,
  wallH: number,
): AtticRoofEnvelope {
  const all = Object.values(nodes)
  const levels = all.filter((n) => n.type === 'level')
  const curLvl = levelId ? nodes[levelId] : levels[0]
  const curBuildingId = resolveLevelBuildingId(nodes, curLvl)
  const hasRoofAbove = !levels.some((o) => {
    if (!curLvl || o.id === curLvl.id) return false
    const oBldg = resolveLevelBuildingId(nodes, o)
    if (curBuildingId && oBldg && curBuildingId !== oBldg) return false
    return compareLevelsVertically(o, curLvl) > 0 && all.some((w) => w.type === 'wall' && belongsToLevel(nodes, w, o.id))
  })

  const assembly = all.find((n) => n.type === 'structural:assembly' && belongsToLevel(nodes, n, levelId))
  const pitchRiseOver12 =
    typeof assembly?.roofPitchRise === 'number' && Number.isFinite(assembly.roofPitchRise) && assembly.roofPitchRise > 0
      ? assembly.roofPitchRise
      : 6

  const spanX = Math.max(0.5, bounds.maxX - bounds.minX)
  const spanZ = Math.max(0.5, bounds.maxZ - bounds.minZ)
  const ridgeAlongX = spanX >= spanZ
  const halfSpan = (ridgeAlongX ? spanZ : spanX) / 2
  const center = ridgeAlongX ? (bounds.minZ + bounds.maxZ) / 2 : (bounds.minX + bounds.maxX) / 2

  type ExplicitRoofSeg = {
    cx: number
    cz: number
    cosR: number
    sinR: number
    effW: number
    effD: number
    width: number
    depth: number
    overhangM: number
    eaveY: number
    pitchRad: number
    slopeTan: number
    roofType: string
  }
  const unwalledUpperLevelIds = new Set<string>()
  if (hasRoofAbove && curLvl) {
    for (const o of levels) {
      if (o.id === curLvl.id) continue
      const oBldg = resolveLevelBuildingId(nodes, o)
      if (curBuildingId && oBldg && curBuildingId !== oBldg) continue
      const oHasWalls = all.some((w) => w.type === 'wall' && belongsToLevel(nodes, w, o.id))
      if (!oHasWalls && compareLevelsVertically(o, curLvl) >= 0) {
        unwalledUpperLevelIds.add(o.id)
      }
    }
  }
  const explicitSegs: ExplicitRoofSeg[] = []
  for (const n of all) {
    if (n.type !== 'roof-segment' || n.visible === false) continue
    let inScope = belongsToLevel(nodes, n, levelId)
    if (!inScope && unwalledUpperLevelIds.size > 0) {
      for (const uid of unwalledUpperLevelIds) {
        if (belongsToLevel(nodes, n, uid)) {
          inScope = true
          break
        }
      }
    }
    if (!inScope) continue
    let wx = Array.isArray(n.position) ? Number(n.position[0] ?? 0) : 0
    let wy = Array.isArray(n.position) ? Number(n.position[1] ?? 0) : 0
    let wz = Array.isArray(n.position) ? Number(n.position[2] ?? 0) : 0
    let rot = typeof n.rotation === 'number' ? n.rotation : 0
    const parent = n.parentId ? nodes[n.parentId] : undefined
    if (parent && parent.type === 'roof') {
      const pRot = typeof parent.rotation === 'number' ? parent.rotation : 0
      const pc = Math.cos(pRot)
      const ps = Math.sin(pRot)
      const px = Array.isArray(parent.position) ? Number(parent.position[0] ?? 0) : 0
      const py = Array.isArray(parent.position) ? Number(parent.position[1] ?? 0) : 0
      const pz = Array.isArray(parent.position) ? Number(parent.position[2] ?? 0) : 0
      const rx = wx * pc + wz * ps
      const rz = -wx * ps + wz * pc
      wx = px + rx
      wy = py + wy
      wz = pz + rz
      rot += pRot
    }
    const width = typeof n.width === 'number' && n.width > 0.2 ? n.width : 6
    const depth = typeof n.depth === 'number' && n.depth > 0.2 ? n.depth : 6
    const roofType = typeof n.roofType === 'string' ? n.roofType : 'gable'
    const rawPitch = typeof n.pitch === 'number' && Number.isFinite(n.pitch) ? n.pitch : 26.57
    const pitchRad =
      rawPitch <= 0
        ? 0
        : rawPitch > 1.4
          ? (Math.min(65, rawPitch) * Math.PI) / 180
          : Math.min((65 * Math.PI) / 180, rawPitch)
    const overhangM = typeof n.overhang === 'number' && n.overhang >= 0 ? n.overhang : 0.35
    const segWallH = typeof n.wallHeight === 'number' && Number.isFinite(n.wallHeight) ? n.wallHeight : 0
    const eaveY = wy > 0.05 ? wy + segWallH : wallH + segWallH
    const swapAxes = (roofType === 'hip' || roofType === 'dutch' || roofType === 'mansard') && width < depth
    const effYaw = swapAxes ? rot + Math.PI / 2 : rot
    const effW = swapAxes ? depth : width
    const effD = swapAxes ? width : depth
    explicitSegs.push({
      cx: wx,
      cz: wz,
      cosR: Math.cos(effYaw),
      sinR: Math.sin(effYaw),
      effW,
      effD,
      width,
      depth,
      overhangM,
      eaveY,
      pitchRad,
      slopeTan: roofType === 'flat' || pitchRad <= 0.008 ? 0 : Math.tan(pitchRad),
      roofType,
    })
  }

  const roofYAt = (x: number, z: number): number => {
    const distFromRidge = Math.abs((ridgeAlongX ? z : x) - center)
    const riseM = Math.max(0, halfSpan - distFromRidge) * (pitchRiseOver12 / 12)
    const fallbackY = wallH + riseM
    if (explicitSegs.length > 0) {
      let bestSegY: number | null = null
      for (const seg of explicitSegs) {
        const dx = x - seg.cx
        const dz = z - seg.cz
        const lx = dx * seg.cosR - dz * seg.sinR
        const lz = dx * seg.sinR + dz * seg.cosR
        let sy: number
        if (seg.roofType === 'conical') {
          const r = Math.min(seg.width, seg.depth) / 2
          const dist = Math.hypot(lx, lz)
          if (dist > r + seg.overhangM + 0.15) continue
          sy = seg.eaveY + Math.max(0, r - dist) * seg.slopeTan
        } else {
          const padX =
            seg.roofType === 'hip' || seg.roofType === 'dutch' || seg.roofType === 'mansard'
              ? seg.overhangM + 0.15
              : 0.15
          if (Math.abs(lx) > seg.effW / 2 + padX || Math.abs(lz) > seg.effD / 2 + seg.overhangM + 0.15) {
            continue
          }
          if (seg.roofType === 'flat' || seg.pitchRad <= 0.008) {
            sy = seg.eaveY
          } else if (seg.roofType === 'shed') {
            sy = seg.eaveY + Math.max(0, seg.effD / 2 - lz) * seg.slopeTan
          } else if (seg.roofType === 'hip' || seg.roofType === 'dutch') {
            const halfW = seg.effW / 2
            const halfD = seg.effD / 2
            const hipRise = seg.roofType === 'dutch' ? Math.min(halfD * seg.slopeTan, halfD * 1.35) : halfD * seg.slopeTan
            const effTan = hipRise / Math.max(0.1, halfD)
            const dMin = Math.min(halfW - Math.abs(lx), halfD - Math.abs(lz))
            sy = seg.eaveY + Math.min(hipRise, Math.max(0, dMin) * effTan)
          } else if (seg.roofType === 'mansard') {
            const halfW = seg.effW / 2
            const halfD = seg.effD / 2
            const inset = Math.min(seg.effW, seg.effD) * 0.18
            const manRise = Math.min(2.2, Math.max(0.25, inset * seg.slopeTan))
            const dMin = Math.min(halfW - Math.abs(lx), halfD - Math.abs(lz))
            sy = seg.eaveY + Math.min(manRise, Math.max(0, dMin) * (manRise / Math.max(0.1, inset)))
          } else {
            sy = seg.eaveY + Math.max(0, seg.effD / 2 - Math.abs(lz)) * seg.slopeTan
          }
        }
        if (bestSegY === null || sy > bestSegY) bestSegY = sy
      }
      if (bestSegY !== null) return Math.min(fallbackY, bestSegY)
    }
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
  clearanceM = 0.08,
): boolean {
  if (!roof.hasRoofAbove) return true
  const { bounds, wallH, roofYAt } = roof
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!
    const b = path[i + 1]!
    if (Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) < 0.02) continue
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      const px = a[0] + (b[0] - a[0]) * f
      const py = a[1] + (b[1] - a[1]) * f
      const pz = a[2] + (b[2] - a[2]) * f
      if (px < bounds.minX - 0.1 || px > bounds.maxX + 0.1 || pz < bounds.minZ - 0.1 || pz > bounds.maxZ + 0.1) {
        continue
      }
      if (py > wallH + 0.05 && py + halfH > roofYAt(px, pz) - clearanceM) {
        return false
      }
    }
  }
  return true
}

function parseNominalIn(raw: unknown): number {
  if (typeof raw === 'number' && raw > 0) return raw
  if (typeof raw !== 'string') return 2
  const cleaned = raw.replace(/"/g, '').trim()
  if (cleaned.includes('-')) {
    const [whole, frac] = cleaned.split('-')
    const [num, den] = (frac ?? '').split('/')
    if (whole && num && den) return Number(whole) + Number(num) / Number(den)
  }
  if (cleaned.includes('/')) {
    const [num, den] = cleaned.split('/')
    if (num && den) return Number(num) / Number(den)
  }
  const n = Number(cleaned)
  return Number.isFinite(n) && n > 0 ? n : 2
}

const obstacleCache = new WeakMap<
  Readonly<Record<string, SceneNodeLike>>,
  Map<string, HvacObstacle[]>
>()

/**
 * Extract Priority #1 Structural obstacles, Priority #2 Plumbing obstacles (`plumbing:pipe-run`,
 * `plumbing:equipment`, `plumbing:manifold`), AND NEC 110.26(E) Dedicated Electrical Space columns.
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

  const obstacles: HvacObstacle[] = []
  const levelH = resolveLevelHeightM(nodes, levelId)

  const pushBeamSubBoxes = (
    id: string,
    label: string,
    sx: number,
    sz: number,
    ex: number,
    ez: number,
    w: number,
    y: number,
    h: number,
  ) => {
    const dx = Math.abs(ex - sx)
    const dz = Math.abs(ez - sz)
    const isDiagonal = dx > 0.2 && dz > 0.2
    const steps = isDiagonal ? Math.min(8, Math.max(3, Math.ceil(Math.hypot(dx, dz) / 0.5))) : 1
    for (let s = 0; s < steps; s++) {
      const t0 = s / steps
      const t1 = (s + 1) / steps
      const x0 = sx + (ex - sx) * t0
      const z0 = sz + (ez - sz) * t0
      const x1 = sx + (ex - sx) * t1
      const z1 = sz + (ez - sz) * t1
      obstacles.push({
        id: steps === 1 ? id : `${id}:seg${s}`,
        nodeId: id,
        category: 'structural',
        label,
        box: {
          minX: Math.min(x0, x1) - w / 2,
          maxX: Math.max(x0, x1) + w / 2,
          minY: y - h / 2,
          maxY: y + h / 2,
          minZ: Math.min(z0, z1) - w / 2,
          maxZ: Math.max(z0, z1) + w / 2,
        },
      })
    }
  }

  const readYaw = (rotation: unknown): number =>
    typeof rotation === 'number'
      ? rotation
      : Array.isArray(rotation) && typeof rotation[1] === 'number'
        ? rotation[1]
        : 0

  for (const n of Object.values(nodes)) {
    if (!belongsToLevel(nodes, n, levelId)) continue
    const pos =
      Array.isArray(n.position) && n.position.length >= 3
        ? ([Number(n.position[0]), Number(n.position[1]), Number(n.position[2])] as Vec3)
        : null

    // 1. Structural (Priority #1)
    if (n.type === 'structural:column' && pos) {
      const w = (typeof n.widthIn === 'number' ? n.widthIn : 5.5) * INCHES_TO_METERS
      const d = (typeof n.depthIn === 'number' ? n.depthIn : 5.5) * INCHES_TO_METERS
      const h = typeof n.heightM === 'number' ? n.heightM : levelH
      const rot = readYaw(n.rotation)
      const cosR = Math.abs(Math.cos(rot))
      const sinR = Math.abs(Math.sin(rot))
      const halfX = (w * cosR + d * sinR) / 2
      const halfZ = (w * sinR + d * cosR) / 2
      obstacles.push({
        id: n.id,
        nodeId: n.id,
        category: 'structural',
        label: `Structural column (${n.name ?? n.id})`,
        box: { minX: pos[0] - halfX, maxX: pos[0] + halfX, minY: pos[1], maxY: pos[1] + h, minZ: pos[2] - halfZ, maxZ: pos[2] + halfZ },
      })
    } else if (n.type === 'structural:beam' && Array.isArray(n.start) && Array.isArray(n.end)) {
      const sx = Number(n.start[0])
      const sz = Number(n.start.length >= 3 ? n.start[2] : n.start[1])
      const ex = Number(n.end[0])
      const ez = Number(n.end.length >= 3 ? n.end[2] : n.end[1])
      const w = (typeof n.widthIn === 'number' ? n.widthIn : 3.5) * INCHES_TO_METERS
      const h = (typeof n.depthIn === 'number' ? n.depthIn : 11.875) * INCHES_TO_METERS
      const y =
        typeof n.elevationY === 'number'
          ? Number(n.elevationY)
          : typeof n.elevation === 'number'
            ? Number(n.elevation)
            : n.start.length >= 3
              ? Number(n.start[1])
              : levelH - h / 2
      pushBeamSubBoxes(n.id, `Structural beam (${n.name ?? n.id})`, sx, sz, ex, ez, w, y, h)
    } else if (n.type === 'column' && pos) {
      const w = typeof n.width === 'number' ? n.width : 0.25
      const d = typeof n.depth === 'number' ? n.depth : 0.25
      const h = typeof n.height === 'number' ? n.height : levelH
      const rot = readYaw(n.rotation)
      const cosR = Math.abs(Math.cos(rot))
      const sinR = Math.abs(Math.sin(rot))
      const halfX = (w * cosR + d * sinR) / 2
      const halfZ = (w * sinR + d * cosR) / 2
      obstacles.push({
        id: n.id,
        nodeId: n.id,
        category: 'structural',
        label: `Column (${n.name ?? n.id})`,
        box: { minX: pos[0] - halfX, maxX: pos[0] + halfX, minY: pos[1], maxY: pos[1] + h, minZ: pos[2] - halfZ, maxZ: pos[2] + halfZ },
      })
    } else if (n.type === 'beam' && Array.isArray(n.start) && Array.isArray(n.end)) {
      const sx = Number(n.start[0])
      const sz = Number(n.start[1])
      const ex = Number(n.end[0])
      const ez = Number(n.end[1])
      const w = typeof n.width === 'number' ? n.width : 0.2
      const h = typeof n.height === 'number' ? n.height : 0.3
      const y = typeof n.elevation === 'number' ? Number(n.elevation) : levelH - h / 2
      pushBeamSubBoxes(n.id, `Beam (${n.name ?? n.id})`, sx, sz, ex, ez, w, y, h)
    } else if (n.type === 'plumbing:pipe-run' && Array.isArray(n.path) && n.path.length >= 2) {
      // 2. Plumbing (Priority #2 — gravity DWV & supply right-of-way)
      // Subdivide diagonal segments into tighter sub-AABBs so angled runs never cast phantom boxes.
      const diamIn = parseNominalIn(n.nominalSize)
      const r = Math.max(0.02, (diamIn * INCHES_TO_METERS) / 2)
      for (let i = 1; i < n.path.length; i++) {
        const a = n.path[i - 1]!
        const b = n.path[i]!
        const dx = Math.abs(b[0] - a[0])
        const dz = Math.abs(b[2] - a[2])
        const isDiagonal = dx > 0.2 && dz > 0.2
        const steps = isDiagonal ? Math.min(8, Math.max(3, Math.ceil(Math.hypot(dx, dz) / 0.45))) : 1
        for (let s = 0; s < steps; s++) {
          const t0 = s / steps
          const t1 = (s + 1) / steps
          const p0: Vec3 = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0, a[2] + (b[2] - a[2]) * t0]
          const p1: Vec3 = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1, a[2] + (b[2] - a[2]) * t1]
          obstacles.push({
            id: steps === 1 ? `${n.id}:seg${i - 1}` : `${n.id}:seg${i - 1}_${s}`,
            nodeId: n.id,
            category: 'plumbing',
            label: `Plumbing ${String(n.nominalSize ?? '2"')} ${String(n.system ?? 'pipe')} (${n.id})`,
            box: {
              minX: Math.min(p0[0], p1[0]) - r,
              maxX: Math.max(p0[0], p1[0]) + r,
              minY: Math.min(p0[1], p1[1]) - r,
              maxY: Math.max(p0[1], p1[1]) + r,
              minZ: Math.min(p0[2], p1[2]) - r,
              maxZ: Math.max(p0[2], p1[2]) + r,
            },
          })
        }
      }
    } else if (n.type === 'plumbing:manifold' && pos) {
      // Center-anchored wall-mounted manifold (0.48m x 0.70m x 0.48m)
      const halfW = 0.24
      obstacles.push({
        id: n.id,
        nodeId: n.id,
        category: 'plumbing',
        label: `Plumbing manifold (${n.name ?? n.id})`,
        box: {
          minX: pos[0] - halfW,
          maxX: pos[0] + halfW,
          minY: pos[1] - 0.35,
          maxY: pos[1] + 0.35,
          minZ: pos[2] - halfW,
          maxZ: pos[2] + halfW,
        },
      })
    } else if (n.type === 'plumbing:equipment' && pos) {
      const eqKind = typeof n.equipmentKind === 'string' ? n.equipmentKind : ''
      const isCompact =
        eqKind === 'expansion-tank' ||
        eqKind === 'sump-pump' ||
        eqKind === 'main-shutoff-prv' ||
        eqKind === 'gas-meter'
      const isTankless = eqKind.startsWith('water-heater-tankless')
      const w = isCompact ? 0.32 : isTankless ? 0.45 : 0.6
      const d = isCompact ? 0.32 : isTankless ? 0.3 : 0.6
      const h = isCompact ? 0.45 : isTankless ? 0.65 : 1.55
      const rot = readYaw(n.rotation)
      const cosR = Math.abs(Math.cos(rot))
      const sinR = Math.abs(Math.sin(rot))
      const halfX = (w * cosR + d * sinR) / 2
      const halfZ = (w * sinR + d * cosR) / 2
      obstacles.push({
        id: n.id,
        nodeId: n.id,
        category: 'plumbing',
        label: `Plumbing equipment (${n.name ?? n.id})`,
        box: {
          minX: pos[0] - halfX,
          maxX: pos[0] + halfX,
          minY: pos[1],
          maxY: pos[1] + h,
          minZ: pos[2] - halfZ,
          maxZ: pos[2] + halfZ,
        },
      })
    } else if (n.type === 'electrical:panel' && pos) {
      // NEC 110.26(E)(1)(a): Dedicated electrical space from floor (minY = 0) to 6 ft above panel
      const w = typeof n.width === 'number' ? n.width : 0.42
      const d = typeof n.depth === 'number' ? n.depth : 0.16
      const rot = readYaw(n.rotation)
      const cosR = Math.abs(Math.cos(rot))
      const sinR = Math.abs(Math.sin(rot))
      const halfX = (w * cosR + d * sinR) / 2 + 0.03
      const halfZ = (w * sinR + d * cosR) / 2 + 0.03
      const panelTopY = pos[1] + (typeof n.height === 'number' ? n.height / 2 : 0.46)
      obstacles.push({
        id: n.id,
        nodeId: n.id,
        category: 'electrical-dedicated-space',
        label: `NEC 110.26(E) Dedicated Space (${n.name ?? n.id})`,
        box: {
          minX: pos[0] - halfX,
          maxX: pos[0] + halfX,
          minY: 0,
          maxY: Math.max(levelH + 0.6, panelTopY + 1.83),
          minZ: pos[2] - halfZ,
          maxZ: pos[2] + halfZ,
        },
      })
      // NEC 110.26(A): 36" (0.914m) deep x 30" (0.762m) wide x 78" (1.981m) tall working space in front of panel
      const fx = Math.sin(rot)
      const fz = Math.cos(rot)
      const tx = Math.cos(rot)
      const tz = -Math.sin(rot)
      const wsDepth = 0.914
      const wsHalfW = Math.max(0.762, w) / 2
      const fcX = pos[0] + fx * (d / 2)
      const fcZ = pos[2] + fz * (d / 2)
      const farX = fcX + fx * wsDepth
      const farZ = fcZ + fz * wsDepth
      const c0x = fcX - tx * wsHalfW
      const c1x = fcX + tx * wsHalfW
      const c2x = farX - tx * wsHalfW
      const c3x = farX + tx * wsHalfW
      const c0z = fcZ - tz * wsHalfW
      const c1z = fcZ + tz * wsHalfW
      const c2z = farZ - tz * wsHalfW
      const c3z = farZ + tz * wsHalfW
      obstacles.push({
        id: `${n.id}:working-space`,
        nodeId: n.id,
        category: 'electrical-working-space',
        label: `NEC 110.26(A) Working Space (${n.name ?? n.id})`,
        box: {
          minX: Math.min(c0x, c1x, c2x, c3x),
          maxX: Math.max(c0x, c1x, c2x, c3x),
          minY: 0,
          maxY: Math.max(1.981, panelTopY),
          minZ: Math.min(c0z, c1z, c2z, c3z),
          maxZ: Math.max(c0z, c1z, c2z, c3z),
        },
      })
    } else if (n.type === 'electrical:transformer' && pos) {
      // NEC 110.26(E): Dry-type transformer footprint & overhead dedicated space
      const w = typeof n.width === 'number' ? n.width : 0.76
      const d = typeof n.depth === 'number' ? n.depth : 0.64
      const rot = readYaw(n.rotation)
      const cosR = Math.abs(Math.cos(rot))
      const sinR = Math.abs(Math.sin(rot))
      const halfX = (w * cosR + d * sinR) / 2 + 0.03
      const halfZ = (w * sinR + d * cosR) / 2 + 0.03
      const topY = pos[1] + (typeof n.height === 'number' ? n.height : 0.95)
      obstacles.push({
        id: n.id,
        nodeId: n.id,
        category: 'electrical-dedicated-space',
        label: `NEC 110.26(E) Dedicated Space (${n.name ?? n.id})`,
        box: {
          minX: pos[0] - halfX,
          maxX: pos[0] + halfX,
          minY: 0,
          maxY: Math.max(levelH + 0.6, topY + 1.83),
          minZ: pos[2] - halfZ,
          maxZ: pos[2] + halfZ,
        },
      })
    }
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
  const [mx, my, mz] = typeof margin === 'number' ? [margin, margin, margin] : margin
  const mins = [box.minX - mx, box.minY - my, box.minZ - mz] as const
  const maxs = [box.maxX + mx, box.maxY + my, box.maxZ + mz] as const
  const dirs = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const
  const starts = [a[0], a[1], a[2]] as const

  let tMin = 0
  let tMax = 1
  for (let axis = 0; axis < 3; axis++) {
    const d = dirs[axis]!
    const s = starts[axis]!
    if (Math.abs(d) < 1e-8) {
      if (s < mins[axis]! || s > maxs[axis]!) return false
    } else {
      let t1 = (mins[axis]! - s) / d
      let t2 = (maxs[axis]! - s) / d
      if (t1 > t2) [t1, t2] = [t2, t1]
      tMin = Math.max(tMin, t1)
      tMax = Math.min(tMax, t2)
      if (tMin > tMax) return false
    }
  }
  return true
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
      if (segmentIntersectsAabb(a, b, obs.box, margin3)) {
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

/**
 * Route an HVAC duct, exhaust run, or refrigerant lineset in the target plenum plane (`attic` / `crawlspace` / `basement`),
 * automatically detouring around Priority #1 Structural, Priority #2 Plumbing, and NEC 110.26(E) panel columns,
 * while staying within `xzBounds` (when provided) and strictly beneath `roofEnvelope` (when routing in an attic).
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
  const roofSoffitY = roofEnvelope ? round2(roofEnvelope.wallH - Math.max(0.08, ductHalfV + 0.04)) : plenumY

  const isRoofOk = (cand: ReadonlyArray<Vec3>): boolean =>
    !hasPitchedRoof || !roofEnvelope ? true : pathClearOfRoof(cand, roofEnvelope, ductHalfV, 0.08)

  const stepUnderRoof = (pts: Vec3[], y: number): Vec3[] => {
    if (!hasPitchedRoof || !roofEnvelope || y <= roofEnvelope.wallH + 0.05) return pts
    if (pathClearOfRoof(pts, roofEnvelope, ductHalfV, 0.08)) return pts

    const safeHalf = safeRoofCorridorHalfWidth(roofEnvelope, y, ductHalfV, 0.1)
    const lo = roofEnvelope.center - safeHalf
    const hi = roofEnvelope.center + safeHalf
    const alongX = roofEnvelope.ridgeAlongX
    const fromPerp = alongX ? from[2] : from[0]
    const toPerp = alongX ? to[2] : to[0]

    const safeEndY = (pt: Vec3): number => {
      const cap = roofEnvelope.roofYAt(pt[0], pt[2]) - ductHalfV - 0.09
      if (cap <= roofEnvelope.wallH + 0.05) return Math.min(y, roofSoffitY)
      return Math.min(y, round2(cap))
    }

    const fromSafeY = safeEndY(from)
    const toSafeY = safeEndY(to)

    // If corridor has no width at y, or both ends sit outside the same eave side, route cleanly at soffit/safe height
    if (safeHalf < 0.15 || (fromPerp < lo && toPerp < lo) || (fromPerp > hi && toPerp > hi)) {
      const lowY = Math.min(fromSafeY, toSafeY, roofSoffitY)
      return cleanPath(
        pts.map((p, idx) =>
          idx === 0 || idx === pts.length - 1 ? p : ([p[0], Math.min(p[1], lowY), p[2]] as Vec3),
        ),
      )
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
    return cleanPath(out)
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
}): {
  path: Vec3[]
  slopeInPerFt: number
  lengthFt: number
  detoured: boolean
  clashes: HvacObstacle[]
} {
  const { from, to, obstacles = [], xzBounds, roofEnvelope, footprintContains } = params
  const slopeInPerFt =
    typeof params.slopeInPerFt === 'number' && Number.isFinite(params.slopeInPerFt)
      ? Math.max(0.13, Math.min(1.0, params.slopeInPerFt))
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
          if (!slopeCheck.hasUphillSegment && (slopeCheck.horizontalDistFt < 1.0 || slopeCheck.overallSlopeInPerFt >= 0.125)) {
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
