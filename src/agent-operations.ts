/**
 * Pure Agent Operations (`@kruschdev/pascal-plugin-hvac/agent-operations`).
 * Runs identically in Pascal's MCP server, detached scene runtime, or live editor tab
 * in a single undo step (`DECISIONS.md` E-016 & E-018).
 */

import type { AnyNode } from '@pascal-app/core'
import type { AgentContext, AgentOperations, SceneNodes } from '@pascal-app/core/agent-operations'
import { refuse } from '@pascal-app/core/agent-tools'
import { auditSceneHvac } from './imc/audit'
import { planHvacAutoPopulate } from './imc/autopopulate'
import {
  type DuctFramingClearance,
  type SceneNodeLike,
  type Vec3,
  computeDuctFramingClearances,
  extractHvacFramingContext,
  getHvacEquipmentElectricalDemand,
  resolveNodeLevelId,
} from './imc/framing-interop'
import { buildHvacBom, formatHvacBomCsv } from './imc/pricing'
import {
  extractHvacObstacles,
  extractWallSegments,
  resolveLevelHeightM,
  routeCondensateDrain,
  routeHvacDuctRun,
} from './imc/routing'
import { buildHvacSchedule, formatHvacScheduleCsv } from './imc/schedule'
import { calculateDuctHydraulics, sizeDuctForCfm } from './imc/sizing'
import {
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
} from './imc/tables'

function asRecord(nodes: SceneNodes): Readonly<Record<string, SceneNodeLike>> {
  return nodes as unknown as Readonly<Record<string, SceneNodeLike>>
}

function resolveLevelId(nodes: SceneNodes, requested: string | undefined, ctx: AgentContext): string | null {
  if (requested && nodes[requested]) return requested
  if (ctx.activeLevelId && nodes[ctx.activeLevelId]) return ctx.activeLevelId
  for (const n of Object.values(nodes)) {
    if ((n as { type?: string }).type === 'level') return (n as { id: string }).id
  }
  return null
}

function deterministicId(prefix: string, nodes: SceneNodes): string {
  let idx = 1
  while (nodes[`${prefix}_${idx}`]) idx += 1
  return `${prefix}_${idx}`
}

function collectAllSceneClearances(nodes: Readonly<Record<string, SceneNodeLike>>): DuctFramingClearance[] {
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
  return out
}

