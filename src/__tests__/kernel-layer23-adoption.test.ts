import { describe, expect, test } from 'bun:test'
import {
  evaluateDeclarativeRules,
  evaluatePlacementCandidate,
  segmentIntersectsOrientedPrismY,
  validateRuleTable,
} from '@kruschdev/pascal-mep-kernel'
import { auditSceneHvac } from '../imc/audit'
import { planHvacAutoPopulate } from '../imc/autopopulate'
import type { SceneNodeLike } from '../imc/framing-interop'
import {
  createHvacLegalCavityContext,
  detectHvacClashes,
  extractHvacObstacles,
  extractHvacOpeningPrisms,
  measureCondensateSlope,
  routeCondensateDrain,
  routeHvacDuctRun,
  routeHvacViaLegalCavity,
} from '../imc/routing'
import {
  IECC_ATTIC_DUCT_INSULATION_RULE,
  IMC_CONDENSATE_SLOPE_RULE,
  IMC_CONDENSER_DOOR_CLEARANCE_RULE,
  IMC_CONDENSER_SIBLING_CLEARANCE_RULE,
  IMC_CONDENSER_WINDOW_PLUMBING_CLEARANCE_RULE,
  IMC_DECLARATIVE_RULES,
  IMC_PROHIBITED_RETURN_CATEGORIES,
  IMC_PROHIBITED_RETURN_ZONES_RULE,
  IMC_RANGE_HOOD_MATERIAL_RULE,
  IMC_RULE_THRESHOLDS,
  getImcRuleById,
} from '../imc/rules'
import { INCHES_TO_METERS } from '../imc/tables'

