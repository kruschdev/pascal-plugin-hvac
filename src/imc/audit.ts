/**
 * Live IMC / UMC / ACCA Manual D / ASHRAE 62.2 / IECC / NEC 110.26(E) HVAC Auditor (`src/imc/audit.ts`).
 * WeakMap-memoized and strictly scoped per building level so multi-story models never mix coordinates.
 * Framework-free: zero React, Three.js, or `@pascal-app/*` imports.
 */

import {
  type SceneNodeLike,
  resolveNodeLevelId,
} from './framing-interop'
import {
  type HvacObstacle,
  type RoomPolygon2D,
  classifyHvacRoomName,
  detectHvacClashes,
  extractHvacObstacles,
  extractRoomPolygons,
  measureCondensateSlope,
  pointInPolygon2D,
  polylineLengthM,
  resolveLevelHeightM,
} from './routing'
import { buildHvacElectricalCoordination } from './schedule'
import { calculateDuctHydraulics } from './sizing'
import {
  CLIMATE_ZONES,
  type ClimateZone,
  type CodeEdition,
  type DuctMaterial,
  type DuctShape,
  HVAC_EQUIPMENT_SPECS,
  type HvacDuctSystem,
  type HvacEquipmentKind,
  INCHES_TO_METERS,
  METERS_TO_FEET,
  type OccupancyType,
  round2,
} from './tables'

export type HvacAuditSeverity = 'error' | 'warning' | 'info'

export type HvacAuditFinding = {
  id: string
  severity: HvacAuditSeverity
  codeRef: string
  title: string
  detail: string
  suggestedFix: string
  nodeIds: string[]
}

export type HvacAuditResult = {
  codeEdition: CodeEdition
  climateZone: ClimateZone
  errorCount: number
  warningCount: number
  infoCount: number
  findings: HvacAuditFinding[]
}

const auditCache = new WeakMap<Readonly<Record<string, SceneNodeLike>>, Map<string, HvacAuditResult>>()

