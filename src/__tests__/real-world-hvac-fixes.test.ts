import { describe, expect, test } from 'bun:test'
import { auditSceneHvac } from '../imc/audit'
import { planHvacAutoPopulate } from '../imc/autopopulate'
import type { SceneNodeLike } from '../imc/framing-interop'
import {
  classifyHvacRoomName,
  detectHvacClashes,
  extractHvacObstacles,
  measureCondensateSlope,
  routeCondensateDrain,
  routeHvacDuctRun,
} from '../imc/routing'

function materializeHvac(
  base: Record<string, SceneNodeLike>,
  plan: ReturnType<typeof planHvacAutoPopulate>,
  levelId = 'level_0',
): Record<string, SceneNodeLike> {
  const out: Record<string, SceneNodeLike> = { ...base }
  for (const eq of plan.equipment) out[eq.id] = { ...eq, type: 'hvac:equipment', parentId: levelId }
  for (const pl of plan.plenums) out[pl.id] = { ...pl, type: 'hvac:plenum', parentId: levelId }
  for (const t of plan.terminals) out[t.id] = { ...t, type: 'hvac:terminal', parentId: levelId }
  for (const d of plan.ductRuns) out[d.id] = { ...d, type: 'hvac:duct-run', parentId: levelId }
  return out
}

