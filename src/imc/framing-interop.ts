/**
 * Pure TypeScript interoperability helpers for:
 * 1. Priority #1 `@kruschdev/pascal-plugin-structural` (`structural:assembly`) & `@pascal-app/plugin-bones` (`bones:framing`)
 * 2. Cross-trade electrical power coordination (`electricalDemand` contract consumed by `@kruschdev/pascal-plugin-electrical`)
 * 3. Cross-trade fuel-gas coordination (`gasBtuh` consumed by `@kruschdev/pascal-plugin-plumbing`)
 *
 * Framework-free: zero React, Three.js, or `@pascal-app/*` imports.
 */

import {
  type DuctShape,
  type HvacEquipmentKind,
  INCHES_TO_METERS,
  type OccupancyType,
} from './tables'

export type Vec3 = readonly [number, number, number]

export type SceneNodeLike = {
  id: string
  type: string
  name?: string
  parentId?: string | null
  position?: readonly [number, number, number]
  rotation?: number | readonly [number, number, number]
  start?: readonly [number, number]
  end?: readonly [number, number]
  height?: number
  thickness?: number
  width?: number
  depth?: number
  polygon?: ReadonlyArray<readonly [number, number]>
  path?: ReadonlyArray<readonly [number, number, number]>
  children?: readonly string[]
  [key: string]: unknown
}

/**
 * Standardized cross-trade electrical power demand payload published by every powered
 * `hvac:equipment` node so `@kruschdev/pascal-plugin-electrical` automatically provisions
 * dedicated 240V/208V/120V breakers, NEC 220/440 loads, and 3D power runs with zero coupling.
 */
export type ElectricalPowerDemand = {
  required: boolean
  voltage: 120 | 208 | 240 | 480
  poles: 1 | 2 | 3
  breakerAmps: number
  loadVa: number
  continuous: boolean
  dedicatedCircuit: boolean
  gfciRequired: boolean
  afciRequired: boolean
  loadCategory: 'fixed' | 'appliance' | 'motor' | 'hvac-heating' | 'hvac-cooling' | 'heat-pump'
  label: string
}

const NEC_STANDARD_BREAKERS = [15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 125, 150, 175, 200] as const

function nextStandardBreaker(minAmps: number): number {
  for (const std of NEC_STANDARD_BREAKERS) {
    if (std >= minAmps) return std
  }
  return 200
}

/**
 * Compute NEC Article 440 / 424 compliant electrical demand payload for any HVAC equipment node.
 */
