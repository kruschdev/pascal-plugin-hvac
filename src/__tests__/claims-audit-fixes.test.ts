import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'
import { Box3, Group, Mesh, Vector3 } from 'three'
import { hvacAgentOperations } from '../agent-operations'
import { hvacAgentTools } from '../agent-tools'
import {
  HVAC_CAD_CATALOG,
  buildDuctRunCad,
  buildHvacCadPart,
  buildHvacEquipmentCad,
  buildHvacPlenumCad,
  buildWiredAirHandlerCutawayCad,
} from '../cad'
import {
  type SceneNodeLike,
  auditSceneHvac,
  buildHvacSchedule,
  calculateManualJLoad,
  classifyHvacRoomName,
  extractHvacObstacles,
  extractRoomPolygons,
  getHvacEquipmentElectricalDemand,
  planHvacAutoPopulate,
  pointInPolygon2D,
  sizeHvacEquipment,
} from '../imc'
import { hvacChatExtension } from '../index'
import { HvacDuctRunNode } from '../nodes/duct-run'
import { hvacDuctRunParametrics } from '../nodes/parametrics'

function collectMeshBoxes(root: Group): Array<{ mesh: Mesh; box: Box3 }> {
  root.updateMatrixWorld(true)
  const out: Array<{ mesh: Mesh; box: Box3 }> = []
  root.traverse((obj) => {
    if (obj instanceof Mesh) {
      out.push({ mesh: obj, box: new Box3().setFromObject(obj) })
    }
  })
  return out
}

function boxesTouchOrOverlap(a: Box3, b: Box3, eps = 0.002): boolean {
  return (
    a.min.x <= b.max.x + eps &&
    a.max.x >= b.min.x - eps &&
    a.min.y <= b.max.y + eps &&
    a.max.y >= b.min.y - eps &&
    a.min.z <= b.max.z + eps &&
    a.max.z >= b.min.z - eps
  )
}

function countConnectedComponents(root: Group, eps = 0.002): number {
  const items = collectMeshBoxes(root)
  if (items.length <= 1) return items.length
  const visited = new Set<number>()
  let components = 0
  for (let i = 0; i < items.length; i++) {
    if (visited.has(i)) continue
    components += 1
    const stack = [i]
    visited.add(i)
    while (stack.length > 0) {
      const cur = stack.pop()!
      for (let j = 0; j < items.length; j++) {
        if (visited.has(j)) continue
        if (boxesTouchOrOverlap(items[cur]!.box, items[j]!.box, eps)) {
          visited.add(j)
          stack.push(j)
        }
      }
    }
  }
  return components
}