export function auditSceneHvac(
  nodes: Readonly<Record<string, SceneNodeLike>>,
  options: {
    codeEdition?: CodeEdition
    climateZone?: ClimateZone
    occupancy?: OccupancyType
  } = {},
): HvacAuditResult {
  const codeEdition = options.codeEdition ?? 'IMC-2021'
  const climateZone = options.climateZone ?? '4A'
  const inferredCommercial = Object.values(nodes).some(
    (n) =>
      (n.type === 'hvac:equipment' &&
        (n.equipmentKind === 'rooftop-package-unit' || n.occupancy === 'commercial')) ||
      (n.type === 'hvac:duct-run' && n.occupancy === 'commercial') ||
      (n.type === 'electrical:panel' &&
        (n.voltageSystem === '120/208V-3P' ||
          n.voltageSystem === '277/480V-3P' ||
          n.occupancy === 'commercial')),
  )
  const occupancy: OccupancyType = options.occupancy ?? (inferredCommercial ? 'commercial' : 'residential')
  const cacheKey = `${codeEdition}|${climateZone}|${occupancy}`

  let byKey = auditCache.get(nodes)
  if (!byKey) {
    byKey = new Map()
    auditCache.set(nodes, byKey)
  }
  const cached = byKey.get(cacheKey)
  if (cached) return cached

  const findings: HvacAuditFinding[] = []
  let seq = 1
  const push = (f: Omit<HvacAuditFinding, 'id'>) => {
    findings.push({ id: `imc_finding_${seq++}`, ...f })
  }

  const all = Object.values(nodes)
  const equipment = all.filter((n) => n.type === 'hvac:equipment')
  const ductRuns = all.filter((n) => n.type === 'hvac:duct-run')
  const terminals = all.filter((n) => n.type === 'hvac:terminal')
  const hasElectricalPanel = all.some((n) => n.type === 'electrical:panel')
  const gasPipeLevels = new Set<string>()
  for (const n of all) {
    if (n.type === 'plumbing:pipe-run' && n.system === 'fuel-gas') {
      gasPipeLevels.add(resolveNodeLevelId(nodes, n) ?? '__root__')
    }
  }
  const zoneSpec = CLIMATE_ZONES[climateZone] ?? CLIMATE_ZONES['4A']

  const obstaclesByLevel = new Map<string, HvacObstacle[]>()
  const roomsByLevel = new Map<string, RoomPolygon2D[]>()
  const levelHeightCache = new Map<string, number>()

  const getObstaclesForLevel = (lvlId: string | null): HvacObstacle[] => {
    const key = lvlId ?? '__all__'
    let list = obstaclesByLevel.get(key)
    if (!list) {
      list = extractHvacObstacles(nodes, lvlId)
      obstaclesByLevel.set(key, list)
    }
    return list
  }
  const getRoomsForLevel = (lvlId: string | null): RoomPolygon2D[] => {
    const key = lvlId ?? '__all__'
    let list = roomsByLevel.get(key)
    if (!list) {
      list = extractRoomPolygons(nodes, lvlId)
      roomsByLevel.set(key, list)
    }
    return list
  }
  const getLevelH = (lvlId: string | null): number => {
    const key = lvlId ?? '__all__'
    let h = levelHeightCache.get(key)
    if (h === undefined) {
      h = resolveLevelHeightM(nodes, lvlId)
      levelHeightCache.set(key, h)
    }
    return h
  }

  // 1. Equipment checks (IMC 307.2 condensate drain & secondary pan, NEC 440.14 disconnect, gas furnace fuel-gas)
  const levelCoolingCoils = new Map<string, string[]>()
  for (const eq of equipment) {
    const kind = (eq.equipmentKind as HvacEquipmentKind) || 'air-handler'
    const spec = HVAC_EQUIPMENT_SPECS[kind]
    const eqLevelKey = resolveNodeLevelId(nodes, eq) ?? '__root__'
    if (
      kind === 'gas-furnace-96' ||
      ((kind === 'air-handler' || kind === 'gas-furnace-80') &&
        (typeof eq.coolingTons === 'number' ? eq.coolingTons > 0 : true))
    ) {
      const list = levelCoolingCoils.get(eqLevelKey) ?? []
      list.push(eq.id)
      levelCoolingCoils.set(eqLevelKey, list)
    }
    if (spec?.needsCondensate) {
      if (!spec.isOutdoor && eq.hasSecondaryDrainPan === false) {
        push({
          severity: 'error',
          codeRef: 'IMC 307.2.3',
          title: 'Indoor cooling coil / condensing unit missing secondary drain pan',
          detail: `${eq.name ?? eq.id} requires auxiliary drain pan or float-switch overflow protection where leakage could damage building components.`,
          suggestedFix: 'Enable secondary drain pan and auxiliary float cutoff switch on the equipment node.',
          nodeIds: [eq.id],
        })
      }
      if (!spec.isOutdoor && eq.hasFloatSwitch === false) {
        push({
          severity: 'warning',
          codeRef: 'IMC 307.2.3(3)',
          title: 'Condensate overflow float switch disabled',
          detail: `${eq.name ?? eq.id} does not have an automatic condensate shutoff float switch configured.`,
          suggestedFix: 'Install inline SS2 float switch wired to break thermostat R/Y circuit on pan overflow.',
          nodeIds: [eq.id],
        })
      }
    }
    if (spec?.isOutdoor && eq.hasDisconnectWithinSight === false) {
      push({
        severity: 'error',
        codeRef: 'NEC 440.14',
        title: 'Outdoor HVAC unit missing disconnecting means within sight',
        detail: `${eq.name ?? eq.id} requires a lockable disconnecting means within sight (<= 50 ft) and readily accessible.`,
        suggestedFix: 'Mount a 60A non-fused weatherproof pull-out disconnect adjacent to the outdoor condenser.',
        nodeIds: [eq.id],
      })
    }
    if (spec?.usesFuelGas && typeof eq.gasBtuh === 'number' && eq.gasBtuh > 0 && !gasPipeLevels.has(eqLevelKey)) {
      push({
        severity: 'info',
        codeRef: 'IFGC 402 / Plumbing Coordination',
        title: `Gas furnace (${Math.round(eq.gasBtuh / 1000)} kBTU/h) needs fuel-gas line from Plumbing`,
        detail: `${eq.name ?? eq.id} specifies ${eq.gasBtuh} BTU/h natural gas input with no plumbing fuel-gas pipe run on this level yet.`,
        suggestedFix: 'Enable Fuel Gas in Plumbing Auto-Populate or route a sized black-iron/CSST gas line with drip leg.',
        nodeIds: [eq.id],
      })
    }
  }

  // 2. Duct-run checks (strictly per-level obstacles, ACCA Manual D velocity, IECC attic duct R-value, lineset max length)
  const levelDuctState = new Map<
    string,
    { hasSupply: boolean; hasReturn: boolean; hasCondensate: boolean; sampleSupplyIds: string[] }
  >()
  const getLvlState = (key: string) => {
    let st = levelDuctState.get(key)
    if (!st) {
      st = { hasSupply: false, hasReturn: false, hasCondensate: false, sampleSupplyIds: [] }
      levelDuctState.set(key, st)
    }
    return st
  }

  for (const run of ductRuns) {
    const system = (run.system as HvacDuctSystem) || 'supply-branch'
    const shape = (run.shape as DuctShape) || 'round'
    const material = (run.material as DuctMaterial) || 'galvanized-sheet'
    const widthIn = typeof run.width === 'number' ? run.width : 14
    const heightIn = typeof run.height === 'number' ? run.height : 8
    const diameterIn = typeof run.diameter === 'number' ? run.diameter : 6
    const path = Array.isArray(run.path) ? (run.path as ReadonlyArray<readonly [number, number, number]>) : []
    const lengthFt = round2(polylineLengthM(path) * METERS_TO_FEET)
    const runLevelId = resolveNodeLevelId(nodes, run)
    const lvlKey = runLevelId ?? '__root__'
    const st = getLvlState(lvlKey)

    if (system === 'supply-trunk' || system === 'supply-branch') {
      st.hasSupply = true
      if (st.sampleSupplyIds.length < 1) st.sampleSupplyIds.push(run.id)
    }
    if (system === 'return-trunk' || system === 'return-branch') st.hasReturn = true
    if (system === 'condensate-drain') st.hasCondensate = true

    // Same-level Priority #1 Structural, Priority #2 Plumbing & NEC 110.26(E) clashes
    if (path.length >= 2) {
      const clashMargin =
        shape === 'round'
          ? Math.max(0.02, (diameterIn * INCHES_TO_METERS) / 2)
          : {
              horizontal: Math.max(0.05, (widthIn * INCHES_TO_METERS) / 2),
              vertical: Math.max(0.04, (heightIn * INCHES_TO_METERS) / 2),
            }
      const clashes = detectHvacClashes(path, getObstaclesForLevel(runLevelId), clashMargin)
      const seenBaseObs = new Set<string>()
      for (const obs of clashes) {
        const baseObsId = obs.nodeId ?? obs.id.replace(/:seg.*$/, '')
        if (seenBaseObs.has(baseObsId)) continue
        seenBaseObs.add(baseObsId)
        if (obs.category === 'electrical-dedicated-space') {
          push({
            severity: 'error',
            codeRef: 'NEC 110.26(E)',
            title: 'HVAC duct invades electrical panel dedicated overhead space',
            detail: `${run.name ?? run.id} passes through ${obs.label}.`,
            suggestedFix: 'Offset ductwork horizontally clear of the electrical panel footprint.',
            nodeIds: [run.id, baseObsId],
          })
        } else if (obs.category === 'electrical-working-space') {
          push({
            severity: 'error',
            codeRef: 'NEC 110.26(A)',
            title: 'HVAC duct invades electrical panel working space',
            detail: `${run.name ?? run.id} passes through ${obs.label}.`,
            suggestedFix: 'Offset ductwork above 6.5 ft (1.98 m) or outside the 30" x 36" clear working space in front of the panel.',
            nodeIds: [run.id, baseObsId],
          })
        } else if (obs.category === 'structural') {
          push({
            severity: 'error',
            codeRef: 'IRC R502.8 / Structural',
            title: 'HVAC duct collides with structural member',
            detail: `${run.name ?? run.id} intersects ${obs.label}.`,
            suggestedFix: 'Route duct around structural beam/column or drop into a drywall soffit.',
            nodeIds: [run.id, baseObsId],
          })
        } else {
          push({
            severity: 'error',
            codeRef: 'TRADE-PRIORITY (Plumbing #2)',
            title: 'HVAC duct clashes with higher-priority Plumbing',
            detail: `${run.name ?? run.id} intersects ${obs.label}. Gravity plumbing holds Priority #2 right-of-way.`,
            suggestedFix: 'Offset HVAC duct around the plumbing pipe or equipment without moving gravity DWV drains.',
            nodeIds: [run.id, baseObsId],
          })
        }
      }
    }

    // ACCA Manual D / IMC Airflow Velocity check (supply, return, exhaust, and fresh-air ERV)
    const cfm = typeof run.airflowCfm === 'number' ? run.airflowCfm : 0
    if (
      cfm > 0 &&
      (system === 'supply-trunk' ||
        system === 'supply-branch' ||
        system === 'return-trunk' ||
        system === 'return-branch' ||
        system === 'exhaust-duct' ||
        system === 'fresh-air-erv')
    ) {
      const hyd = calculateDuctHydraulics({
        cfm,
        shape,
        diameterIn,
        widthIn,
        heightIn,
        material,
        system,
        isTrunk: system === 'supply-trunk' || system === 'return-trunk',
        isReturn: system === 'return-trunk' || system === 'return-branch',
        occupancy,
      })
      if (!hyd.velocityOk) {
        push({
          severity: 'warning',
          codeRef: hyd.codeRef,
          title: `Duct velocity (${hyd.velocityFpm} FPM) exceeds ${hyd.maxVelocityFpm} FPM quiet limit`,
          detail: `${run.name ?? run.id} carries ${cfm} CFM at ${hyd.velocityFpm} FPM (${hyd.frictionRateInWgPer100Ft}" wc/100ft), risking noise and static pressure loss.`,
          suggestedFix: 'Upsize duct diameter/width one trade step per ACCA Manual D.',
          nodeIds: [run.id],
        })
      }
    }

    // IMC 505.4 Domestic kitchen range hood exhaust must use smooth rigid metallic duct (never flex or ductboard)
    if (system === 'exhaust-duct' && (material === 'flex-r8' || material === 'flex-r6' || material === 'ductboard')) {
      const srcNode = typeof run.sourceNodeId === 'string' ? nodes[run.sourceNodeId] : undefined
      const isRangeHood =
        srcNode?.equipmentKind === 'range-hood' ||
        (typeof run.name === 'string' && /range\s*hood|kitchen/i.test(run.name))
      if (isRangeHood) {
        push({
          severity: 'error',
          codeRef: 'IMC 505.4',
          title: 'Kitchen range hood exhaust uses non-metallic / flexible duct',
          detail: `${run.name ?? run.id} specifies ${material}; domestic kitchen exhaust ducts must have smooth interior surfaces constructed of galvanized steel, stainless steel, or copper.`,
          suggestedFix: 'Change kitchen exhaust duct material to galvanized-sheet (smooth rigid metal).',
          nodeIds: [run.id],
        })
      }
    }

    // IMC 307.2.1 Condensate drain continuous gravity slope (>= 1/8"/ft downward, no uphill segments)
    if (system === 'condensate-drain' && path.length >= 2) {
      const slope = measureCondensateSlope(path)
      if (slope.hasUphillSegment) {
        push({
          severity: 'error',
          codeRef: 'IMC 307.2.1',
          title: 'Condensate drain pitches uphill (back-pitched)',
          detail: `${run.name ?? run.id} contains an upward-sloping segment; gravity condensate drains must slope continuously downward (>= 1/8"/ft).`,
          suggestedFix: 'Re-route condensate line with continuous downward pitch or install a dedicated condensate pump.',
          nodeIds: [run.id],
        })
      } else if (slope.horizontalDistFt >= 1.0 && slope.overallSlopeInPerFt < 0.12) {
        push({
          severity: 'error',
          codeRef: 'IMC 307.2.1',
          title: `Condensate drain slope (${slope.overallSlopeInPerFt}"/ft) below 1/8"/ft minimum`,
          detail: `${run.name ?? run.id} slopes ${slope.overallSlopeInPerFt}"/ft across ${slope.horizontalDistFt} ft, below the 0.125"/ft (1%) IMC minimum.`,
          suggestedFix: 'Increase downward pitch to at least 1/8" to 1/4" per foot along the horizontal run.',
          nodeIds: [run.id],
        })
      }
    }

    // IECC R403.3.1 Unconditioned Attic Supply & Return Duct Insulation (must be >= R-8)
    // Segment-level check: a duct is in the unconditioned attic if any horizontal segment
    // or >= 30% of total path length runs at midpoint y >= levelH + 0.05.
    const levelH = getLevelH(runLevelId)
    const atticThresholdY = levelH + 0.05
    let totalPathLenM = 0
    let atticLenM = 0
    let hasHorizontalAtticSeg = false
    let maxAtticMidY = 0
    if (path.length >= 2) {
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1]!
        const b = path[i]!
        const dx = b[0] - a[0]
        const dy = b[1] - a[1]
        const dz = b[2] - a[2]
        const segLen = Math.hypot(dx, dy, dz)
        if (segLen < 1e-4) continue
        const horizLen = Math.hypot(dx, dz)
        const minY = Math.min(a[1], b[1])
        const maxY = Math.max(a[1], b[1])
        totalPathLenM += segLen
        const frac =
          minY >= atticThresholdY
            ? 1
            : maxY <= atticThresholdY
              ? 0
              : (maxY - atticThresholdY) / Math.abs(dy)
        if (frac > 0) {
          atticLenM += segLen * frac
          const subMidY = (Math.max(minY, atticThresholdY) + maxY) / 2
          if (subMidY > maxAtticMidY) maxAtticMidY = subMidY
          if (horizLen * frac >= 0.1 && horizLen >= Math.abs(dy)) {
            hasHorizontalAtticSeg = true
          }
        }
      }
    } else if (path.length === 1 && path[0]![1] >= atticThresholdY) {
      hasHorizontalAtticSeg = true
      maxAtticMidY = path[0]![1]
    }
    const isAtticDuct =
      hasHorizontalAtticSeg || (totalPathLenM > 0 && atticLenM / totalPathLenM >= 0.3)
    if (
      isAtticDuct &&
      (system === 'supply-trunk' || system === 'supply-branch' || system === 'return-trunk' || system === 'return-branch')
    ) {
      const insR = typeof run.insulationR === 'number' ? run.insulationR : 0
      if (insR < zoneSpec.ieccAtticDuctR) {
        push({
          severity: 'error',
          codeRef: 'IECC R403.3.1',
          title: `Attic duct insulation (R-${insR}) below IECC R-${zoneSpec.ieccAtticDuctR} minimum`,
          detail: `${run.name ?? run.id} runs in unconditioned attic space (${(maxAtticMidY * METERS_TO_FEET).toFixed(1)} ft) with R-${insR} insulation.`,
          suggestedFix: `Upgrade attic duct wrap or flex duct to >= R-${zoneSpec.ieccAtticDuctR} per IECC R403.3.1.`,
          nodeIds: [run.id],
        })
      }
    }

    // Refrigerant Lineset length check (> 50 ft requires additional refrigerant charge / oil trap)
    if (system === 'refrigerant-lineset' && lengthFt > 50) {
      push({
        severity: 'warning',
        codeRef: 'IMC 1107 / Manufacturer Charge',
        title: `Refrigerant lineset (${lengthFt} ft) exceeds 50 ft pre-charged length`,
        detail: `${run.name ?? run.id} spans ${lengthFt} ft between indoor coil and outdoor condenser.`,
        suggestedFix: 'Weigh in additional refrigerant per OEM oz/ft chart and verify suction oil return.',
        nodeIds: [run.id],
      })
    }
  }

  // Per-level indoor cooling coil condensate drain check (IMC 307.2.1)
  for (const [lvlKey, coilIds] of levelCoolingCoils.entries()) {
    const st = levelDuctState.get(lvlKey)
    if (!st?.hasCondensate) {
      push({
        severity: 'warning',
        codeRef: 'IMC 307.2.1',
        title: `Indoor cooling coil missing condensate drain line${lvlKey !== '__root__' && levelCoolingCoils.size > 1 ? ` (level ${lvlKey})` : ''}`,
        detail: `Indoor cooling coil equipment (${coilIds.join(', ')}) has no 3/4" PVC condensate-drain run on this level.`,
        suggestedFix: 'Route a gravity-sloped (>= 1/8"/ft) 3/4" PVC condensate drain from the evaporator coil to an approved discharge.',
        nodeIds: coilIds,
      })
    }
  }

  // Per-level return air path invariant (IMC 601)
  for (const [lvlKey, st] of levelDuctState.entries()) {
    const lvlHasReturnGrille = terminals.some(
      (t) => (resolveNodeLevelId(nodes, t) ?? '__root__') === lvlKey && t.terminalKind === 'return-grille',
    )
    if (st.hasSupply && !st.hasReturn && !lvlHasReturnGrille) {
      push({
        severity: 'error',
        codeRef: 'IMC 601 / Manual D',
        title: `Ducted supply system missing return air pathway${lvlKey !== '__root__' && levelDuctState.size > 1 ? ` (level ${lvlKey})` : ''}`,
        detail: 'Supply ducts exist without a return air trunk or return grille on this level.',
        suggestedFix: 'Add a central return grille and sized return trunk back to the air handler return plenum.',
        nodeIds: st.sampleSupplyIds,
      })
    }
  }

  // Prohibited return-air intake zones (IMC 601.5 / IRC M1602.2)
  const prohibitedReturnCategories = new Set(['bathroom', 'garage', 'kitchen', 'utility', 'closet', 'exterior', 'attic'])
  for (const t of terminals) {
    if (t.terminalKind !== 'return-grille') continue
    const tLvlId = resolveNodeLevelId(nodes, t)
    const lvlRooms = getRoomsForLevel(tLvlId)
    const lvlH = getLevelH(tLvlId)
    const pos = Array.isArray(t.position) && t.position.length >= 3 ? t.position : null
    const termY = pos ? Number(pos[1]) : 0
    const matchingRooms = pos
      ? lvlRooms
          .filter((r) => !(r.category === 'attic' && termY < lvlH))
          .filter((r) => pointInPolygon2D(Number(pos[0]), Number(pos[2]), r.polygon))
          .sort((a, b) => a.areaSqm - b.areaSqm)
      : []
    const containingRoom = matchingRooms[0]
    const roomLabel = containingRoom?.name ?? (typeof t.roomName === 'string' ? t.roomName : '')
    const roomCat = containingRoom?.category ?? (roomLabel ? classifyHvacRoomName(roomLabel) : 'other')
    if (prohibitedReturnCategories.has(roomCat)) {
      push({
        severity: 'error',
        codeRef: 'IMC 601.5 / IRC M1602.2',
        title: `Return air grille placed in prohibited ${roomCat} zone`,
        detail: `${t.name ?? t.id} draws return air from ${roomLabel || roomCat}; IMC 601.5 and IRC M1602.2 prohibit return air from bathrooms, kitchens, garages, closets, utility rooms, attics, or exterior spaces.`,
        suggestedFix: 'Relocate the return air grille into a conditioned hallway, living room, or other habitable space.',
        nodeIds: [t.id],
      })
    }
  }

  // 3. Cross-Trade Electrical Power Coordination check (when an electrical panel exists in scene)
  if (hasElectricalPanel) {
    const coord = buildHvacElectricalCoordination(nodes)
    for (const row of coord) {
      if (!row.wired) {
        push({
          severity: 'warning',
          codeRef: 'NEC Art. 440 / Cross-Trade Power',
          title: `Powered HVAC equipment unwired: ${row.label}`,
          detail: `${row.label} requires ${row.voltage}V ${row.poles}P ${row.breakerAmps}A (${row.loadVa} VA${row.dedicatedCircuit ? ', dedicated' : ''}) from the electrical panel.`,
          suggestedFix: 'Run Electrical Auto-Populate to automatically allocate the HVAC breaker and route the 3D power run.',
          nodeIds: [row.sourceNodeId],
        })
      }
    }
  }

  const result: HvacAuditResult = {
    codeEdition,
    climateZone,
    errorCount: findings.filter((f) => f.severity === 'error').length,
    warningCount: findings.filter((f) => f.severity === 'warning').length,
    infoCount: findings.filter((f) => f.severity === 'info').length,
    findings,
  }
  byKey.set(cacheKey, result)
  return result
}
