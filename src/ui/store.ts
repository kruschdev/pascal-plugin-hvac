'use client'

/**
 * Isolated Zustand UI state store for `krusch:hvac`.
 * Never mutates or extends Pascal's `useScene`, `useEditor`, or `useViewer` stores.
 */

import { create } from 'zustand'
import type { HvacCutawayViewMode } from '../cad/plenum-cutaway'
import type {
  ClimateZone,
  CodeEdition,
  DuctPlenumLocation,
  HvacDuctSystem,
  HvacSystemType,
  OccupancyType,
} from '../imc/tables'

export type HvacScheduleTab =
  | 'manual-j'
  | 'loads'
  | 'audit'
  | 'framing'
  | 'bom'
  | 'cutaway'

type HvacUiState = {
  codeEdition: CodeEdition
  occupancy: OccupancyType
  climateZone: ClimateZone
  systemType: HvacSystemType
  plenumLocation: DuctPlenumLocation
  includeErv: boolean
  includeExhaustFans: boolean
  activeTab: HvacScheduleTab
  cutawayViewMode: HvacCutawayViewMode
  selectedEquipmentId: string | null
  hiddenSystems: Readonly<Record<HvacDuctSystem, boolean>>
  setCodeEdition: (v: CodeEdition) => void
  setOccupancy: (v: OccupancyType) => void
  setClimateZone: (v: ClimateZone) => void
  setSystemType: (v: HvacSystemType) => void
  setPlenumLocation: (v: DuctPlenumLocation) => void
  setIncludeErv: (v: boolean) => void
  setIncludeExhaustFans: (v: boolean) => void
  setActiveTab: (v: HvacScheduleTab) => void
  setCutawayViewMode: (v: HvacCutawayViewMode) => void
  setSelectedEquipmentId: (id: string | null) => void
  toggleSystemVisibility: (sys: HvacDuctSystem) => void
}

export const useHvacUi = create<HvacUiState>((set) => ({
  codeEdition: 'IMC-2021',
  occupancy: 'residential',
  climateZone: '4A',
  systemType: 'split-heat-pump',
  plenumLocation: 'attic',
  includeErv: true,
  includeExhaustFans: true,
  activeTab: 'manual-j',
  cutawayViewMode: 'joist-bay-cutaway',
  selectedEquipmentId: null,
  hiddenSystems: {
    'supply-trunk': false,
    'supply-branch': false,
    'return-trunk': false,
    'return-branch': false,
    'fresh-air-erv': false,
    'exhaust-duct': false,
    'refrigerant-lineset': false,
    'condensate-drain': false,
  },
  setCodeEdition: (codeEdition) => set({ codeEdition }),
  setOccupancy: (occupancy) => set({ occupancy }),
  setClimateZone: (climateZone) => set({ climateZone }),
  setSystemType: (systemType) => set({ systemType }),
  setPlenumLocation: (plenumLocation) => set({ plenumLocation }),
  setIncludeErv: (includeErv) => set({ includeErv }),
  setIncludeExhaustFans: (includeExhaustFans) => set({ includeExhaustFans }),
  setActiveTab: (activeTab) => set({ activeTab }),
  setCutawayViewMode: (cutawayViewMode) => set({ cutawayViewMode }),
  setSelectedEquipmentId: (selectedEquipmentId) => set({ selectedEquipmentId }),
  toggleSystemVisibility: (sys) =>
    set((s) => ({
      hiddenSystems: { ...s.hiddenSystems, [sys]: !s.hiddenSystems[sys] },
    })),
}))
