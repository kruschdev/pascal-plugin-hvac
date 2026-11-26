import { describe, expect, test } from 'bun:test'
import { auditSceneHvac } from '../imc/audit'
import { planHvacAutoPopulate } from '../imc/autopopulate'
import { routeHvacDuctRun, type HvacObstacle } from '../imc/routing'
import type { SceneNodeLike } from '../imc/framing-interop'

describe('Cross-Trade 4-MEP Coordination Regression Suite (XTRADE-04)', () => {
  test('routeHvacDuctRun steps cleanly over attic Priority #2 DWV vent pipes via elevation hop', () => {
    const dwvVent: HvacObstacle = {
      id: 'plumb_vent_1',
      category: 'plumbing',
      label: 'Plumbing 1-1/2" dwv-vent',
      box: { minX: 0, maxX: 10, minY: 2.8, maxY: 3.05, minZ: 3.9, maxZ: 4.1 },
    }
    const routed = routeHvacDuctRun({
      from: [5, 2.67, 2],
      to: [5, 2.67, 6],
      plenumY: 2.95,
      ductHalfSpanM: 0.1,
      allowDiagonalBranch: true,
      obstacles: [dwvVent],
    })
    expect(routed.clashes).toHaveLength(0)
    expect(routed.detoured).toBe(true)
  })

  test('planHvacAutoPopulate nudges return plenum, diffusers, and exhaust fan clear of plumbing equipment/vents', () => {
    const scene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', name: 'Level 1', height: 2.7 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [10, 0], height: 2.7, thickness: 0.16 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [10, 0], end: [10, 8], height: 2.7, thickness: 0.16 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [10, 8], end: [0, 8], height: 2.7, thickness: 0.16 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 8], end: [0, 0], height: 2.7, thickness: 0.16 },
      r_util: { id: 'r_util', type: 'zone', parentId: 'level_0', name: 'Utility', polygon: [[0, 0], [5, 0], [5, 8], [0, 8]] },
      r_bath: { id: 'r_bath', type: 'zone', parentId: 'level_0', name: 'Bathroom', polygon: [[5, 0], [10, 0], [10, 8], [5, 8]] },
      wh_1: { id: 'wh_1', type: 'plumbing:equipment', parentId: 'level_0', name: 'Water Heater', position: [2.5, 0, 4] },
      bath_vent: {
        id: 'bath_vent',
        type: 'plumbing:pipe-run',
        parentId: 'level_0',
        system: 'dwv-vent',
        nominalSize: '1-1/2"',
        path: [[7.5, 0.5, 4], [7.5, 2.95, 4]],
      },
    }

    const plan = planHvacAutoPopulate(scene, { levelId: 'level_0' })
    const bathFan = plan.equipment.find((e) => e.equipmentKind === 'bath-exhaust-fan')
    expect(bathFan).toBeDefined()
    const fanDistToVent = Math.hypot(bathFan!.position[0] - 7.5, bathFan!.position[2] - 4)
    expect(fanDistToVent).toBeGreaterThan(0.25)
  })

  test('auditSceneHvac auto-detects commercial occupancy from packaged-rtu/3-phase panels when occupancy is omitted (XTRADE-22)', () => {
    const scene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', name: 'Ground Floor', height: 3.05 },
      rtu_1: {
        id: 'rtu_1',
        type: 'hvac:equipment',
        parentId: 'level_0',
        name: 'Packaged RTU (6 Ton)',
        equipmentKind: 'rooftop-package-unit',
        position: [2, 3.3, 2],
        coolingTons: 6,
        airflowCfm: 2400,
        electricalDemand: { voltage: 208, phases: 3, mca: 35, mop: 50, disconnectRequired: true },
      },
      trunk_sup: {
        id: 'trunk_sup',
        type: 'hvac:duct-run',
        parentId: 'level_0',
        name: '26"x12" Main Supply Trunk (2400 CFM)',
        system: 'supply-trunk',
        shape: 'rectangular',
        width: 26,
        height: 12,
        material: 'galvanized-sheet',
        insulationR: 8,
        airflowCfm: 2400,
        path: [
          [2, 2.75, 2],
          [10, 2.75, 2],
        ],
      },
      trunk_ret: {
        id: 'trunk_ret',
        type: 'hvac:duct-run',
        parentId: 'level_0',
        name: '24"x14" Return Air Trunk (2400 CFM)',
        system: 'return-trunk',
        shape: 'rectangular',
        width: 24,
        height: 14,
        material: 'galvanized-sheet',
        insulationR: 8,
        airflowCfm: 2400,
        path: [
          [10, 2.75, 4],
          [2, 2.75, 4],
        ],
      },
    }

    const audit = auditSceneHvac(scene)
    const velWarns = audit.findings.filter((f) => /Duct velocity/i.test(f.title))
    expect(velWarns).toHaveLength(0)
  })
})
