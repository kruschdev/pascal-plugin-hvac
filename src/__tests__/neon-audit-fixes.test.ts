import { describe, expect, test } from 'bun:test'
import { auditSceneHvac } from '../imc/audit'
import { planHvacAutoPopulate } from '../imc/autopopulate'
import type { SceneNodeLike } from '../imc/framing-interop'
import {
  type HvacObstacle,
  buildAtticRoofEnvelope,
  classifyHvacRoomName,
  detectHvacClashes,
  measureCondensateSlope,
  pathClearOfRoof,
  pointInPolygon2D,
  resolveLevelHeightM,
  routeCondensateDrain,
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

describe('Phase 3 Neon MEP & 3D Visual Audit Regression Suite (HVA-BUG-01..06, HVA-OPT-01, HVA-CON-01, VIS-01/02/04/06)', () => {
  test('HVA-BUG-01: Splits closet/storage/dressing/placard/cellier/pantry into closet category (no IMC 303.3 closet gas furnace, no pantry range hood)', () => {
    expect(classifyHvacRoomName('Walk-In Closet')).toBe('closet')
    expect(classifyHvacRoomName('Master Closet')).toBe('closet')
    expect(classifyHvacRoomName('Dressing')).toBe('closet')
    expect(classifyHvacRoomName('Placard')).toBe('closet')
    expect(classifyHvacRoomName('Storage')).toBe('closet')
    expect(classifyHvacRoomName('Cellier')).toBe('closet')
    expect(classifyHvacRoomName('Pantry')).toBe('closet')
    expect(classifyHvacRoomName('Kitchen Pantry')).toBe('closet')
    expect(classifyHvacRoomName('Utility Room')).toBe('utility')
    expect(classifyHvacRoomName('Mechanical Room')).toBe('utility')
    expect(classifyHvacRoomName('Local Technique')).toBe('utility')
    expect(classifyHvacRoomName('Chaufferie')).toBe('utility')
    expect(classifyHvacRoomName('Cuisine')).toBe('kitchen')

    const scene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [12, 0], height: 2.7, thickness: 0.16 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [12, 0], end: [12, 8], height: 2.7, thickness: 0.16 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [12, 8], end: [0, 8], height: 2.7, thickness: 0.16 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 8], end: [0, 0], height: 2.7, thickness: 0.16 },
      r_dressing: { id: 'r_dressing', type: 'zone', name: 'Dressing', parentId: 'level_0', polygon: [[0, 0], [3, 0], [3, 3], [0, 3]] },
      r_cellier: { id: 'r_cellier', type: 'zone', name: 'Cellier', parentId: 'level_0', polygon: [[3, 0], [6, 0], [6, 3], [3, 3]] },
      r_garage: { id: 'r_garage', type: 'zone', name: 'Garage', parentId: 'level_0', polygon: [[6, 0], [12, 0], [12, 4], [6, 4]] },
      r_liv: { id: 'r_liv', type: 'zone', name: 'Living Room', parentId: 'level_0', polygon: [[0, 3], [6, 3], [6, 8], [0, 8]] },
      r_bed: { id: 'r_bed', type: 'zone', name: 'Master Bedroom', parentId: 'level_0', polygon: [[6, 4], [12, 4], [12, 8], [6, 8]] },
    }
    const plan = planHvacAutoPopulate(scene, {
      levelId: 'level_0',
      systemType: 'split-gas-furnace',
      climateZone: '4A',
    })
    const furnace = plan.equipment.find((e) => e.equipmentKind === 'gas-furnace-96')!
    expect(furnace).toBeDefined()
    // Must pick Garage (not Dressing clothes closet!) per IMC 303.3 / IFGC 303.3
    expect(furnace.roomName).toBe('Garage')
    // Must NOT spawn a range hood in Cellier pantry
    expect(plan.equipment.filter((e) => e.equipmentKind === 'range-hood')).toHaveLength(0)
    // Return grille must NOT land in Dressing or Cellier
    const ret = plan.terminals.find((t) => t.terminalKind === 'return-grille')!
    expect(ret.roomName).not.toBe('Dressing')
    expect(ret.roomName).not.toBe('Cellier')
    const audit = auditSceneHvac(materialize(scene, plan), { climateZone: '4A' })
    expect(audit.errorCount).toBe(0)
  })

  test('HVA-BUG-02: Clamps condensate exit targets and ERV fresh-air intake hoods strictly within walled building spans', () => {
    const scene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [8, 0], height: 2.7, thickness: 0.16 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [8, 0], end: [8, 6], height: 2.7, thickness: 0.16 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [8, 6], end: [0, 6], height: 2.7, thickness: 0.16 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 6], end: [0, 0], height: 2.7, thickness: 0.16 },
      // Utility room right at the SW corner (x=0..2.2, z=0..2.2) so indoorPos sits ~0.48m from both corner walls
      r_util: { id: 'r_util', type: 'zone', name: 'Utility', parentId: 'level_0', polygon: [[0, 0], [2.2, 0], [2.2, 2.2], [0, 2.2]] },
      r_liv: { id: 'r_liv', type: 'zone', name: 'Living Room', parentId: 'level_0', polygon: [[2.2, 0], [8, 0], [8, 6], [2.2, 6]] },
      // Block immediate west wall near indoorPos with header/pipe to force fallback targets
      win_blk: { id: 'win_blk', type: 'structural:beam', parentId: 'level_0', start: [0, 0.2], end: [0, 2.5], widthIn: 3.5, depthIn: 12, elevationY: 2.1 },
      pipe_blk: { id: 'pipe_blk', type: 'plumbing:pipe-run', parentId: 'level_0', nominalSize: '3"', path: [[0.1, 0, 0.5], [0.1, 2.6, 1.5]] },
    }
    const plan = planHvacAutoPopulate(scene, { levelId: 'level_0', includeErv: true, climateZone: '4A' })
    const intake = plan.terminals.find((t) => t.terminalKind === 'fresh-air-intake')!
    const cond = plan.ductRuns.find((d) => d.system === 'condensate-drain')!
    expect(intake).toBeDefined()
    expect(cond).toBeDefined()

    // Check intake stays along a walled span (if on X wall, Z in [0.3, 5.7]; if on Z wall, X in [0.3, 7.7])
    const [ix, , iz] = intake.position
    if (ix < 0 || ix > 8) {
      expect(iz).toBeGreaterThanOrEqual(0.3)
      expect(iz).toBeLessThanOrEqual(5.7)
    } else {
      expect(ix).toBeGreaterThanOrEqual(0.3)
      expect(ix).toBeLessThanOrEqual(7.7)
    }

    const condEnd = cond.path[cond.path.length - 1]!
    if (condEnd[0] < 0 || condEnd[0] > 8) {
      expect(condEnd[2]).toBeGreaterThanOrEqual(0.3)
      expect(condEnd[2]).toBeLessThanOrEqual(5.7)
    } else {
      expect(condEnd[0]).toBeGreaterThanOrEqual(0.3)
      expect(condEnd[0]).toBeLessThanOrEqual(7.7)
    }
  })

  test('HVA-BUG-03 & HVA-BUG-04: conditioned-soffit ERV never breaches Level 2 slab, and crawlspace/basement ducts never hop upward through y = 0 floor slab', () => {
    const scene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [10, 0], height: 2.7, thickness: 0.16 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [10, 0], end: [10, 8], height: 2.7, thickness: 0.16 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [10, 8], end: [0, 8], height: 2.7, thickness: 0.16 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 8], end: [0, 0], height: 2.7, thickness: 0.16 },
      r_util: { id: 'r_util', type: 'zone', name: 'Utility', parentId: 'level_0', polygon: [[0, 0], [3, 0], [3, 3], [0, 3]] },
      r_liv: { id: 'r_liv', type: 'zone', name: 'Living Room', parentId: 'level_0', polygon: [[3, 0], [10, 0], [10, 8], [3, 8]] },
      // Window header blocking intakeCandidates[0] at y=2.1 on west wall
      win_hdr: { id: 'win_hdr', type: 'structural:beam', parentId: 'level_0', start: [0, 0.5], end: [0, 3.5], widthIn: 4, depthIn: 12, elevationY: 2.1 },
      // Priority #2 DWV drain running right through the crawlspace trunk elevation (y = -0.26)
      dwv_crawl: { id: 'dwv_crawl', type: 'plumbing:pipe-run', parentId: 'level_0', nominalSize: '3"', path: [[5, -0.26, 0.2], [5, -0.26, 7.8]] },
    }

    // 1. Conditioned-soffit (multi-story Level 1): ERV intake & ERV duct must NEVER exceed levelH = 2.7m!
    const soffitPlan = planHvacAutoPopulate(scene, {
      levelId: 'level_0',
      plenumLocation: 'conditioned-soffit',
      includeErv: true,
    })
    const soffitIntake = soffitPlan.terminals.find((t) => t.terminalKind === 'fresh-air-intake')!
    const soffitErvDuct = soffitPlan.ductRuns.find((d) => d.system === 'fresh-air-erv')!
    expect(soffitIntake.position[1]).toBeLessThanOrEqual(2.5)
    for (const pt of soffitErvDuct.path) {
      expect(pt[1]).toBeLessThanOrEqual(2.62)
    }

    // 2. Crawlspace & basement: horizontal plenum segments of supply trunk, branches, and return trunk must stay strictly below y = 0!
    const crawlPlan = planHvacAutoPopulate(scene, {
      levelId: 'level_0',
      plenumLocation: 'crawlspace',
      includeErv: true,
    })
    const crawlIntake = crawlPlan.terminals.find((t) => t.terminalKind === 'fresh-air-intake')!
    expect(crawlIntake.position[1]).toBeLessThanOrEqual(2.5)
    const crawlAhu = crawlPlan.equipment.find((e) => e.equipmentKind === 'air-handler')!
    const crawlRetPl = crawlPlan.plenums.find((p) => p.plenumKind === 'return-plenum')!

    for (const run of crawlPlan.ductRuns) {
      if (run.system !== 'supply-trunk' && run.system !== 'supply-branch' && run.system !== 'return-trunk') continue
      const halfV = ((run.shape === 'rectangular' ? run.height : run.diameter) * 0.0254) / 2
      for (let i = 1; i < run.path.length; i++) {
        const a = run.path[i - 1]!
        const b = run.path[i]!
        // Exclude the short mechanical-room side-return boot connecting returnPlenumPos to indoorPos at y = 0.25
        const isCabinetBoot =
          run.system === 'return-trunk' &&
          i === run.path.length - 1 &&
          Math.hypot(a[0] - crawlRetPl.position[0], a[2] - crawlRetPl.position[2]) < 0.05 &&
          Math.hypot(b[0] - crawlAhu.position[0], b[2] - crawlAhu.position[2]) < 0.05
        if (isCabinetBoot) continue
        const horiz = Math.hypot(b[0] - a[0], b[2] - a[2])
        const vert = Math.abs(b[1] - a[1])
        // Every horizontal crawlspace segment must stay below the floor slab (top < 0)
        if (horiz > 0.3 && vert < 0.05) {
          expect((a[1] + b[1]) / 2 + halfV).toBeLessThan(0)
        }
      }
    }

    // Direct routeHvacDuctRun crawlspace DWV clash test: must detour UNDER/around rather than hopping above y = 0
    const directCrawl = routeHvacDuctRun({
      from: [1, 0.02, 4],
      to: [9, 0.02, 4],
      plenumY: -0.26,
      maxPlenumY: -0.14,
      ductHalfSpanM: { horizontal: 0.2, vertical: 0.1 },
      obstacles: [
        {
          id: 'dwv_block',
          nodeId: 'dwv_block',
          category: 'plumbing',
          label: 'Crawlspace 3" DWV',
          box: { minX: 4.9, maxX: 5.1, minY: -0.35, maxY: -0.18, minZ: 0, maxZ: 8 },
        },
      ],
    })
    expect(directCrawl.clashes).toHaveLength(0)
    for (let i = 1; i < directCrawl.path.length - 1; i++) {
      expect(directCrawl.path[i]![1]).toBeLessThanOrEqual(-0.14)
    }
  })

  test('HVA-BUG-05: Return plenum hard-rejects out-of-bounds exterior wall candidates even when interior sides have clashes', () => {
    const scene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [10, 0], height: 2.7, thickness: 0.16 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [10, 0], end: [10, 8], height: 2.7, thickness: 0.16 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [10, 8], end: [0, 8], height: 2.7, thickness: 0.16 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 8], end: [0, 0], height: 2.7, thickness: 0.16 },
      r_util: { id: 'r_util', type: 'zone', name: 'Utility', parentId: 'level_0', polygon: [[0, 0], [2.4, 0], [2.4, 2.4], [0, 2.4]] },
      r_liv: { id: 'r_liv', type: 'zone', name: 'Living Room', parentId: 'level_0', polygon: [[2.4, 0], [10, 0], [10, 8], [2.4, 8]] },
      // Obstacles surrounding interior sides of Utility corner so exterior side would have 0 clashes if not hard-rejected
      p1: { id: 'p1', type: 'plumbing:pipe-run', parentId: 'level_0', nominalSize: '3"', path: [[1.1, 0, 0.5], [1.1, 3.2, 0.5]] },
      p2: { id: 'p2', type: 'plumbing:pipe-run', parentId: 'level_0', nominalSize: '3"', path: [[0.5, 0, 1.1], [0.5, 3.2, 1.1]] },
    }
    const plan = planHvacAutoPopulate(scene, { levelId: 'level_0', climateZone: '4A' })
    const retPl = plan.plenums.find((p) => p.plenumKind === 'return-plenum')!
    expect(retPl).toBeDefined()
    expect(retPl.position[0]).toBeGreaterThanOrEqual(0.15)
    expect(retPl.position[0]).toBeLessThanOrEqual(9.85)
    expect(retPl.position[2]).toBeGreaterThanOrEqual(0.15)
    expect(retPl.position[2]).toBeLessThanOrEqual(7.85)
  })

  test('HVA-BUG-06: Central Return Air Grille avoids nested Kitchen at Living Room centroid and larger overlapping Garage/Kitchen polygons (IMC 601.5)', () => {
    const scene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [12, 0], height: 2.7, thickness: 0.16 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [12, 0], end: [12, 8], height: 2.7, thickness: 0.16 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [12, 8], end: [0, 8], height: 2.7, thickness: 0.16 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 8], end: [0, 0], height: 2.7, thickness: 0.16 },
      // Open-concept Living zone [0..12, 0..8] with a nested Kitchen right on its centroid [4..8, 2.5..5.5]
      r_liv: { id: 'r_liv', type: 'zone', name: 'Living Room', parentId: 'level_0', polygon: [[0, 0], [12, 0], [12, 8], [0, 8]] },
      r_kit: { id: 'r_kit', type: 'zone', name: 'Kitchen', parentId: 'level_0', polygon: [[4, 2.5], [8, 2.5], [8, 5.5], [4, 5.5]] },
      // Small Hallway overlapping a larger Kitchen polygon to verify removal of broken areaSqm <= roomAreaSqm guard
      r_hall: { id: 'r_hall', type: 'zone', name: 'Hallway', parentId: 'level_0', polygon: [[4.5, 3.0], [6.5, 3.0], [6.5, 5.0], [4.5, 5.0]] },
    }
    const plan = planHvacAutoPopulate(scene, { levelId: 'level_0', climateZone: '4A' })
    const ret = plan.terminals.find((t) => t.terminalKind === 'return-grille')!
    expect(ret).toBeDefined()
    const kitPoly = [[4, 2.5], [8, 2.5], [8, 5.5], [4, 5.5]] as const
    expect(pointInPolygon2D(ret.position[0], ret.position[2], kitPoly)).toBe(false)

    const audit = auditSceneHvac(materialize(scene, plan), { climateZone: '4A' })
    expect(audit.findings.some((f) => f.codeRef === 'IMC 601.5 / IRC M1602.2')).toBe(false)
  })

  test('HVA-OPT-01: Broad-phase spatial filter, clamped Y deduplication, and irreducible endpoint early exit keep routing fast on 350+ obstacles', () => {
    const obstacles: HvacObstacle[] = []
    for (let i = 0; i < 350; i++) {
      const gx = 20 + (i % 25) * 2
      const gz = 20 + Math.floor(i / 25) * 2
      obstacles.push({
        id: `far_obs_${i}`,
        nodeId: `far_obs_${i}`,
        category: 'plumbing',
        label: `Far pipe ${i}`,
        box: { minX: gx, maxX: gx + 0.1, minY: 0, maxY: 3.5, minZ: gz, maxZ: gz + 0.1 },
      })
    }
    // Irreducible obstacle sitting directly on fixed `from` endpoint
    obstacles.push({
      id: 'endpoint_blocker',
      nodeId: 'endpoint_blocker',
      category: 'structural',
      label: 'Column on start endpoint',
      box: { minX: 0.9, maxX: 1.1, minY: 0, maxY: 3.5, minZ: 0.9, maxZ: 1.1 },
    })

    const t0 = performance.now()
    const ductRes = routeHvacDuctRun({
      from: [1, 2.6, 1],
      to: [8, 2.6, 6],
      plenumY: 2.5,
      maxPlenumY: 2.62,
      ductHalfSpanM: 0.1,
      obstacles,
    })
    const condRes = routeCondensateDrain({
      from: [1, 1.0, 1],
      to: [8, 0.05, 6],
      obstacles,
    })
    const elapsedMs = performance.now() - t0
    expect(ductRes.clashes).toHaveLength(1)
    expect(condRes.clashes).toHaveLength(1)
    // Early exit + broad-phase filter should finish well under 50ms even on slow CI
    expect(elapsedMs).toBeLessThan(50)
  })

  test('HVA-CON-01: ERV & bath exhaust ducts size before clash-routing and apply effectiveDuctR in attic runs', () => {
    const scene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [12, 0], height: 2.7, thickness: 0.16 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [12, 0], end: [12, 8], height: 2.7, thickness: 0.16 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [12, 8], end: [0, 8], height: 2.7, thickness: 0.16 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 8], end: [0, 0], height: 2.7, thickness: 0.16 },
      r_liv: { id: 'r_liv', type: 'zone', name: 'Living Room', parentId: 'level_0', polygon: [[0, 0], [6, 0], [6, 8], [0, 8]] },
      r_kit: { id: 'r_kit', type: 'zone', name: 'Kitchen', parentId: 'level_0', polygon: [[6, 0], [9, 0], [9, 4], [6, 4]] },
      r_bath: { id: 'r_bath', type: 'zone', name: 'Bathroom', parentId: 'level_0', polygon: [[9, 0], [12, 0], [12, 4], [9, 4]] },
      // Place a DWV vent 0.085m from bath centroid — old hardcoded 0.06m span missed 6" duct (0.0762m half-span)!
      bath_vent: {
        id: 'bath_vent',
        type: 'plumbing:pipe-run',
        parentId: 'level_0',
        system: 'dwv-vent',
        nominalSize: '2"',
        path: [[10.585, 0, 2.0], [10.585, 3.2, 2.0]],
      },
    }
    const plan = planHvacAutoPopulate(scene, {
      levelId: 'level_0',
      climateZone: '4A',
      plenumLocation: 'crawlspace',
      includeErv: true,
      includeExhaustFans: true,
    })
    const audit = auditSceneHvac(materialize(scene, plan), { climateZone: '4A' })
    expect(audit.errorCount).toBe(0)

    // In crawlspace mode (ductR = 6), any exhaust/hood duct routing above levelH - 0.02 MUST get IECC attic R-8
    const bathEx = plan.ductRuns.find((d) => d.name.includes('Bath Exhaust'))!
    const hoodEx = plan.ductRuns.find((d) => d.name.includes('Range Hood'))!
    expect(bathEx).toBeDefined()
    expect(hoodEx).toBeDefined()
    if (bathEx.path.some((p) => p[1] > 2.68)) expect(bathEx.insulationR).toBeGreaterThanOrEqual(8)
    if (hoodEx.path.some((p) => p[1] > 2.68)) expect(hoodEx.insulationR).toBeGreaterThanOrEqual(8)
  })

  test('VIS-01: Zero roof protrusions for attic equipment (horizontal low-profile switch on narrow apartments) and all attic ducts under pitched gable & explicit roof-segments', () => {
    // Narrow apartment topology (Cenon Apartment: 11m x 5.2m, wallH = 2.5m -> ridge rise = 1.30m)
    const cenonApt: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.5 },
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [11, 0], height: 2.5, thickness: 0.16 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [11, 0], end: [11, 5.2], height: 2.5, thickness: 0.16 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [11, 5.2], end: [0, 5.2], height: 2.5, thickness: 0.16 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 5.2], end: [0, 0], height: 2.5, thickness: 0.16 },
      r_sej: { id: 'r_sej', type: 'zone', name: 'Séjour', parentId: 'level_0', polygon: [[0, 0], [5, 0], [5, 5.2], [0, 5.2]] },
      r_cui: { id: 'r_cui', type: 'zone', name: 'Cuisine', parentId: 'level_0', polygon: [[5, 0], [8, 0], [8, 2.6], [5, 2.6]] },
      r_ch1: { id: 'r_ch1', type: 'zone', name: 'Chambre 1', parentId: 'level_0', polygon: [[8, 0], [11, 0], [11, 5.2], [8, 5.2]] },
      r_sdb: { id: 'r_sdb', type: 'zone', name: 'Salle de Bains', parentId: 'level_0', polygon: [[5, 2.6], [8, 2.6], [8, 5.2], [5, 5.2]] },
    }
    const plan = planHvacAutoPopulate(cenonApt, {
      levelId: 'level_0',
      climateZone: '4A',
      plenumLocation: 'attic',
      includeErv: true,
      includeExhaustFans: true,
    })
    const bounds = { minX: 0, maxX: 11, minZ: 0, maxZ: 5.2 }
    const roof = buildAtticRoofEnvelope(cenonApt, 'level_0', bounds, 2.5)

    const ahu = plan.equipment.find((e) => e.equipmentKind === 'air-handler')!
    expect(ahu).toBeDefined()
    // Narrow 5.2m span cannot fit a vertical 1.43m AHU + top plenum in attic -> must switch to horizontal low-profile (0.52m)
    if (ahu.position[1] >= 2.5) {
      expect(ahu.orientation).toBe('horizontal')
      expect(ahu.heightM).toBe(0.52)
    }

    // Verify ZERO roof protrusions on ALL indoor equipment & plenums (>= 12cm below roof plane)
    for (const eq of plan.equipment) {
      if (eq.equipmentKind === 'heat-pump-condenser' || eq.equipmentKind === 'ac-condenser') continue
      const hM = eq.heightM ?? (eq.equipmentKind === 'air-handler' ? 1.22 : 0.6)
      const topY = eq.position[1] + hM
      expect(topY).toBeLessThanOrEqual(roof.roofYAt(eq.position[0], eq.position[2]) - 0.1 + 1e-4)
    }
    for (const pl of plan.plenums) {
      const hM = pl.heightM ?? 0.45
      const topY = pl.position[1] + hM
      expect(topY).toBeLessThanOrEqual(roof.roofYAt(pl.position[0], pl.position[2]) - 0.1 + 1e-4)
    }

    // Verify ZERO roof protrusions on ALL duct runs (supply, return, ERV, exhaust, lineset, condensate)
    for (const run of plan.ductRuns) {
      const halfH = ((run.shape === 'rectangular' ? run.height : run.diameter) * 0.0254) / 2
      expect(pathClearOfRoof(run.path, roof, halfH, 0.05)).toBe(true)
    }

    // Flat explicit roof-segment -> attic AHU falls back cleanly to interior floor placement (never pokes through flat roof!)
    const flatRoofApt: Record<string, SceneNodeLike> = {
      ...cenonApt,
      rseg_flat: {
        id: 'rseg_flat',
        type: 'roof-segment',
        parentId: 'level_0',
        roofType: 'flat',
        position: [5.5, 2.5, 2.6],
        width: 11,
        depth: 5.2,
        wallHeight: 0,
        pitch: 0,
      },
    }
    const flatPlan = planHvacAutoPopulate(flatRoofApt, { levelId: 'level_0', plenumLocation: 'attic' })
    const flatAhu = flatPlan.equipment.find((e) => e.equipmentKind === 'air-handler')!
    expect(flatAhu.position[1]).toBe(0)
    const flatRoof = buildAtticRoofEnvelope(flatRoofApt, 'level_0', bounds, 2.5)
    for (const run of flatPlan.ductRuns) {
      const halfH = ((run.shape === 'rectangular' ? run.height : run.diameter) * 0.0254) / 2
      expect(pathClearOfRoof(run.path, flatRoof, halfH, 0.05)).toBe(true)
    }
  })

  test('VIS-02 & VIS-04: Commercial Bouldering Gym resolves true 5.0m roof height for RTU (not averaged 2.6m) and routes RTU condensate strictly inside roof deck', () => {
    const boulderingGym: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 5.0 },
      // Tall 4.8m outer commercial walls
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [18, 0], height: 4.8, thickness: 0.2 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [18, 0], end: [18, 12], height: 4.8, thickness: 0.2 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [18, 12], end: [0, 12], height: 4.8, thickness: 0.2 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 12], end: [0, 0], height: 4.8, thickness: 0.2 },
      // Many short 2.5m interior restroom/locker partitions (previously dragged average wallH down to ~2.8m!)
      p1: { id: 'p1', type: 'wall', parentId: 'level_0', start: [0, 9], end: [5, 9], height: 2.5, thickness: 0.12 },
      p2: { id: 'p2', type: 'wall', parentId: 'level_0', start: [2.5, 9], end: [2.5, 12], height: 2.5, thickness: 0.12 },
      p3: { id: 'p3', type: 'wall', parentId: 'level_0', start: [5, 9], end: [5, 12], height: 2.5, thickness: 0.12 },
      p4: { id: 'p4', type: 'wall', parentId: 'level_0', start: [1, 9], end: [1, 11], height: 2.5, thickness: 0.12 },
      p5: { id: 'p5', type: 'wall', parentId: 'level_0', start: [3.5, 9], end: [3.5, 11], height: 2.5, thickness: 0.12 },
      p6: { id: 'p6', type: 'wall', parentId: 'level_0', start: [0, 10.5], end: [2.5, 10.5], height: 2.5, thickness: 0.12 },
      r_gym: { id: 'r_gym', type: 'zone', name: 'Main Gym', parentId: 'level_0', polygon: [[0, 0], [18, 0], [18, 9], [0, 9]] },
      r_rest: { id: 'r_rest', type: 'zone', name: 'Restroom', parentId: 'level_0', polygon: [[0, 9], [5, 9], [5, 12], [0, 12]] },
    }

    // Even when level.height is omitted, tallest perimeter wall (4.8m) wins over 2.5m partitions
    expect(resolveLevelHeightM(boulderingGym, 'level_0')).toBe(5.0)
    const noLvlHeight = { ...boulderingGym, level_0: { id: 'level_0', type: 'level' } }
    expect(resolveLevelHeightM(noLvlHeight, 'level_0')).toBe(4.8)

    const plan = planHvacAutoPopulate(boulderingGym, {
      levelId: 'level_0',
      occupancy: 'commercial',
      systemType: 'rooftop-package',
      climateZone: '4A',
    })
    const rtu = plan.equipment.find((e) => e.equipmentKind === 'rooftop-package-unit')!
    const rtuCond = plan.ductRuns.find((d) => d.system === 'condensate-drain' && d.sourceNodeId === rtu.id)!
    expect(rtu).toBeDefined()
    expect(rtuCond).toBeDefined()

    // RTU must sit ON TOP of the 5.0m roof deck (not floating mid-room at 2.6m!)
    expect(rtu.position[1]).toBeGreaterThanOrEqual(5.0)

    // RTU condensate stays cleanly across the flat roof deck strictly inside walled bounds [0.15..17.85, 0.15..11.85]
    for (const pt of rtuCond.path) {
      expect(pt[0]).toBeGreaterThanOrEqual(0.15)
      expect(pt[0]).toBeLessThanOrEqual(17.85)
      expect(pt[2]).toBeGreaterThanOrEqual(0.15)
      expect(pt[2]).toBeLessThanOrEqual(11.85)
      expect(pt[1]).toBeGreaterThanOrEqual(4.6)
      expect(pt[1]).toBeLessThanOrEqual(5.12)
    }
    const slope = measureCondensateSlope(rtuCond.path)
    expect(slope.hasUphillSegment).toBe(false)
    expect(slope.overallSlopeInPerFt).toBeGreaterThanOrEqual(0.125)

    const audit = auditSceneHvac(materialize(boulderingGym, plan), { occupancy: 'commercial', climateZone: '4A' })
    expect(audit.errorCount).toBe(0)
  })

  test('VIS-06: Excludes outdoor Swimming Pool / Piscine & patio/yard zones from conditioned rooms and keeps all indoor ducts/equipment strictly within walled bounds', () => {
    expect(classifyHvacRoomName('Swimming Pool')).toBe('exterior')
    expect(classifyHvacRoomName('Piscine')).toBe('exterior')
    expect(classifyHvacRoomName('Pool Deck')).toBe('exterior')
    expect(classifyHvacRoomName('Back Garden')).toBe('exterior')
    expect(classifyHvacRoomName('Courtyard')).toBe('exterior')
    expect(classifyHvacRoomName('Driveway')).toBe('exterior')

    const poolHouse: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.8 },
      // Enclosed house walls [0..10, 0..8]
      w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [10, 0], height: 2.8, thickness: 0.16 },
      w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [10, 0], end: [10, 8], height: 2.8, thickness: 0.16 },
      w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [10, 8], end: [0, 8], height: 2.8, thickness: 0.16 },
      w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 8], end: [0, 0], height: 2.8, thickness: 0.16 },
      r_liv: { id: 'r_liv', type: 'zone', name: 'Living Room', parentId: 'level_0', polygon: [[0, 0], [6, 0], [6, 8], [0, 8]] },
      r_bed: { id: 'r_bed', type: 'zone', name: 'Bedroom', parentId: 'level_0', polygon: [[6, 0], [10, 0], [10, 8], [6, 8]] },
      // Outdoor Swimming Pool & Patio far outside the east wall [12..19, 1..7]
      r_pool: { id: 'r_pool', type: 'zone', name: 'Swimming Pool', parentId: 'level_0', polygon: [[12, 1], [19, 1], [19, 7], [12, 7]] },
      r_patio: { id: 'r_patio', type: 'zone', name: 'Patio', parentId: 'level_0', polygon: [[10, 0], [12, 0], [12, 8], [10, 8]] },
    }
    const plan = planHvacAutoPopulate(poolHouse, { levelId: 'level_0', climateZone: '4A' })

    // Zero conditioned rooms or terminals for Swimming Pool or Patio
    expect(plan.load.rooms.some((r) => /pool|patio/i.test(r.roomName))).toBe(false)
    expect(plan.terminals.some((t) => /pool|patio/i.test(t.roomName))).toBe(false)

    // ALL indoor equipment, plenums, supply/return terminals, and indoor ducts strictly within walled bounds [0.15..9.85, 0.15..7.85]
    for (const eq of plan.equipment) {
      if (eq.equipmentKind === 'heat-pump-condenser' || eq.equipmentKind === 'ac-condenser') continue
      expect(eq.position[0]).toBeGreaterThanOrEqual(0.15)
      expect(eq.position[0]).toBeLessThanOrEqual(9.85)
      expect(eq.position[2]).toBeGreaterThanOrEqual(0.15)
      expect(eq.position[2]).toBeLessThanOrEqual(7.85)
    }
    for (const pl of plan.plenums) {
      expect(pl.position[0]).toBeGreaterThanOrEqual(0.15)
      expect(pl.position[0]).toBeLessThanOrEqual(9.85)
      expect(pl.position[2]).toBeGreaterThanOrEqual(0.15)
      expect(pl.position[2]).toBeLessThanOrEqual(7.85)
    }
    for (const run of plan.ductRuns) {
      if (run.system !== 'supply-trunk' && run.system !== 'supply-branch' && run.system !== 'return-trunk') continue
      for (const pt of run.path) {
        expect(pt[0]).toBeGreaterThanOrEqual(0.15)
        expect(pt[0]).toBeLessThanOrEqual(9.85)
        expect(pt[2]).toBeGreaterThanOrEqual(0.15)
        expect(pt[2]).toBeLessThanOrEqual(7.85)
      }
    }
  })
})
