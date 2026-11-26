/**
 * Lazy per-build PBR material pool for clean-room MIT 3D HVAC CAD models (`src/cad/materials.ts`).
 * Instantiates each `MeshStandardMaterial` only on first access.
 * Editor-free and React-free: zero React or `@pascal-app/*` imports.
 */

import { MeshStandardMaterial } from 'three'
import { type DuctMaterial, HVAC_SYSTEM_COLORS, type HvacDuctSystem } from '../imc/tables'

const MATERIAL_SPECS = {
  galvanizedSheet: { color: 0xb8c4d0, roughness: 0.36, metalness: 0.78 },
  flexSilver: { color: 0xd1d5db, roughness: 0.45, metalness: 0.52 },
  ductboardYellow: { color: 0xeab308, roughness: 0.78, metalness: 0.05 },
  supplyBlue: { color: 0x0284c7, roughness: 0.42, metalness: 0.25 },
  supplyBranchCyan: { color: 0x38bdf8, roughness: 0.45, metalness: 0.2 },
  returnViolet: { color: 0x7c3aed, roughness: 0.44, metalness: 0.22 },
  freshGreen: { color: 0x10b981, roughness: 0.44, metalness: 0.2 },
  exhaustAmber: { color: 0xf59e0b, roughness: 0.44, metalness: 0.2 },
  copperInsulated: { color: 0x1e293b, roughness: 0.82, metalness: 0.08 },
  copperBare: { color: 0xc87544, roughness: 0.28, metalness: 0.88 },
  condensateWhite: { color: 0xf1f5f9, roughness: 0.42, metalness: 0.04 },
  cabinetSlate: { color: 0x475569, roughness: 0.42, metalness: 0.48 },
  cabinetLight: { color: 0xe2e8f0, roughness: 0.32, metalness: 0.18 },
  enamelWhite: { color: 0xf8fafc, roughness: 0.22, metalness: 0.08 },
  fanBlack: { color: 0x0f172a, roughness: 0.55, metalness: 0.35 },
  coilAluminum: { color: 0x94a3b8, roughness: 0.3, metalness: 0.85 },
  filterBlue: { color: 0x60a5fa, roughness: 0.85, metalness: 0.02 },
  dangerRed: { color: 0xef4444, roughness: 0.4, metalness: 0.1 },
  woodJoist: { color: 0xd4a373, roughness: 0.78, metalness: 0.02 },
  concretePad: { color: 0x9ca3af, roughness: 0.9, metalness: 0.0 },
  brass: { color: 0xd4a024, roughness: 0.3, metalness: 0.85 },
} as const

type MaterialKey = keyof typeof MATERIAL_SPECS

export type HvacMaterialPool = {
  [K in MaterialKey]: MeshStandardMaterial
} & { dispose: () => void }

export function createHvacMaterialPool(): HvacMaterialPool {
  const cache = new Map<MaterialKey, MeshStandardMaterial>()
  const get = (key: MaterialKey): MeshStandardMaterial => {
    let m = cache.get(key)
    if (!m) {
      m = new MeshStandardMaterial(MATERIAL_SPECS[key])
      cache.set(key, m)
    }
    return m
  }

  const pool = {
    dispose: () => {
      for (const m of cache.values()) m.dispose()
      cache.clear()
    },
  } as HvacMaterialPool

  for (const key of Object.keys(MATERIAL_SPECS) as MaterialKey[]) {
    Object.defineProperty(pool, key, {
      enumerable: true,
      get: () => get(key),
    })
  }
  return pool
}

export function ductMaterialForSystem(
  pool: HvacMaterialPool,
  system: HvacDuctSystem,
  material: DuctMaterial,
): MeshStandardMaterial {
  switch (system) {
    case 'supply-trunk':
      return pool.supplyBlue
    case 'supply-branch':
      return material === 'flex-r8' || material === 'flex-r6' ? pool.supplyBranchCyan : pool.galvanizedSheet
    case 'return-trunk':
    case 'return-branch':
      return pool.returnViolet
    case 'fresh-air-erv':
      return pool.freshGreen
    case 'exhaust-duct':
      return pool.exhaustAmber
    case 'refrigerant-lineset':
      return pool.copperInsulated
    case 'condensate-drain':
      return pool.condensateWhite
  }
}

export function hvacSystemColorMeta(system: HvacDuctSystem) {
  return HVAC_SYSTEM_COLORS[system]
}
