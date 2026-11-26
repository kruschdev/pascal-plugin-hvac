import { describe, expect, test } from 'bun:test'
import {
  type SceneNodeLike,
  auditSceneHvac,
  buildHvacElectricalCoordination,
  buildHvacSchedule,
  planHvacAutoPopulate,
} from '../imc'

/**
 * End-to-End 4-Trade MEP Integration Test:
 *   Priority #1: Structural (`structural:assembly`, `structural:column`, `structural:beam`)
 *   Priority #2: Plumbing (`plumbing:equipment` gas WH, `plumbing:pipe-run` DWV stack & fuel-gas)
 *   Priority #3: HVAC (`hvac:equipment`, `hvac:plenum`, `hvac:terminal`, `hvac:duct-run`)
 *   Priority #4: Electrical (`electrical:panel` + dedicated 240V/120V breakers linked via `metadata.mepSourceNodeId`)
 */
describe('4-Trade MEP Coordination (Structural #1 -> Plumbing #2 -> HVAC #3 -> Electrical #4)', () => {
  test('Full 4-trade scene routes with 0 clashes and 100% HVAC-to-Electrical & Gas Furnace-to-Plumbing handoff', () => {
    const baseScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      // Envelope walls
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [12, 0], height: 2.7, thickness: 0.16 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [12, 0], end: [12, 8], height: 2.7, thickness: 0.16 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [12, 8], end: [0, 8], height: 2.7, thickness: 0.16 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 8], end: [0, 0], height: 2.7, thickness: 0.16 },
      // Rooms
      r_liv: { id: 'r_liv', type: 'zone', name: 'Living Room', parentId: 'level_0', polygon: [[0, 0], [6, 0], [6, 5], [0, 5]] },
      r_bed: { id: 'r_bed', type: 'zone', name: 'Primary Bedroom', parentId: 'level_0', polygon: [[0, 5], [6, 5], [6, 8], [0, 8]] },
      r_bath: { id: 'r_bath', type: 'zone', name: 'Bathroom', parentId: 'level_0', polygon: [[6, 5], [9, 5], [9, 8], [6, 8]] },
      r_util: { id: 'r_util', type: 'zone', name: 'Utility', parentId: 'level_0', polygon: [[9, 0], [12, 0], [12, 8], [9, 8]] },
      // Priority #1: Structural Assembly + Steel Column
      struct_asm: {
        id: 'struct_asm',
        type: 'structural:assembly',
        parentId: 'level_0',
        studSpacingIn: 16,
        floorSystem: 'tji-ijoist',
        joistDepthIn: 11.875,
      },
      struct_col: {
        id: 'struct_col',
        type: 'structural:column',
        name: 'Center Support Column',
        parentId: 'level_0',
        position: [6.0, 0, 4.0],
        widthIn: 6,
        depthIn: 6,
        heightM: 3.2,
      },
      // Priority #2: Plumbing 3" DWV Stack + Fuel-Gas Line
      plumb_stack: {
        id: 'plumb_stack',
        type: 'plumbing:pipe-run',
        name: '3" Main DWV Stack',
        parentId: 'level_0',
        system: 'dwv-drain',
        nominalSize: '3"',
        path: [
          [7.5, -0.3, 6.2],
          [7.5, 3.2, 6.2],
        ],
      },
      plumb_gas: {
        id: 'plumb_gas',
        type: 'plumbing:pipe-run',
        name: '3/4" Black-Iron Fuel Gas',
        parentId: 'level_0',
        system: 'fuel-gas',
        nominalSize: '3/4"',
        path: [
          [11.8, 0.4, 7.5],
          [11.8, 0.4, 5.5],
        ],
      },
      // Priority #4: Electrical Main Panel (NEC 110.26(E) protected footprint)
      elec_panel: {
        id: 'elec_panel',
        type: 'electrical:panel',
        name: 'MDP-1 (200A)',
        parentId: 'level_0',
        position: [11.7, 1.5, 1.0],
        width: 0.42,
        depth: 0.16,
        height: 0.92,
      },
    }

    // Run Priority #3 HVAC Auto-Populate (Gas Furnace + AC Condenser + ERV + Bath Exhaust)
    const plan = planHvacAutoPopulate(baseScene, {
      levelId: 'level_0',
      climateZone: '5A',
      systemType: 'split-gas-furnace',
      plenumLocation: 'attic',
      includeErv: true,
      includeExhaustFans: true,
    })

    const scene: Record<string, SceneNodeLike> = { ...baseScene }
    for (const eq of plan.equipment) scene[eq.id] = { ...eq, type: 'hvac:equipment', parentId: 'level_0' }
    for (const pl of plan.plenums) scene[pl.id] = { ...pl, type: 'hvac:plenum', parentId: 'level_0' }
    for (const t of plan.terminals) scene[t.id] = { ...t, type: 'hvac:terminal', parentId: 'level_0' }
    for (const d of plan.ductRuns) scene[d.id] = { ...d, type: 'hvac:duct-run', parentId: 'level_0' }

    // Before Electrical wires the HVAC loads, buildHvacElectricalCoordination reports every powered unit as unwired
    const preCoord = buildHvacElectricalCoordination(scene)
    expect(preCoord.length).toBeGreaterThanOrEqual(3) // furnace + AC condenser + ERV (+ bath fan)
    expect(preCoord.every((r) => !r.wired)).toBe(true)

    // Simulate Priority #4 Electrical ingesting each HVAC node's `electricalDemand` payload & assigning breakers
    let cktNum = 10
    for (const eq of plan.equipment) {
      if (!eq.electricalDemand.required) continue
      const devId = `elec_dev_${eq.id}`
      scene[devId] = {
        id: devId,
        type: 'electrical:device',
        parentId: 'level_0',
        panelId: 'elec_panel',
        circuitNumber: cktNum,
        deviceKind: eq.electricalDemand.poles >= 2 ? 'dedicated-240v' : 'receptacle',
        poles: eq.electricalDemand.poles,
        breakerAmps: eq.electricalDemand.breakerAmps,
        position: eq.position,
        metadata: { mepSourceNodeId: eq.id },
      }
      cktNum += eq.electricalDemand.poles === 2 ? 2 : 1
    }

    // Verify 100% electrical handoff & 0 audit errors/warnings!
    const postCoord = buildHvacElectricalCoordination(scene)
    expect(postCoord.every((r) => r.wired && typeof r.matchedCircuitNumber === 'number')).toBe(true)

    const sched = buildHvacSchedule(scene, { climateZone: '5A', systemType: 'split-gas-furnace' })
    expect(sched.totalFurnaceGasBtuh).toBeGreaterThanOrEqual(40000)

    const audit = auditSceneHvac(scene, { climateZone: '5A', codeEdition: 'IMC-2021' })
    expect(audit.errorCount).toBe(0)
    expect(audit.warningCount).toBe(0)
    expect(audit.infoCount).toBe(0) // Fuel-gas pipe is present, so zero IFGC info notices too!
  })
})
