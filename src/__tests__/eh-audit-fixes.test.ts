import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'bun:test'
import {
  type SceneNodeLike as KernelSceneNodeLike,
  compileBuildingAnatomy,
  evaluatePlacementCandidate,
  getPlumbingEquipmentPrism,
  validateRuleTable,
} from '@kruschdev/pascal-mep-kernel'
import { auditSceneHvac } from '../imc/audit'
import { planHvacAutoPopulate } from '../imc/autopopulate'
import type { SceneNodeLike } from '../imc/framing-interop'
import {
  buildAtticRoofEnvelope,
  createHvacLegalCavityContext,
  detectHvacClashes,
  extractHvacObstacles,
  extractRoomPolygons,
  extractWallSegments,
  isPointInsideBuildingFootprint,
  pathClearOfRoof,
  routeHvacViaLegalCavity,
  safeRoofCorridorHalfWidth,
  segmentCrossesOutdoorVoid,
} from '../imc/routing'
import {
  IMC_CONDENSATE_SLOPE_RULE,
  IMC_DECLARATIVE_RULES,
  IMC_RULE_THRESHOLDS,
} from '../imc/rules'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

function makeWall(
  id: string,
  levelId: string,
  start: [number, number],
  end: [number, number],
  height = 2.7,
  thickness = 0.16,
): SceneNodeLike {
  return {
    id,
    type: 'wall',
    name: id,
    parentId: levelId,
    start,
    end,
    height,
    thickness,
    visible: true,
  }
}

function makeRoom(
  id: string,
  levelId: string,
  name: string,
  polygon: Array<[number, number]>,
  category?: string,
): SceneNodeLike {
  return {
    id,
    type: 'zone',
    name,
    parentId: levelId,
    polygon,
    ...(category ? { category } : {}),
    visible: true,
  }
}