export function getHvacEquipmentElectricalDemand(params: {
  kind: HvacEquipmentKind
  coolingTons?: number
  heatStripKw?: number
  occupancy?: OccupancyType
}): ElectricalPowerDemand {
  const { kind, coolingTons = 3, heatStripKw = 10, occupancy = 'residential' } = params
  const isCommercial3P = occupancy === 'commercial' && coolingTons >= 4

  switch (kind) {
    case 'heat-pump-condenser': {
      const loadVa = Math.round(coolingTons * 1450)
      const voltage = isCommercial3P ? 208 : 240
      const poles: 1 | 2 | 3 = isCommercial3P ? 3 : 2
      const amps = isCommercial3P
        ? nextStandardBreaker(Math.max(20, (loadVa / (208 * Math.sqrt(3))) * 1.45))
        : coolingTons <= 2.0
          ? 25
          : coolingTons <= 3.0
            ? 35
            : coolingTons <= 4.0
              ? 45
              : 60
      return {
        required: true,
        voltage,
        poles,
        breakerAmps: amps,
        loadVa,
        continuous: true,
        dedicatedCircuit: true,
        gfciRequired: false,
        afciRequired: false,
        loadCategory: 'heat-pump',
        label: `${coolingTons}-Ton Heat Pump Condenser`,
      }
    }
    case 'ac-condenser': {
      const loadVa = Math.round(coolingTons * 1350)
      const voltage = isCommercial3P ? 208 : 240
      const poles: 1 | 2 | 3 = isCommercial3P ? 3 : 2
      const amps = isCommercial3P
        ? nextStandardBreaker(Math.max(20, (loadVa / (208 * Math.sqrt(3))) * 1.45))
        : coolingTons <= 2.0
          ? 25
          : coolingTons <= 3.0
            ? 30
            : coolingTons <= 4.0
              ? 40
              : 50
      return {
        required: true,
        voltage,
        poles,
        breakerAmps: amps,
        loadVa,
        continuous: true,
        dedicatedCircuit: true,
        gfciRequired: false,
        afciRequired: false,
        loadCategory: 'hvac-cooling',
        label: `${coolingTons}-Ton AC Condenser`,
      }
    }
    case 'air-handler': {
      const kw = Math.max(5, heatStripKw)
      const loadVa = Math.round(kw * 1000 + 600) // Aux heat strips + ECM blower
      const amps = nextStandardBreaker((loadVa / 240) * 1.25)
      return {
        required: true,
        voltage: 240,
        poles: 2,
        breakerAmps: Math.max(30, amps),
        loadVa,
        continuous: true,
        dedicatedCircuit: true,
        gfciRequired: false,
        afciRequired: false,
        loadCategory: 'hvac-heating',
        label: `Air Handler (${kw} kW Aux Heat)`,
      }
    }
    case 'gas-furnace-96':
    case 'gas-furnace-80':
      return {
        required: true,
        voltage: 120,
        poles: 1,
        breakerAmps: 15,
        loadVa: 850,
        continuous: false,
        dedicatedCircuit: true, // NEC 422.12 dedicated branch circuit for central heating equipment
        gfciRequired: false,
        afciRequired: false,
        loadCategory: 'hvac-heating',
        label: kind === 'gas-furnace-96' ? '96% Gas Furnace Blower/Controls' : '80% Gas Furnace Blower/Controls',
      }
    case 'rooftop-package-unit': {
      const loadVa = Math.round(coolingTons * 1850)
      const voltage = occupancy === 'commercial' ? 208 : 240
      const poles: 1 | 2 | 3 = occupancy === 'commercial' ? 3 : 2
      const amps = nextStandardBreaker(
        (loadVa / (poles === 3 ? voltage * Math.sqrt(3) : voltage)) * 1.35,
      )
      return {
        required: true,
        voltage,
        poles,
        breakerAmps: Math.max(30, amps),
        loadVa,
        continuous: true,
        dedicatedCircuit: true,
        gfciRequired: false,
        afciRequired: false,
        loadCategory: 'heat-pump',
        label: `${coolingTons}-Ton Packaged RTU`,
      }
    }
    case 'mini-split-outdoor': {
      const loadVa = Math.round(Math.max(1.5, coolingTons) * 1250)
      const amps = coolingTons <= 2.0 ? 20 : coolingTons <= 3.0 ? 30 : 40
      return {
        required: true,
        voltage: 240,
        poles: 2,
        breakerAmps: amps,
        loadVa,
        continuous: true,
        dedicatedCircuit: true,
        gfciRequired: false,
        afciRequired: false,
        loadCategory: 'heat-pump',
        label: `Inverter Mini-Split Outdoor (${coolingTons}-Ton)`,
      }
    }
    case 'mini-split-indoor':
      // Powered via 14/4 communication & power cable from outdoor unit; low control load
      return {
        required: false,
        voltage: 240,
        poles: 2,
        breakerAmps: 15,
        loadVa: 0,
        continuous: false,
        dedicatedCircuit: false,
        gfciRequired: false,
        afciRequired: false,
        loadCategory: 'heat-pump',
        label: 'Mini-Split Wall Head (Fed from Outdoor Unit)',
      }
    case 'erv-ventilator':
      return {
        required: true,
        voltage: 120,
        poles: 1,
        breakerAmps: 15,
        loadVa: 180,
        continuous: true,
        dedicatedCircuit: false,
        gfciRequired: false,
        afciRequired: false,
        loadCategory: 'motor',
        label: 'Energy Recovery Ventilator (ERV)',
      }
    case 'dehumidifier-whole-house':
      return {
        required: true,
        voltage: 120,
        poles: 1,
        breakerAmps: 15,
        loadVa: 750,
        continuous: true,
        dedicatedCircuit: false,
        gfciRequired: true,
        afciRequired: false,
        loadCategory: 'appliance',
        label: 'Whole-House Dehumidifier',
      }
    case 'bath-exhaust-fan':
      return {
        required: true,
        voltage: 120,
        poles: 1,
        breakerAmps: 15,
        loadVa: 50,
        continuous: false,
        dedicatedCircuit: false,
        gfciRequired: true,
        afciRequired: false,
        loadCategory: 'motor',
        label: 'Bath Exhaust Fan',
      }
    case 'range-hood':
      return {
        required: true,
        voltage: 120,
        poles: 1,
        breakerAmps: 15,
        loadVa: 300,
        continuous: false,
        dedicatedCircuit: false,
        gfciRequired: false,
        afciRequired: true,
        loadCategory: 'appliance',
        label: 'Kitchen Range Exhaust Hood',
      }
  }
}