export const hvacAgentOperations = {
  hvac_place_equipment: (
    nodes: SceneNodes,
    input: {
      levelId?: string
      name?: string
      equipmentKind?: HvacEquipmentKind
      position: [number, number, number]
      rotation?: number
      roomName?: string
      coolingTons?: number
      gasBtuh?: number
      heatStripKw?: number
      occupancy?: OccupancyType
    },
    ctx: AgentContext,
  ) => {
    const levelId = resolveLevelId(nodes, input.levelId, ctx)
    if (!levelId) refuse('level_not_found', 'No level found in scene to host HVAC equipment.')
    const kind = input.equipmentKind ?? 'air-handler'
    const spec = HVAC_EQUIPMENT_SPECS[kind]
    const id = deterministicId('hvaceq', nodes)
    const tons = input.coolingTons ?? (kind === 'erv-ventilator' || kind === 'bath-exhaust-fan' || kind === 'range-hood' || kind === 'dehumidifier-whole-house' ? 0 : 3)
    const gasBtuh = input.gasBtuh ?? (spec.usesFuelGas ? 60000 : 0)
    const electricalDemand = getHvacEquipmentElectricalDemand({
      kind,
      coolingTons: tons || 3,
      heatStripKw: input.heatStripKw ?? 10,
      occupancy: input.occupancy ?? 'residential',
    })
    const pos: [number, number, number] = [
      input.position[0],
      input.position[1] === 0 && spec.defaultMountY > 0 ? spec.defaultMountY : input.position[1],
      input.position[2],
    ]
    const node = {
      object: 'node',
      id,
      type: 'hvac:equipment',
      name: input.name ?? spec.label,
      parentId: levelId,
      visible: true,
      metadata: {},
      position: pos,
      rotation: input.rotation ?? 0,
      equipmentKind: kind,
      roomName: input.roomName ?? 'Mechanical',
      coolingTons: tons,
      heatingBtuh: tons > 0 ? Math.round(tons * 12000) : Math.round(gasBtuh * 0.95),
      gasBtuh,
      airflowCfm: tons > 0 ? Math.round(tons * 400) : kind === 'bath-exhaust-fan' ? 80 : kind === 'range-hood' ? 250 : 120,
      seer2: tons > 0 ? 15.2 : 0,
      hspf2: tons > 0 ? 7.5 : 0,
      refrigerant: 'R-454B',
      hasSecondaryDrainPan: spec.needsCondensate,
      hasFloatSwitch: spec.needsCondensate,
      hasDisconnectWithinSight: true,
      electricalDemand,
    } as unknown as AnyNode

    return {
      result: { nodeId: id, name: node.name, equipmentKind: kind, levelId, electricalDemand, gasBtuh },
      changes: { create: [{ node, parentId: levelId }] },
    }
  },

  hvac_place_plenum: (
    nodes: SceneNodes,
    input: {
      levelId?: string
      name?: string
      plenumKind?: HvacPlenumKind
      position: [number, number, number]
      rotation?: number
      widthIn?: number
      heightIn?: number
      depthIn?: number
      airflowCfm?: number
    },
    ctx: AgentContext,
  ) => {
    const levelId = resolveLevelId(nodes, input.levelId, ctx)
    if (!levelId) refuse('level_not_found', 'No level found in scene to host HVAC plenum.')
    const id = deterministicId('hvacpl', nodes)
    const kind = input.plenumKind ?? 'supply-plenum'
    const widthIn = input.widthIn ?? 18
    const heightIn = input.heightIn ?? 10
    const depthIn = input.depthIn ?? 24
    const node = {
      object: 'node',
      id,
      type: 'hvac:plenum',
      name: input.name ?? `${kind} (${widthIn}"x${heightIn}")`,
      parentId: levelId,
      visible: true,
      metadata: {},
      position: input.position,
      rotation: input.rotation ?? 0,
      plenumKind: kind,
      widthIn,
      heightIn,
      depthIn,
      airflowCfm: input.airflowCfm ?? 1200,
      staticPressureInWg: kind === 'return-plenum' ? -0.2 : 0.25,
      insulationR: 8,
    } as unknown as AnyNode

    return {
      result: { nodeId: id, name: node.name, plenumKind: kind, levelId },
      changes: { create: [{ node, parentId: levelId }] },
    }
  },

  hvac_place_terminal: (
    nodes: SceneNodes,
    input: {
      levelId?: string
      name?: string
      terminalKind?: HvacTerminalKind
      position: [number, number, number]
      rotation?: number
      roomName?: string
      designCfm?: number
      neckSizeIn?: number
    },
    ctx: AgentContext,
  ) => {
    const levelId = resolveLevelId(nodes, input.levelId, ctx)
    if (!levelId) refuse('level_not_found', 'No level found in scene to host HVAC terminal.')
    const kind = input.terminalKind ?? 'supply-ceiling-diffuser'
    const spec = HVAC_TERMINAL_SPECS[kind]
    const id = deterministicId('hvacterm', nodes)
    const pos: [number, number, number] = [
      input.position[0],
      input.position[1] === 0 && spec.defaultMountY > 0 ? spec.defaultMountY : input.position[1],
      input.position[2],
    ]
    const cfm = input.designCfm ?? spec.defaultCfm
    const neckSizeIn = input.neckSizeIn ?? spec.defaultNeckIn
    const node = {
      object: 'node',
      id,
      type: 'hvac:terminal',
      name: input.name ?? spec.label,
      parentId: levelId,
      visible: true,
      metadata: {},
      position: pos,
      rotation: input.rotation ?? 0,
      terminalKind: kind,
      roomName: input.roomName ?? 'Living Room',
      designCfm: cfm,
      neckSizeIn,
      throwFt: cfm > 0 ? Math.min(18, Math.max(6, Math.round(cfm / 12))) : 0,
    } as unknown as AnyNode

    return {
      result: { nodeId: id, name: node.name, terminalKind: kind, designCfm: cfm, neckSizeIn },
      changes: { create: [{ node, parentId: levelId }] },
    }
  },

  hvac_route_duct: (
    nodes: SceneNodes,
    input: {
      levelId?: string
      name?: string
      from: [number, number, number]
      to: [number, number, number]
      system?: HvacDuctSystem
      shape?: DuctShape
      material?: DuctMaterial
      width?: number
      height?: number
      diameter?: number
      airflowCfm?: number
      insulationR?: number
      plenumLocation?: DuctPlenumLocation
    },
    ctx: AgentContext,
  ) => {
    const levelId = resolveLevelId(nodes, input.levelId, ctx)
    if (!levelId) refuse('level_not_found', 'No level found in scene to route HVAC duct.')
    const record = asRecord(nodes)
    const system = input.system ?? 'supply-branch'
    const isTrunk = system === 'supply-trunk' || system === 'return-trunk'
    const isReturn = system === 'return-trunk' || system === 'return-branch'
    const shape: DuctShape = input.shape ?? (isTrunk ? 'rectangular' : 'round')
    const material: DuctMaterial =
      input.material ??
      (system === 'refrigerant-lineset'
        ? 'insulated-copper'
        : system === 'condensate-drain'
          ? 'pvc-condensate'
          : isTrunk || system === 'exhaust-duct' || system === 'fresh-air-erv'
            ? 'galvanized-sheet'
            : 'flex-r8')

    const cfm = input.airflowCfm ?? (system === 'refrigerant-lineset' || system === 'condensate-drain' ? 0 : isTrunk ? 1000 : 120)
    const autoSized = cfm > 0 ? sizeDuctForCfm({ cfm, shape, material, isTrunk, isReturn }) : null
    const width = input.width ?? (shape === 'rectangular' ? (autoSized?.widthIn ?? 16) : (input.diameter ?? autoSized?.diameterIn ?? (system === 'condensate-drain' ? 1 : 6)))
    const height = input.height ?? (shape === 'rectangular' ? (autoSized?.heightIn ?? 8) : width)
    const diameter = input.diameter ?? (shape === 'round' ? (autoSized?.diameterIn ?? (system === 'condensate-drain' ? 1 : system === 'refrigerant-lineset' ? 2 : 6)) : (autoSized?.diameterIn ?? 12))

    const hyd =
      cfm > 0
        ? calculateDuctHydraulics({ cfm, shape, diameterIn: diameter, widthIn: width, heightIn: height, material, isTrunk, isReturn })
        : null

    const obstacles = extractHvacObstacles(record, levelId)
    const levelH = resolveLevelHeightM(record, levelId)
    const plenumLoc = input.plenumLocation ?? 'attic'
    const plenumY = plenumLoc === 'attic' ? levelH + 0.28 : plenumLoc === 'conditioned-soffit' ? levelH - 0.22 : -0.26

    let path: Vec3[]
    let lengthFt: number
    let detoured: boolean
    let clashes: ReturnType<typeof extractHvacObstacles>

    if (system === 'condensate-drain') {
      const r = routeCondensateDrain({ from: input.from, to: input.to, obstacles })
      path = r.path
      lengthFt = r.lengthFt
      detoured = r.detoured
      clashes = r.clashes
    } else {
      const halfSpan =
        shape === 'round'
          ? Math.max(0.03, (diameter * 0.0254) / 2)
          : Math.max(0.08, (Math.max(width, height) * 0.0254) / 2)
      const r = routeHvacDuctRun({
        from: input.from,
        to: input.to,
        plenumY,
        ductHalfSpanM: halfSpan,
        allowDiagonalBranch: !isTrunk && system !== 'refrigerant-lineset',
        obstacles,
      })
      path = r.path
      lengthFt = r.lengthFt
      detoured = r.detoured
      clashes = r.clashes
    }

    const id = deterministicId('hvacduct', nodes)
    const walls = extractWallSegments(record, levelId)
    const framingContext = extractHvacFramingContext(record, levelId)
    const clearances = computeDuctFramingClearances({
      ductRunId: id,
      path,
      shape,
      widthIn: width,
      heightIn: height,
      diameterIn: diameter,
      walls,
      framingContext,
    })

    const insulationR =
      input.insulationR ??
      (system === 'condensate-drain' ? 0 : system === 'refrigerant-lineset' ? 4 : plenumLoc === 'attic' ? 8 : 6)

    const node = {
      object: 'node',
      id,
      type: 'hvac:duct-run',
      name: input.name ?? `${shape === 'rectangular' ? `${width}"x${height}"` : `${diameter}"`} ${system}`,
      parentId: levelId,
      visible: true,
      metadata: {},
      path,
      system,
      shape,
      material,
      width,
      height,
      diameter,
      airflowCfm: cfm,
      velocityFpm: hyd?.velocityFpm ?? 0,
      frictionRateInWgPer100Ft: hyd?.frictionRateInWgPer100Ft ?? 0,
      insulationR,
      showFramingClearances: true,
    } as unknown as AnyNode

    return {
      result: {
        nodeId: id,
        lengthFt,
        velocityFpm: hyd?.velocityFpm ?? 0,
        detoured,
        clashes,
        clearances,
      },
      changes: { create: [{ node, parentId: levelId }] },
    }
  },

  hvac_autopopulate: (
    nodes: SceneNodes,
    input: {
      levelId?: string
      codeEdition?: CodeEdition
      occupancy?: OccupancyType
      climateZone?: ClimateZone
      systemType?: HvacSystemType
      plenumLocation?: DuctPlenumLocation
      includeErv?: boolean
      includeExhaustFans?: boolean
      clearExisting?: boolean
    },
    ctx: AgentContext,
  ) => {
    const levelId = resolveLevelId(nodes, input.levelId, ctx)
    if (!levelId) refuse('level_not_found', 'No level found in scene to auto-populate HVAC.')

    const deleteIds: string[] = []
    const baseNodes: Record<string, SceneNodeLike> = { ...asRecord(nodes) }
    if (input.clearExisting !== false) {
      for (const [id, n] of Object.entries(baseNodes)) {
        if (n.type.startsWith('hvac:') && (!n.parentId || n.parentId === levelId)) {
          deleteIds.push(id)
          delete baseNodes[id]
        }
      }
    }

    const plan = planHvacAutoPopulate(baseNodes, {
      levelId,
      codeEdition: input.codeEdition,
      occupancy: input.occupancy,
      climateZone: input.climateZone,
      systemType: input.systemType,
      plenumLocation: input.plenumLocation,
      includeErv: input.includeErv,
      includeExhaustFans: input.includeExhaustFans,
    })

    const created: Array<{ node: AnyNode; parentId: string }> = []
    const simulated: Record<string, SceneNodeLike> = { ...baseNodes }

    for (const eq of plan.equipment) {
      const node = { object: 'node', ...eq, type: 'hvac:equipment', parentId: levelId, visible: true, metadata: {} }
      created.push({ node: node as unknown as AnyNode, parentId: levelId })
      simulated[eq.id] = node as unknown as SceneNodeLike
    }
    for (const pl of plan.plenums) {
      const node = { object: 'node', ...pl, type: 'hvac:plenum', parentId: levelId, visible: true, metadata: {} }
      created.push({ node: node as unknown as AnyNode, parentId: levelId })
      simulated[pl.id] = node as unknown as SceneNodeLike
    }
    for (const t of plan.terminals) {
      const node = { object: 'node', ...t, type: 'hvac:terminal', parentId: levelId, visible: true, metadata: {} }
      created.push({ node: node as unknown as AnyNode, parentId: levelId })
      simulated[t.id] = node as unknown as SceneNodeLike
    }
    for (const d of plan.ductRuns) {
      const node = { object: 'node', ...d, type: 'hvac:duct-run', parentId: levelId, visible: true, metadata: {} }
      created.push({ node: node as unknown as AnyNode, parentId: levelId })
      simulated[d.id] = node as unknown as SceneNodeLike
    }

    const audit = auditSceneHvac(simulated, {
      codeEdition: plan.codeEdition,
      climateZone: plan.climateZone,
      occupancy: input.occupancy,
    })

    return {
      result: {
        levelId,
        summary: plan.summary,
        recommendedTons: plan.load.recommendedTons,
        designTotalCfm: plan.load.designTotalCfm,
        equipmentCount: plan.equipment.length,
        plenumCount: plan.plenums.length,
        terminalCount: plan.terminals.length,
        ductRunCount: plan.ductRuns.length,
        audit,
      },
      changes: {
        ...(deleteIds.length > 0 ? { delete: deleteIds } : {}),
        create: created,
      },
    }
  },

  hvac_calculate_loads: (
    nodes: SceneNodes,
    input: {
      codeEdition?: CodeEdition
      climateZone?: ClimateZone
      occupancy?: OccupancyType
      systemType?: HvacSystemType
    },
  ) => {
    const schedule = buildHvacSchedule(asRecord(nodes), {
      codeEdition: input.codeEdition ?? 'IMC-2021',
      climateZone: input.climateZone ?? '4A',
      occupancy: input.occupancy ?? 'residential',
      systemType: input.systemType ?? 'split-heat-pump',
    })
    return {
      result: {
        manualJ: schedule.manualJ,
        equipmentRec: schedule.equipmentRec,
        ventilation: schedule.ventilation,
        insulation: schedule.insulation,
        electricalCoordination: schedule.electricalCoordination,
        totalFurnaceGasBtuh: schedule.totalFurnaceGasBtuh,
      },
    }
  },

  hvac_generate_schedule: (
    nodes: SceneNodes,
    input: {
      codeEdition?: CodeEdition
      climateZone?: ClimateZone
      occupancy?: OccupancyType
      laborRateUsd?: number
      materialMarkupPct?: number
      salesTaxPct?: number
      includeInsulation?: boolean
    },
  ) => {
    const record = asRecord(nodes)
    const schedule = buildHvacSchedule(record, {
      codeEdition: input.codeEdition ?? 'IMC-2021',
      climateZone: input.climateZone ?? '4A',
      occupancy: input.occupancy ?? 'residential',
    })
    const bom = buildHvacBom(record, {
      codeEdition: input.codeEdition ?? 'IMC-2021',
      climateZone: input.climateZone ?? '4A',
      occupancy: input.occupancy ?? 'residential',
      laborRateUsd: input.laborRateUsd ?? 120,
      materialMarkupPct: input.materialMarkupPct ?? 0,
      salesTaxPct: input.salesTaxPct ?? 0,
      includeInsulation: input.includeInsulation ?? false,
      schedule,
    })
    const clearances = collectAllSceneClearances(record)
    return {
      result: {
        schedule,
        bom,
        clearances,
        scheduleCsv: formatHvacScheduleCsv(schedule),
        bomCsv: formatHvacBomCsv(bom),
      },
    }
  },

  hvac_audit_imc: (
    nodes: SceneNodes,
    input: { codeEdition?: CodeEdition; climateZone?: ClimateZone; occupancy?: OccupancyType },
  ) => {
    const audit = auditSceneHvac(asRecord(nodes), {
      codeEdition: input.codeEdition ?? 'IMC-2021',
      climateZone: input.climateZone ?? '4A',
      occupancy: input.occupancy ?? 'residential',
    })
    return { result: audit }
  },
} satisfies AgentOperations
