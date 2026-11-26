import { describe, expect, test } from 'bun:test'
import {
  type HvacSystemType,
  type SceneNodeLike,
  auditSceneHvac,
  buildHvacBom,
  buildHvacSchedule,
  formatHvacBomCsv,
  formatHvacScheduleCsv,
  planHvacAutoPopulate,
} from '../imc'

function makeHouseScene(): Record<string, SceneNodeLike> {
  return {
    level_0: { id: 'level_0', type: 'level', height: 2.7 },
    w1: { id: 'w1', type: 'wall', parentId: 'level_0', start: [0, 0], end: [12, 0], height: 2.7, thickness: 0.16 },
    w2: { id: 'w2', type: 'wall', parentId: 'level_0', start: [12, 0], end: [12, 9], height: 2.7, thickness: 0.16 },
    w3: { id: 'w3', type: 'wall', parentId: 'level_0', start: [12, 9], end: [0, 9], height: 2.7, thickness: 0.16 },
    w4: { id: 'w4', type: 'wall', parentId: 'level_0', start: [0, 9], end: [0, 0], height: 2.7, thickness: 0.16 },
    r_liv: { id: 'r_liv', type: 'zone', name: 'Living Room', parentId: 'level_0', polygon: [[0, 0], [6, 0], [6, 5], [0, 5]] },
    r_kit: { id: 'r_kit', type: 'zone', name: 'Kitchen', parentId: 'level_0', polygon: [[6, 0], [12, 0], [12, 4], [6, 4]] },
    r_bed1: { id: 'r_bed1', type: 'zone', name: 'Primary Bedroom', parentId: 'level_0', polygon: [[0, 5], [5, 5], [5, 9], [0, 9]] },
    r_bath: { id: 'r_bath', type: 'zone', name: 'Bathroom', parentId: 'level_0', polygon: [[5, 5], [8, 5], [8, 9], [5, 9]] },
    r_util: { id: 'r_util', type: 'zone', name: 'Utility', parentId: 'level_0', polygon: [[8, 4], [12, 4], [12, 9], [8, 9]] },
  }
}

function materializePlan(base: Record<string, SceneNodeLike>, plan: ReturnType<typeof planHvacAutoPopulate>): Record<string, SceneNodeLike> {
  const out: Record<string, SceneNodeLike> = { ...base }
  const lvl = plan.levelId ?? 'level_0'
  for (const eq of plan.equipment) out[eq.id] = { ...eq, type: 'hvac:equipment', parentId: lvl }
  for (const pl of plan.plenums) out[pl.id] = { ...pl, type: 'hvac:plenum', parentId: lvl }
  for (const t of plan.terminals) out[t.id] = { ...t, type: 'hvac:terminal', parentId: lvl }
  for (const d of plan.ductRuns) out[d.id] = { ...d, type: 'hvac:duct-run', parentId: lvl }
  return out
}