export function belongsToLevel(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  node: SceneNodeLike,
  levelId: string | null,
): boolean {
  if (!levelId) return true
  if (node.id === levelId || node.parentId === levelId) return true
  let cur: SceneNodeLike | undefined = node
  let guard = 0
  while (cur?.parentId && guard < 12) {
    if (cur.parentId === levelId) return true
    cur = nodes[cur.parentId]
    guard += 1
  }
  return false
}

export function resolveNodeLevelId(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  node: SceneNodeLike,
): string | null {
  if (node.type === 'level') return node.id
  let cur: SceneNodeLike | undefined = node
  let guard = 0
  while (cur?.parentId && guard < 12) {
    const parent: SceneNodeLike | undefined = nodes[cur.parentId]
    if (!parent) return cur.parentId
    if (parent.type === 'level') return parent.id
    cur = parent
    guard += 1
  }
  return null
}

export type HvacFramingContext = {
  framingPresent: boolean
  source: 'structural' | 'bones' | 'default'
  studSpacingIn: 12 | 16 | 24
  joistDepthIn: number
  floorSystem: 'dimensional' | 'tji-ijoist' | 'open-web-truss'
  wallRules: ReadonlyMap<string, { construction: string; spacingIn: 12 | 16 | 24; isLoadBearing: boolean }>
}

const framingCtxCache = new WeakMap<
  Readonly<Record<string, SceneNodeLike>>,
  Map<string, HvacFramingContext>
>()

/**
 * Extract Priority #1 `structural:assembly` or `@pascal-app/plugin-bones` `bones:framing` rules.
 * WeakMap-memoized per scene nodes object reference.
 */
export function extractHvacFramingContext(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  levelId: string | null = null,
): HvacFramingContext {
  const key = levelId ?? '__all__'
  let byLevel = framingCtxCache.get(nodes)
  if (!byLevel) {
    byLevel = new Map()
    framingCtxCache.set(nodes, byLevel)
  }
  const cached = byLevel.get(key)
  if (cached) return cached

  const all = Object.values(nodes)
  const structuralNode = all.find(
    (n) => n.type === 'structural:assembly' && belongsToLevel(nodes, n, levelId),
  )
  const bonesNode = all.find(
    (n) => n.type === 'bones:framing' && belongsToLevel(nodes, n, levelId),
  )
  const framingNode = structuralNode ?? bonesNode
  const source: 'structural' | 'bones' | 'default' = structuralNode
    ? 'structural'
    : bonesNode
      ? 'bones'
      : 'default'

  const studSpacingIn: 12 | 16 | 24 =
    framingNode?.studSpacingIn === 12 ? 12 : framingNode?.studSpacingIn === 24 ? 24 : 16
  const floorSystem: 'dimensional' | 'tji-ijoist' | 'open-web-truss' =
    structuralNode?.floorSystem === 'open-web-truss'
      ? 'open-web-truss'
      : structuralNode?.floorSystem === 'tji-ijoist'
        ? 'tji-ijoist'
        : 'dimensional'
  const joistDepthIn =
    typeof structuralNode?.joistDepthIn === 'number'
      ? structuralNode.joistDepthIn
      : floorSystem === 'open-web-truss'
        ? 16
        : floorSystem === 'tji-ijoist'
          ? 11.875
          : 9.25

  const wallRules = new Map<string, { construction: string; spacingIn: 12 | 16 | 24; isLoadBearing: boolean }>()
  const rawOverrides = framingNode?.wallOverrides
  if (rawOverrides && typeof rawOverrides === 'object') {
    for (const [wallId, rawRule] of Object.entries(rawOverrides as Record<string, unknown>)) {
      if (!rawRule || typeof rawRule !== 'object') continue
      const r = rawRule as Record<string, unknown>
      const rawSpacing = r.studSpacingIn ?? r.spacingIn
      wallRules.set(wallId, {
        construction: typeof r.construction === 'string' ? r.construction : 'framed',
        spacingIn: rawSpacing === 12 ? 12 : rawSpacing === 24 ? 24 : studSpacingIn,
        isLoadBearing: Boolean(r.isLoadBearing),
      })
    }
  }

  const ctx: HvacFramingContext = {
    framingPresent: Boolean(framingNode),
    source,
    studSpacingIn,
    joistDepthIn,
    floorSystem,
    wallRules,
  }
  byLevel.set(key, ctx)
  return ctx
}

