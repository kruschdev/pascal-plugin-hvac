import { describe, expect, test } from 'bun:test'
import {
  type SceneNodeLike,
  computeDuctFramingClearances,
  extractHvacFramingContext,
  extractHvacObstacles,
  extractWallSegments,
  routeCondensateDrain,
  routeHvacDuctRun,
} from '../imc'

describe('Priority #3 Obstacle-Aware Duct Routing & Structural/Bones Framing Clearances', () => {
  test('extractHvacObstacles captures Structural (#1), Plumbing (#2), and NEC 110.26(E) panels (minY = 0)', () => {
    const nodes: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      col_1: {
        id: 'col_1',
        type: 'structural:column',
        name: 'Steel Column C1',
        parentId: 'level_0',
        position: [3, 0, 0],
        widthIn: 8,
        depthIn: 8,
        heightM: 3.0,
      },
      plumb_stack: {
        id: 'plumb_stack',
        type: 'plumbing:pipe-run',
        name: '3" Main DWV Stack',
        parentId: 'level_0',
        system: 'dwv-drain',
        nominalSize: '3"',
        path: [
          [5, 0, 0],
          [5, 3.2, 0],
        ],
      },
      panel_1: {
        id: 'panel_1',
        type: 'electrical:panel',
        name: 'MDP-1',
        parentId: 'level_0',
        position: [2, 1.5, 0],
        width: 0.42,
        depth: 0.16,
        height: 0.92,
      },
    }

    const obs = extractHvacObstacles(nodes, 'level_0')
    expect(obs.some((o) => o.category === 'structural' && o.id === 'col_1')).toBe(true)
    expect(obs.some((o) => o.category === 'plumbing' && o.id.startsWith('plumb_stack'))).toBe(true)
    const panelObs = obs.find((o) => o.category === 'electrical-dedicated-space' && o.id === 'panel_1')!
    expect(panelObs).toBeDefined()
    expect(panelObs.box.minY).toBe(0)
    expect(panelObs.box.maxY).toBeGreaterThanOrEqual(3.75)

    // Route an attic supply trunk straight across all three obstacles -> detours cleanly with 0 clashes
    const routed = routeHvacDuctRun({
      from: [0, 1.8, 0],
      to: [7, 2.6, 0],
      plenumY: 2.95,
      ductHalfSpanM: 0.18,
      allowDiagonalBranch: false,
      obstacles: obs,
    })
    expect(routed.detoured).toBe(true)
    expect(routed.clashes.length).toBe(0)
    expect(routed.lengthFt).toBeGreaterThan(20)
  })

  test('routeCondensateDrain maintains continuous downward gravity slope (>= 1/8"/ft) per IMC 307.2', () => {
    const res = routeCondensateDrain({
      from: [1.0, 0.95, 1.0],
      to: [6.0, 0.05, 1.4],
    })
    expect(res.path.length).toBeGreaterThanOrEqual(2)
    expect(res.slopeInPerFt).toBeGreaterThanOrEqual(0.125)
    for (let i = 1; i < res.path.length; i++) {
      expect(res.path[i]![1]).toBeLessThanOrEqual(res.path[i - 1]![1] + 1e-4)
    }
  })

  test('extractHvacFramingContext prefers structural:assembly over bones:framing and detects wall/soffit clearances', () => {
    const nodes: Record<string, SceneNodeLike> = {
      level_0: { id: 'level_0', type: 'level', height: 2.7 },
      struct_1: {
        id: 'struct_1',
        type: 'structural:assembly',
        parentId: 'level_0',
        studSpacingIn: 16,
        floorSystem: 'dimensional',
        joistDepthIn: 9.25,
        wallOverrides: {
          w_bearing: { construction: 'framed', studSpacingIn: 16, isLoadBearing: true },
        },
      },
      bones_1: {
        id: 'bones_1',
        type: 'bones:framing',
        parentId: 'level_0',
        studSpacingIn: 24,
      },
      w_bearing: {
        id: 'w_bearing',
        type: 'wall',
        parentId: 'level_0',
        start: [4, 0],
        end: [4, 6],
        height: 2.7,
        thickness: 0.14,
      },
    }

    const ctx = extractHvacFramingContext(nodes, 'level_0')
    expect(ctx.framingPresent).toBe(true)
    expect(ctx.source).toBe('structural')
    expect(ctx.studSpacingIn).toBe(16)
    expect(ctx.wallRules.get('w_bearing')?.isLoadBearing).toBe(true)

    const walls = extractWallSegments(nodes, 'level_0')
    // 18"x8" rectangular trunk piercing load-bearing 16" OC wall -> flags header required + non-compliant without box header
    const wallClearances = computeDuctFramingClearances({
      ductRunId: 'duct_trunk_1',
      path: [
        [2, 2.2, 3],
        [6, 2.2, 3],
      ],
      shape: 'rectangular',
      widthIn: 18,
      heightIn: 8,
      diameterIn: 12,
      walls,
      framingContext: ctx,
    })
    expect(wallClearances.length).toBeGreaterThanOrEqual(1)
    expect(wallClearances[0]!.needsSoffitOrChase).toBe(true)
    expect(wallClearances[0]!.codeCompliant).toBe(false)
    expect(wallClearances[0]!.codeRef).toContain('Header Required')

    // Under-joist 16"x8" trunk below 9.25" dimensional floor joists -> flags dropped-soffit chase
    const soffitClearances = computeDuctFramingClearances({
      ductRunId: 'duct_crawl_1',
      path: [
        [1, -0.26, 2],
        [3.5, -0.26, 2],
      ],
      shape: 'rectangular',
      widthIn: 16,
      heightIn: 8,
      diameterIn: 12,
      walls,
      framingContext: ctx,
    })
    expect(soffitClearances.some((c) => c.memberKind === 'dropped-soffit')).toBe(true)
  })
})
