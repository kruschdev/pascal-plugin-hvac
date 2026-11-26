import { describe, expect, test } from 'bun:test'
import { Mesh } from 'three'
import {
  HVAC_CAD_CATALOG,
  buildDuctRunCad,
  buildWiredAirHandlerCutawayCad,
  createHvacMaterialPool,
} from '../cad'

describe('42-Part Clean-Room MIT 3D HVAC CAD Catalog', () => {
  test('Catalog contains exactly 42 unique parts and every part builds valid Three.js meshes', () => {
    expect(HVAC_CAD_CATALOG.length).toBe(42)
    const ids = new Set<string>()
    for (const part of HVAC_CAD_CATALOG) {
      expect(ids.has(part.id)).toBe(false)
      ids.add(part.id)
      const group = part.build()
      let meshCount = 0
      group.traverse((obj) => {
        if (obj instanceof Mesh) {
          meshCount += 1
          expect(obj.geometry).toBeDefined()
        }
      })
      expect(meshCount).toBeGreaterThanOrEqual(1)
    }
  })

  test('createHvacMaterialPool is lazy-initialized and caches materials per key', () => {
    const pool = createHvacMaterialPool()
    const a = pool.supplyBlue
    const b = pool.supplyBlue
    expect(a).toBe(b)
    expect(pool.galvanizedSheet).toBeDefined()
    expect(pool.returnViolet).toBeDefined()
  })

  test('buildDuctRunCad generates shared-geometry 3D duct segments and oriented wall penetration collars', () => {
    const group = buildDuctRunCad({
      id: 'duct_test_1',
      path: [
        [0, 2.8, 0],
        [4, 2.8, 0],
        [4, 2.8, 3],
      ],
      system: 'supply-trunk',
      shape: 'rectangular',
      material: 'galvanized-sheet',
      widthIn: 16,
      heightIn: 8,
      diameterIn: 12,
      clearances: [
        {
          position: [2, 2.8, 0],
          wallNormal: [1, 0],
          openingWidthIn: 17,
          openingHeightIn: 9,
          codeCompliant: true,
        },
      ],
    })
    let meshCount = 0
    group.traverse((obj) => {
      if (obj instanceof Mesh) meshCount += 1
    })
    expect(meshCount).toBeGreaterThanOrEqual(4)
  })

  test('buildWiredAirHandlerCutawayCad supports all 3 view modes', () => {
    for (const mode of ['joist-bay-cutaway', 'open-plenum', 'cabinet-closed'] as const) {
      const g = buildWiredAirHandlerCutawayCad({
        coolingTons: 3.5,
        viewMode: mode,
        branches: [
          { index: 0, label: 'Living Room', cfm: 240, diameterIn: 8, side: 'supply' },
          { index: 1, label: 'Bedroom 1', cfm: 140, diameterIn: 6, side: 'supply' },
        ],
      })
      let meshes = 0
      g.traverse((o) => {
        if (o instanceof Mesh) meshes += 1
      })
      expect(meshes).toBeGreaterThanOrEqual(8)
    }
  })
})
