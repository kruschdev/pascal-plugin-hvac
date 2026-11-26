import { describe, expect, test } from 'bun:test'
import { Box3 } from 'three'
import { buildHvacTerminalCad } from '../cad/terminals'
import { auditSceneHvac } from '../imc/audit'
import { planHvacAutoPopulate } from '../imc/autopopulate'
import type { SceneNodeLike } from '../imc/framing-interop'
import {
  buildAtticRoofEnvelope,
  distancePointToSegment2D,
  extractRoomPolygons,
  extractWallSegments,
  isPointInsideBuildingFootprint,
  measureCondensateSlope,
  minRoofYOverFootprint,
  pathClearOfRoof,
  pathCrossesOutdoorVoid,
  routeHvacDuctRun,
} from '../imc/routing'

function materialize(
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

describe('Round 3 Visual & Geometric Regression Suite (VIS-V3-03, VIS-V3-04, VIS-V3-10)', () => {
  test('VIS-V3-03a: Upper-story outdoor condenser grounds at -cumulativeBelowHeightM outside union footprint on aligned wall with wall-flush lineset', () => {
    // Two-story farmhouse topology:
    // Ground floor (Floor 0): X in [0..14], Z in [0..8], wall height 2.8m (includes 1-story East wing X=[8..14])
    // Upper floor (Floor 1):  X in [0..8],  Z in [0..8], wall height 2.7m (West wall X=0 aligns with Floor 0)
    const scene: Record<string, SceneNodeLike> = {
      bldg_1: { id: 'bldg_1', type: 'building', children: ['level_0', 'level_1'] },
      level_0: { id: 'level_0', type: 'level', parentId: 'bldg_1', level: 0, baseElevation: 0, height: 2.8 },
      level_1: { id: 'level_1', type: 'level', parentId: 'bldg_1', level: 1, baseElevation: 0, height: 2.7 },
      // Floor 0 walls [0..14, 0..8]
      g_w1: { id: 'g_w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [14, 0], height: 2.8, thickness: 0.18 },
      g_w2: { id: 'g_w2', type: 'wall', parentId: 'level_0', start: [14, 0], end: [14, 8], height: 2.8, thickness: 0.18 },
      g_w3: { id: 'g_w3', type: 'wall', parentId: 'level_0', start: [14, 8], end: [0, 8], height: 2.8, thickness: 0.18 },
      g_w4: { id: 'g_w4', type: 'wall', parentId: 'level_0', start: [0, 8], end: [0, 0], height: 2.8, thickness: 0.18 },
      g_r1: { id: 'g_r1', type: 'zone', name: 'Living Room', parentId: 'level_0', polygon: [[0, 0], [14, 0], [14, 8], [0, 8]] },
      // Floor 1 walls [0..8, 0..8] (West wall aligns at X=0; East wall X=8 sits above Floor 0 wing!)
      u_w1: { id: 'u_w1', type: 'wall', parentId: 'level_1', start: [0, 0], end: [8, 0], height: 2.7, thickness: 0.16 },
      u_w2: { id: 'u_w2', type: 'wall', parentId: 'level_1', start: [8, 0], end: [8, 8], height: 2.7, thickness: 0.16 },
      u_w3: { id: 'u_w3', type: 'wall', parentId: 'level_1', start: [8, 8], end: [0, 8], height: 2.7, thickness: 0.16 },
      u_w4: { id: 'u_w4', type: 'wall', parentId: 'level_1', start: [0, 8], end: [0, 0], height: 2.7, thickness: 0.16 },
      // Place Utility room near East side of Floor 1 (X=5.5..8) to prove alignment with Floor 0 still prefers aligned wall over floating on 1-story wing!
      u_util: { id: 'u_util', type: 'zone', name: 'Utility', parentId: 'level_1', polygon: [[5.5, 0], [8, 0], [8, 3], [5.5, 3]] },
      u_bed1: { id: 'u_bed1', type: 'zone', name: 'Bedroom 1', parentId: 'level_1', polygon: [[0, 0], [5.5, 0], [5.5, 4], [0, 4]] },
      u_bed2: { id: 'u_bed2', type: 'zone', name: 'Bedroom 2', parentId: 'level_1', polygon: [[0, 4], [8, 4], [8, 8], [0, 8]] },
    }

    const plan = planHvacAutoPopulate(scene, {
      levelId: 'level_1',
      systemType: 'split-heat-pump',
      plenumLocation: 'attic',
      climateZone: '4A',
    })
    const condenser = plan.equipment.find((e) => e.equipmentKind === 'heat-pump-condenser')!
    const lineset = plan.ductRuns.find((d) => d.system === 'refrigerant-lineset')!
    expect(condenser).toBeDefined()
    expect(lineset).toBeDefined()

    // Condenser grounded at worldY = 0 -> local Y = -2.8
    expect(condenser.position[1]).toBe(-2.8)
    // Strictly outside the union footprint [0..14, 0..8] and NOT sitting on top of the East 1-story wing [8..14]!
    const outsideUnion =
      condenser.position[0] < 0 ||
      condenser.position[0] > 14 ||
      condenser.position[2] < 0 ||
      condenser.position[2] > 8
    expect(outsideUnion).toBe(true)
    expect(condenser.position[0] >= 8 && condenser.position[0] <= 14 && condenser.position[2] >= 0 && condenser.position[2] <= 8).toBe(false)

    // Refrigerant lineset drops vertically flush to exterior wall down to gradeY + 0.35 = -2.45 then stubs into condenser
    const lastPt = lineset.path[lineset.path.length - 1]!
    const prevPt = lineset.path[lineset.path.length - 2]!
    const dropTopPt = lineset.path[lineset.path.length - 3]!
    expect(lastPt[1]).toBeCloseTo(-2.45, 2)
    expect(prevPt[1]).toBeCloseTo(-2.45, 2)
    // Pure vertical drop along exterior wall face (same X and Z from dropTopPt to prevPt)
    expect(Math.hypot(dropTopPt[0] - prevPt[0], dropTopPt[2] - prevPt[2])).toBeLessThan(0.02)
    expect(dropTopPt[1]).toBeGreaterThan(prevPt[1] + 2.0)

    const audit = auditSceneHvac(materialize(scene, plan, 'level_1'), { climateZone: '4A' })
    expect(audit.errorCount).toBe(0)
    expect(audit.warningCount).toBe(0)
  })

  test('VIS-V3-03b: Third-story (Floor 2) outdoor condenser accumulates both lower storeys (-5.3m)', () => {
    const scene: Record<string, SceneNodeLike> = {
      bldg_1: { id: 'bldg_1', type: 'building', children: ['level_0', 'level_1', 'level_2'] },
      level_0: { id: 'level_0', type: 'level', parentId: 'bldg_1', level: 0, baseElevation: 0, height: 2.7 },
      level_1: { id: 'level_1', type: 'level', parentId: 'bldg_1', level: 1, baseElevation: 0, height: 2.6 },
      level_2: { id: 'level_2', type: 'level', parentId: 'bldg_1', level: 2, baseElevation: 0, height: 2.5 },
      w0: { id: 'w0', type: 'wall', parentId: 'level_0', start: [0, 0], end: [10, 0], height: 2.7, thickness: 0.16 },
      w0b: { id: 'w0b', type: 'wall', parentId: 'level_0', start: [10, 0], end: [10, 8], height: 2.7, thickness: 0.16 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_1', start: [0, 0], end: [10, 0], height: 2.6, thickness: 0.16 },
      w1b: { id: 'w1b', type: 'wall', parentId: 'level_1', start: [10, 0], end: [10, 8], height: 2.6, thickness: 0.16 },
      w2_1: { id: 'w2_1', type: 'wall', parentId: 'level_2', start: [0, 0], end: [10, 0], height: 2.5, thickness: 0.16 },
      w2_2: { id: 'w2_2', type: 'wall', parentId: 'level_2', start: [10, 0], end: [10, 8], height: 2.5, thickness: 0.16 },
      w2_3: { id: 'w2_3', type: 'wall', parentId: 'level_2', start: [10, 8], end: [0, 8], height: 2.5, thickness: 0.16 },
      w2_4: { id: 'w2_4', type: 'wall', parentId: 'level_2', start: [0, 8], end: [0, 0], height: 2.5, thickness: 0.16 },
      r2_liv: { id: 'r2_liv', type: 'zone', name: 'Suite', parentId: 'level_2', polygon: [[0, 0], [10, 0], [10, 8], [0, 8]] },
    }
    const plan = planHvacAutoPopulate(scene, { levelId: 'level_2', systemType: 'split-heat-pump', climateZone: '4A' })
    const condenser = plan.equipment.find((e) => e.equipmentKind === 'heat-pump-condenser')!
    const lineset = plan.ductRuns.find((d) => d.system === 'refrigerant-lineset')!
    expect(condenser.position[1]).toBe(-5.3)
    expect(lineset.path[lineset.path.length - 1]![1]).toBeCloseTo(-4.95, 2)

    const audit = auditSceneHvac(materialize(scene, plan, 'level_2'), { climateZone: '4A' })
    expect(audit.errorCount).toBe(0)
  })

  test('VIS-V3-04a: L-shaped building snaps ERV fresh-air intake to nearest actual exterior wall and keeps ERV duct inside envelope', () => {
    // L-shaped gym footprint:
    // North wing: X in [0..12], Z in [0..4]
    // West wing:  X in [0..8],  Z in [4..10]
    // Bare front-right L-notch yard: X in [8..12], Z in [4..10] (NO walls, NO rooms!)
    const lScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 4.5 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [12, 0], height: 4.5, thickness: 0.2 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [12, 0], end: [12, 4], height: 4.5, thickness: 0.2 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [12, 4], end: [8, 4], height: 4.5, thickness: 0.2 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [8, 4], end: [8, 10], height: 4.5, thickness: 0.2 },
      w5: { id: 'w5', type: 'wall', parentId: 'level_0', start: [8, 10], end: [0, 10], height: 4.5, thickness: 0.2 },
      w6: { id: 'w6', type: 'wall', parentId: 'level_0', start: [0, 10], end: [0, 0], height: 4.5, thickness: 0.2 },
      // Interior partition separating mechanical room in West wing right along X=8 wall
      p1: { id: 'p1', type: 'wall', parentId: 'level_0', start: [5, 6], end: [8, 6], height: 2.8, thickness: 0.14 },
      p2: { id: 'p2', type: 'wall', parentId: 'level_0', start: [5, 6], end: [5, 10], height: 2.8, thickness: 0.14 },
      r_north: { id: 'r_north', type: 'zone', name: 'Main Gym', parentId: 'level_0', polygon: [[0, 0], [12, 0], [12, 4], [0, 4]] },
      r_west: { id: 'r_west', type: 'zone', name: 'Bouldering Area', parentId: 'level_0', polygon: [[0, 4], [5, 4], [5, 10], [0, 10]] },
      r_mid: { id: 'r_mid', type: 'zone', name: 'Lobby', parentId: 'level_0', polygon: [[5, 4], [8, 4], [8, 6], [5, 6]] },
      r_mech: { id: 'r_mech', type: 'zone', name: 'Mechanical Room', parentId: 'level_0', polygon: [[5, 6], [8, 6], [8, 10], [5, 10]] },
    }

    const plan = planHvacAutoPopulate(lScene, {
      levelId: 'level_0',
      occupancy: 'commercial',
      systemType: 'rooftop-package',
      includeErv: true,
      climateZone: '4A',
    })
    const intake = plan.terminals.find((t) => t.terminalKind === 'fresh-air-intake')!
    const ervDuct = plan.ductRuns.find((d) => d.system === 'fresh-air-erv')!
    expect(intake).toBeDefined()
    expect(ervDuct).toBeDefined()

    const walls = extractWallSegments(lScene, 'level_0')
    const rooms = extractRoomPolygons(lScene, 'level_0')
    const minDistToWall = Math.min(
      ...walls.map((w) => distancePointToSegment2D(intake.position[0], intake.position[2], w.start[0], w.start[1], w.end[0], w.end[1]).dist),
    )
    // Intake hood MUST sit flush (+0.08m) on an actual exterior wall, NEVER 4m out in the bare front yard at X=12.08!
    expect(minDistToWall).toBeLessThanOrEqual(0.15)
    expect(intake.position[0] > 9 && intake.position[2] > 4.5).toBe(false)

    // ERV duct path must stay inside the L-shaped building envelope (never crossing the open front-right yard)
    const isInside = (x: number, z: number) => isPointInsideBuildingFootprint(x, z, walls, rooms)
    expect(pathCrossesOutdoorVoid(ervDuct.path, isInside, 0.5)).toBe(false)
  })

  test('VIS-V3-04b: Concave U-shaped courtyard house routes supply/return trunks & branches through connecting wing, never across open courtyard', () => {
    // U-shaped house with open central courtyard X in [-5..4], Z in [-5..6]
    // West wing: [-10..-5, -12..6], Back wing: [-10..8, -12..-5], East wing: [4..8, -12..6]
    const uScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [-10, -12], end: [8, -12], height: 2.7, thickness: 0.18 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [8, -12], end: [8, 6], height: 2.7, thickness: 0.18 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [8, 6], end: [4, 6], height: 2.7, thickness: 0.18 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [4, 6], end: [4, -5], height: 2.7, thickness: 0.18 },
      w5: { id: 'w5', type: 'wall', parentId: 'level_0', start: [4, -5], end: [-5, -5], height: 2.7, thickness: 0.18 },
      w6: { id: 'w6', type: 'wall', parentId: 'level_0', start: [-5, -5], end: [-5, 6], height: 2.7, thickness: 0.18 },
      w7: { id: 'w7', type: 'wall', parentId: 'level_0', start: [-5, 6], end: [-10, 6], height: 2.7, thickness: 0.18 },
      w8: { id: 'w8', type: 'wall', parentId: 'level_0', start: [-10, 6], end: [-10, -12], height: 2.7, thickness: 0.18 },
      r_util: { id: 'r_util', type: 'zone', name: 'Utility', parentId: 'level_0', polygon: [[-10, 2], [-5, 2], [-5, 6], [-10, 6]] },
      r_west: { id: 'r_west', type: 'zone', name: 'Living Room', parentId: 'level_0', polygon: [[-10, -5], [-5, -5], [-5, 2], [-10, 2]] },
      r_back: { id: 'r_back', type: 'zone', name: 'Hallway', parentId: 'level_0', polygon: [[-10, -12], [8, -12], [8, -5], [-10, -5]] },
      r_east: { id: 'r_east', type: 'zone', name: 'Master Bedroom', parentId: 'level_0', polygon: [[4, -5], [8, -5], [8, 6], [4, 6]] },
      r_pool: { id: 'r_pool', type: 'zone', name: 'Swimming Pool', parentId: 'level_0', polygon: [[-3, -2], [2, -2], [2, 4], [-3, 4]] },
    }

    const walls = extractWallSegments(uScene, 'level_0')
    const rooms = extractRoomPolygons(uScene, 'level_0')
    const isInside = (x: number, z: number) => isPointInsideBuildingFootprint(x, z, walls, rooms)

    // Verify courtyard center is strictly outside while all 3 wings are inside
    expect(isInside(0, 4.5)).toBe(false)
    expect(isInside(-7.5, 4.0)).toBe(true)
    expect(isInside(0, -8.5)).toBe(true)
    expect(isInside(6.0, 4.0)).toBe(true)

    // Direct 2-bend corridor test: West wing tip [-7.5, 4.0] -> East wing tip [6.0, 4.0] must detour through Back wing (Z < -5)
    const directU = routeHvacDuctRun({
      from: [-7.5, 2.6, 4.0],
      to: [6.0, 2.6, 4.0],
      plenumY: 3.05,
      ductHalfSpanM: { horizontal: 0.2, vertical: 0.1 },
      xzBounds: { minX: -9.85, maxX: 7.85, minZ: -11.85, maxZ: 5.85 },
      footprintContains: isInside,
      interiorCorridorSpines: { xs: [-7.5, 6.0], zs: [-8.5, -1.5, 4.0] },
    })
    expect(pathCrossesOutdoorVoid(directU.path, isInside, 0.5)).toBe(false)
    expect(directU.path.some((p) => p[2] < -5)).toBe(true)

    // Full auto-populate test on concave U-shaped house
    const plan = planHvacAutoPopulate(uScene, {
      levelId: 'level_0',
      systemType: 'split-heat-pump',
      plenumLocation: 'attic',
      includeErv: true,
      climateZone: '4A',
    })
    for (const run of plan.ductRuns) {
      if (
        run.system !== 'supply-trunk' &&
        run.system !== 'return-trunk' &&
        run.system !== 'supply-branch' &&
        run.system !== 'fresh-air-erv'
      ) {
        continue
      }
      expect(pathCrossesOutdoorVoid(run.path, isInside, 0.5)).toBe(false)
    }
  })

  test('VIS-V3-10a: Residential attic trunks & branches clear ceiling joist depth while staying strictly below pitched roof rafters', () => {
    const house: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      sa_1: { id: 'sa_1', type: 'structural:assembly', parentId: 'level_0', joistDepthIn: 9.25, roofPitchRise: 6 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [12, 0], height: 2.7, thickness: 0.16 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [12, 0], end: [12, 8], height: 2.7, thickness: 0.16 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [12, 8], end: [0, 8], height: 2.7, thickness: 0.16 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 8], end: [0, 0], height: 2.7, thickness: 0.16 },
      r_util: { id: 'r_util', type: 'zone', name: 'Utility', parentId: 'level_0', polygon: [[0, 0], [3, 0], [3, 3], [0, 3]] },
      r_liv: { id: 'r_liv', type: 'zone', name: 'Living Room', parentId: 'level_0', polygon: [[3, 0], [8, 0], [8, 8], [3, 8]] },
      r_bed: { id: 'r_bed', type: 'zone', name: 'Bedroom', parentId: 'level_0', polygon: [[8, 0], [12, 0], [12, 8], [8, 8]] },
    }
    const plan = planHvacAutoPopulate(house, {
      levelId: 'level_0',
      systemType: 'split-heat-pump',
      plenumLocation: 'attic',
      climateZone: '4A',
    })
    const joistTopY = 2.7 + Math.round(9.25 * 0.0254 * 100) / 100 // 2.93m
    const roof = buildAtticRoofEnvelope(house, 'level_0', { minX: 0, maxX: 12, minZ: 0, maxZ: 8 }, 2.7)

    const supplyTrunk = plan.ductRuns.find((d) => d.system === 'supply-trunk')!
    const returnTrunk = plan.ductRuns.find((d) => d.system === 'return-trunk')!
    expect(supplyTrunk).toBeDefined()
    expect(returnTrunk).toBeDefined()

    for (const trunk of [supplyTrunk, returnTrunk]) {
      const halfV = (trunk.height * 0.0254) / 2
      // Every horizontal attic trunk run clears the ceiling joist top (bottom >= joistTopY)
      const horizAtticSegs = []
      for (let i = 1; i < trunk.path.length; i++) {
        const a = trunk.path[i - 1]!
        const b = trunk.path[i]!
        const horiz = Math.hypot(b[0] - a[0], b[2] - a[2])
        const vert = Math.abs(b[1] - a[1])
        if (horiz > 0.4 && vert < 0.05 && a[1] > 2.7) {
          horizAtticSegs.push((a[1] + b[1]) / 2)
          expect((a[1] + b[1]) / 2 - halfV).toBeGreaterThanOrEqual(joistTopY - 0.01)
        }
      }
      expect(horizAtticSegs.length).toBeGreaterThan(0)
      expect(pathClearOfRoof(trunk.path, roof, halfV, 0.05)).toBe(true)
    }

    // Low-ridge narrow house: must still clamp strictly under ridgePeakY - halfV - 0.10
    const lowRidgeHouse: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      sa_low: { id: 'sa_low', type: 'structural:assembly', parentId: 'level_0', joistDepthIn: 11.875, roofPitchRise: 3 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [8, 0], height: 2.7, thickness: 0.16 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [8, 0], end: [8, 3.6], height: 2.7, thickness: 0.16 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [8, 3.6], end: [0, 3.6], height: 2.7, thickness: 0.16 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 3.6], end: [0, 0], height: 2.7, thickness: 0.16 },
      r_liv: { id: 'r_liv', type: 'zone', name: 'Studio', parentId: 'level_0', polygon: [[0, 0], [8, 0], [8, 3.6], [0, 3.6]] },
    }
    const lowPlan = planHvacAutoPopulate(lowRidgeHouse, { levelId: 'level_0', plenumLocation: 'attic' })
    const lowRoof = buildAtticRoofEnvelope(lowRidgeHouse, 'level_0', { minX: 0, maxX: 8, minZ: 0, maxZ: 3.6 }, 2.7)
    for (const run of lowPlan.ductRuns) {
      const halfH = ((run.shape === 'rectangular' ? run.height : run.diameter) * 0.0254) / 2
      expect(pathClearOfRoof(run.path, lowRoof, halfH, 0.05)).toBe(true)
    }
  })

  test('VIS-V3-10b: Commercial flat-roof RTU clears roof joist band (2.50..2.79m) for ceiling terminals, exhausts, and rooftop condensate drain', () => {
    // Dental Office topology: levelH = 2.50m, flat-roof structural joist band 2.50..2.79m
    const dentalOffice: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.5 },
      sa_roof: { id: 'sa_roof', type: 'structural:assembly', parentId: 'level_0', joistDepthIn: 11.25, roofPitchRise: 0 },
      roof_joist_1: {
        id: 'roof_joist_1',
        type: 'structural:beam',
        parentId: 'level_0',
        start: [0, 3.5],
        end: [12, 3.5],
        widthIn: 3.5,
        depthIn: 11.25,
        elevationY: 2.645, // spans 2.502..2.788m
      },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [12, 0], height: 2.5, thickness: 0.18 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [12, 0], end: [12, 7], height: 2.5, thickness: 0.18 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [12, 7], end: [0, 7], height: 2.5, thickness: 0.18 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 7], end: [0, 0], height: 2.5, thickness: 0.18 },
      r_wait: { id: 'r_wait', type: 'zone', name: 'Reception', parentId: 'level_0', polygon: [[0, 0], [5, 0], [5, 7], [0, 7]] },
      r_exam: { id: 'r_exam', type: 'zone', name: 'Exam Suite', parentId: 'level_0', polygon: [[5, 0], [10, 0], [10, 7], [5, 7]] },
      r_rest: { id: 'r_rest', type: 'zone', name: 'Restroom', parentId: 'level_0', polygon: [[10, 0], [12, 0], [12, 7], [10, 7]] },
    }

    const plan = planHvacAutoPopulate(dentalOffice, {
      levelId: 'level_0',
      occupancy: 'commercial',
      systemType: 'rooftop-package',
      includeErv: true,
      includeExhaustFans: true,
      climateZone: '4A',
    })

    const rtu = plan.equipment.find((e) => e.equipmentKind === 'rooftop-package-unit')!
    const rtuCond = plan.ductRuns.find((d) => d.system === 'condensate-drain' && d.sourceNodeId === rtu.id)!
    expect(rtu).toBeDefined()
    expect(rtuCond).toBeDefined()

    // 1. RTU sits cleanly ON TOP of the 2.50..2.79m flat-roof deck
    expect(rtu.position[1]).toBeGreaterThanOrEqual(2.8)

    // 2. RTU condensate runs ON TOP of the flat roof deck (never slicing mid-joist 2.51..2.58m!)
    for (const pt of rtuCond.path) {
      expect(pt[1]).toBeGreaterThanOrEqual(rtu.position[1] + 0.005)
      expect(pt[1]).toBeGreaterThan(2.79)
    }
    const slope = measureCondensateSlope(rtuCond.path)
    expect(slope.hasUphillSegment).toBe(false)
    expect(slope.overallSlopeInPerFt).toBeGreaterThanOrEqual(0.125)

    // 3. Ceiling terminals (supply diffusers & return grille) sit flush below ceiling (y <= 2.46)
    //    and their 3D CAD meshes NEVER poke above levelH = 2.50m into the roof joists!
    const ceilingTerms = plan.terminals.filter(
      (t) =>
        t.terminalKind === 'supply-ceiling-diffuser' ||
        t.terminalKind === 'return-grille' ||
        t.terminalKind === 'exhaust-grille',
    )
    expect(ceilingTerms.length).toBeGreaterThanOrEqual(2)
    for (const term of ceilingTerms) {
      expect(term.position[1]).toBeLessThanOrEqual(2.46)
      const cad = buildHvacTerminalCad({ terminalKind: term.terminalKind, neckSizeIn: term.neckSizeIn })
      cad.updateMatrixWorld(true)
      const bbox = new Box3().setFromObject(cad)
      const worldMaxY = term.position[1] + bbox.max.y
      expect(worldMaxY).toBeLessThan(2.5)
    }

    // 4. Commercial restroom exhaust fan & duct stay strictly below the 2.50m flat roof joists
    const bathFan = plan.equipment.find((e) => e.equipmentKind === 'bath-exhaust-fan')
    const bathEx = plan.ductRuns.find((d) => d.system === 'exhaust-duct')
    expect(bathFan).toBeDefined()
    expect(bathEx).toBeDefined()
    expect(bathFan!.position[1] + 0.16).toBeLessThan(2.5)
    for (const pt of bathEx!.path) {
      expect(pt[1]).toBeLessThan(2.5)
    }

    // 5. Full audit passes with 0 errors and 0 warnings (no false roof-protrusion or joist clashes)
    const audit = auditSceneHvac(materialize(dentalOffice, plan), { occupancy: 'commercial', climateZone: '4A' })
    expect(audit.errorCount).toBe(0)
    expect(audit.warningCount).toBe(0)
  })

  test('VIS-V3-CORPUS-01: Asymmetric hip roof swaps axes for width < depth and enforces 4-corner footprint clearance on all attic equipment & plenums', () => {
    // Starter-House-style asymmetric hip roof on unwalled upper roof level (width 7.75 < depth 14.5, shifted X=-2.125)
    const hipHouse: Record<string, SceneNodeLike> = {
      bldg_1: { id: 'bldg_1', type: 'building', children: ['level_0', 'level_1'] },
      level_0: { id: 'level_0', type: 'level', parentId: 'bldg_1', level: 0, baseElevation: 0, height: 2.55 },
      level_1: { id: 'level_1', type: 'level', parentId: 'bldg_1', level: 1, baseElevation: 0, height: 2.5 },
      roof_1: { id: 'roof_1', type: 'roof', parentId: 'level_1', position: [-2.125, 0, 0.25], rotation: 0 },
      rseg_hip: {
        id: 'rseg_hip',
        type: 'roof-segment',
        parentId: 'roof_1',
        roofType: 'hip',
        position: [0, 0, 0],
        width: 7.75,
        depth: 14.5,
        pitch: 36.73,
        wallHeight: 0.61,
        rotation: 0,
      },
      rseg_wing: {
        id: 'rseg_wing',
        type: 'roof-segment',
        parentId: 'roof_1',
        roofType: 'gable',
        position: [5.43, 0, 0.98],
        width: 6.83,
        depth: 12.53,
        pitch: 15.11,
        wallHeight: 0.5,
        rotation: 0,
      },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [-6, -7], end: [6.75, -7], height: 2.55, thickness: 0.16 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [6.75, -7], end: [6.75, 7.5], height: 2.55, thickness: 0.16 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [6.75, 7.5], end: [-6, 7.5], height: 2.55, thickness: 0.16 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [-6, 7.5], end: [-6, -7], height: 2.55, thickness: 0.16 },
      r_liv: { id: 'r_liv', type: 'zone', name: 'Living Room', parentId: 'level_0', polygon: [[-6, -7], [6.75, -7], [6.75, 2], [-6, 2]] },
      r_bed: { id: 'r_bed', type: 'zone', name: 'Bedroom', parentId: 'level_0', polygon: [[-6, 2], [6.75, 2], [6.75, 7.5], [-6, 7.5]] },
    }

    const bounds = { minX: -6, maxX: 6.75, minZ: -7, maxZ: 7.5 }
    const roof = buildAtticRoofEnvelope(hipHouse, 'level_0', bounds, 2.55)
    // Hip roof with width=7.75 < depth=14.5 swaps axes so roof at (0.38, 3.65) is ~4.18m (NOT 5.73m!)
    expect(roof.roofYAt(0.38, 3.65)).toBeLessThan(4.3)
    expect(roof.roofYAt(0.38, 3.65)).toBeGreaterThan(4.0)

    const plan = planHvacAutoPopulate(hipHouse, {
      levelId: 'level_0',
      systemType: 'split-heat-pump',
      plenumLocation: 'attic',
      includeErv: true,
      climateZone: '4A',
    })

    // Verify ZERO roof protrusions across all 4 corners of every attic equipment & plenum box
    for (const eq of plan.equipment) {
      if (eq.equipmentKind === 'heat-pump-condenser' || eq.equipmentKind === 'ac-condenser') continue
      if (eq.position[1] <= 2.55) continue
      const hM = eq.heightM ?? 1.22
      const topY = eq.position[1] + hM
      expect(topY).toBeLessThanOrEqual(minRoofYOverFootprint(roof, eq.position[0], eq.position[2], 0.3, 0.3) - 0.08 + 1e-4)
    }
    for (const pl of plan.plenums) {
      if (pl.position[1] <= 2.55) continue
      const hM = pl.heightM ?? 0.45
      const topY = pl.position[1] + hM
      const halfW = (pl.widthIn * 0.0254) / 2
      expect(topY).toBeLessThanOrEqual(minRoofYOverFootprint(roof, pl.position[0], pl.position[2], halfW, 0.3) - 0.08 + 1e-4)
    }
    for (const run of plan.ductRuns) {
      const halfH = ((run.shape === 'rectangular' ? run.height : run.diameter) * 0.0254) / 2
      expect(pathClearOfRoof(run.path, roof, halfH, 0.05)).toBe(true)
    }
  })

  test('VIS-V3-CORPUS-02: Refrigerant lineset clears door/window headers (2x8 & tall commercial W14x48 steel beams) on ground and upper stories', () => {
    // 1. Tall commercial building with W14x48 steel header spanning the exterior wall directly behind the condenser
    const gymScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 4.8 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [12, 0], height: 4.8, thickness: 0.2 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [12, 0], end: [12, 8], height: 4.8, thickness: 0.2 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [12, 8], end: [0, 8], height: 4.8, thickness: 0.2 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 8], end: [0, 0], height: 4.8, thickness: 0.2 },
      r_gym: { id: 'r_gym', type: 'zone', name: 'Main Gym', parentId: 'level_0', polygon: [[0, 0], [12, 0], [12, 8], [0, 8]] },
      // Wide W14x48 steel window header on East wall (x=12) spanning z=0.5..7.5 at y=4.3m
      hdr_w14: {
        id: 'hdr_w14',
        type: 'structural:beam',
        parentId: 'level_0',
        name: 'Header (W14x48 A992 Steel Beam) over Window 5',
        start: [12, 0.5],
        end: [12, 7.5],
        widthIn: 10,
        depthIn: 14,
        elevationY: 4.3,
      },
      // Also add a residential-height 2x8 door header on West wall (x=0) spanning z=0.5..7.5 at y=2.25m
      hdr_2x8: {
        id: 'hdr_2x8',
        type: 'structural:beam',
        parentId: 'level_0',
        name: 'Header ((2) 2x8 Built-Up Header) over Door 4',
        start: [0, 0.5],
        end: [0, 7.5],
        widthIn: 3.5,
        depthIn: 7.25,
        elevationY: 2.25,
      },
    }

    const gymPlan = planHvacAutoPopulate(gymScene, {
      levelId: 'level_0',
      systemType: 'split-heat-pump',
      plenumLocation: 'attic',
      climateZone: '4A',
    })
    const gymAudit = auditSceneHvac(materialize(gymScene, gymPlan), { climateZone: '4A' })
    expect(gymAudit.errorCount).toBe(0)

    // 2. Ground-floor apartment (2.5m ceiling) with door/window header directly behind outdoor condenser
    const aptScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.5 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [10, 0], height: 2.5, thickness: 0.16 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [10, 0], end: [10, 6], height: 2.5, thickness: 0.16 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [10, 6], end: [0, 6], height: 2.5, thickness: 0.16 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 6], end: [0, 0], height: 2.5, thickness: 0.16 },
      r_liv: { id: 'r_liv', type: 'zone', name: 'Living Room', parentId: 'level_0', polygon: [[0, 0], [10, 0], [10, 6], [0, 6]] },
      hdr_east: {
        id: 'hdr_east',
        type: 'structural:beam',
        parentId: 'level_0',
        name: 'Header ((2) 2x8 Built-Up Header) over Door 4',
        start: [10, 0.5],
        end: [10, 5.5],
        widthIn: 3.5,
        depthIn: 7.25,
        elevationY: 2.28,
      },
      hdr_west: {
        id: 'hdr_west',
        type: 'structural:beam',
        parentId: 'level_0',
        name: 'Header ((2) 2x8 Built-Up Header) over Window 5',
        start: [0, 0.5],
        end: [0, 5.5],
        widthIn: 3.5,
        depthIn: 7.25,
        elevationY: 2.28,
      },
    }
    const aptPlan = planHvacAutoPopulate(aptScene, {
      levelId: 'level_0',
      systemType: 'split-heat-pump',
      plenumLocation: 'attic',
      climateZone: '4A',
    })
    const aptAudit = auditSceneHvac(materialize(aptScene, aptPlan), { climateZone: '4A' })
    expect(aptAudit.errorCount).toBe(0)
  })
})
