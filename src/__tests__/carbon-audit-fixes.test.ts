import { describe, expect, test } from 'bun:test'
import { Box3, Mesh } from 'three'
import { hvacAgentOperations } from '../agent-operations'
import { hvacAgentTools } from '../agent-tools'
import { buildDuctRunCad, buildHvacTerminalCad, buildWiredAirHandlerCutawayCad } from '../cad'
import {
  type SceneNodeLike,
  auditSceneHvac,
  buildHvacBom,
  buildHvacElectricalCoordination,
  buildHvacSchedule,
  calculateDuctHydraulics,
  collectSceneFramingClearances,
  computeDuctFramingClearances,
  extractHvacObstacles,
  extractRoomPolygons,
  formatHvacScheduleCsv,
  measureCondensateSlope,
  planHvacAutoPopulate,
  routeCondensateDrain,
} from '../imc'
import { HvacEquipmentNode, getHvacEquipmentPorts } from '../nodes/equipment'

describe('Phase 1 Gemini 4 Carbon Audit Regression Suite (BUG-01..10, OPT-01..04, CON-01..06)', () => {
  test('BUG-01: Multi-level hvac_autopopulate allocates collision-free IDs and belongsToLevel preserves Level 1 nodes', () => {
    const scene: Record<string, SceneNodeLike> = {
      level_1: { id: 'level_1', type: 'level', height: 2.7 },
      level_2: { id: 'level_2', type: 'level', height: 2.7 },
      r1: { id: 'r1', type: 'zone', name: 'Living Room', parentId: 'level_1', polygon: [[0, 0], [8, 0], [8, 6], [0, 6]] },
      r2: { id: 'r2', type: 'zone', name: 'Primary Bedroom', parentId: 'level_2', polygon: [[0, 0], [8, 0], [8, 6], [0, 6]] },
    }
    const res1 = hvacAgentOperations.hvac_autopopulate(scene as never, { levelId: 'level_1' }, { activeLevelId: 'level_1' })
    const afterLvl1: Record<string, SceneNodeLike> = { ...scene }
    const lvl1Ids = new Set<string>()
    for (const c of res1.changes?.create ?? []) {
      const id = (c.node as { id: string }).id
      lvl1Ids.add(id)
      afterLvl1[id] = c.node as unknown as SceneNodeLike
    }

    const res2 = hvacAgentOperations.hvac_autopopulate(afterLvl1 as never, { levelId: 'level_2' }, { activeLevelId: 'level_2' })
    expect(res2.changes?.delete ?? []).toEqual([]) // Level 1 untouched!
    for (const c of res2.changes?.create ?? []) {
      const id = (c.node as { id: string }).id
      expect(lvl1Ids.has(id)).toBe(false)
    }
  })

  test('BUG-02: buildHvacElectricalCoordination never double-claims one electrical:device and checks exact poles/voltage', () => {
    const nodes: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level' },
      cond_1: { id: 'cond_1', type: 'hvac:equipment', equipmentKind: 'heat-pump-condenser', parentId: 'level_0', position: [1, 0, 1], coolingTons: 3 },
      cond_2: { id: 'cond_2', type: 'hvac:equipment', equipmentKind: 'heat-pump-condenser', parentId: 'level_0', position: [1.5, 0, 1], coolingTons: 3 },
      erv_1: { id: 'erv_1', type: 'hvac:equipment', equipmentKind: 'erv-ventilator', parentId: 'level_0', position: [1.2, 1.5, 1] },
      dev_240: {
        id: 'dev_240',
        type: 'electrical:device',
        parentId: 'level_0',
        deviceKind: 'dedicated-240v',
        voltage: 240,
        poles: 2,
        breakerAmps: 40,
        circuitNumber: 12,
        panelId: 'p1',
        position: [1.2, 1.0, 1.0],
      },
    }
    const coord = buildHvacElectricalCoordination(nodes)
    const wired = coord.filter((c) => c.wired)
    expect(wired.length).toBe(1) // Only one condenser claims dev_240; cond_2 and 120V ERV remain unwired!
    const ervRow = coord.find((c) => c.sourceNodeId === 'erv_1')!
    expect(ervRow.wired).toBe(false)
  })

  test('BUG-03: Per-level gas pipe check in auditSceneHvac and non-inflated multi-story IECC attic/perimeter in buildHvacSchedule', () => {
    const multiStory: Record<string, SceneNodeLike> = {
      level_1: { id: 'level_1', type: 'level', height: 2.7 },
      level_2: { id: 'level_2', type: 'level', height: 2.7 },
      // 10m x 10m footprint (~1076 sq ft per floor, ~2152 sq ft total) + interior partition walls
      r1: { id: 'r1', type: 'zone', name: 'Living', parentId: 'level_1', polygon: [[0, 0], [10, 0], [10, 10], [0, 10]] },
      r2: { id: 'r2', type: 'zone', name: 'Bedroom', parentId: 'level_2', polygon: [[0, 0], [10, 0], [10, 10], [0, 10]] },
      w_int_1: { id: 'w_int_1', type: 'wall', parentId: 'level_1', start: [5, 0], end: [5, 10], height: 2.7 },
      w_int_2: { id: 'w_int_2', type: 'wall', parentId: 'level_1', start: [0, 5], end: [10, 5], height: 2.7 },
      gas_l1: { id: 'gas_l1', type: 'plumbing:pipe-run', parentId: 'level_1', system: 'fuel-gas', path: [[0, 0.4, 0], [2, 0.4, 0]] },
      furn_l2: { id: 'furn_l2', type: 'hvac:equipment', parentId: 'level_2', equipmentKind: 'gas-furnace-96', gasBtuh: 60000, hasSecondaryDrainPan: true, hasFloatSwitch: true },
    }
    const audit = auditSceneHvac(multiStory)
    // Level 1 has a gas pipe, Level 2 does NOT -> Level 2 gas furnace still emits IFGC info notice!
    expect(audit.findings.some((f) => f.codeRef.includes('IFGC') && f.nodeIds.includes('furn_l2'))).toBe(true)

    const sched = buildHvacSchedule(multiStory, { climateZone: '4A' })
    // Attic footprint is top-floor ~1076 sq ft, NOT 2152 sq ft double-counted across 2 stories!
    expect(sched.insulation.atticSqft).toBeLessThan(1200)
    expect(sched.insulation.atticSqft).toBeGreaterThan(950)
  })

  test('BUG-04: routeCondensateDrain keeps attic runs sloped overhead before dropping, and auditSceneHvac catches uphill condensate', () => {
    const atticCond = routeCondensateDrain({ from: [2, 2.9, 2], to: [8, 0.1, 2] })
    // Midpoint stays above ceiling (~2.7m+) instead of dropping through living space at x=2!
    expect(atticCond.path[1]![1]).toBeGreaterThan(2.5)
    expect(atticCond.path[atticCond.path.length - 1]![1]).toBeCloseTo(0.1, 2)
    expect(measureCondensateSlope(atticCond.path).hasUphillSegment).toBe(false)

    const uphillAudit = auditSceneHvac({
      level_0: { id: 'level_0', type: 'level' },
      bad_cond: {
        id: 'bad_cond',
        type: 'hvac:duct-run',
        parentId: 'level_0',
        system: 'condensate-drain',
        material: 'pvc-condensate',
        shape: 'round',
        diameter: 1,
        path: [
          [0, 0.2, 0],
          [4, 0.6, 0], // Uphill!
        ],
      },
    })
    expect(uphillAudit.findings.some((f) => f.codeRef === 'IMC 307.2.1')).toBe(true)
  })

  test('BUG-05: X-axis rectangular duct keeps width horizontal (Z) and height upright (Y), and dropped-soffit collar normal matches duct axis', () => {
    // 24" wide x 8" tall rectangular trunk running along +X (0,2,0) -> (4,2,0)
    const g = buildDuctRunCad({
      id: 'x_trunk',
      path: [
        [0, 2, 0],
        [4, 2, 0],
      ],
      system: 'supply-trunk',
      shape: 'rectangular',
      material: 'galvanized-sheet',
      widthIn: 24, // 0.6096 m horizontal span
      heightIn: 8, // 0.2032 m vertical span
      diameterIn: 14,
    })
    g.updateMatrixWorld(true)
    const box = new Box3().setFromObject(g)
    const spanY = box.max.y - box.min.y
    const spanZ = box.max.z - box.min.z
    expect(spanY).toBeCloseTo(8 * 0.0254, 2) // 8" tall vertically!
    expect(spanZ).toBeCloseTo(24 * 0.0254, 2) // 24" wide horizontally!

    const clr = computeDuctFramingClearances({
      ductRunId: 'soffit_x',
      path: [
        [0, -0.25, 2],
        [4, -0.25, 2],
      ],
      shape: 'rectangular',
      widthIn: 18,
      heightIn: 8,
      diameterIn: 12,
      walls: [],
    })
    const soffit = clr.find((c) => c.memberKind === 'dropped-soffit')!
    expect(Math.abs(soffit.wallNormal[0])).toBeGreaterThan(0.95)
    expect(Math.abs(soffit.wallNormal[1])).toBeLessThan(0.05)
  })

  test('BUG-06 & OPT-01: Diagonal structural beams subdivide into sub-AABBs and WeakMap caches obstacles & rooms', () => {
    const nodes: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      diag_beam: {
        id: 'diag_beam',
        type: 'structural:beam',
        parentId: 'level_0',
        start: [0, 0],
        end: [6, 6],
        widthIn: 4,
        depthIn: 12,
      },
      r1: { id: 'r1', type: 'zone', name: 'Room', parentId: 'level_0', polygon: [[0, 0], [6, 0], [6, 6], [0, 6]] },
    }
    const obs1 = extractHvacObstacles(nodes, 'level_0')
    const obs2 = extractHvacObstacles(nodes, 'level_0')
    expect(obs1).toBe(obs2) // WeakMap hit
    expect(obs1.filter((o) => o.id.startsWith('diag_beam:seg')).length).toBeGreaterThanOrEqual(3)

    const rooms1 = extractRoomPolygons(nodes, 'level_0')
    const rooms2 = extractRoomPolygons(nodes, 'level_0')
    expect(rooms1).toBe(rooms2) // WeakMap hit
  })

  test('BUG-08 & CON-06: Kitchen auto-populate adds range-hood + rigid metal exhaust, and audit enforces exhaust/fresh-air velocity & IMC 505.4', () => {
    const plan = planHvacAutoPopulate(
      {
        level_0: { id: 'level_0', type: 'level', height: 2.7 },
        r_kit: { id: 'r_kit', type: 'zone', name: 'Kitchen', parentId: 'level_0', polygon: [[0, 0], [5, 0], [5, 4], [0, 4]] },
      },
      { levelId: 'level_0', includeExhaustFans: true },
    )
    expect(plan.equipment.some((e) => e.equipmentKind === 'range-hood')).toBe(true)
    expect(plan.ductRuns.some((d) => d.system === 'exhaust-duct' && d.material === 'galvanized-sheet')).toBe(true)

    // Exhaust velocity cap (800 FPM res) and IMC 505.4 flex range hood duct violation
    const exHyd = calculateDuctHydraulics({ cfm: 250, shape: 'round', diameterIn: 4, system: 'exhaust-duct', occupancy: 'residential' })
    expect(exHyd.maxVelocityFpm).toBe(800)
    expect(exHyd.velocityOk).toBe(false)

    const badHoodAudit = auditSceneHvac({
      level_0: { id: 'level_0', type: 'level' },
      hood_1: { id: 'hood_1', type: 'hvac:equipment', equipmentKind: 'range-hood', parentId: 'level_0' },
      hood_flex: {
        id: 'hood_flex',
        type: 'hvac:duct-run',
        parentId: 'level_0',
        system: 'exhaust-duct',
        material: 'flex-r6',
        shape: 'round',
        diameter: 4,
        airflowCfm: 250,
        sourceNodeId: 'hood_1',
        path: [[1, 2.0, 1], [1, 2.6, 0]],
      },
    })
    expect(badHoodAudit.findings.some((f) => f.codeRef === 'IMC 505.4')).toBe(true)
    expect(badHoodAudit.findings.some((f) => f.title.includes('velocity'))).toBe(true)
  })

  test('BUG-10, OPT-02, OPT-03, CON-02, CON-03, CON-04: Equipment ports scale to dims, hoisted CAD geometries, refrigerant/heatStrip, CSV totals, BOM counts', () => {
    // BUG-10: bath-exhaust-fan port sits near its cabinet height (not y + 1.45m!)
    const fan = HvacEquipmentNode.parse({ id: 'hvaceq_fan', parentId: 'level_0', equipmentKind: 'bath-exhaust-fan', position: [2, 2.55, 2] })
    const fanPorts = getHvacEquipmentPorts(fan)
    expect(fanPorts[0]!.id).toBe('exhaust-out')
    expect(fanPorts[0]!.position[1]).toBeLessThan(2.75)

    // OPT-03: Shared blade geometry on return-grille & shared branch collar geometry on cutaway
    const grille = buildHvacTerminalCad({ terminalKind: 'return-grille' })
    const grilleGeos = new Set<unknown>()
    let grilleMeshes = 0
    grille.traverse((o) => {
      if (o instanceof Mesh) {
        grilleMeshes += 1
        grilleGeos.add(o.geometry)
      }
    })
    expect(grilleMeshes).toBe(8) // 1 frame + 7 blades
    expect(grilleGeos.size).toBe(2) // Only 2 shared geometries!

    const cutaway = buildWiredAirHandlerCutawayCad({ viewMode: 'joist-bay-cutaway' })
    expect(cutaway.children.length).toBeGreaterThan(10)

    // OPT-02: collectSceneFramingClearances is WeakMap-memoized
    const sc: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level' },
      d1: { id: 'd1', type: 'hvac:duct-run', parentId: 'level_0', shape: 'rectangular', width: 16, height: 8, path: [[0, -0.25, 0], [3, -0.25, 0]] },
    }
    expect(collectSceneFramingClearances(sc)).toBe(collectSceneFramingClearances(sc))

    // CON-02: refrigerant option & air-handler coolingTons=0 heatingBtuh from heatStripKw
    const eqTool = hvacAgentTools.tools.find((t) => t.name === 'hvac_place_equipment')!
    expect('refrigerant' in eqTool.input).toBe(true)
    const placed = hvacAgentOperations.hvac_place_equipment(
      { level_0: { object: 'node', id: 'level_0', type: 'level', visible: true, metadata: {} } } as never,
      { levelId: 'level_0', equipmentKind: 'air-handler', position: [1, 0, 1], coolingTons: 0, heatStripKw: 15, refrigerant: 'R-32' },
      { activeLevelId: 'level_0' },
    )
    const eqNode = placed.changes?.create?.[0]?.node as unknown as Record<string, unknown>
    expect(eqNode.refrigerant).toBe('R-32')
    expect(eqNode.heatingBtuh).toBe(Math.round(15 * 3412))

    // CON-03: Schedule CSV includes TOTAL summary row
    const sched = buildHvacSchedule({
      level_0: { id: 'level_0', type: 'level' },
      r1: { id: 'r1', type: 'zone', name: 'Office', parentId: 'level_0', polygon: [[0, 0], [5, 0], [5, 4], [0, 4]] },
    })
    expect(formatHvacScheduleCsv(sched)).toContain('TOTAL (')

    // CON-04: BOM scales pads & secondary pans by actual outdoor/condensate unit counts (0 pans for exhaust-only!)
    const bomTwoSystems = buildHvacBom({
      level_0: { id: 'level_0', type: 'level' },
      c1: { id: 'c1', type: 'hvac:equipment', equipmentKind: 'heat-pump-condenser', parentId: 'level_0' },
      c2: { id: 'c2', type: 'hvac:equipment', equipmentKind: 'ac-condenser', parentId: 'level_0' },
      a1: { id: 'a1', type: 'hvac:equipment', equipmentKind: 'air-handler', parentId: 'level_0' },
      a2: { id: 'a2', type: 'hvac:equipment', equipmentKind: 'gas-furnace-96', parentId: 'level_0' },
    })
    const padLine = bomTwoSystems.lines.find((l) => l.item.includes('Condenser Pad'))!
    const panLine = bomTwoSystems.lines.find((l) => l.item.includes('Secondary Condensate Pan'))!
    expect(padLine.quantity).toBe(2)
    expect(panLine.quantity).toBe(2)

    const bomFanOnly = buildHvacBom({
      level_0: { id: 'level_0', type: 'level' },
      f1: { id: 'f1', type: 'hvac:equipment', equipmentKind: 'bath-exhaust-fan', parentId: 'level_0' },
    })
    expect(bomFanOnly.lines.some((l) => l.item.includes('Secondary Condensate Pan'))).toBe(false)
  })
})