describe('One-Click HVAC Auto-Populate, IMC/IECC Audit & Priced BOM', () => {
  const systems: HvacSystemType[] = ['split-heat-pump', 'split-gas-furnace', 'mini-split-multizone', 'rooftop-package']

  for (const systemType of systems) {
    test(`Auto-populate (${systemType}) generates complete code-compliant layout with 0 audit errors`, () => {
      const base = makeHouseScene()
      const plan = planHvacAutoPopulate(base, {
        levelId: 'level_0',
        climateZone: '4A',
        systemType,
        plenumLocation: 'attic',
        includeErv: true,
        includeExhaustFans: true,
      })

      expect(plan.equipment.length).toBeGreaterThanOrEqual(1)
      expect(plan.terminals.length).toBeGreaterThanOrEqual(2)
      expect(plan.ductRuns.length).toBeGreaterThanOrEqual(1)

      const scene = materializePlan(base, plan)
      const audit = auditSceneHvac(scene, { climateZone: '4A', codeEdition: 'IMC-2021' })
      expect(audit.errorCount).toBe(0)

      if (systemType === 'split-gas-furnace') {
        const sched = buildHvacSchedule(scene, { climateZone: '4A', systemType })
        expect(sched.totalFurnaceGasBtuh).toBeGreaterThan(0)
        // Info notice reminding Plumbing to add fuel-gas line if none present yet
        expect(audit.findings.some((f) => f.codeRef.includes('IFGC'))).toBe(true)
      }
    })
  }

  test('Audit flags IECC R-8 attic violation, IMC 307.2 missing pan, NEC 440.14 disconnect, velocity cap, and per-level missing return', () => {
    const badScene: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      level_1: { id: 'level_1', type: 'level', height: 2.7 },
      ahu_bad: {
        id: 'ahu_bad',
        type: 'hvac:equipment',
        parentId: 'level_0',
        equipmentKind: 'air-handler',
        hasSecondaryDrainPan: false,
        hasFloatSwitch: false,
      },
      cond_bad: {
        id: 'cond_bad',
        type: 'hvac:equipment',
        parentId: 'level_0',
        equipmentKind: 'heat-pump-condenser',
        hasDisconnectWithinSight: false,
      },
      attic_low_r: {
        id: 'attic_low_r',
        type: 'hvac:duct-run',
        parentId: 'level_0',
        system: 'supply-branch',
        shape: 'round',
        material: 'flex-r6',
        diameter: 4, // 250 CFM in 4" -> high velocity warning
        airflowCfm: 250,
        insulationR: 4, // < R-8 IECC attic minimum!
        path: [
          [1, 3.0, 1],
          [5, 3.0, 1],
        ],
      },
      // Level 1 has a return grille, Level 0 does NOT -> per-level return invariant MUST still flag Level 0!
      ret_lvl1: {
        id: 'ret_lvl1',
        type: 'hvac:terminal',
        parentId: 'level_1',
        terminalKind: 'return-grille',
        position: [2, 2.2, 2],
      },
    }

    const audit = auditSceneHvac(badScene, { climateZone: '4A', codeEdition: 'IMC-2021' })
    expect(audit.findings.some((f) => f.codeRef === 'IMC 307.2.3')).toBe(true)
    expect(audit.findings.some((f) => f.codeRef === 'IMC 307.2.3(3)')).toBe(true)
    expect(audit.findings.some((f) => f.codeRef === 'NEC 440.14')).toBe(true)
    expect(audit.findings.some((f) => f.codeRef === 'IECC R403.3.1')).toBe(true)
    expect(audit.findings.some((f) => f.codeRef === 'IMC 601 / Manual D')).toBe(true)
    expect(audit.findings.some((f) => f.title.includes('velocity'))).toBe(true)
  })

  test('Priced BOM computes Material Subtotal, Markup, Tax, Labor, optional IECC Insulation, and clean CSV export', () => {
    const base = makeHouseScene()
    const plan = planHvacAutoPopulate(base, { levelId: 'level_0', climateZone: '5A', systemType: 'split-heat-pump' })
    const scene = materializePlan(base, plan)

    const sched = buildHvacSchedule(scene, { climateZone: '5A' })
    const bomWithoutIns = buildHvacBom(scene, {
      climateZone: '5A',
      laborRateUsd: 120,
      materialMarkupPct: 15,
      salesTaxPct: 8,
      includeInsulation: false,
      schedule: sched,
    })
    const bomWithIns = buildHvacBom(scene, {
      climateZone: '5A',
      laborRateUsd: 120,
      materialMarkupPct: 15,
      salesTaxPct: 8,
      includeInsulation: true,
      schedule: sched,
    })

    expect(bomWithoutIns.markupUsd).toBeGreaterThan(0)
    expect(bomWithoutIns.taxUsd).toBeGreaterThan(0)
    expect(bomWithoutIns.grandTotalUsd).toBeCloseTo(
      bomWithoutIns.subtotalMaterialUsd + bomWithoutIns.markupUsd + bomWithoutIns.taxUsd + bomWithoutIns.subtotalLaborUsd,
      1,
    )
    expect(bomWithIns.grandTotalUsd).toBeGreaterThan(bomWithoutIns.grandTotalUsd)
    expect(bomWithIns.lines.some((l) => l.category === 'IECC Insulation')).toBe(true)

    const bomCsv = formatHvacBomCsv(bomWithIns)
    expect(bomCsv).toContain('Material Subtotal')
    expect(bomCsv).toContain('Material Markup')
    expect(bomCsv).toContain('Sales Tax')
    expect(bomCsv).toContain('Grand Total')

    const schedCsv = formatHvacScheduleCsv(sched)
    expect(schedCsv).toContain('Living Room')
    expect(schedCsv).toContain('Design CFM')
  })
})