export type DuctFramingClearance = {
  id: string
  ductRunId: string
  wallId?: string
  memberKind: 'stud' | 'top-plate' | 'sole-plate' | 'joist-bay' | 'dropped-soffit'
  memberLabel: string
  position: Vec3
  ductDirection: Vec3
  wallNormal: readonly [number, number]
  openingWidthIn: number
  openingHeightIn: number
  codeCompliant: boolean
  needsSoffitOrChase: boolean
  codeRef: string
  note?: string
}

/**
 * Evaluate exact 3D framing penetrations & joist-bay clearances where an HVAC duct or lineset
 * crosses walls, top/sole plates, or floor/ceiling framing cavities (IRC R502.8 / R602.6 / R302.11).
 */
export function computeDuctFramingClearances(params: {
  ductRunId: string
  path: ReadonlyArray<Vec3>
  shape: DuctShape
  widthIn: number
  heightIn: number
  diameterIn: number
  walls: ReadonlyArray<{
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
  }>
  framingContext?: HvacFramingContext | null
}): DuctFramingClearance[] {
  const { ductRunId, path, shape, widthIn, heightIn, diameterIn, walls, framingContext } = params
  if (path.length < 2) return []

  const ductWIn = shape === 'round' ? diameterIn : widthIn
  const ductHIn = shape === 'round' ? diameterIn : heightIn
  const out: DuctFramingClearance[] = []
  const joistDepthIn = framingContext?.joistDepthIn ?? 9.25
  const floorSystem = framingContext?.floorSystem ?? 'dimensional'
  let seq = 1

  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!
    const b = path[i]!
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const dz = b[2] - a[2]
    const segLen = Math.hypot(dx, dy, dz)
    if (segLen < 0.05) continue
    const dir: Vec3 = [dx / segLen, dy / segLen, dz / segLen]

    // Check floor/ceiling joist bay clearance for horizontal trunks below floor (y < 0)
    const midY = (a[1] + b[1]) / 2
    if (Math.hypot(dx, dz) > 0.6 && midY < -0.02 && midY > -0.6) {
      const maxJoistHoleIn = floorSystem === 'open-web-truss' ? joistDepthIn - 4.0 : joistDepthIn / 3
      const fitsInJoistWeb = ductHIn <= maxJoistHoleIn
      if (!fitsInJoistWeb && ductHIn >= 6) {
        out.push({
          id: `${ductRunId}_clr_${seq++}`,
          ductRunId,
          memberKind: 'dropped-soffit',
          memberLabel: `Under-Joist Chase / Dropped Soffit (${floorSystem})`,
          position: [(a[0] + b[0]) / 2, midY, (a[2] + b[2]) / 2],
          ductDirection: dir,
          wallNormal: [0, 1],
          openingWidthIn: Math.ceil(ductWIn + 2),
          openingHeightIn: Math.ceil(ductHIn + 2),
          codeCompliant: true,
          needsSoffitOrChase: true,
          codeRef: 'IRC R502.8 / IMC 603',
          note: `${ductWIn}"x${ductHIn}" trunk runs below ${joistDepthIn}" ${floorSystem} joists (never notch/bore > 1/3 joist depth); enclose in drywall soffit if finished ceiling.`,
        })
      }
    }

    // Check wall crossings (top plate / sole plate / through-wall chases)
    for (const wall of walls) {
      const rule = framingContext?.wallRules.get(wall.id)
      if (rule?.construction === 'skip') continue
      const halfThick = wall.thicknessM / 2 + 0.05
      const ua = (a[0] - wall.start[0]) * wall.ux + (a[2] - wall.start[1]) * wall.uz
      const na = (a[0] - wall.start[0]) * wall.nx + (a[2] - wall.start[1]) * wall.nz
      const ub = (b[0] - wall.start[0]) * wall.ux + (b[2] - wall.start[1]) * wall.uz
      const nb = (b[0] - wall.start[0]) * wall.nx + (b[2] - wall.start[1]) * wall.nz

      const crossesWallPlane = na * nb < 0
      if (crossesWallPlane) {
        const t = Math.abs(na) / (Math.abs(na) + Math.abs(nb) + 1e-9)
        const pu = ua + (ub - ua) * t
        const py = a[1] + dy * t
        if (pu >= 0.05 && pu <= wall.lengthM - 0.05 && py > 0.08 && py < wall.heightM - 0.05) {
          const px = a[0] + dx * t
          const pz = a[2] + dz * t
          const isBearing = rule?.isLoadBearing ?? false
          const studBayClearIn = (rule?.spacingIn ?? framingContext?.studSpacingIn ?? 16) - 1.5
          const fitsBetweenStuds = ductWIn + 0.5 <= studBayClearIn
          out.push({
            id: `${ductRunId}_clr_${seq++}`,
            ductRunId,
            wallId: wall.id,
            memberKind: 'stud',
            memberLabel: `Wall Penetration (${wall.id})`,
            position: [px, py, pz],
            ductDirection: dir,
            wallNormal: [wall.nx, wall.nz],
            openingWidthIn: Math.ceil(ductWIn + 1),
            openingHeightIn: Math.ceil(ductHIn + 1),
            codeCompliant: fitsBetweenStuds || !isBearing,
            needsSoffitOrChase: !fitsBetweenStuds,
            codeRef: isBearing ? 'IRC R602.6 / R602.7 Header Required' : 'IRC R602.6 / R302.11(5)',
            note: !fitsBetweenStuds
              ? `Duct (${ductWIn}" wide) exceeds ${studBayClearIn}" stud bay clear width; frame box header / firestop collar around penetration.`
              : 'Frame clear within stud bay and seal perimeter with IRC R302.11(5) fireblocking.',
          })
        }
      }

      // Vertical crossing of top plate or sole plate inside wall cavity
      const minAbsN = Math.min(Math.abs(na), Math.abs(nb))
      if (Math.abs(dy) > 0.1 && minAbsN <= halfThick && Math.max(ua, ub) >= 0 && Math.min(ua, ub) <= wall.lengthM) {
        const cavityIn = Math.max(3.5, (wall.thicknessM - 0.0254) / INCHES_TO_METERS)
        const plates: Array<{ kind: 'sole-plate' | 'top-plate'; label: string; y: number }> = [
          { kind: 'sole-plate', label: `Sole Plate (${wall.id})`, y: 0.02 },
          { kind: 'top-plate', label: `Double Top Plate (${wall.id})`, y: wall.heightM - 0.04 },
        ]
        const yMin = Math.min(a[1], b[1])
        const yMax = Math.max(a[1], b[1])
        for (const pl of plates) {
          if (yMin <= pl.y && yMax >= pl.y) {
            const t = (pl.y - a[1]) / dy
            const px = a[0] + dx * t
            const pz = a[2] + dz * t
            const pu = (px - wall.start[0]) * wall.ux + (pz - wall.start[1]) * wall.uz
            if (pu >= 0 && pu <= wall.lengthM) {
              const fitsCavity = Math.min(ductWIn, ductHIn) <= cavityIn + 0.1
              out.push({
                id: `${ductRunId}_clr_${seq++}`,
                ductRunId,
                wallId: wall.id,
                memberKind: pl.kind,
                memberLabel: pl.label,
                position: [px, pl.y, pz],
                ductDirection: dir,
                wallNormal: [wall.nx, wall.nz],
                openingWidthIn: Math.ceil(ductWIn + 0.5),
                openingHeightIn: Math.ceil(ductHIn + 0.5),
                codeCompliant: fitsCavity,
                needsSoffitOrChase: !fitsCavity,
                codeRef: 'IRC R602.6.1 / R302.11(5)',
                note: fitsCavity
                  ? 'Install IRC R602.6.1 16-ga steel tie strap across notched/cut top plate + firestop.'
                  : `${ductWIn}"x${ductHIn}" duct exceeds ${cavityIn.toFixed(1)}" stud cavity; use 3-1/4"x10" wall stack boot or chase.`,
              })
            }
          }
        }
      }
    }
  }

  return out
}