describe('Phase 1 Adversarial Audit Regressions (BUG-EH-05..11, CON-EH-05)', () => {
  test('BUG-EH-05: buildAtticRoofEnvelope preserves pitchRiseOver12 === 0 for flat roofs in roofYAt and safeRoofCorridorHalfWidth', () => {
    const bounds = { minX: 0, maxX: 12, minZ: 0, maxZ: 8 }

    // Case A: structural:assembly sets roofPitchRise: 0 (no explicit roof-segment nodes)
    const flatAssemblyScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.8 },
      w1: makeWall('w1', 'level_0', [0, 0], [12, 0], 2.8),
      w2: makeWall('w2', 'level_0', [12, 0], [12, 8], 2.8),
      w3: makeWall('w3', 'level_0', [12, 8], [0, 8], 2.8),
      w4: makeWall('w4', 'level_0', [0, 8], [0, 0], 2.8),
      asm_flat: {
        id: 'asm_flat',
        type: 'structural:assembly',
        parentId: 'level_0',
        roofPitchRise: 0,
      },
    }
    const envA = buildAtticRoofEnvelope(flatAssemblyScene, 'level_0', bounds, 2.8)
    expect(envA.isFlatRoof).toBe(true)
    expect(envA.pitchRiseOver12).toBe(0)
    expect(envA.roofYAt(6, 4)).toBeCloseTo(2.8, 3)
    expect(safeRoofCorridorHalfWidth(envA, 2.95, 0.1, 0.08)).toBe(0)

    // Case B: explicit roofType: 'flat' roof-segment node
    const flatSegScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 3.0 },
      w1: makeWall('w1', 'level_0', [0, 0], [12, 0], 3.0),
      w2: makeWall('w2', 'level_0', [12, 0], [12, 8], 3.0),
      w3: makeWall('w3', 'level_0', [12, 8], [0, 8], 3.0),
      w4: makeWall('w4', 'level_0', [0, 8], [0, 0], 3.0),
      roof_flat: {
        id: 'roof_flat',
        type: 'roof-segment',
        parentId: 'level_0',
        roofType: 'flat',
        position: [6, 3.0, 4],
        width: 12,
        depth: 8,
        pitch: 0,
        visible: true,
      },
    }
    const envB = buildAtticRoofEnvelope(flatSegScene, 'level_0', bounds, 3.0)
    expect(envB.isFlatRoof).toBe(true)
    expect(envB.pitchRiseOver12).toBe(0)
    expect(envB.roofYAt(6, 4)).toBeCloseTo(3.0, 3)
    expect(safeRoofCorridorHalfWidth(envB, 3.1, 0.1, 0.08)).toBe(0)
    expect(safeRoofCorridorHalfWidth(envB, 2.5, 0.1, 0.08)).toBe(0)

    // Case C: pitched gable default (no roofPitchRise / no flat segment) retains 6:12 fallback
    const pitchedScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      w1: makeWall('w1', 'level_0', [0, 0], [12, 0], 2.7),
      w2: makeWall('w2', 'level_0', [12, 0], [12, 8], 2.7),
      w3: makeWall('w3', 'level_0', [12, 8], [0, 8], 2.7),
      w4: makeWall('w4', 'level_0', [0, 8], [0, 0], 2.7),
    }
    const envC = buildAtticRoofEnvelope(pitchedScene, 'level_0', bounds, 2.7)
    expect(envC.isFlatRoof).toBe(false)
    expect(envC.pitchRiseOver12).toBe(6)
    expect(envC.roofYAt(6, 4)).toBeCloseTo(2.7 + 4 * 0.5, 3)
    expect(safeRoofCorridorHalfWidth(envC, 3.0, 0.1, 0.08)).toBeGreaterThan(2)
  })

  test('BUG-EH-06: routeHvacViaLegalCavity cacheKey isolates levelId and custom polygon overrides', () => {
    const scene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', name: 'Ground', level: 0, height: 2.7, visible: true },
      level_1: { id: 'level_1', type: 'level', name: 'Upper', level: 1, height: 3.4, visible: true },
      // Level 0: [0..10] x [0..8]
      w0_n: makeWall('w0_n', 'level_0', [0, 0], [10, 0], 2.7),
      w0_e: makeWall('w0_e', 'level_0', [10, 0], [10, 8], 2.7),
      w0_s: makeWall('w0_s', 'level_0', [10, 8], [0, 8], 2.7),
      w0_w: makeWall('w0_w', 'level_0', [0, 8], [0, 0], 2.7),
      r0: makeRoom('r0', 'level_0', 'Living Room', [[0, 0], [10, 0], [10, 8], [0, 8]], 'living'),
      // Level 1: taller 3.4m story on [0..10] x [0..8]
      w1_n: makeWall('w1_n', 'level_1', [0, 0], [10, 0], 3.4),
      w1_e: makeWall('w1_e', 'level_1', [10, 0], [10, 8], 3.4),
      w1_s: makeWall('w1_s', 'level_1', [10, 8], [0, 8], 3.4),
      w1_w: makeWall('w1_w', 'level_1', [0, 8], [0, 0], 3.4),
      r1: makeRoom('r1', 'level_1', 'Master Suite', [[0, 0], [10, 0], [10, 8], [0, 8]], 'bedroom'),
    }

    const cavityContext = createHvacLegalCavityContext(scene, 'level_0')
    expect(cavityContext.graphCache.size).toBe(0)

    const resLvl0 = routeHvacViaLegalCavity({
      cavityContext,
      levelId: 'level_0',
      from: [1.5, 2.45, 4.0],
      to: [8.5, 2.45, 4.0],
      plenumLocation: 'conditioned-soffit',
      flatSoffitMarginM: 0.25,
    })
    expect(resLvl0.ok).toBe(true)
    expect(cavityContext.graphCache.size).toBe(1)

    // Reusing the same cavityContext on level_1 MUST compile a distinct level_1 graph (height 3.4m, not 2.7m)
    const resLvl1 = routeHvacViaLegalCavity({
      cavityContext,
      levelId: 'level_1',
      from: [1.5, 3.15, 4.0],
      to: [8.5, 3.15, 4.0],
      plenumLocation: 'conditioned-soffit',
      flatSoffitMarginM: 0.25,
    })
    expect(resLvl1.ok).toBe(true)
    expect(cavityContext.graphCache.size).toBe(2)
    // Level 1 soffit runs near y ~ 3.15 (not clamped down to level 0's 2.45m!)
    const maxYLvl1 = Math.max(...resLvl1.path.map((p) => p[1]))
    expect(maxYLvl1).toBeGreaterThan(2.9)

    // Reusing cavityContext on level_0 with a custom outdoor courtyard polygon override MUST miss cache
    const resCourtyard = routeHvacViaLegalCavity({
      cavityContext,
      levelId: 'level_0',
      from: [1.5, 2.45, 6.0],
      to: [8.5, 2.45, 6.0],
      plenumLocation: 'conditioned-soffit',
      flatSoffitMarginM: 0.25,
      outdoorPolygons: [[[3.5, 3.5], [6.5, 3.5], [6.5, 8.0], [3.5, 8.0]]],
    })
    expect(resCourtyard.ok).toBe(true)
    expect(cavityContext.graphCache.size).toBe(3)
  })

  test('BUG-EH-07: routeHvacViaLegalCavity returns baseOccupancy deterministic reservationId when extraObstacles clones occupancy', () => {
    const scene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7, level: 0, visible: true },
      w_n: makeWall('w_n', 'level_0', [0, 0], [10, 0]),
      w_e: makeWall('w_e', 'level_0', [10, 0], [10, 8]),
      w_s: makeWall('w_s', 'level_0', [10, 8], [0, 8]),
      w_w: makeWall('w_w', 'level_0', [0, 8], [0, 0]),
      r0: makeRoom('r0', 'level_0', 'Living Room', [[0, 0], [10, 0], [10, 8], [0, 8]], 'living'),
    }

    const cavityContext = createHvacLegalCavityContext(scene, 'level_0')
    const baseCountBefore = cavityContext.occupancy.obstacles.length

    // Supply a synthetic obstacle NOT present in baseOccupancy so effectiveOccupancy is cloned
    const res = routeHvacViaLegalCavity({
      cavityContext,
      from: [1.5, 2.45, 4.0],
      to: [8.5, 2.45, 4.0],
      plenumLocation: 'conditioned-soffit',
      flatSoffitMarginM: 0.25,
      reserveOnCommit: true,
      extraObstacles: [
        {
          id: 'synthetic_beam_missing',
          nodeId: 'synthetic_beam_missing',
          category: 'structural',
          label: 'Synthetic Girder',
          box: { minX: 4.8, maxX: 5.2, minY: 2.1, maxY: 2.7, minZ: 2.5, maxZ: 5.5 },
        },
      ],
    })

    expect(res.ok).toBe(true)
    expect(res.reservationId).toBeDefined()
    // Deterministic monotonic counter (not a 13-digit Date.now() epoch timestamp)
    expect(res.reservationId).toMatch(/^res:hvac-cavity-\d{1,6}:\d+$/)
    expect(cavityContext.occupancy.obstacles.length).toBeGreaterThan(baseCountBefore)

    // Unreserving using the returned reservationId MUST remove all reserved segments from baseOccupancy
    cavityContext.occupancy.unreserve(res.reservationId!)
    expect(cavityContext.occupancy.obstacles.length).toBe(baseCountBefore)
  })

  test('BUG-EH-08: auditSceneHvac evaluates all 3 condenser clearance rules and distinguishes above-ceiling conditioned return grilles', () => {
    const badScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7, level: 0, visible: true },
      w_n: makeWall('w_n', 'level_0', [0, 0], [12, 0], 2.7),
      w_e: makeWall('w_e', 'level_0', [12, 0], [12, 8], 2.7),
      w_s: makeWall('w_s', 'level_0', [12, 8], [0, 8], 2.7),
      w_w: makeWall('w_w', 'level_0', [0, 8], [0, 0], 2.7),
      r_hall: makeRoom('r_hall', 'level_0', 'Main Hallway', [[0, 0], [12, 0], [12, 8], [0, 8]], 'hallway'),
      // Door at (6, 0) on north wall, window at (2, 0) on north wall
      front_door: {
        id: 'front_door',
        type: 'door',
        parentId: 'w_n',
        position: [6.0, 0, 0],
        width: 0.9,
        height: 2.1,
        visible: true,
      },
      north_win: {
        id: 'north_win',
        type: 'window',
        parentId: 'w_n',
        position: [2.0, 0.9, 0],
        width: 1.2,
        height: 1.2,
        visible: true,
      },
      // Exterior gas meter on east wall
      gas_meter_1: {
        id: 'gas_meter_1',
        type: 'plumbing:equipment',
        equipmentKind: 'gas-meter',
        parentId: 'level_0',
        position: [12.3, 0, 4.0],
      },
      // Condenser 1: 0.9m from front_door (< 2.4m) AND 0.5m from sibling Condenser 2 (< 1.5m)
      cond_1: {
        id: 'cond_1',
        type: 'hvac:equipment',
        equipmentKind: 'heat-pump-condenser',
        name: 'Heat Pump Condenser 1',
        parentId: 'level_0',
        position: [6.0, 0, -0.9],
      },
      cond_2: {
        id: 'cond_2',
        type: 'hvac:equipment',
        equipmentKind: 'ac-condenser',
        name: 'AC Condenser 2',
        parentId: 'level_0',
        position: [6.5, 0, -0.9],
      },
      // Condenser 3: 0.8m from north_win (< 1.2m)
      cond_3: {
        id: 'cond_3',
        type: 'hvac:equipment',
        equipmentKind: 'mini-split-outdoor',
        name: 'Mini-Split Outdoor',
        parentId: 'level_0',
        position: [2.0, 0, -0.8],
      },
      // Condenser 4: 0.6m from exterior gas meter (< 1.2m)
      cond_4: {
        id: 'cond_4',
        type: 'hvac:equipment',
        equipmentKind: 'heat-pump-condenser',
        name: 'East Condenser',
        parentId: 'level_0',
        position: [12.9, 0, 4.0],
      },
      // Return grille A: right at ceiling elevation (y = 2.7 === lvlH) in conditioned hallway -> VALID
      ret_at_ceiling: {
        id: 'ret_at_ceiling',
        type: 'hvac:terminal',
        terminalKind: 'return-grille',
        name: 'Hallway Ceiling Return',
        parentId: 'level_0',
        position: [4.0, 2.7, 4.0],
      },
      // Return grille B: strictly above ceiling (y = 2.95 > 2.7) in conditioned hallway -> above-ceiling / attic error
      ret_above_ceiling: {
        id: 'ret_above_ceiling',
        type: 'hvac:terminal',
        terminalKind: 'return-grille',
        name: 'Misplaced Attic Return',
        parentId: 'level_0',
        position: [8.0, 2.95, 4.0],
      },
    }

    const audit = auditSceneHvac(badScene)

    // All 3 condenser clearance rules fire as warnings with IMC 304 / M1403
    const condenserWarnings = audit.findings.filter((f) => f.codeRef === 'IMC 304 / M1403')
    expect(condenserWarnings.every((f) => f.severity === 'warning')).toBe(true)
    expect(
      condenserWarnings.some(
        (f) => f.nodeIds.includes('cond_1') && f.nodeIds.includes('front_door'),
      ),
    ).toBe(true)
    expect(
      condenserWarnings.some(
        (f) => f.nodeIds.includes('cond_1') && f.nodeIds.includes('cond_2'),
      ),
    ).toBe(true)
    expect(
      condenserWarnings.some(
        (f) => f.nodeIds.includes('cond_3') && f.nodeIds.includes('north_win'),
      ),
    ).toBe(true)
    expect(
      condenserWarnings.some(
        (f) => f.nodeIds.includes('cond_4') && f.nodeIds.includes('gas_meter_1'),
      ),
    ).toBe(true)
    // No `:segN` leakage in any finding.nodeIds
    for (const f of audit.findings) {
      for (const nid of f.nodeIds) {
        expect(nid).not.toContain(':seg')
      }
    }

    // Conditioned-room ceiling-elevation return grille is NOT flagged
    expect(audit.findings.some((f) => f.nodeIds.includes('ret_at_ceiling'))).toBe(false)

    // Above-ceiling return grille over hallway is labeled above-ceiling / attic, NOT prohibited hallway zone
    const aboveFinding = audit.findings.find((f) => f.nodeIds.includes('ret_above_ceiling'))
    expect(aboveFinding).toBeDefined()
    expect(aboveFinding!.severity).toBe('error')
    expect(aboveFinding!.title.toLowerCase()).toContain('above-ceiling / attic')
    expect(aboveFinding!.title.toLowerCase()).not.toContain('prohibited hallway')
  })

  test('BUG-EH-09: Exhaust duct routing clamps dropped-under-header exit Y and avoids concave courtyard & roof clipping', () => {
    // Concave U-shaped building with kitchen on West wing facing the courtyard + low-pitched roof
    const uScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.6, level: 0, visible: true },
      // Outer perimeter of U-shape: West wing x in [0,5], z in [0,10];
      // Connecting North bridge x in [5,11], z in [0,4];
      // East wing x in [11,16], z in [0,10]; Courtyard void x in [5,11], z in [4,10]
      w1: makeWall('w1', 'level_0', [0, 0], [16, 0], 2.6),
      w2: makeWall('w2', 'level_0', [16, 0], [16, 10], 2.6),
      w3: makeWall('w3', 'level_0', [16, 10], [11, 10], 2.6),
      w4: makeWall('w4', 'level_0', [11, 10], [11, 4], 2.6),
      w5: makeWall('w5', 'level_0', [11, 4], [5, 4], 2.6),
      w6: makeWall('w6', 'level_0', [5, 4], [5, 10], 2.6),
      w7: makeWall('w7', 'level_0', [5, 10], [0, 10], 2.6),
      w8: makeWall('w8', 'level_0', [0, 10], [0, 0], 2.6),
      r_kit: makeRoom('r_kit', 'level_0', 'Kitchen', [[0, 4], [5, 4], [5, 10], [0, 10]], 'kitchen'),
      r_liv: makeRoom('r_liv', 'level_0', 'Living Room', [[0, 0], [11, 0], [11, 4], [0, 4]], 'living'),
      r_bath: makeRoom('r_bath', 'level_0', 'Bathroom', [[11, 4], [16, 4], [16, 10], [11, 10]], 'bathroom'),
      r_bed: makeRoom('r_bed', 'level_0', 'Bedroom', [[11, 0], [16, 0], [16, 4], [11, 4]], 'bedroom'),
      // Low 3:12 roof pitch + continuous header on west kitchen wall forcing drop-under-header
      asm_low: { id: 'asm_low', type: 'structural:assembly', parentId: 'level_0', roofPitchRise: 3 },
      hdr_west: {
        id: 'hdr_west',
        type: 'structural:beam',
        name: 'West Kitchen Header',
        parentId: 'level_0',
        start: [0, 4.1],
        end: [0, 9.9],
        widthIn: 3.5,
        depthIn: 11.25,
        elevationY: 2.31,
      },
    }

    const plan = planHvacAutoPopulate(uScene, {
      levelId: 'level_0',
      climateZone: '4A',
      includeExhaustFans: true,
    })
    const exhaustRuns = plan.ductRuns.filter((d) => d.system === 'exhaust-duct')
    expect(exhaustRuns.length).toBeGreaterThanOrEqual(2)

    const walls = extractWallSegments(uScene, 'level_0')
    const rooms = extractRoomPolygons(uScene, 'level_0')
    const roof = buildAtticRoofEnvelope(uScene, 'level_0', { minX: 0, maxX: 16, minZ: 0, maxZ: 10 }, 2.6)
    const isInside = (x: number, z: number) => isPointInsideBuildingFootprint(x, z, walls, rooms)

    for (const run of exhaustRuns) {
      const halfSpan = ((run.diameter ?? 6) * 0.0254) / 2
      expect(pathClearOfRoof(run.path, roof, halfSpan, 0.14, halfSpan)).toBe(true)
      for (let i = 1; i < run.path.length; i++) {
        expect(segmentCrossesOutdoorVoid(run.path[i - 1]!, run.path[i]!, isInside, 0.5)).toBe(false)
      }
      // Exit Y must stay below the roof envelope at the penetration wall point
      const exitPt = run.path[run.path.length - 1]!
      const wx = Math.max(0, Math.min(16, exitPt[0]))
      const wz = Math.max(0, Math.min(10, exitPt[2]))
      expect(exitPt[1]).toBeLessThanOrEqual(roof.roofYAt(wx, wz) - halfSpan - 0.09)
    }

    // Part B: 1st-floor beneath 2nd-story with continuous perimeter headers where rawDroppedY > soffitExitY
    // verifies `buildHeaderSafeExteriorExhaustTargets` clamps dropped-under-header Y via `clampExteriorExitY`.
    const lowSoffitTwoStory: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', level: 0, height: 2.45, visible: true },
      level_1: { id: 'level_1', type: 'level', level: 1, height: 2.7, visible: true },
      w0_n: makeWall('w0_n', 'level_0', [0, 0], [8, 0], 2.45),
      w0_e: makeWall('w0_e', 'level_0', [8, 0], [8, 6], 2.45),
      w0_s: makeWall('w0_s', 'level_0', [8, 6], [0, 6], 2.45),
      w0_w: makeWall('w0_w', 'level_0', [0, 6], [0, 0], 2.45),
      w1_n: makeWall('w1_n', 'level_1', [0, 0], [8, 0], 2.7),
      w1_e: makeWall('w1_e', 'level_1', [8, 0], [8, 6], 2.7),
      w1_s: makeWall('w1_s', 'level_1', [8, 6], [0, 6], 2.7),
      w1_w: makeWall('w1_w', 'level_1', [0, 6], [0, 0], 2.7),
      r_kit0: makeRoom('r_kit0', 'level_0', 'Kitchen', [[0, 0], [4, 0], [4, 6], [0, 6]], 'kitchen'),
      r_liv0: makeRoom('r_liv0', 'level_0', 'Living Room', [[4, 0], [8, 0], [8, 6], [4, 6]], 'living'),
      // Perimeter headers with minY = 2.41 -> rawDroppedY ~ 2.29 > soffitExitY = 2.45 - 0.18 = 2.27
      hdr_n: { id: 'hdr_n', type: 'structural:beam', name: 'N Header', parentId: 'level_0', start: [0, 0], end: [8, 0], widthIn: 3.5, depthIn: 3.15, elevationY: 2.45 },
      hdr_w: { id: 'hdr_w', type: 'structural:beam', name: 'W Header', parentId: 'level_0', start: [0, 0], end: [0, 6], widthIn: 3.5, depthIn: 3.15, elevationY: 2.45 },
      hdr_s: { id: 'hdr_s', type: 'structural:beam', name: 'S Header', parentId: 'level_0', start: [0, 6], end: [8, 6], widthIn: 3.5, depthIn: 3.15, elevationY: 2.45 },
      hdr_e: { id: 'hdr_e', type: 'structural:beam', name: 'E Header', parentId: 'level_0', start: [8, 0], end: [8, 6], widthIn: 3.5, depthIn: 3.15, elevationY: 2.45 },
    }
    const lowPlan = planHvacAutoPopulate(lowSoffitTwoStory, {
      levelId: 'level_0',
      climateZone: '4A',
      includeExhaustFans: true,
    })
    const hoodRuns = lowPlan.ductRuns.filter((d) => d.system === 'exhaust-duct')
    expect(hoodRuns.length).toBeGreaterThanOrEqual(1)
    for (const run of hoodRuns) {
      const exitPt = run.path[run.path.length - 1]!
      expect(exitPt[1]).toBeLessThanOrEqual(2.27)
    }
  })

  test('BUG-EH-10: extractHvacObstacles aligns water-heater-tankless & expansion-tank with kernel getPlumbingEquipmentPrism', () => {
    const scene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7, level: 0, visible: true },
      tankless_1: {
        id: 'tankless_1',
        type: 'plumbing:equipment',
        equipmentKind: 'water-heater-tankless-gas',
        name: 'Tankless Gas Water Heater',
        parentId: 'level_0',
        position: [4.0, 0, 2.0],
        rotation: Math.PI / 6,
      },
      exp_1: {
        id: 'exp_1',
        type: 'plumbing:equipment',
        equipmentKind: 'expansion-tank',
        name: 'Thermal Expansion Tank',
        parentId: 'level_0',
        position: [2.0, 1.5, 2.0],
      },
    }

    const hvacObstacles = extractHvacObstacles(scene, 'level_0')
    const anatomy = compileBuildingAnatomy(scene as Readonly<Record<string, KernelSceneNodeLike>>)
    const grid = anatomy.createOccupancyGrid('level_0', { forTrade: 'hvac' })

    for (const nodeId of ['tankless_1', 'exp_1'] as const) {
      const kernelPrism = getPlumbingEquipmentPrism(scene[nodeId] as KernelSceneNodeLike)!
      const hvacObs = hvacObstacles.find((o) => o.nodeId === nodeId)!
      const gridObs = grid.obstacles.find((o) => o.nodeId === nodeId)!

      expect(hvacObs).toBeDefined()
      expect(gridObs).toBeDefined()
      expect(hvacObs.box.minX).toBeCloseTo(kernelPrism.aabb.minX, 5)
      expect(hvacObs.box.maxX).toBeCloseTo(kernelPrism.aabb.maxX, 5)
      expect(hvacObs.box.minY).toBeCloseTo(kernelPrism.aabb.minY, 5)
      expect(hvacObs.box.maxY).toBeCloseTo(kernelPrism.aabb.maxY, 5)
      expect(hvacObs.box.minZ).toBeCloseTo(kernelPrism.aabb.minZ, 5)
      expect(hvacObs.box.maxZ).toBeCloseTo(kernelPrism.aabb.maxZ, 5)
      expect(hvacObs.prism).toBeDefined()
    }

    // Low floor-level duct (y = 0.30) under wall-hung tankless WH (minY = 0.90) has 0 clashes
    expect(detectHvacClashes([[3.0, 0.3, 2.0], [5.0, 0.3, 2.0]], hvacObstacles, 0.08)).toHaveLength(0)
    // Mid-height duct (y = 1.40) through wall-hung tankless WH body (0.90..1.95) clashes consistently
    expect(detectHvacClashes([[3.0, 1.4, 2.0], [5.0, 1.4, 2.0]], hvacObstacles, 0.08)).toHaveLength(1)
  })

  test('BUG-EH-11: scripts/build-dist.ts marks @kruschdev/pascal-mep-kernel external', () => {
    const buildScript = fs.readFileSync(path.join(repoRoot, 'scripts', 'build-dist.ts'), 'utf8')
    expect(buildScript).toContain("'@kruschdev/pascal-mep-kernel'")
    expect(buildScript).toContain("'@kruschdev/pascal-mep-kernel/*'")
  })

  test('CON-EH-05: IMC_CONDENSATE_SLOPE_RULE uses placementSlopeMarginInPerFt (0.005) for placement-vs-audit soundness', () => {
    expect(IMC_CONDENSATE_SLOPE_RULE.placementMarginM).toBeUndefined()
    expect(IMC_CONDENSATE_SLOPE_RULE.params.placementSlopeMarginInPerFt).toBe(0.005)
    expect(IMC_RULE_THRESHOLDS.condensateMinSlopeAuditInPerFt).toBe(0.12)
    expect(IMC_RULE_THRESHOLDS.condensateMinSlopePlacementInPerFt).toBe(0.125)
    expect(validateRuleTable(IMC_DECLARATIVE_RULES).valid).toBe(true)

    const cushionCandidate = {
      id: 'cond_cushion',
      kind: 'condensate-drain',
      system: 'condensate-drain',
      pos: [1, 0.5, 1] as const,
      slopeInPerFt: 0.122,
    }
    // 0.122 < 0.125 -> illegal in placement mode, legal in audit mode (0.122 >= 0.12)
    expect(evaluatePlacementCandidate([IMC_CONDENSATE_SLOPE_RULE], cushionCandidate, 'placement').legal).toBe(false)
    expect(evaluatePlacementCandidate([IMC_CONDENSATE_SLOPE_RULE], cushionCandidate, 'audit').legal).toBe(true)

    // 0.125 >= 0.125 -> legal in both modes
    const okCandidate = { ...cushionCandidate, id: 'cond_exact', slopeInPerFt: 0.125 }
    expect(evaluatePlacementCandidate([IMC_CONDENSATE_SLOPE_RULE], okCandidate, 'placement').legal).toBe(true)
    expect(evaluatePlacementCandidate([IMC_CONDENSATE_SLOPE_RULE], okCandidate, 'audit').legal).toBe(true)
  })
})