describe('Real-World Public House HVAC Fixes (REAL-HVC-01 & REAL-HVC-02)', () => {
  test('REAL-HVC-01a: routeCondensateDrain and routeHvacDuctRun cleanly detour around Water Heater, Expansion Tank, dryer vent, and DWV vents', () => {
    const scene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.6 },
      wh: {
        id: 'wh_75',
        type: 'plumbing:equipment',
        equipmentKind: 'water-heater-tank-electric',
        name: 'Electric Water Heater (75 gal)',
        parentId: 'level_0',
        position: [1.0, 0, 2.85],
      },
      exp: {
        id: 'exp_tank',
        type: 'plumbing:equipment',
        equipmentKind: 'expansion-tank',
        name: 'Thermal Expansion Tank',
        parentId: 'level_0',
        position: [1.4, 1.65, 2.85],
      },
      dryer: {
        id: 'dryer_vent',
        type: 'plumbing:pipe-run',
        system: 'dryer-vent',
        nominalSize: '4"',
        parentId: 'level_0',
        path: [
          [0.0, 0.25, 2.0],
          [0.0, 0.25, 6.0],
        ],
      },
      vent: {
        id: 'dwv_vent_1',
        type: 'plumbing:pipe-run',
        system: 'dwv-vent',
        nominalSize: '1-1/2"',
        parentId: 'level_0',
        path: [
          [1.96, 0, 2.73],
          [1.96, 2.45, 2.73],
          [2.35, 2.45, 2.73],
          [2.35, 2.45, -1.34],
        ],
      },
    }
    const obstacles = extractHvacObstacles(scene, 'level_0')

    // Condensate drain exiting near the Water Heater & crossing the 4" dryer vent detours cleanly with valid gravity slope
    const cond = routeCondensateDrain({
      from: [1.8, 0.95, 2.85],
      to: [-4.0, 0.05, 3.1],
      obstacles,
    })
    expect(cond.clashes).toHaveLength(0)
    expect(cond.detoured).toBe(true)
    const slope = measureCondensateSlope(cond.path)
    expect(slope.hasUphillSegment).toBe(false)
    expect(slope.overallSlopeInPerFt).toBeGreaterThanOrEqual(0.125)

    // Refrigerant lineset routing past Water Heater & overhead DWV vent detours with 0 clashes
    const lineset = routeHvacDuctRun({
      from: [1.8, 0.95, 2.73],
      to: [-4.5, 0.35, 3.5],
      plenumY: 2.76,
      ductHalfSpanM: 0.03,
      obstacles,
    })
    expect(lineset.clashes).toHaveLength(0)

    // 32"x10" Supply Trunk crossing Expansion Tank, Water Heater, & DWV vent detours cleanly
    const supplySpan = { horizontal: (32 * 0.0254) / 2, vertical: (10 * 0.0254) / 2 }
    const trunk = routeHvacDuctRun({
      from: [2.8, 1.56, 2.85],
      to: [-2.5, 2.88, 2.85],
      plenumY: 2.88,
      ductHalfSpanM: supplySpan,
      obstacles,
    })
    expect(trunk.clashes).toHaveLength(0)
  })

  test('REAL-HVC-01b: Auto-populate clears packed tiny Storage/Laundry closets (Wawa House & Starter House topology) with 0 Plumbing or Structural errors', () => {
    // Topology 1: Tiny 6 sq ft Storage closet occupied by WH + Expansion Tank + DWV vent + door header, plus spacious Garage
    const wawaLike: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.6 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [-6, -6], end: [10, -6], height: 2.6, thickness: 0.16 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [10, -6], end: [10, 6], height: 2.6, thickness: 0.16 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [10, 6], end: [-6, 6], height: 2.6, thickness: 0.16 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [-6, 6], end: [-6, -6], height: 2.6, thickness: 0.16 },
      r_stor: { id: 'r_stor', type: 'zone', name: 'Storage', parentId: 'level_0', polygon: [[1.85, 2.35], [2.65, 2.35], [2.65, 3.1], [1.85, 3.1]] },
      r_gar: { id: 'r_gar', type: 'zone', name: 'Garage', parentId: 'level_0', polygon: [[-6, 1], [0, 1], [0, 6], [-6, 6]] },
      r_hall: { id: 'r_hall', type: 'zone', name: 'Hallway', parentId: 'level_0', polygon: [[-2.8, -0.5], [-1.9, -0.5], [-1.9, 1.0], [-2.8, 1.0]] },
      r_liv: { id: 'r_liv', type: 'zone', name: 'Living Room', parentId: 'level_0', polygon: [[0, -6], [6, -6], [6, 1], [0, 1]] },
      r_bed: { id: 'r_bed', type: 'zone', name: 'Master Bedroom', parentId: 'level_0', polygon: [[6, -6], [10, -6], [10, 1], [6, 1]] },
      r_kit: { id: 'r_kit', type: 'zone', name: 'Kitchen', parentId: 'level_0', polygon: [[0, 1], [6, 1], [6, 6], [0, 6]] },
      r_bath: { id: 'r_bath', type: 'zone', name: 'Bathroom', parentId: 'level_0', polygon: [[6, 1], [10, 1], [10, 6], [6, 6]] },
      wh: { id: 'wh_1', type: 'plumbing:equipment', equipmentKind: 'water-heater-tank-electric', name: 'Electric Water Heater (75 gal)', parentId: 'level_0', position: [2.27, 0, 2.82] },
      exp: { id: 'exp_1', type: 'plumbing:equipment', equipmentKind: 'expansion-tank', name: 'Thermal Expansion Tank', parentId: 'level_0', position: [2.62, 1.65, 2.82] },
      vent: { id: 'vent_1', type: 'plumbing:pipe-run', system: 'dwv-vent', nominalSize: '1-1/2"', parentId: 'level_0', path: [[1.96, 0, 2.73], [1.96, 2.45, 2.73], [2.35, 2.45, 2.73], [2.35, 2.45, -1.34]] },
      hdr_stor: { id: 'hdr_stor', type: 'structural:beam', name: 'Header ((2) 2x8 Built-Up Header) over door', parentId: 'level_0', start: [1.83, 2.36], end: [1.83, 3.1], widthIn: 3, depthIn: 7.25, elevationY: 2.183 },
      hdr_h1: { id: 'hdr_h1', type: 'structural:beam', name: 'Header ((2) 2x8 Built-Up Header) over door', parentId: 'level_0', start: [-2.8, -0.35], end: [-2.8, 0.42], widthIn: 3, depthIn: 7.25, elevationY: 2.125 },
      hdr_h2: { id: 'hdr_h2', type: 'structural:beam', name: 'Header ((2) 2x8 Built-Up Header) over door', parentId: 'level_0', start: [-1.9, -0.53], end: [-1.9, 0.44], widthIn: 3, depthIn: 7.25, elevationY: 2.192 },
    }
    const planWawa = planHvacAutoPopulate(wawaLike, { levelId: 'level_0', climateZone: '4A' })
    const auditWawa = auditSceneHvac(materializeHvac(wawaLike, planWawa), { climateZone: '4A' })
    expect(auditWawa.errorCount).toBe(0)

    // Topology 2: Tight 16 sq ft Laundry (no Garage) packed with WH + Expansion Tank + Manifold + vents + door header -> promotes to Attic Mechanical Platform cleanly
    const starterLike: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.6 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [-8, -4], end: [6, -4], height: 2.6, thickness: 0.16 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [6, -4], end: [6, 5], height: 2.6, thickness: 0.16 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [6, 5], end: [-8, 5], height: 2.6, thickness: 0.16 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [-8, 5], end: [-8, -4], height: 2.6, thickness: 0.16 },
      r_laun: { id: 'r_laun', type: 'zone', name: 'Laundry', parentId: 'level_0', polygon: [[-2.1, 2.4], [-1.0, 2.4], [-1.0, 3.8], [-2.1, 3.8]] },
      r_liv: { id: 'r_liv', type: 'zone', name: 'Living Room', parentId: 'level_0', polygon: [[-8, -4], [0, -4], [0, 2.4], [-8, 2.4]] },
      r_bed: { id: 'r_bed', type: 'zone', name: 'Bedroom', parentId: 'level_0', polygon: [[0, -4], [6, -4], [6, 2.4], [0, 2.4]] },
      r_kit: { id: 'r_kit', type: 'zone', name: 'Kitchen / Dining Room', parentId: 'level_0', polygon: [[0, 2.4], [6, 2.4], [6, 5], [0, 5]] },
      r_bath: { id: 'r_bath', type: 'zone', name: 'Bathroom', parentId: 'level_0', polygon: [[-8, 2.4], [-2.1, 2.4], [-2.1, 5], [-8, 5]] },
      wh: { id: 'wh_2', type: 'plumbing:equipment', equipmentKind: 'water-heater-tank-electric', name: 'Electric Water Heater (50 gal)', parentId: 'level_0', position: [-1.77, 0, 3.65] },
      exp: { id: 'exp_2', type: 'plumbing:equipment', equipmentKind: 'expansion-tank', name: 'Thermal Expansion Tank', parentId: 'level_0', position: [-1.42, 1.65, 3.65] },
      man: { id: 'man_2', type: 'plumbing:manifold', name: 'PEX Home-Run Manifold', parentId: 'level_0', position: [-1.12, 1.35, 3.65] },
      v1: { id: 'v1', type: 'plumbing:pipe-run', system: 'dwv-vent', nominalSize: '2"', parentId: 'level_0', path: [[-5.5, 0.15, 3.19], [-5.5, 2.45, 3.19], [-1.08, 2.45, 3.19], [-1.08, 2.45, 4.0]] },
      v2: { id: 'v2', type: 'plumbing:pipe-run', system: 'dwv-vent', nominalSize: '1-1/2"', parentId: 'level_0', path: [[-1.68, 1.07, 2.86], [-1.68, 2.45, 2.86], [-1.08, 2.45, 2.86], [-1.08, 2.45, 4.0]] },
      hdr_d4: { id: 'hdr_d4', type: 'structural:beam', name: 'Header ((2) 2x8 Built-Up Header) over Door 4', parentId: 'level_0', start: [-1.0, 2.54], end: [-1.0, 3.92], widthIn: 3, depthIn: 7.25, elevationY: 2.192 },
    }
    const planStarter = planHvacAutoPopulate(starterLike, { levelId: 'level_0', climateZone: '4A' })
    const auditStarter = auditSceneHvac(materializeHvac(starterLike, planStarter), { climateZone: '4A' })
    expect(auditStarter.errorCount).toBe(0)
  })

  test('REAL-HVC-01c: Wide Return Air Trunk clears adjacent DWV vent risers near the room centroid (My Home & Warner 2 topology)', () => {
    const scene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.2 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [-12, -8], end: [12, -8], height: 2.2, thickness: 0.16 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [12, -8], end: [12, 8], height: 2.2, thickness: 0.16 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [12, 8], end: [-12, 8], height: 2.2, thickness: 0.16 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [-12, 8], end: [-12, -8], height: 2.2, thickness: 0.16 },
      // Multiple horizontal DWV vent manifolds running right beside the building center at y=2.05
      vent_a: { id: 'vent_a', type: 'plumbing:pipe-run', system: 'dwv-vent', nominalSize: '2"', parentId: 'level_0', path: [[-10, 0.15, -1.96], [-10, 2.05, -1.96], [-0.4, 2.05, -1.96], [-0.4, 2.05, 0.8]] },
      vent_b: { id: 'vent_b', type: 'plumbing:pipe-run', system: 'dwv-vent', nominalSize: '1-1/2"', parentId: 'level_0', path: [[9, 0.4, -4.0], [9, 2.05, -4.0], [-0.4, 2.05, -4.0], [-0.4, 2.05, 0.8]] },
      wh: { id: 'wh_w', type: 'plumbing:equipment', equipmentKind: 'water-heater-tank-electric', parentId: 'level_0', position: [-10.5, 0, -6.8] },
    }
    const plan = planHvacAutoPopulate(scene, { levelId: 'level_0', climateZone: '4A' })
    const audit = auditSceneHvac(materializeHvac(scene, plan), { climateZone: '4A' })
    expect(audit.errorCount).toBe(0)
  })

  test('REAL-HVC-02: extractHvacObstacles captures structural:beam headers and supply trunk, branches, and ERV intake clear door/window headers', () => {
    const scene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.6 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [12, 0], height: 2.6, thickness: 0.16 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [12, 0], end: [12, 8], height: 2.6, thickness: 0.16 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [12, 8], end: [0, 8], height: 2.6, thickness: 0.16 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 8], end: [0, 0], height: 2.6, thickness: 0.16 },
      r_liv: { id: 'r_liv', type: 'zone', name: 'Living Room', parentId: 'level_0', polygon: [[0, 0], [6, 0], [6, 8], [0, 8]] },
      r_bed: { id: 'r_bed', type: 'zone', name: 'Bedroom', parentId: 'level_0', polygon: [[6, 0], [12, 0], [12, 8], [6, 8]] },
      door_hdr: {
        id: 'door_hdr',
        type: 'structural:beam',
        name: 'Header ((2) 2x8 Built-Up Header) over door',
        parentId: 'level_0',
        start: [6, 3.0],
        end: [6, 4.2],
        widthIn: 3,
        depthIn: 7.25,
        elevationY: 2.183,
      },
      win_hdr: {
        id: 'win_hdr',
        type: 'structural:beam',
        name: 'Header ((2) 1-3/4"x11-7/8" 2.0E LVL) over Window 5',
        parentId: 'level_0',
        start: [0, 2.0],
        end: [0, 6.0],
        widthIn: 3.5,
        depthIn: 11.875,
        elevationY: 2.512,
      },
    }

    const obs = extractHvacObstacles(scene, 'level_0')
    const doorObs = obs.find((o) => o.nodeId === 'door_hdr')!
    const winObs = obs.find((o) => o.nodeId === 'win_hdr')!
    expect(doorObs).toBeDefined()
    expect(doorObs.box.minY).toBeCloseTo(2.183 - (7.25 * 0.0254) / 2, 3)
    expect(doorObs.box.maxY).toBeCloseTo(2.183 + (7.25 * 0.0254) / 2, 3)
    expect(winObs).toBeDefined()
    expect(winObs.box.maxY).toBeCloseTo(2.512 + (11.875 * 0.0254) / 2, 3)

    const plan = planHvacAutoPopulate(scene, { levelId: 'level_0', climateZone: '4A', plenumLocation: 'attic' })
    const audit = auditSceneHvac(materializeHvac(scene, plan), { climateZone: '4A' })
    expect(audit.findings.filter((f) => f.codeRef.includes('Structural'))).toHaveLength(0)
    expect(audit.errorCount).toBe(0)

    // Verify supply trunk & every branch clears both headers directly
    for (const run of plan.ductRuns) {
      const margin =
        run.shape === 'round'
          ? Math.max(0.02, (run.diameter * 0.0254) / 2)
          : { horizontal: Math.max(0.05, (run.width * 0.0254) / 2), vertical: Math.max(0.04, (run.height * 0.0254) / 2) }
      expect(detectHvacClashes(run.path, [doorObs, winObs], margin)).toHaveLength(0)
    }
  })

  test('REAL-HVC-02 (French/International): classifyHvacRoomName & autopopulate classify French apartment rooms properly', () => {
    expect(classifyHvacRoomName('Salle de Bains')).toBe('bathroom')
    expect(classifyHvacRoomName("Salle d'eau")).toBe('bathroom')
    expect(classifyHvacRoomName('WC')).toBe('bathroom')
    expect(classifyHvacRoomName('Cuisine')).toBe('kitchen')
    expect(classifyHvacRoomName('Séjour / Cuisine')).toBe('kitchen')
    expect(classifyHvacRoomName('Chambre 1')).toBe('bedroom')
    expect(classifyHvacRoomName('Séjour')).toBe('living')
    expect(classifyHvacRoomName('Salon')).toBe('living')
    expect(classifyHvacRoomName('Buanderie')).toBe('laundry')
    expect(classifyHvacRoomName('Entrée')).toBe('hallway')
    expect(classifyHvacRoomName('Balcon')).toBe('exterior')

    const frenchApt: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.6 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [10, 0], height: 2.6, thickness: 0.16 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [10, 0], end: [10, 8], height: 2.6, thickness: 0.16 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [10, 8], end: [0, 8], height: 2.6, thickness: 0.16 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 8], end: [0, 0], height: 2.6, thickness: 0.16 },
      z_sej: { id: 'z_sej', type: 'zone', name: 'Séjour', parentId: 'level_0', polygon: [[0, 0], [5, 0], [5, 4], [0, 4]] },
      z_cui: { id: 'z_cui', type: 'zone', name: 'Cuisine', parentId: 'level_0', polygon: [[5, 0], [8, 0], [8, 4], [5, 4]] },
      z_bua: { id: 'z_bua', type: 'zone', name: 'Buanderie', parentId: 'level_0', polygon: [[8, 0], [10, 0], [10, 4], [8, 4]] },
      z_ch1: { id: 'z_ch1', type: 'zone', name: 'Chambre 1', parentId: 'level_0', polygon: [[0, 4], [4, 4], [4, 8], [0, 8]] },
      z_ent: { id: 'z_ent', type: 'zone', name: 'Entrée', parentId: 'level_0', polygon: [[4, 4], [6, 4], [6, 8], [4, 8]] },
      z_sdb: { id: 'z_sdb', type: 'zone', name: 'Salle de Bains', parentId: 'level_0', polygon: [[6, 4], [8, 4], [8, 8], [6, 8]] },
      z_sde: { id: 'z_sde', type: 'zone', name: "Salle d'eau", parentId: 'level_0', polygon: [[8, 4], [10, 4], [10, 6], [8, 6]] },
      z_wc: { id: 'z_wc', type: 'zone', name: 'WC', parentId: 'level_0', polygon: [[8, 6], [10, 6], [10, 8], [8, 8]] },
    }
    const plan = planHvacAutoPopulate(frenchApt, { levelId: 'level_0', climateZone: '4A' })
    expect(plan.equipment.filter((e) => e.equipmentKind === 'bath-exhaust-fan')).toHaveLength(3)
    expect(plan.equipment.filter((e) => e.equipmentKind === 'range-hood')).toHaveLength(1)
    expect(plan.terminals.some((t) => t.terminalKind === 'transfer-grille' && t.roomName === 'Chambre 1')).toBe(true)
    const ret = plan.terminals.find((t) => t.terminalKind === 'return-grille')!
    expect(ret).toBeDefined()
    expect(['Entrée', 'Séjour']).toContain(ret.roomName)
    const audit = auditSceneHvac(materializeHvac(frenchApt, plan), { climateZone: '4A' })
    expect(audit.errorCount).toBe(0)
  })
})
