import { describe, expect, test } from 'bun:test'
import { auditSceneHvac } from '../imc/audit'
import { planHvacAutoPopulate } from '../imc/autopopulate'
import { routeHvacDuctRun, type HvacObstacle } from '../imc/routing'
import { sizeDuctForCfm } from '../imc/sizing'
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

  test('Realistic Attic Mechanical Platform & Wall-Snapped Thermostat when no dedicated utility room exists', () => {
    const twoBrScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.5 },
      w_n: { id: 'w_n', type: 'wall', parentId: 'level_0', start: [0, 0], end: [10, 0], height: 2.5, thickness: 0.16 },
      w_e: { id: 'w_e', type: 'wall', parentId: 'level_0', start: [10, 0], end: [10, 8], height: 2.5, thickness: 0.16 },
      w_s: { id: 'w_s', type: 'wall', parentId: 'level_0', start: [10, 8], end: [0, 8], height: 2.5, thickness: 0.16 },
      w_w: { id: 'w_w', type: 'wall', parentId: 'level_0', start: [0, 8], end: [0, 0], height: 2.5, thickness: 0.16 },
      w_mid: { id: 'w_mid', type: 'wall', parentId: 'level_0', start: [0, 4], end: [10, 4], height: 2.5, thickness: 0.14 },
      r_liv: { id: 'r_liv', type: 'zone', name: 'Living Room', parentId: 'level_0', polygon: [[0, 4], [6, 4], [6, 8], [0, 8]] },
      r_kit: { id: 'r_kit', type: 'zone', name: 'Kitchen', parentId: 'level_0', polygon: [[6, 4], [10, 4], [10, 8], [6, 8]] },
      r_bed1: { id: 'r_bed1', type: 'zone', name: 'Bedroom 1', parentId: 'level_0', polygon: [[0, 0], [4, 0], [4, 4], [0, 4]] },
      r_bath: { id: 'r_bath', type: 'zone', name: 'Bath', parentId: 'level_0', polygon: [[4, 0], [7, 0], [7, 4], [4, 4]] },
      r_bed2: { id: 'r_bed2', type: 'zone', name: 'Bedroom 2', parentId: 'level_0', polygon: [[7, 0], [10, 0], [10, 4], [7, 4]] },
      // Plumbing water heater tucked cleanly into Kitchen SE corner
      wh_kit: { id: 'wh_kit', type: 'plumbing:equipment', equipmentKind: 'water-heater-tank-electric', parentId: 'level_0', position: [9.5, 0, 7.5] },
    }
    const plan = planHvacAutoPopulate(twoBrScene, {
      levelId: 'level_0',
      climateZone: '4A',
      systemType: 'split-heat-pump',
      plenumLocation: 'attic',
      includeErv: true,
    })
    const ahu = plan.equipment.find((e) => e.equipmentKind === 'air-handler')!
    const erv = plan.equipment.find((e) => e.equipmentKind === 'erv-ventilator')!
    const retGrille = plan.terminals.find((t) => t.terminalKind === 'return-grille')!
    const thermostat = plan.terminals.find((t) => t.terminalKind === 'smart-thermostat')!

    // Air Handler and ERV mount on Attic Mechanical Platform (not on the Living Room floor!)
    expect(ahu.position[1]).toBeGreaterThanOrEqual(2.5)
    expect(ahu.roomName).toBe('Attic Mechanical Platform')
    expect(erv.position[1]).toBeGreaterThanOrEqual(2.5)
    // Ceiling return grille flushes to ceiling rather than hanging in mid-air
    expect(retGrille.position[1]).toBeGreaterThanOrEqual(2.4)
    // Smart thermostat snaps near a Living Room wall (not at Living Room centroid [3, 6])
    expect(Math.hypot(thermostat.position[0] - 3, thermostat.position[2] - 6)).toBeGreaterThan(0.9)

    // Full IMC/IECC audit passes cleanly with 0 errors and 0 warnings
    const fullScene: Record<string, SceneNodeLike> = { ...twoBrScene }
    for (const eq of plan.equipment) fullScene[eq.id] = { ...eq, type: 'hvac:equipment', parentId: 'level_0' }
    for (const pl of plan.plenums) fullScene[pl.id] = { ...pl, type: 'hvac:plenum', parentId: 'level_0' }
    for (const t of plan.terminals) fullScene[t.id] = { ...t, type: 'hvac:terminal', parentId: 'level_0' }
    for (const d of plan.ductRuns) fullScene[d.id] = { ...d, type: 'hvac:duct-run', parentId: 'level_0' }
    const audit = auditSceneHvac(fullScene, { climateZone: '4A' })
    expect(audit.errorCount).toBe(0)
    expect(audit.warningCount).toBe(0)
  })

  test('Shared Mechanical Room + Plumbing synchronicity: places AHU & ERV clear of WH/Manifold and condenser on nearest exterior wall clear of Gas Meter', () => {
    const sharedScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.6 },
      w_n: { id: 'w_n', type: 'wall', parentId: 'level_0', start: [-7, -4.5], end: [7, -4.5], height: 2.6, thickness: 0.16 },
      w_e: { id: 'w_e', type: 'wall', parentId: 'level_0', start: [7, -4.5], end: [7, 4.5], height: 2.6, thickness: 0.16 },
      w_s: { id: 'w_s', type: 'wall', parentId: 'level_0', start: [7, 4.5], end: [-7, 4.5], height: 2.6, thickness: 0.16 },
      w_w: { id: 'w_w', type: 'wall', parentId: 'level_0', start: [-7, 4.5], end: [-7, -4.5], height: 2.6, thickness: 0.16 },
      r_mech: { id: 'r_mech', type: 'zone', name: 'Mechanical Room', parentId: 'level_0', polygon: [[-7, -4.5], [-4, -4.5], [-4, -0.5], [-7, -0.5]] },
      r_bath: { id: 'r_bath', type: 'zone', name: 'Bath', parentId: 'level_0', polygon: [[-1.6, -4.5], [1.4, -4.5], [1.4, -0.5], [-1.6, -0.5]] },
      r_liv: { id: 'r_liv', type: 'zone', name: 'Living Room', parentId: 'level_0', polygon: [[-7, -0.5], [2.2, -0.5], [2.2, 4.5], [-7, 4.5]] },
      r_kit: { id: 'r_kit', type: 'zone', name: 'Kitchen', parentId: 'level_0', polygon: [[2.2, -0.5], [7, -0.5], [7, 4.5], [2.2, 4.5]] },
      wh_gas: { id: 'wh_gas', type: 'plumbing:equipment', equipmentKind: 'water-heater-tank-gas', name: 'Gas Water Heater (40 gal)', parentId: 'level_0', position: [-5.5, 0, -4.08] },
      man_pex: { id: 'man_pex', type: 'plumbing:manifold', name: 'PEX Home-Run Manifold', parentId: 'level_0', position: [-4.85, 1.35, -4.08] },
      gas_mtr: { id: 'gas_mtr', type: 'plumbing:equipment', equipmentKind: 'gas-meter', name: 'Natural Gas Meter', parentId: 'level_0', position: [-7.15, 0.9, -3.28] },
    }
    const plan = planHvacAutoPopulate(sharedScene, {
      levelId: 'level_0',
      climateZone: '4A',
      systemType: 'split-heat-pump',
      plenumLocation: 'attic',
      includeErv: true,
    })
    const ahu = plan.equipment.find((e) => e.equipmentKind === 'air-handler')!
    const cond = plan.equipment.find((e) => e.equipmentKind === 'heat-pump-condenser')!
    // Air Handler stays inside Mechanical Room and clear of Plumbing WH/Manifold
    expect(ahu.roomName).toBe('Mechanical Room')
    expect(ahu.position[0]).toBeGreaterThanOrEqual(-7)
    expect(ahu.position[0]).toBeLessThanOrEqual(-4)
    expect(Math.hypot(ahu.position[0] - -5.5, ahu.position[2] - -4.08)).toBeGreaterThanOrEqual(1.1)
    // Outdoor Condenser mounts on nearest exterior West wall (x < -7), >= 1.2m clear of Gas Meter
    expect(cond.position[0]).toBeLessThan(-7)
    expect(Math.abs(cond.position[2] - -3.28)).toBeGreaterThanOrEqual(1.2)

    const fullScene: Record<string, SceneNodeLike> = { ...sharedScene }
    for (const eq of plan.equipment) fullScene[eq.id] = { ...eq, type: 'hvac:equipment', parentId: 'level_0' }
    for (const pl of plan.plenums) fullScene[pl.id] = { ...pl, type: 'hvac:plenum', parentId: 'level_0' }
    for (const t of plan.terminals) fullScene[t.id] = { ...t, type: 'hvac:terminal', parentId: 'level_0' }
    for (const d of plan.ductRuns) fullScene[d.id] = { ...d, type: 'hvac:duct-run', parentId: 'level_0' }
    const audit = auditSceneHvac(fullScene, { climateZone: '4A' })
    expect(audit.errorCount).toBe(0)
    expect(audit.warningCount).toBe(0)
  })

  test('Large commercial RTU trunks (11,600 CFM supermarket) size up to 72"x36" within commercial velocity caps (XTRADE-25)', () => {
    const sup = sizeDuctForCfm({
      cfm: 11600,
      shape: 'rectangular',
      isTrunk: true,
      isReturn: false,
      occupancy: 'commercial',
      maxHeightIn: 12,
    })
    const ret = sizeDuctForCfm({
      cfm: 11600,
      shape: 'rectangular',
      isTrunk: true,
      isReturn: true,
      occupancy: 'commercial',
      maxHeightIn: 14,
    })
    expect(sup.velocityFpm).toBeLessThanOrEqual(1400)
    expect(ret.velocityFpm).toBeLessThanOrEqual(1100)
  })
})