function makeWall(
  id: string,
  levelId: string,
  start: [number, number],
  end: [number, number],
  height = 2.7,
  thickness = 0.14,
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

function materializePlanIntoScene(
  base: Readonly<Record<string, SceneNodeLike>>,
  plan: ReturnType<typeof planHvacAutoPopulate>,
  levelId: string,
): Record<string, SceneNodeLike> {
  const out: Record<string, SceneNodeLike> = { ...base }
  for (const eq of plan.equipment) {
    out[eq.id] = { ...eq, type: 'hvac:equipment', parentId: levelId, visible: true }
  }
  for (const pl of plan.plenums) {
    out[pl.id] = { ...pl, type: 'hvac:plenum', parentId: levelId, visible: true }
  }
  for (const t of plan.terminals) {
    out[t.id] = { ...t, type: 'hvac:terminal', parentId: levelId, visible: true }
  }
  for (const d of plan.ductRuns) {
    out[d.id] = { ...d, type: 'hvac:duct-run', parentId: levelId, visible: true }
  }
  return out
}

describe('Layer 3 — Single-Source Declarative IMC Rule Table (INV-MEP-08)', () => {
  test('validateRuleTable(IMC_DECLARATIVE_RULES) passes with 0 errors and all canonical rule IDs resolve', () => {
    const validation = validateRuleTable(IMC_DECLARATIVE_RULES)
    expect(validation.valid).toBe(true)
    expect(validation.errors).toEqual([])

    const expectedIds = [
      'imc-601-5-prohibited-return-zones',
      'iecc-r403-3-1-attic-duct-insulation',
      'imc-307-2-1-condensate-slope',
      'imc-505-4-range-hood-material',
      'imc-condenser-door-clearance',
      'imc-condenser-window-plumbing-clearance',
      'imc-condenser-sibling-clearance',
    ]
    for (const id of expectedIds) {
      const rule = getImcRuleById(id)
      expect(rule).toBeDefined()
      expect(rule!.trade).toBe('hvac')
    }

    // Prohibited return categories set matches single-source rule verbatim
    expect([...IMC_PROHIBITED_RETURN_CATEGORIES].sort()).toEqual([
      'attic',
      'bathroom',
      'closet',
      'exterior',
      'garage',
      'kitchen',
      'utility',
    ])

    // Derived thresholds match mathematical placementMarginM coupling
    expect(IMC_RULE_THRESHOLDS.atticThresholdOffsetM).toBe(0.05)
    expect(IMC_RULE_THRESHOLDS.atticPlacementMarginM).toBe(0.07)
    expect(IMC_RULE_THRESHOLDS.atticPlacementOffsetM).toBe(-0.02)
    expect(IMC_RULE_THRESHOLDS.condensateMinSlopeAuditInPerFt).toBe(0.12)
    expect(IMC_RULE_THRESHOLDS.condensateMinSlopePlacementInPerFt).toBe(0.125)
    expect(IMC_RULE_THRESHOLDS.rangeHoodRequiredMaterial).toBe('galvanized-sheet')
    expect(IMC_RULE_THRESHOLDS.condenserDoorClearanceM).toBe(2.4)
    expect(IMC_RULE_THRESHOLDS.condenserWindowPlumbingClearanceM).toBe(1.2)
    expect(IMC_RULE_THRESHOLDS.condenserSiblingClearanceM).toBe(1.5)
  })

  test('Placement-vs-Audit soundness parity: every placement-legal candidate is strictly audit-legal', () => {
    const levelH = 2.7
    const samples = [
      // Return grilles
      { id: 'ret_ok', kind: 'return-grille', pos: [2, 2.66, 2] as const, roomCategory: 'hallway', ceilingHeightM: levelH },
      { id: 'ret_bath', kind: 'return-grille', pos: [2, 2.66, 2] as const, roomCategory: 'bathroom', ceilingHeightM: levelH },
      { id: 'ret_kitchen', kind: 'return-grille', pos: [2, 2.66, 2] as const, roomCategory: 'kitchen', ceilingHeightM: levelH },
      { id: 'ret_attic_y', kind: 'return-grille', pos: [2, 2.9, 2] as const, roomCategory: 'hallway', ceilingHeightM: levelH },
      // Attic duct elevation band (placement margin: levelH - 0.02 = 2.68, audit: levelH + 0.05 = 2.75)
      { id: 'duct_below', kind: 'supply-trunk', pos: [2, 2.60, 2] as const, ceilingHeightM: levelH },
      { id: 'duct_cushion', kind: 'supply-trunk', pos: [2, 2.71, 2] as const, ceilingHeightM: levelH },
      { id: 'duct_attic', kind: 'supply-trunk', pos: [2, 2.95, 2] as const, ceilingHeightM: levelH },
      // Condensate slope
      { id: 'cond_ok', kind: 'condensate-drain', system: 'condensate-drain', pos: [1, 0.5, 1] as const, slopeInPerFt: 0.125 },
      { id: 'cond_flat', kind: 'condensate-drain', system: 'condensate-drain', pos: [1, 0.5, 1] as const, slopeInPerFt: 0.08 },
      // Range hood material
      { id: 'hood_galv', kind: 'range-hood-exhaust', system: 'range-hood-exhaust', pos: [1, 2.4, 1] as const, material: 'galvanized-sheet' },
      { id: 'hood_flex', kind: 'range-hood-exhaust', system: 'range-hood-exhaust', pos: [1, 2.4, 1] as const, material: 'flex-r8' },
      { id: 'hood_db', kind: 'range-hood-exhaust', system: 'range-hood-exhaust', pos: [1, 2.4, 1] as const, material: 'ductboard' },
      // Outdoor condenser clearances
      {
        id: 'condenser_ok',
        kind: 'outdoor-condenser',
        role: 'outdoor-condenser',
        pos: [-1, 0, 4] as const,
        nearFixtures: [
          { kind: 'door', horizontalDistM: 2.6 },
          { kind: 'window', horizontalDistM: 1.4 },
          { kind: 'sibling-condenser', horizontalDistM: 1.8 },
        ],
      },
      {
        id: 'condenser_bad_door',
        kind: 'outdoor-condenser',
        role: 'outdoor-condenser',
        pos: [-1, 0, 4] as const,
        nearFixtures: [{ kind: 'door', horizontalDistM: 1.5 }],
      },
    ]

    for (const c of samples) {
      const placeEval = evaluatePlacementCandidate(IMC_DECLARATIVE_RULES, c, 'placement')
      const auditEval = evaluatePlacementCandidate(IMC_DECLARATIVE_RULES, c, 'audit')
      if (placeEval.legal) {
        expect(auditEval.legal).toBe(true)
      }
    }

    // Cushion band check: y = 2.71 triggers placement attic insulation (> 2.68) while still <= audit 2.75
    const cushionPlace = evaluatePlacementCandidate([IECC_ATTIC_DUCT_INSULATION_RULE], samples[5]!, 'placement')
    const cushionAudit = evaluatePlacementCandidate([IECC_ATTIC_DUCT_INSULATION_RULE], samples[5]!, 'audit')
    expect(cushionPlace.legal).toBe(false)
    expect(cushionAudit.legal).toBe(true)

    // Audit summary confirms exact rule violations on known bad candidates
    const summary = evaluateDeclarativeRules(
      [
        IMC_PROHIBITED_RETURN_ZONES_RULE,
        IMC_CONDENSATE_SLOPE_RULE,
        IMC_RANGE_HOOD_MATERIAL_RULE,
        IMC_CONDENSER_DOOR_CLEARANCE_RULE,
        IMC_CONDENSER_WINDOW_PLUMBING_CLEARANCE_RULE,
        IMC_CONDENSER_SIBLING_CLEARANCE_RULE,
      ],
      [samples[1]!, samples[8]!, samples[10]!, samples[13]!],
      { trade: 'hvac', tool: 'hvac_audit_declarative' },
    )
    expect(summary.ok).toBe(false)
    expect(summary.data.violationCount).toBe(4)
  })
})

describe('Layer 2 — Legal-Space-First Cavity Router (`routeHvacViaLegalCavity`)', () => {
  test('Routes HVAC ducts orthogonally around a structural beam obstacle with 0 clashes', () => {
    const levelId = 'lvl_beam'
    const scene: Record<string, SceneNodeLike> = {
      [levelId]: { id: levelId, type: 'level', name: 'Level 1', height: 2.7, level: 0, visible: true },
      w_n: makeWall('w_n', levelId, [0, 0], [10, 0]),
      w_e: makeWall('w_e', levelId, [10, 0], [10, 8]),
      w_s: makeWall('w_s', levelId, [10, 8], [0, 8]),
      w_w: makeWall('w_w', levelId, [0, 8], [0, 0]),
      r_main: makeRoom('r_main', levelId, 'Living Room', [[0, 0], [10, 0], [10, 8], [0, 8]], 'living'),
      // Structural steel girder bisecting the middle of the overhead soffit at x = 5, z in [1.5, 6.5]
      beam_mid: {
        id: 'beam_mid',
        type: 'structural:beam',
        name: 'Central W10x22 Girder',
        parentId: levelId,
        start: [5, 1.5],
        end: [5, 6.5],
        widthIn: 8,
        depthIn: 14,
        elevationY: 2.25,
        visible: true,
      },
    }

    const cavityContext = createHvacLegalCavityContext(scene, levelId)
    const cavityRes = routeHvacViaLegalCavity({
      cavityContext,
      from: [1.5, 2.45, 4.0],
      to: [8.5, 2.45, 4.0],
      mode: 'orthogonal',
      ductHalfSpanM: 0.08,
      plenumLocation: 'conditioned-soffit',
      flatSoffitMarginM: 0.25,
    })

    expect(cavityRes.ok).toBe(true)
    expect(cavityRes.clashObstacleIds).toEqual([])
    expect(cavityRes.openingHits).toBe(0)
    expect(cavityRes.path.length).toBeGreaterThanOrEqual(3)

    // Integrated routeHvacDuctRun with cavityContext also achieves 0 clashes
    const obstacles = extractHvacObstacles(scene, levelId)
    const integrated = routeHvacDuctRun({
      from: [1.5, 2.45, 4.0],
      to: [8.5, 2.45, 4.0],
      plenumY: 2.45,
      maxPlenumY: 2.55,
      ductHalfSpanM: 0.08,
      obstacles,
      cavityContext,
      plenumLocation: 'conditioned-soffit',
    })
    expect(integrated.clashes).toEqual([])
    expect(integrated.detoured).toBe(true)
  })

  test('Routes HVAC ducts strictly inside an L-shaped courtyard building without bridging outdoor notch', () => {
    const levelId = 'lvl_lshape'
    // L-shaped footprint: West wing [0..6, 0..10], South wing [6..12, 6..10];
    // Open outdoor courtyard notch at [6..12, 0..6]!
    const scene: Record<string, SceneNodeLike> = {
      [levelId]: { id: levelId, type: 'level', name: 'Level 1', height: 2.7, level: 0, visible: true },
      w1: makeWall('w1', levelId, [0, 0], [6, 0]),
      w2: makeWall('w2', levelId, [6, 0], [6, 6]),
      w3: makeWall('w3', levelId, [6, 6], [12, 6]),
      w4: makeWall('w4', levelId, [12, 6], [12, 10]),
      w5: makeWall('w5', levelId, [12, 10], [0, 10]),
      w6: makeWall('w6', levelId, [0, 10], [0, 0]),
      r_west: makeRoom('r_west', levelId, 'Living Room', [[0, 0], [6, 0], [6, 10], [0, 10]], 'living'),
      r_east: makeRoom('r_east', levelId, 'Primary Bedroom', [[6, 6], [12, 6], [12, 10], [6, 10]], 'bedroom'),
      r_court: makeRoom('r_court', levelId, 'Courtyard Patio', [[6, 0], [12, 0], [12, 6], [6, 6]], 'exterior'),
    }

    const cavityContext = createHvacLegalCavityContext(scene, levelId)
    const cavityRes = routeHvacViaLegalCavity({
      cavityContext,
      from: [2.0, 2.5, 2.0],
      to: [10.0, 2.5, 8.0],
      mode: 'orthogonal',
      ductHalfSpanM: 0.08,
      plenumLocation: 'conditioned-soffit',
      flatSoffitMarginM: 0.2,
    })

    expect(cavityRes.ok).toBe(true)
    expect(cavityRes.outdoorVoidViolation).toBe(false)
    expect(cavityRes.clashObstacleIds).toEqual([])
    // Verify no waypoint lands deep in the outdoor courtyard [6.3..12, 0..5.7]
    for (const pt of cavityRes.path) {
      const insideCourtyard = pt[0] > 6.3 && pt[2] < 5.7
      expect(insideCourtyard).toBe(false)
    }
  })

  test('Routes gravity-slope condensate drain cleanly around obstacles and honors TradeOccupancyGrid reservations', () => {
    const levelId = 'lvl_cond'
    const scene: Record<string, SceneNodeLike> = {
      [levelId]: { id: levelId, type: 'level', name: 'Level 1', height: 2.7, level: 0, visible: true },
      w_n: makeWall('w_n', levelId, [0, 0], [8, 0]),
      w_e: makeWall('w_e', levelId, [8, 0], [8, 6]),
      w_s: makeWall('w_s', levelId, [8, 6], [0, 6]),
      w_w: makeWall('w_w', levelId, [0, 6], [0, 0]),
      r_mech: makeRoom('r_mech', levelId, 'Utility Room', [[0, 0], [8, 0], [8, 6], [0, 6]], 'utility'),
      wh_1: {
        id: 'wh_1',
        type: 'plumbing:equipment',
        equipmentKind: 'water-heater-tank',
        name: '50-Gal Water Heater',
        parentId: levelId,
        position: [4.0, 0, 3.0],
        width: 0.65,
        depth: 0.65,
        height: 1.65,
        visible: true,
      },
    }

    const cavityContext = createHvacLegalCavityContext(scene, levelId)
    const condRes = routeCondensateDrain({
      from: [1.5, 1.0, 3.0],
      to: [7.8, 0.05, 3.0],
      obstacles: extractHvacObstacles(scene, levelId),
      cavityContext,
      reserveOnCommit: true,
      runId: 'cond_run_1',
    })

    expect(condRes.clashes).toEqual([])
    const slope = measureCondensateSlope(condRes.path)
    expect(slope.hasUphillSegment).toBe(false)
    expect(slope.overallSlopeInPerFt).toBeGreaterThanOrEqual(IMC_RULE_THRESHOLDS.condensateMinSlopePlacementInPerFt)

    // Verify TradeOccupancyGrid recorded the reserved condensate run
    expect(cavityContext.occupancy.obstacles.some((o) => o.nodeId === 'cond_run_1')).toBe(true)

    // Direct gravity-slope cavity helper also produces zero uphill segments
    const directGrav = routeHvacViaLegalCavity({
      cavityContext,
      from: [1.5, 1.1, 1.2],
      to: [6.5, 0.1, 1.2],
      mode: 'gravity-slope',
      minSlopeInPerFt: 0.25,
    })
    expect(directGrav.clashObstacleIds).toEqual([])
    const directSlope = measureCondensateSlope(directGrav.path)
    expect(directSlope.hasUphillSegment).toBe(false)
    expect(directSlope.overallSlopeInPerFt).toBeGreaterThanOrEqual(0.125)
  })
})

describe('CRITICAL REGRESSION — Aymeric House 1st-Floor Kitchen Range Hood Under 2nd Story Avoiding 14" LVL Window Header', () => {
  test('Case A: 1st-floor Kitchen Range Hood (no attic above) avoids wide window + 14" LVL header (y in [2.30, 2.66]) with 0 structural clashes & 0 opening hits', () => {
    // Two-story Aymeric House topology: Level 1 (ground, height 2.7m) beneath Level 2 (upper story)
    // so `hasRoofAbove === false` on Level 1 and exhaust runs are capped inside the 1st-floor ceiling soffit.
    const scene: Record<string, SceneNodeLike> = {
      bldg_1: { id: 'bldg_1', type: 'building', name: 'Aymeric House', parentId: null, visible: true },
      lvl_1: { id: 'lvl_1', type: 'level', name: 'Ground Floor', parentId: 'bldg_1', level: 0, height: 2.7, visible: true },
      lvl_2: { id: 'lvl_2', type: 'level', name: 'Second Floor', parentId: 'bldg_1', level: 1, height: 2.7, visible: true },

      // Level 1 perimeter walls
      w1_n: makeWall('w1_n', 'lvl_1', [0, 0], [10, 0], 2.7, 0.2),
      w1_e: makeWall('w1_e', 'lvl_1', [10, 0], [10, 8], 2.7, 0.2),
      w1_s: makeWall('w1_s', 'lvl_1', [10, 8], [0, 8], 2.7, 0.2),
      w1_w: makeWall('w1_w', 'lvl_1', [0, 8], [0, 0], 2.7, 0.2),

      // Level 1 rooms: Kitchen in NW corner [0..4.5, 0..3.8], Living Room + Hallway + Bath
      r1_kit: makeRoom('r1_kit', 'lvl_1', 'Kitchen', [[0, 0], [4.5, 0], [4.5, 3.8], [0, 3.8]], 'kitchen'),
      r1_liv: makeRoom('r1_liv', 'lvl_1', 'Living Room', [[4.5, 0], [10, 0], [10, 8], [4.5, 8]], 'living'),
      r1_hall: makeRoom('r1_hall', 'lvl_1', 'Hallway', [[0, 3.8], [4.5, 3.8], [4.5, 5.6], [0, 5.6]], 'hallway'),
      r1_bath: makeRoom('r1_bath', 'lvl_1', 'Powder Bath', [[0, 5.6], [4.5, 5.6], [4.5, 8], [0, 8]], 'bathroom'),

      // Wide Kitchen Window on North wall directly opposite kitchen centroid (x = 2.25)
      win_kit_n: {
        id: 'win_kit_n',
        type: 'window',
        name: 'Kitchen North Window',
        parentId: 'w1_n',
        position: [2.25, 1.55, 0],
        width: 1.8,
        height: 1.3,
        visible: true,
      },
      // 14" LVL Structural Window Header Beam (y in [2.30, 2.66], centerline 2.48m) directly over Kitchen North Window!
      // Exact elevation band where 1st-floor soffit exhaust (y ~ 2.54) previously collided!
      lvl_hdr_kit_n: {
        id: 'lvl_hdr_kit_n',
        type: 'structural:beam',
        name: '3-Ply 14" LVL Window Header (Kitchen N)',
        parentId: 'lvl_1',
        start: [1.15, 0],
        end: [3.35, 0],
        widthIn: 5.25,
        depthIn: 14,
        elevationY: 2.48,
        visible: true,
      },

      // Level 2 walls above Level 1 so `hasRoofAbove === false` on Level 1
      w2_n: makeWall('w2_n', 'lvl_2', [0, 0], [10, 0], 2.7, 0.2),
      w2_e: makeWall('w2_e', 'lvl_2', [10, 0], [10, 8], 2.7, 0.2),
      w2_s: makeWall('w2_s', 'lvl_2', [10, 8], [0, 8], 2.7, 0.2),
      w2_w: makeWall('w2_w', 'lvl_2', [0, 8], [0, 0], 2.7, 0.2),
      r2_bed: makeRoom('r2_bed', 'lvl_2', 'Master Bedroom', [[0, 0], [10, 0], [10, 8], [0, 8]], 'bedroom'),
    }

    const plan = planHvacAutoPopulate(scene, {
      levelId: 'lvl_1',
      climateZone: '4A',
      systemType: 'split-heat-pump',
      plenumLocation: 'attic',
      includeExhaustFans: true,
      includeErv: true,
    })

    const hoodDuct = plan.ductRuns.find(
      (d) => d.system === 'exhaust-duct' && /range\s*hood|kitchen/i.test(d.name),
    )
    expect(hoodDuct).toBeDefined()
    expect(hoodDuct!.material).toBe('galvanized-sheet')

    // Strictly below 2nd-story floor slab (no roof above on 1st floor)
    for (const pt of hoodDuct!.path) {
      expect(pt[1]).toBeLessThan(2.7)
    }

    // ZERO structural clashes (including 14" LVL window header!)
    const lvl1Obstacles = extractHvacObstacles(scene, 'lvl_1')
    const hoodHalfSpan = Math.max(0.02, (hoodDuct!.diameter * INCHES_TO_METERS) / 2)
    const hoodClashes = detectHvacClashes(hoodDuct!.path, lvl1Obstacles, hoodHalfSpan)
    expect(hoodClashes).toEqual([])

    // ZERO window/door opening prism penetrations
    const openingPrisms = extractHvacOpeningPrisms(scene, 'lvl_1')
    expect(openingPrisms.length).toBeGreaterThanOrEqual(1)
    for (let i = 1; i < hoodDuct!.path.length; i++) {
      for (const op of openingPrisms) {
        expect(
          segmentIntersectsOrientedPrismY(hoodDuct!.path[i - 1]!, hoodDuct!.path[i]!, op, hoodHalfSpan),
        ).toBe(false)
      }
    }

    // Full IMC/IECC/Structural/Plumbing audit passes with 0 errors
    const populated = materializePlanIntoScene(scene, plan, 'lvl_1')
    const audit = auditSceneHvac(populated, { climateZone: '4A' })
    expect(audit.errorCount).toBe(0)
  })

  test('Case B: Continuous full-wall 14" LVL headers (no lateral escape) trigger safe drop-under-header (>= 2.05m) with 0 structural clashes', () => {
    const scene: Record<string, SceneNodeLike> = {
      bldg_1: { id: 'bldg_1', type: 'building', name: 'Continuous Header House', parentId: null, visible: true },
      lvl_1: { id: 'lvl_1', type: 'level', name: 'Ground Floor', parentId: 'bldg_1', level: 0, height: 2.7, visible: true },
      lvl_2: { id: 'lvl_2', type: 'level', name: 'Second Floor', parentId: 'bldg_1', level: 1, height: 2.7, visible: true },

      w1_n: makeWall('w1_n', 'lvl_1', [0, 0], [8, 0], 2.7, 0.2),
      w1_e: makeWall('w1_e', 'lvl_1', [8, 0], [8, 6], 2.7, 0.2),
      w1_s: makeWall('w1_s', 'lvl_1', [8, 6], [0, 6], 2.7, 0.2),
      w1_w: makeWall('w1_w', 'lvl_1', [0, 6], [0, 0], 2.7, 0.2),

      r1_kit: makeRoom('r1_kit', 'lvl_1', 'Kitchen', [[0, 0], [4, 0], [4, 6], [0, 6]], 'kitchen'),
      r1_liv: makeRoom('r1_liv', 'lvl_1', 'Living Room', [[4, 0], [8, 0], [8, 6], [4, 6]], 'living'),

      // Full-perimeter continuous 14" LVL rim/header beams at y in [2.30, 2.66] (centerline 2.48m) around ALL 4 exterior walls
      hdr_n: { id: 'hdr_n', type: 'structural:beam', name: 'North 14" LVL Header', parentId: 'lvl_1', start: [0, 0], end: [8, 0], widthIn: 5.5, depthIn: 14, elevationY: 2.48, visible: true },
      hdr_s: { id: 'hdr_s', type: 'structural:beam', name: 'South 14" LVL Header', parentId: 'lvl_1', start: [0, 6], end: [8, 6], widthIn: 5.5, depthIn: 14, elevationY: 2.48, visible: true },
      hdr_w: { id: 'hdr_w', type: 'structural:beam', name: 'West 14" LVL Header', parentId: 'lvl_1', start: [0, 0], end: [0, 6], widthIn: 5.5, depthIn: 14, elevationY: 2.48, visible: true },
      hdr_e: { id: 'hdr_e', type: 'structural:beam', name: 'East 14" LVL Header', parentId: 'lvl_1', start: [8, 0], end: [8, 6], widthIn: 5.5, depthIn: 14, elevationY: 2.48, visible: true },

      // Second story above
      w2_n: makeWall('w2_n', 'lvl_2', [0, 0], [8, 0], 2.7, 0.2),
      w2_e: makeWall('w2_e', 'lvl_2', [8, 0], [8, 6], 2.7, 0.2),
      w2_s: makeWall('w2_s', 'lvl_2', [8, 6], [0, 6], 2.7, 0.2),
      w2_w: makeWall('w2_w', 'lvl_2', [0, 6], [0, 0], 2.7, 0.2),
    }

    const plan = planHvacAutoPopulate(scene, {
      levelId: 'lvl_1',
      climateZone: '4A',
      systemType: 'split-heat-pump',
      plenumLocation: 'attic',
      includeExhaustFans: true,
      includeErv: false,
    })

    const hoodDuct = plan.ductRuns.find(
      (d) => d.system === 'exhaust-duct' && /range\s*hood|kitchen/i.test(d.name),
    )
    expect(hoodDuct).toBeDefined()

    // Exit elevation must drop cleanly underneath the 2.30m LVL soffit while staying >= 2.05m
    const exitPt = hoodDuct!.path[hoodDuct!.path.length - 1]!
    expect(exitPt[1]).toBeGreaterThanOrEqual(2.05)
    expect(exitPt[1]).toBeLessThan(2.3)

    // ZERO structural clashes on range hood exhaust
    const lvl1Obstacles = extractHvacObstacles(scene, 'lvl_1')
    const hoodHalfSpan = Math.max(0.02, (hoodDuct!.diameter * INCHES_TO_METERS) / 2)
    expect(detectHvacClashes(hoodDuct!.path, lvl1Obstacles, hoodHalfSpan)).toEqual([])

    const populated = materializePlanIntoScene(scene, plan, 'lvl_1')
    const audit = auditSceneHvac(populated, { climateZone: '4A' })
    expect(audit.errorCount).toBe(0)
  })
})