describe('Claims-vs-Reality Audit Fix Regression Suite (HVC-01..HVC-08)', () => {
  test('HVC-01: Segment-level IECC R403.3.1 audit catches uninsulated attic supply & return trunks even with indoor vertical drops', () => {
    const scene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [10, 0], height: 2.7, thickness: 0.16 },
      // Supply trunk starts low indoors (y=1.53), rises into attic (y=2.98), runs horizontally in attic, drops back down
      // Vertex average Y = (1.53 + 2.98 + 2.98 + 1.8) / 4 = 2.32 < 2.75 (old avgY missed it!)
      supply_attic_unins: {
        id: 'supply_attic_unins',
        type: 'hvac:duct-run',
        parentId: 'level_0',
        name: 'Uninsulated Attic Supply Trunk',
        system: 'supply-trunk',
        shape: 'rectangular',
        material: 'galvanized-sheet',
        width: 18,
        height: 8,
        airflowCfm: 1000,
        insulationR: 0,
        path: [
          [1, 1.53, 1],
          [1, 2.98, 1],
          [8, 2.98, 1],
          [8, 1.8, 1],
        ],
      },
      // Return trunk starts at grille (y=2.2), rises to attic (y=3.22), runs horizontally, drops to return plenum (y=0.25)
      // Vertex average Y = (2.2 + 3.22 + 3.22 + 0.25) / 4 = 2.22 < 2.75 (old avgY missed it!)
      return_attic_unins: {
        id: 'return_attic_unins',
        type: 'hvac:duct-run',
        parentId: 'level_0',
        name: 'Uninsulated Attic Return Trunk',
        system: 'return-trunk',
        shape: 'rectangular',
        material: 'galvanized-sheet',
        width: 20,
        height: 10,
        airflowCfm: 1000,
        insulationR: 4,
        path: [
          [5, 2.2, 4],
          [5, 3.22, 4],
          [1, 3.22, 4],
          [1, 0.25, 4],
        ],
      },
      // Conditioned soffit supply duct running entirely below ceiling (y=2.45 < 2.75) should NOT trigger attic R-8 error
      soffit_ok: {
        id: 'soffit_ok',
        type: 'hvac:duct-run',
        parentId: 'level_0',
        name: 'Conditioned Soffit Trunk',
        system: 'supply-trunk',
        shape: 'rectangular',
        material: 'galvanized-sheet',
        width: 18,
        height: 8,
        airflowCfm: 1000,
        insulationR: 0,
        path: [
          [1, 2.45, 2],
          [6, 2.45, 2],
        ],
      },
    }

    const audit = auditSceneHvac(scene, { climateZone: '4A' })
    const ieccFindings = audit.findings.filter((f) => f.codeRef === 'IECC R403.3.1')
    expect(ieccFindings.some((f) => f.nodeIds.includes('supply_attic_unins'))).toBe(true)
    expect(ieccFindings.some((f) => f.nodeIds.includes('return_attic_unins'))).toBe(true)
    expect(ieccFindings.some((f) => f.nodeIds.includes('soffit_ok'))).toBe(false)
  })

  test('HVC-02: IMC 601.5 / IRC M1602.2 blocks prohibited return-air zones in autopopulate and flags them in auditSceneHvac', () => {
    // Scene where only prohibited rooms + 1 bedroom exist: returnRoom must pick Bedroom (NOT Bathroom/Garage/Kitchen/Utility)
    const mixedScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      r_bath: { id: 'r_bath', type: 'zone', name: 'Bathroom', parentId: 'level_0', polygon: [[0, 0], [3, 0], [3, 3], [0, 3]] },
      r_gar: { id: 'r_gar', type: 'zone', name: 'Garage', parentId: 'level_0', polygon: [[3, 0], [8, 0], [8, 5], [3, 5]] },
      r_kit: { id: 'r_kit', type: 'zone', name: 'Kitchen', parentId: 'level_0', polygon: [[0, 3], [3, 3], [3, 6], [0, 6]] },
      r_bed: { id: 'r_bed', type: 'zone', name: 'Guest Bedroom', parentId: 'level_0', polygon: [[0, 6], [6, 6], [6, 10], [0, 10]] },
    }
    const plan = planHvacAutoPopulate(mixedScene, { levelId: 'level_0', systemType: 'split-heat-pump' })
    const retGrille = plan.terminals.find((t) => t.terminalKind === 'return-grille')
    expect(retGrille).toBeDefined()
    expect(retGrille!.roomName).toBe('Guest Bedroom')

    // Scene with ZERO habitable rooms (only Bathroom + Garage): autopopulate must omit illegal return grille & warn cleanly
    const prohibitedOnly: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      r_bath: { id: 'r_bath', type: 'zone', name: 'Bathroom', parentId: 'level_0', polygon: [[0, 0], [4, 0], [4, 4], [0, 4]] },
      r_gar: { id: 'r_gar', type: 'zone', name: 'Garage', parentId: 'level_0', polygon: [[4, 0], [9, 0], [9, 4], [4, 4]] },
    }
    const noHabPlan = planHvacAutoPopulate(prohibitedOnly, { levelId: 'level_0', systemType: 'split-heat-pump' })
    expect(noHabPlan.terminals.some((t) => t.terminalKind === 'return-grille')).toBe(false)
    expect(noHabPlan.summary).toContain('IMC 601.5')

    // Audit flags return-grille placed inside prohibited zones (both via polygon and via roomName)
    const badRetScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      r_bath: { id: 'r_bath', type: 'zone', name: 'Master Bath', parentId: 'level_0', polygon: [[0, 0], [4, 0], [4, 4], [0, 4]] },
      r_gar: { id: 'r_gar', type: 'zone', name: 'Garage', parentId: 'level_0', polygon: [[4, 0], [9, 0], [9, 4], [4, 4]] },
      ret_in_bath: {
        id: 'ret_in_bath',
        type: 'hvac:terminal',
        parentId: 'level_0',
        terminalKind: 'return-grille',
        roomName: 'Hallway', // even if mislabeled Hallway, geometric polygon is Master Bath!
        position: [2, 2.1, 2],
      },
      ret_in_kitchen_name: {
        id: 'ret_in_kitchen_name',
        type: 'hvac:terminal',
        parentId: 'level_0',
        terminalKind: 'return-grille',
        roomName: 'Kitchen',
        position: [12, 2.1, 12],
      },
    }
    const audit = auditSceneHvac(badRetScene)
    const imc6015 = audit.findings.filter((f) => f.codeRef === 'IMC 601.5 / IRC M1602.2' && f.severity === 'error')
    expect(imc6015.some((f) => f.nodeIds.includes('ret_in_bath'))).toBe(true)
    expect(imc6015.some((f) => f.nodeIds.includes('ret_in_kitchen_name'))).toBe(true)
  })

  test('HVC-03: rooftop-package RTU connects to roof curb plenums directly below rtuPos and generates 3/4" condensate drain', () => {
    const base: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 3.0 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [14, 0], height: 3.0, thickness: 0.16 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [14, 0], end: [14, 10], height: 3.0, thickness: 0.16 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [14, 10], end: [0, 10], height: 3.0, thickness: 0.16 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 10], end: [0, 0], height: 3.0, thickness: 0.16 },
      r_open: { id: 'r_open', type: 'zone', name: 'Open Office', parentId: 'level_0', polygon: [[0, 0], [10, 0], [10, 10], [0, 10]] },
      r_util: { id: 'r_util', type: 'zone', name: 'Utility', parentId: 'level_0', polygon: [[10, 0], [14, 0], [14, 10], [10, 10]] },
    }
    const plan = planHvacAutoPopulate(base, { levelId: 'level_0', systemType: 'rooftop-package', climateZone: '4A' })
    const rtu = plan.equipment.find((e) => e.equipmentKind === 'rooftop-package-unit')!
    const supPl = plan.plenums.find((p) => p.plenumKind === 'supply-plenum')!
    const retPl = plan.plenums.find((p) => p.plenumKind === 'return-plenum')!
    const rtuCond = plan.ductRuns.find((d) => d.system === 'condensate-drain' && d.sourceNodeId === rtu.id)

    expect(rtu).toBeDefined()
    expect(supPl).toBeDefined()
    expect(retPl).toBeDefined()
    expect(rtuCond).toBeDefined()
    expect(rtuCond!.diameter).toBe(0.75)

    // Both curb drop plenums sit directly under the RTU curb (levelH - 0.15 = 2.85), NOT at distant mechRoom centroid (12, 5)
    expect(Math.hypot(supPl.position[0] - rtu.position[0], supPl.position[2] - rtu.position[2])).toBeLessThan(0.6)
    expect(Math.hypot(retPl.position[0] - rtu.position[0], retPl.position[2] - rtu.position[2])).toBeLessThan(0.6)
    expect(supPl.position[1]).toBeCloseTo(2.85, 2)
    expect(retPl.position[1]).toBeCloseTo(2.85, 2)

    const materialized: Record<string, SceneNodeLike> = { ...base }
    for (const eq of plan.equipment) materialized[eq.id] = { ...eq, type: 'hvac:equipment', parentId: 'level_0' }
    for (const pl of plan.plenums) materialized[pl.id] = { ...pl, type: 'hvac:plenum', parentId: 'level_0' }
    for (const t of plan.terminals) materialized[t.id] = { ...t, type: 'hvac:terminal', parentId: 'level_0' }
    for (const d of plan.ductRuns) materialized[d.id] = { ...d, type: 'hvac:duct-run', parentId: 'level_0' }

    const audit = auditSceneHvac(materialized, { climateZone: '4A' })
    expect(audit.errorCount).toBe(0)
    expect(audit.warningCount).toBe(0)
  })

  test('HVC-04: classifyHvacRoomName prioritizes bath/closet/utility/attic/garage/exterior over master/primary/guest and reads zone.category', () => {
    expect(classifyHvacRoomName('Master Bath')).toBe('bathroom')
    expect(classifyHvacRoomName('Primary Bath')).toBe('bathroom')
    expect(classifyHvacRoomName('Guest Bath')).toBe('bathroom')
    expect(classifyHvacRoomName('Master Closet')).toBe('utility')
    expect(classifyHvacRoomName('Primary Walk-In Closet')).toBe('utility')
    expect(classifyHvacRoomName('Unconditioned Attic')).toBe('attic')
    expect(classifyHvacRoomName('Master Bedroom')).toBe('bedroom')
    expect(classifyHvacRoomName('Primary Bedroom')).toBe('bedroom')
    expect(classifyHvacRoomName('Outdoor Patio')).toBe('exterior')

    const rooms = extractRoomPolygons({
      level_0: { id: 'level_0', type: 'level' },
      z_cat: { id: 'z_cat', type: 'zone', name: 'Zone A', category: 'bathroom', parentId: 'level_0', polygon: [[0, 0], [3, 0], [3, 3], [0, 3]] },
      z_attic: { id: 'z_attic', type: 'zone', name: 'Attic Space', parentId: 'level_0', polygon: [[0, 0], [10, 0], [10, 8], [0, 8]] },
      z_liv: { id: 'z_liv', type: 'zone', name: 'Living Room', parentId: 'level_0', polygon: [[3, 0], [10, 0], [10, 5], [3, 5]] },
    })
    expect(rooms.find((r) => r.id === 'z_cat')?.category).toBe('bathroom')
    expect(rooms.find((r) => r.id === 'z_attic')?.category).toBe('attic')

    // Attic must be excluded as unconditioned in Manual J
    const load = calculateManualJLoad({
      rooms: rooms.map((r) => ({ id: r.id, name: r.name, category: r.category, areaSqft: r.areaSqft })),
    })
    expect(load.rooms.some((r) => r.roomId === 'z_attic')).toBe(false)
    expect(load.rooms.some((r) => r.roomId === 'z_liv')).toBe(true)
  })

  test('HVC-05: Anisotropic rect duct clash, live hasCondensate audit, RTU pan exemption, base nodeIds (no :segN), and tuple panel rotation', () => {
    // 1. Anisotropic 24"x8" rectangular duct running 15 cm clear below structural beam -> 0 false vertical clash!
    // Beam center y=2.50, depth 12" (0.3048m) -> beam bottom = 2.3476m.
    // Duct center y=2.09, height 8" (halfH = 0.1016m) -> duct top = 2.1916m (15.6 cm clear below beam!).
    // Old isotropic margin used halfW = 12" = 0.3048m -> 2.09 + 0.3248 = 2.4148 > 2.3476 (FALSE clash!).
    const clearBeamScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      beam_1: { id: 'beam_1', type: 'structural:beam', parentId: 'level_0', start: [3, 0], end: [3, 6], widthIn: 3.5, depthIn: 12, elevationY: 2.5 },
      flat_trunk: {
        id: 'flat_trunk',
        type: 'hvac:duct-run',
        parentId: 'level_0',
        system: 'supply-trunk',
        shape: 'rectangular',
        material: 'galvanized-sheet',
        width: 24,
        height: 8,
        airflowCfm: 1000,
        insulationR: 8,
        path: [[0, 2.09, 3], [6, 2.09, 3]],
      },
      ret_1: { id: 'ret_1', type: 'hvac:terminal', parentId: 'level_0', terminalKind: 'return-grille', roomName: 'Hallway', position: [1, 2.1, 1] },
    }
    const clearAudit = auditSceneHvac(clearBeamScene)
    expect(clearAudit.findings.some((f) => f.codeRef.includes('Structural'))).toBe(false)

    // 2. Diagonal beam collision deduplicates to base nodeId (NEVER leaks `:segN`)
    const clashScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      diag_beam: { id: 'diag_beam', type: 'structural:beam', parentId: 'level_0', start: [0, 0], end: [6, 6], widthIn: 4, depthIn: 12, elevationY: 2.2 },
      bad_trunk: {
        id: 'bad_trunk',
        type: 'hvac:duct-run',
        parentId: 'level_0',
        system: 'supply-trunk',
        shape: 'rectangular',
        width: 18,
        height: 8,
        airflowCfm: 800,
        insulationR: 8,
        path: [[0, 2.2, 0], [6, 2.2, 6]],
      },
      ret_1: { id: 'ret_1', type: 'hvac:terminal', parentId: 'level_0', terminalKind: 'return-grille', roomName: 'Hallway', position: [1, 2.1, 1] },
    }
    const clashAudit = auditSceneHvac(clashScene)
    const structFindings = clashAudit.findings.filter((f) => f.codeRef.includes('Structural'))
    expect(structFindings.length).toBe(1) // Deduplicated across sub-segments!
    expect(structFindings[0]!.nodeIds).toEqual(['bad_trunk', 'diag_beam'])
    expect(structFindings[0]!.nodeIds.some((id) => id.includes(':seg'))).toBe(false)

    // 3. Live hasCondensate audit flags indoor cooling coil without condensate-drain; outdoor RTU exempt from indoor secondary pan error
    const noCondScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      ahu_1: { id: 'ahu_1', type: 'hvac:equipment', parentId: 'level_0', equipmentKind: 'air-handler', coolingTons: 3, hasSecondaryDrainPan: true, hasFloatSwitch: true },
      rtu_1: { id: 'rtu_1', type: 'hvac:equipment', parentId: 'level_0', equipmentKind: 'rooftop-package-unit', coolingTons: 4, hasSecondaryDrainPan: false, hasFloatSwitch: true, hasDisconnectWithinSight: true },
    }
    const condAudit = auditSceneHvac(noCondScene)
    expect(condAudit.findings.some((f) => f.codeRef === 'IMC 307.2.1' && f.nodeIds.includes('ahu_1'))).toBe(true)
    expect(condAudit.findings.some((f) => f.codeRef === 'IMC 307.2.3' && f.nodeIds.includes('rtu_1'))).toBe(false)

    // 4. Tuple rotation [rx, ry, rz] on electrical:panel rotates footprint accurately
    const rotObs = extractHvacObstacles({
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      panel_0: { id: 'panel_0', type: 'electrical:panel', parentId: 'level_0', position: [2, 1.5, 2], width: 0.6, depth: 0.16, rotation: [0, 0, 0] },
      panel_90: { id: 'panel_90', type: 'electrical:panel', parentId: 'level_0', position: [5, 1.5, 2], width: 0.6, depth: 0.16, rotation: [0, Math.PI / 2, 0] },
    })
    const p0 = rotObs.find((o) => o.id === 'panel_0')!
    const p90 = rotObs.find((o) => o.id === 'panel_90')!
    expect(p0.box.maxX - p0.box.minX).toBeGreaterThan(p0.box.maxZ - p0.box.minZ)
    expect(p90.box.maxZ - p90.box.minZ).toBeGreaterThan(p90.box.maxX - p90.box.minX)
  })

  test('HVC-06: Cold-climate heating CFM / furnace rise <= 70F, large-tonnage breaker, 0.75" condensate schema, and equipment defaults', () => {
    // 1. Cold climate Zone 7 heating-dominated home (2500 sq ft): furnace temperature rise stays <= 70 deg F!
    const coldLoad = calculateManualJLoad({
      rooms: [{ id: 'r1', name: 'Main House', category: 'living', areaSqft: 2500, ceilingHeightFt: 8.5 }],
      climateZone: '7',
    })
    const coldEq = sizeHvacEquipment({
      coolingTons: coldLoad.recommendedTons,
      heatingBtuh: coldLoad.totalHeatingBtuh,
      systemType: 'split-gas-furnace',
      climateZone: '7',
    })
    const furnaceTempRiseF = coldEq.heatingOutputBtuh / (1.08 * coldLoad.designTotalCfm)
    expect(coldLoad.designTotalCfm).toBeGreaterThan(coldLoad.recommendedTons * 400)
    expect(furnaceTempRiseF).toBeLessThanOrEqual(70)

    // 2. Large-tonnage air handler breaker scaling (>3.5T)
    const eq35 = sizeHvacEquipment({ coolingTons: 3.5, heatingBtuh: 42000, systemType: 'split-heat-pump' })
    const eq50 = sizeHvacEquipment({ coolingTons: 5.0, heatingBtuh: 60000, systemType: 'split-heat-pump' })
    const eq75 = sizeHvacEquipment({ coolingTons: 7.5, heatingBtuh: 90000, systemType: 'split-heat-pump' })
    expect(eq35.airHandlerBreakerAmps).toBe(60)
    expect(eq50.airHandlerBreakerAmps).toBe(90)
    expect(eq75.airHandlerBreakerAmps).toBe(125)

    // 3. 0.75" PVC condensate drain Zod schema & routing defaults
    const parsedCond = HvacDuctRunNode.parse({
      id: 'hvacduct_cond_1',
      parentId: 'level_0',
      system: 'condensate-drain',
      shape: 'round',
      material: 'pvc-condensate',
      width: 0.75,
      height: 0.75,
      diameter: 0.75,
      path: [[1, 0.95, 1], [5, 0.05, 1]],
    })
    expect(parsedCond.diameter).toBe(0.75)

    const baseScene = { level_0: { object: 'node', id: 'level_0', type: 'level', visible: true, metadata: {} } } as never
    const routedCond = hvacAgentOperations.hvac_route_duct(
      baseScene,
      { from: [1, 0.95, 1], to: [5, 0.05, 1], system: 'condensate-drain' },
      { activeLevelId: 'level_0' },
    )
    expect((routedCond.changes.create?.[0]?.node as unknown as Record<string, unknown>).diameter).toBe(0.75)

    // 4. Equipment defaults: gas-furnace-80 (0.80 AFUE), gas-furnace-96 (0.96 AFUE), ac-condenser (0 heating/hspf2), air-handler heatStripKw: 0
    const f80 = hvacAgentOperations.hvac_place_equipment(
      baseScene,
      { levelId: 'level_0', equipmentKind: 'gas-furnace-80', position: [1, 0, 1], gasBtuh: 80000 },
      { activeLevelId: 'level_0' },
    ).changes.create?.[0]?.node as unknown as Record<string, unknown>
    expect(f80.heatingBtuh).toBe(64000)
    expect(f80.hspf2).toBe(0)

    const f96 = hvacAgentOperations.hvac_place_equipment(
      baseScene,
      { levelId: 'level_0', equipmentKind: 'gas-furnace-96', position: [1, 0, 1], gasBtuh: 80000 },
      { activeLevelId: 'level_0' },
    ).changes.create?.[0]?.node as unknown as Record<string, unknown>
    expect(f96.heatingBtuh).toBe(76800)
    expect(f96.hspf2).toBe(0)

    const ac = hvacAgentOperations.hvac_place_equipment(
      baseScene,
      { levelId: 'level_0', equipmentKind: 'ac-condenser', position: [5, 0, 1], coolingTons: 3.5 },
      { activeLevelId: 'level_0' },
    ).changes.create?.[0]?.node as unknown as Record<string, unknown>
    expect(ac.heatingBtuh).toBe(0)
    expect(ac.hspf2).toBe(0)

    const blowerOnlyDemand = getHvacEquipmentElectricalDemand({ kind: 'air-handler', coolingTons: 3, heatStripKw: 0 })
    expect(blowerOnlyDemand.voltage).toBe(120)
    expect(blowerOnlyDemand.poles).toBe(1)
    expect(blowerOnlyDemand.breakerAmps).toBe(15)
  })

  test('HVC-07: Box3 checks confirm zero floating CAD air gaps, grounded air handler without pan, live supply plenum seating, and hollow collars', () => {
    // 1. Live supply-plenum sits flush on top of air handler cabinet (0 mm gap!)
    const plan = planHvacAutoPopulate(
      {
        level_0: { id: 'level_0', type: 'level', height: 2.7 },
        r_liv: { id: 'r_liv', type: 'zone', name: 'Living Room', parentId: 'level_0', polygon: [[0, 0], [8, 0], [8, 6], [0, 6]] },
      },
      { levelId: 'level_0', systemType: 'split-heat-pump' },
    )
    const ahu = plan.equipment.find((e) => e.equipmentKind === 'air-handler')!
    const supPl = plan.plenums.find((p) => p.plenumKind === 'supply-plenum')!
    const ahuGroup = buildHvacEquipmentCad({
      equipmentKind: 'air-handler',
      coolingTons: ahu.coolingTons,
      hasSecondaryDrainPan: ahu.hasSecondaryDrainPan,
    })
    ahuGroup.position.set(ahu.position[0], ahu.position[1], ahu.position[2])
    ahuGroup.updateMatrixWorld(true)
    const ahuBox = new Box3().setFromObject(ahuGroup)

    const plGroup = buildHvacPlenumCad({
      plenumKind: 'supply-plenum',
      widthIn: supPl.widthIn,
      heightIn: supPl.heightIn,
      depthIn: supPl.depthIn,
    })
    plGroup.position.set(supPl.position[0], supPl.position[1], supPl.position[2])
    plGroup.updateMatrixWorld(true)
    const plBox = new Box3().setFromObject(plGroup)

    expect(Math.abs(plBox.min.y - ahuBox.max.y)).toBeLessThan(0.002)

    // 2. Air handler with hasSecondaryDrainPan: false sits flush on floor (minY === 0)
    const ahuNoPan = buildHvacEquipmentCad({ equipmentKind: 'air-handler', hasSecondaryDrainPan: false })
    ahuNoPan.updateMatrixWorld(true)
    const ahuNoPanBox = new Box3().setFromObject(ahuNoPan)
    expect(ahuNoPanBox.min.y).toBeCloseTo(0, 4)

    // 3. Zero floating air gaps (single connected component) across fixed fittings & cutaways
    for (const partId of [
      'fit-rect-transition',
      'acc-lineset-insulated',
      'acc-condensate-trap-ss2',
      'assembly-air-handler-joist-cutaway',
      'assembly-air-handler-open-plenum',
    ]) {
      const g = buildHvacCadPart(partId)!
      expect(g).not.toBeNull()
      expect(countConnectedComponents(g, 0.003)).toBe(1)
    }

    // 4. Cutaway with 6 branches extends supply trunk dynamically so collars #5 & #6 stay attached, dampers flush, joists inside subfloor
    const sixBranches = Array.from({ length: 6 }, (_, i) => ({
      index: i,
      label: `Room ${i + 1}`,
      cfm: 130,
      diameterIn: i === 0 ? 8 : 6,
      side: 'supply' as const,
    }))
    const cutaway6 = buildWiredAirHandlerCutawayCad({
      coolingTons: 4,
      viewMode: 'joist-bay-cutaway',
      branches: sixBranches,
    })
    expect(countConnectedComponents(cutaway6, 0.003)).toBe(1)
    cutaway6.updateMatrixWorld(true)
    const subfloorMesh = cutaway6.getObjectByName('subfloor') as Mesh
    const subfloorBox = new Box3().setFromObject(subfloorMesh)
    cutaway6.traverse((obj) => {
      if (obj instanceof Mesh && obj.name.startsWith('joist-')) {
        const jb = new Box3().setFromObject(obj)
        expect(jb.min.x).toBeGreaterThanOrEqual(subfloorBox.min.x - 0.001)
        expect(jb.max.x).toBeLessThanOrEqual(subfloorBox.max.x + 0.001)
      }
    })

    // 5. Framing collars for dropped-soffit and top-plate are hollow around centerline and top-plate lies horizontally
    const ductWithCollars = buildDuctRunCad({
      id: 'collar_check',
      path: [[0, 2.0, 0], [0, 3.0, 0]],
      system: 'supply-trunk',
      shape: 'rectangular',
      material: 'galvanized-sheet',
      widthIn: 14,
      heightIn: 8,
      diameterIn: 10,
      clearances: [
        {
          memberKind: 'top-plate',
          position: [0, 2.66, 0],
          ductDirection: [0, 1, 0],
          wallNormal: [1, 0],
          openingWidthIn: 15,
          openingHeightIn: 9,
          codeCompliant: true,
        },
        {
          memberKind: 'dropped-soffit',
          position: [2, -0.25, 0],
          ductDirection: [1, 0, 0],
          wallNormal: [1, 0],
          openingWidthIn: 16,
          openingHeightIn: 10,
          codeCompliant: true,
        },
      ],
    })
    ductWithCollars.updateMatrixWorld(true)
    const topPlateCollar = ductWithCollars.getObjectByName('hvac-collar-top-plate') as Group
    const topPlateBox = new Box3().setFromObject(topPlateCollar)
    expect(topPlateBox.max.y - topPlateBox.min.y).toBeLessThan(0.05) // Lies flat horizontally in XZ!
    const topPlateCenter = new Vector3(0, 2.66, 0)
    for (const { box } of collectMeshBoxes(topPlateCollar)) {
      expect(box.containsPoint(topPlateCenter)).toBe(false) // Hollow opening around duct!
    }
    const soffitCollar = ductWithCollars.getObjectByName('hvac-collar-dropped-soffit') as Group
    const soffitCenter = new Vector3(2, -0.25, 0)
    for (const { box } of collectMeshBoxes(soffitCollar)) {
      expect(box.containsPoint(soffitCenter)).toBe(false) // Hollow opening, not a baffle!
    }
  })

  test('HVC-08: Schedule live velocity, walls-only fallback, elevation-sorted attic footprint, even parametrics, tool metadata, & 42/42 docs parity', () => {
    // 1. Live velocity recomputation overrides stale stored velocityFpm
    const schedStale = buildHvacSchedule({
      level_2: { id: 'level_2', type: 'level', elevation: 3.0, height: 2.7 },
      level_1: { id: 'level_1', type: 'level', elevation: 0.0, height: 2.7 },
      // Level 1 (lower) is 20m x 10m; Level 2 (higher, inserted FIRST!) is 10m x 10m + unconditioned attic
      r_l1: { id: 'r_l1', type: 'zone', name: 'Living Room', parentId: 'level_1', polygon: [[0, 0], [20, 0], [20, 10], [0, 10]] },
      r_l2: { id: 'r_l2', type: 'zone', name: 'Bedroom', parentId: 'level_2', polygon: [[0, 0], [10, 0], [10, 10], [0, 10]] },
      r_l2_gar: { id: 'r_l2_gar', type: 'zone', name: 'Garage', parentId: 'level_2', polygon: [[10, 0], [16, 0], [16, 10], [10, 10]] },
      d_stale: {
        id: 'd_stale',
        type: 'hvac:duct-run',
        parentId: 'level_1',
        system: 'supply-branch',
        shape: 'round',
        material: 'flex-r8',
        diameter: 4,
        airflowCfm: 200,
        velocityFpm: 123, // Stale stored value! True velocity for 200 CFM in 4" = 2292 FPM
        path: [[0, 2.9, 0], [4, 2.9, 0]],
      },
    })
    expect(schedStale.ductSummary[0]!.maxVelocityFpm).toBeGreaterThan(2000)
    // Top-level conditioned footprint must be Level 2's 10m x 10m (~1076 sq ft), NOT Level 1's 2152 sq ft and excluding Garage!
    expect(schedStale.insulation.atticSqft).toBeGreaterThan(1000)
    expect(schedStale.insulation.atticSqft).toBeLessThan(1150)

    // 2. Walls-only fallback computes non-zero conditionedSqft
    const wallsOnlySched = buildHvacSchedule({
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [10, 0], height: 2.7 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [10, 0], end: [10, 8], height: 2.7 },
    })
    expect(wallsOnlySched.manualJ.conditionedSqft).toBeGreaterThan(800)

    // 3. Parametrics even steps for rectangular duct width/height
    const dimFields = hvacDuctRunParametrics.groups[0]!.fields
    const wField = dimFields.find((f) => f.key === 'width')!
    const hField = dimFields.find((f) => f.key === 'height')!
    expect(wField.kind === 'number' && wField.min === 2 && wField.step === 2).toBe(true)
    expect(hField.kind === 'number' && hField.min === 2 && hField.step === 2).toBe(true)

    // 4. destructiveHint: true on hvac_autopopulate + all 8 tools registered in hvacChatExtension.cards
    const autoTool = hvacAgentTools.tools.find((t) => t.name === 'hvac_autopopulate')!
    expect(autoTool.annotations?.destructiveHint).toBe(true)
    for (const t of hvacAgentTools.tools) {
      expect(typeof hvacChatExtension.cards?.[t.name]).toBe('function')
    }

    // 5. 42/42 docs/CAD-CATALOG.md slug parity + zero em-dashes in docs/README/UI
    const rootDir = path.resolve(import.meta.dir, '../..')
    const cadCatalogMd = fs.readFileSync(path.join(rootDir, 'docs', 'CAD-CATALOG.md'), 'utf8')
    const imcRefMd = fs.readFileSync(path.join(rootDir, 'docs', 'IMC-REFERENCE.md'), 'utf8')
    const readmeMd = fs.readFileSync(path.join(rootDir, 'README.md'), 'utf8')
    const schedViewTsx = fs.readFileSync(path.join(rootDir, 'src', 'ui', 'schedule-view.tsx'), 'utf8')

    for (const part of HVAC_CAD_CATALOG) {
      expect(cadCatalogMd).toContain(`\`${part.id}\``)
      expect(fs.existsSync(path.join(rootDir, 'assets', 'cad', `${part.id}.glb`))).toBe(true)
    }
    expect(cadCatalogMd).not.toContain('—')
    expect(imcRefMd).not.toContain('—')
    expect(readmeMd).not.toContain('—')
    expect(schedViewTsx).not.toContain('—')
  })

  test('Pass-2 Referee Fixes: narrow hallway return containment, unconditioned storage/category precedence, nested rooms, >3.5T strip heat, clipped attic segments, 96% furnace/RTU condensate, & lineset width', () => {
    // 1. Narrow hallway (0.6m wide in Z) directly adjacent to Bathroom + obstacle near centroid: return-grille stays inside hallway!
    const narrowHallScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [8, 0], height: 2.7, thickness: 0.16 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [8, 0], end: [8, 6], height: 2.7, thickness: 0.16 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [8, 6], end: [0, 6], height: 2.7, thickness: 0.16 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 6], end: [0, 0], height: 2.7, thickness: 0.16 },
      r_hall: { id: 'r_hall', type: 'zone', name: 'Hallway', parentId: 'level_0', polygon: [[1, 2.0], [7, 2.0], [7, 2.6], [1, 2.6]] },
      r_bath: { id: 'r_bath', type: 'zone', name: 'Bathroom', parentId: 'level_0', polygon: [[1, 2.6], [7, 2.6], [7, 5.5], [1, 5.5]] },
      r_liv: { id: 'r_liv', type: 'zone', name: 'Living Room', parentId: 'level_0', polygon: [[1, 0.2], [7, 0.2], [7, 2.0], [1, 2.0]] },
      obs_pipe: { id: 'obs_pipe', type: 'plumbing:pipe-run', parentId: 'level_0', nominalSize: '3"', path: [[4, 0, 2.3], [4, 3.0, 2.3]] },
    }
    const hallPlan = planHvacAutoPopulate(narrowHallScene, { levelId: 'level_0', systemType: 'split-heat-pump' })
    const hallRet = hallPlan.terminals.find((t) => t.terminalKind === 'return-grille')!
    expect(hallRet).toBeDefined()
    expect(pointInPolygon2D(hallRet.position[0], hallRet.position[2], [[1, 2.0], [7, 2.0], [7, 2.6], [1, 2.6]])).toBe(true)
    const matHall: Record<string, SceneNodeLike> = { ...narrowHallScene }
    for (const eq of hallPlan.equipment) matHall[eq.id] = { ...eq, type: 'hvac:equipment', parentId: 'level_0' }
    for (const pl of hallPlan.plenums) matHall[pl.id] = { ...pl, type: 'hvac:plenum', parentId: 'level_0' }
    for (const t of hallPlan.terminals) matHall[t.id] = { ...t, type: 'hvac:terminal', parentId: 'level_0' }
    for (const d of hallPlan.ductRuns) matHall[d.id] = { ...d, type: 'hvac:duct-run', parentId: 'level_0' }
    const hallAudit = auditSceneHvac(matHall)
    expect(hallAudit.findings.some((f) => f.codeRef === 'IMC 601.5 / IRC M1602.2')).toBe(false)

    // 2. Unconditioned spaces win over utility/storage, and zone.category takes precedence when non-'other'
    expect(classifyHvacRoomName('Attic Storage')).toBe('attic')
    expect(classifyHvacRoomName('Garage Storage')).toBe('garage')
    expect(classifyHvacRoomName('Outdoor Storage')).toBe('exterior')
    const catRooms = extractRoomPolygons({
      level_0: { id: 'level_0', type: 'level' },
      z_override: { id: 'z_override', type: 'zone', name: 'Garage View Storage', category: 'living', parentId: 'level_0', polygon: [[0, 0], [4, 0], [4, 4], [0, 4]] },
      z_fallback: { id: 'z_fallback', type: 'zone', name: 'Master Bath', category: 'other', parentId: 'level_0', polygon: [[4, 0], [8, 0], [8, 4], [4, 4]] },
    })
    expect(catRooms.find((r) => r.id === 'z_override')?.category).toBe('living')
    expect(catRooms.find((r) => r.id === 'z_fallback')?.category).toBe('bathroom')

    // 3. Nested rooms & attic exclusion below ceiling height in IMC 601.5 audit
    const nestedScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [10, 0], height: 2.7 },
      // Whole-floor attic polygon overlaps living room below
      z_attic: { id: 'z_attic', type: 'zone', name: 'Attic', parentId: 'level_0', polygon: [[0, 0], [10, 0], [10, 10], [0, 10]] },
      z_liv: { id: 'z_liv', type: 'zone', name: 'Living Room', parentId: 'level_0', polygon: [[0, 0], [8, 0], [8, 8], [0, 8]] },
      z_bath_nested: { id: 'z_bath_nested', type: 'zone', name: 'Powder Room', parentId: 'level_0', polygon: [[5, 5], [7, 5], [7, 7], [5, 7]] },
      ret_liv_ok: { id: 'ret_liv_ok', type: 'hvac:terminal', parentId: 'level_0', terminalKind: 'return-grille', roomName: 'Living Room', position: [2, 2.1, 2] },
      ret_bath_bad: { id: 'ret_bath_bad', type: 'hvac:terminal', parentId: 'level_0', terminalKind: 'return-grille', roomName: 'Living Room', position: [6, 2.1, 6] },
    }
    const nestedAudit = auditSceneHvac(nestedScene)
    const nested6015 = nestedAudit.findings.filter((f) => f.codeRef === 'IMC 601.5 / IRC M1602.2')
    expect(nested6015.some((f) => f.nodeIds.includes('ret_liv_ok'))).toBe(false)
    expect(nested6015.some((f) => f.nodeIds.includes('ret_bath_bad'))).toBe(true)

    // 4. > 3.5T heat pump scales heatStripKw to 15 kW (90A) / 20 kW (125A) matching sizeHvacEquipment().airHandlerBreakerAmps
    const bigHouse: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      r_main: { id: 'r_main', type: 'zone', name: 'Great Room', parentId: 'level_0', polygon: [[0, 0], [18, 0], [18, 12], [0, 12]] },
    }
    const bigPlan = planHvacAutoPopulate(bigHouse, { levelId: 'level_0', climateZone: '2A', systemType: 'split-heat-pump' })
    const bigAhu = bigPlan.equipment.find((e) => e.equipmentKind === 'air-handler')!
    expect(bigPlan.load.recommendedTons).toBeGreaterThan(3.5)
    expect(bigAhu.electricalDemand.breakerAmps).toBe(bigPlan.equipmentSpec.airHandlerBreakerAmps)

    // 5. Clipped segment fraction catches sloped duct crossing into unconditioned attic even when segment midY < levelH + 0.05
    const slopedAtticAudit = auditSceneHvac({
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [10, 0], height: 2.7 },
      sloped_unins: {
        id: 'sloped_unins',
        type: 'hvac:duct-run',
        parentId: 'level_0',
        system: 'supply-branch',
        shape: 'round',
        diameter: 6,
        airflowCfm: 100,
        insulationR: 0,
        // midY = 2.5 < 2.75, but 25% (1.0m horizontal) extends above atticThresholdY = 2.75 up to 3.0m!
        path: [[0, 2.0, 1], [4, 3.0, 1]],
      },
      ret_ok: { id: 'ret_ok', type: 'hvac:terminal', parentId: 'level_0', terminalKind: 'return-grille', roomName: 'Hallway', position: [1, 2.1, 1] },
    })
    expect(slopedAtticAudit.findings.some((f) => f.codeRef === 'IECC R403.3.1' && f.nodeIds.includes('sloped_unins'))).toBe(true)

    // 6. Heat-only 96% condensing furnace (coolingTons: 0) still requires condensate drain; outdoor RTU exempt from both pan & float-switch warnings
    const condAudit2 = auditSceneHvac({
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      furn_heat_only: { id: 'furn_heat_only', type: 'hvac:equipment', parentId: 'level_0', equipmentKind: 'gas-furnace-96', coolingTons: 0, gasBtuh: 80000, hasSecondaryDrainPan: true, hasFloatSwitch: true },
      rtu_no_pan_no_float: { id: 'rtu_no_pan_no_float', type: 'hvac:equipment', parentId: 'level_0', equipmentKind: 'rooftop-package-unit', coolingTons: 4, hasSecondaryDrainPan: false, hasFloatSwitch: false, hasDisconnectWithinSight: true },
    })
    expect(condAudit2.findings.some((f) => f.codeRef === 'IMC 307.2.1' && f.nodeIds.includes('furn_heat_only'))).toBe(true)
    expect(condAudit2.findings.some((f) => f.codeRef === 'IMC 307.2.3' && f.nodeIds.includes('rtu_no_pan_no_float'))).toBe(false)
    expect(condAudit2.findings.some((f) => f.codeRef === 'IMC 307.2.3(3)' && f.nodeIds.includes('rtu_no_pan_no_float'))).toBe(false)

    // 7. hvac_route_duct for refrigerant-lineset defaults width/height/diameter consistently to 2"
    const lineRes = hvacAgentOperations.hvac_route_duct(
      { level_0: { object: 'node', id: 'level_0', type: 'level', visible: true, metadata: {} } } as never,
      { from: [1, 1.1, 1], to: [6, 0.4, 1], system: 'refrigerant-lineset' },
      { activeLevelId: 'level_0' },
    )
    const lineNode = lineRes.changes.create?.[0]?.node as unknown as Record<string, unknown>
    expect(lineNode.width).toBe(2)
    expect(lineNode.height).toBe(2)
    expect(lineNode.diameter).toBe(2)
  })
})
