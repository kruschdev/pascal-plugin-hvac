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
  category: 'structural' | 'plumbing' | 'electrical-dedicated-space'
  label: string
  box: Aabb3
}

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
    | 'laundry'
    | 'office'
    | 'garage'
    | 'exterior'
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
  if (/bed|master|primary|nursery|guest/.test(s)) return 'bedroom'
  if (/bath|powder|restroom|wc|toilet/.test(s)) return 'bathroom'
  if (/kitchen|pantry/.test(s)) return 'kitchen'
  if (/hall|corridor|foyer|entry/.test(s)) return 'hallway'
  if (/utility|mech|furnace|closet|storage/.test(s)) return 'utility'
  if (/laundry|mudroom/.test(s)) return 'laundry'
  if (/office|study|den/.test(s)) return 'office'
  if (/garage|carport/.test(s)) return 'garage'
  if (/porch|patio|deck|balcony|yard|exterior/.test(s)) return 'exterior'
  if (/living|great|family|dining|open|suite|conference/.test(s)) return 'living'
  return 'other'
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
    rooms.push({
      id: n.id,
      name: label,
      category: classifyHvacRoomName(label),
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
  const walls = extractWallSegments(nodes, levelId)
  if (walls.length === 0) return 2.6
  return Math.max(2.2, walls.reduce((s, w) => s + w.heightM, 0) / walls.length)
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
      obstacles.push({
        id: n.id,
        category: 'structural',
        label: `Structural column (${n.name ?? n.id})`,
        box: { minX: pos[0] - w / 2, maxX: pos[0] + w / 2, minY: pos[1], maxY: pos[1] + h, minZ: pos[2] - d / 2, maxZ: pos[2] + d / 2 },
      })
    } else if (n.type === 'structural:beam' && Array.isArray(n.start) && Array.isArray(n.end)) {
      const sx = Number(n.start[0])
      const sz = Number(n.start[1])
      const ex = Number(n.end[0])
      const ez = Number(n.end[1])
      const w = (typeof n.widthIn === 'number' ? n.widthIn : 3.5) * INCHES_TO_METERS
      const h = (typeof n.depthIn === 'number' ? n.depthIn : 11.875) * INCHES_TO_METERS
      const y = typeof n.elevationY === 'number' ? Number(n.elevationY) : levelH - h / 2
      pushBeamSubBoxes(n.id, `Structural beam (${n.name ?? n.id})`, sx, sz, ex, ez, w, y, h)
    } else if (n.type === 'column' && pos) {
      const w = typeof n.width === 'number' ? n.width : 0.25
      const d = typeof n.depth === 'number' ? n.depth : 0.25
      const h = typeof n.height === 'number' ? n.height : levelH
      obstacles.push({
        id: n.id,
        category: 'structural',
        label: `Column (${n.name ?? n.id})`,
        box: { minX: pos[0] - w / 2, maxX: pos[0] + w / 2, minY: pos[1], maxY: pos[1] + h, minZ: pos[2] - d / 2, maxZ: pos[2] + d / 2 },
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
    } else if ((n.type === 'plumbing:equipment' || n.type === 'plumbing:manifold') && pos) {
      const halfW = n.type === 'plumbing:manifold' ? 0.24 : 0.30
      const h = n.type === 'plumbing:manifold' ? 0.7 : 1.55
      obstacles.push({
        id: n.id,
        category: 'plumbing',
        label: `Plumbing ${n.type === 'plumbing:manifold' ? 'manifold' : 'equipment'} (${n.name ?? n.id})`,
        box: {
          minX: pos[0] - halfW,
          maxX: pos[0] + halfW,
          minY: pos[1],
          maxY: pos[1] + h,
          minZ: pos[2] - halfW,
          maxZ: pos[2] + halfW,
        },
      })
    } else if ((n.type === 'electrical:panel' || n.type === 'electrical:transformer') && pos) {
      // NEC 110.26(E)(1)(a): Dedicated electrical space from floor (minY = 0) to 6 ft above panel
      const w = typeof n.width === 'number' ? n.width : 0.42
      const d = typeof n.depth === 'number' ? n.depth : 0.16
      const rot = typeof n.rotation === 'number' ? n.rotation : 0
      const cosR = Math.abs(Math.cos(rot))
      const sinR = Math.abs(Math.sin(rot))
      const halfX = (w * cosR + d * sinR) / 2 + 0.03
      const halfZ = (w * sinR + d * cosR) / 2 + 0.03
      const panelTopY = pos[1] + (typeof n.height === 'number' ? n.height / 2 : 0.46)
      obstacles.push({
        id: n.id,
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
    }
  }
  byLevel.set(key, obstacles)
  return obstacles
}

export function segmentIntersectsAabb(a: Vec3, b: Vec3, box: Aabb3, margin = 0.03): boolean {
  const mins = [box.minX - margin, box.minY - margin, box.minZ - margin] as const
  const maxs = [box.maxX + margin, box.maxY + margin, box.maxZ + margin] as const
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
  ductHalfSpanM = 0.08,
): HvacObstacle[] {
  const hits: HvacObstacle[] = []
  const seen = new Set<string>()
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!
    const b = path[i]!
    for (const obs of obstacles) {
      if (seen.has(obs.id)) continue
      if (segmentIntersectsAabb(a, b, obs.box, ductHalfSpanM + 0.02)) {
        seen.add(obs.id)
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
 * automatically detouring around Priority #1 Structural, Priority #2 Plumbing, and NEC 110.26(E) panel columns.
 */
export function routeHvacDuctRun(params: {
  from: Vec3
  to: Vec3
  plenumY: number
  ductHalfSpanM?: number
  allowDiagonalBranch?: boolean
  obstacles?: ReadonlyArray<HvacObstacle>
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
    ductHalfSpanM = 0.08,
    allowDiagonalBranch = false,
    obstacles = [],
  } = params

  const buildCand = (mode: 'x' | 'z' | 'diag' | 'ux' | 'uz', offsetM = 0, yOffset = 0): Vec3[] => {
    const y = plenumY + yOffset
    const sP: Vec3 = [from[0], y, from[2]]
    const eP: Vec3 = [to[0], y, to[2]]
    if (mode === 'ux') {
      return cleanPath([from, sP, [from[0] + offsetM, y, from[2]], [from[0] + offsetM, y, to[2]], eP, to])
    }
    if (mode === 'uz') {
      return cleanPath([from, sP, [from[0], y, from[2] + offsetM], [to[0], y, from[2] + offsetM], eP, to])
    }
    if (mode === 'diag') {
      if (Math.abs(offsetM) < 1e-4) return cleanPath([from, sP, eP, to])
      const mx = (from[0] + to[0]) / 2 + offsetM
      const mz = (from[2] + to[2]) / 2 - offsetM
      return cleanPath([from, sP, [mx, y, mz], eP, to])
    }
    if (mode === 'x') {
      return cleanPath([from, sP, [to[0] + offsetM, y, from[2] + offsetM], eP, to])
    }
    return cleanPath([from, sP, [from[0] + offsetM, y, to[2] + offsetM], eP, to])
  }

  const primary = buildCand(allowDiagonalBranch ? 'diag' : 'x', 0, 0)
  let bestPath = primary
  let bestClashes = detectHvacClashes(primary, obstacles, ductHalfSpanM)
  let detoured = false

  if (bestClashes.length > 0) {
    const candidates: Vec3[][] = [
      buildCand('z', 0, 0),
      buildCand('x', 0, 0),
      buildCand('ux', 0.65, 0),
      buildCand('ux', -0.65, 0),
      buildCand('uz', 0.65, 0),
      buildCand('uz', -0.65, 0),
      buildCand('x', 0.65, 0),
      buildCand('x', -0.65, 0),
      buildCand('z', 0.65, 0),
      buildCand('z', -0.65, 0),
      buildCand('x', 0, 0.28),
      buildCand('z', 0, 0.28),
      buildCand('ux', 1.1, 0),
      buildCand('ux', -1.1, 0),
      buildCand('uz', 1.1, 0),
      buildCand('uz', -1.1, 0),
      buildCand('diag', 0.85, 0),
      buildCand('diag', -0.85, 0),
    ]
    for (const cand of candidates) {
      const c = detectHvacClashes(cand, obstacles, ductHalfSpanM)
      if (c.length < bestClashes.length) {
        bestPath = cand
        bestClashes = c
        detoured = true
        if (c.length === 0) break
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
}): {
  path: Vec3[]
  slopeInPerFt: number
  lengthFt: number
  detoured: boolean
  clashes: HvacObstacle[]
} {
  const { from, to, obstacles = [] } = params
  const slopeInPerFt = 0.25
  const slopeRatio = slopeInPerFt / 12
  const isAtticStart = from[1] >= 2.2
  const horizEstimateM = Math.abs(to[0] - from[0]) + Math.abs(to[2] - from[2])
  const minRunStartY = to[1] + horizEstimateM * slopeRatio + 0.02
  const startY = isAtticStart
    ? from[1]
    : from[1] > to[1] + 0.05
      ? Math.min(from[1], Math.max(0.25, minRunStartY))
      : from[1]

  const buildSloped = (waypoints: ReadonlyArray<readonly [number, number]>): Vec3[] => {
    const pts: Vec3[] = [from]
    if (!isAtticStart && from[1] > startY + 0.02) pts.push([from[0], startY, from[2]])
    let cx = from[0]
    let cz = from[2]
    let cy = startY
    for (let i = 0; i < waypoints.length; i++) {
      const [wx, wz] = waypoints[i]!
      const leg = Math.hypot(wx - cx, wz - cz)
      const isLast = i === waypoints.length - 1
      if (!isLast && leg < 0.15) continue
      cy -= leg * slopeRatio
      if (isLast) {
        if (isAtticStart && cy > to[1] + 0.05) {
          // Run sloped in attic to exterior termination X/Z, then drop vertically down exterior wall
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

  const primary = buildSloped([
    [to[0], from[2]],
    [to[0], to[2]],
  ])
  let best = primary
  let clashes = detectHvacClashes(primary, obstacles, 0.02)
  let detoured = false

  if (clashes.length > 0) {
    for (const wp of [
      [[from[0], to[2]], [to[0], to[2]]] as const,
      [[from[0], from[2] + 0.65], [to[0], from[2] + 0.65], [to[0], to[2]]] as const,
      [[from[0], from[2] - 0.65], [to[0], from[2] - 0.65], [to[0], to[2]]] as const,
      [[from[0], from[2] + 1.35], [to[0], from[2] + 1.35], [to[0], to[2]]] as const,
      [[from[0], from[2] - 1.35], [to[0], from[2] - 1.35], [to[0], to[2]]] as const,
      [[from[0] + 0.9, from[2]], [from[0] + 0.9, to[2]], [to[0], to[2]]] as const,
      [[from[0] - 0.9, from[2]], [from[0] - 0.9, to[2]], [to[0], to[2]]] as const,
    ]) {
      const cand = buildSloped(wp)
      const c = detectHvacClashes(cand, obstacles, 0.02)
      if (c.length < clashes.length) {
        best = cand
        clashes = c
        detoured = true
        if (c.length === 0) break
      }
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
