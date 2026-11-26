/**
 * Auto-derived Pascal Inspector Parametrics for all 4 `hvac:*` node kinds (`src/nodes/parametrics.ts`).
 */

import type { ParametricDescriptor } from '@pascal-app/core'
import { HvacEquipmentKindEnum, type HvacEquipmentNode, RefrigerantTypeEnum } from './equipment'
import { HvacPlenumKindEnum, type HvacPlenumNode } from './plenum'
import { HvacTerminalKindEnum, type HvacTerminalNode } from './terminal'
import { DuctMaterialEnum, DuctShapeEnum, type HvacDuctRunNode, HvacDuctSystemEnum } from './duct-run'

export const hvacEquipmentParametrics: ParametricDescriptor<HvacEquipmentNode> = {
  groups: [
    {
      label: 'Capacity & Efficiency',
      fields: [
        { key: 'equipmentKind', kind: 'enum', options: [...HvacEquipmentKindEnum.options] },
        { key: 'coolingTons', kind: 'number', unit: 'tons', min: 0, max: 30, step: 0.5 },
        { key: 'heatingBtuh', kind: 'number', unit: 'BTU/h', min: 0, max: 500000, step: 6000 },
        { key: 'gasBtuh', kind: 'number', unit: 'BTU/h', min: 0, max: 500000, step: 10000 },
        { key: 'airflowCfm', kind: 'number', unit: 'CFM', min: 0, max: 15000, step: 50 },
        { key: 'refrigerant', kind: 'enum', options: [...RefrigerantTypeEnum.options] },
      ],
    },
    {
      label: 'IMC / NEC Safety',
      fields: [
        { key: 'hasSecondaryDrainPan', kind: 'boolean', label: 'Secondary Drain Pan (IMC 307.2)' },
        { key: 'hasFloatSwitch', kind: 'boolean', label: 'SS2 Condensate Float Switch' },
        { key: 'hasDisconnectWithinSight', kind: 'boolean', label: 'Disconnect Within Sight (NEC 440.14)' },
      ],
    },
  ],
}

export const hvacPlenumParametrics: ParametricDescriptor<HvacPlenumNode> = {
  groups: [
    {
      label: 'Plenum Dimensions & Airflow',
      fields: [
        { key: 'plenumKind', kind: 'enum', options: [...HvacPlenumKindEnum.options] },
        { key: 'widthIn', kind: 'number', unit: 'in', min: 6, max: 60, step: 2 },
        { key: 'heightIn', kind: 'number', unit: 'in', min: 6, max: 48, step: 2 },
        { key: 'depthIn', kind: 'number', unit: 'in', min: 6, max: 60, step: 2 },
        { key: 'airflowCfm', kind: 'number', unit: 'CFM', min: 0, max: 15000, step: 50 },
        { key: 'insulationR', kind: 'number', unit: 'R', min: 0, max: 16, step: 2 },
      ],
    },
  ],
}

export const hvacTerminalParametrics: ParametricDescriptor<HvacTerminalNode> = {
  groups: [
    {
      label: 'Terminal Sizing & Balancing',
      fields: [
        { key: 'terminalKind', kind: 'enum', options: [...HvacTerminalKindEnum.options] },
        { key: 'designCfm', kind: 'number', unit: 'CFM', min: 0, max: 5000, step: 5 },
        { key: 'neckSizeIn', kind: 'number', unit: 'in', min: 0, max: 24, step: 1 },
        { key: 'throwFt', kind: 'number', unit: 'ft', min: 0, max: 40, step: 1 },
      ],
    },
  ],
}

export const hvacDuctRunParametrics: ParametricDescriptor<HvacDuctRunNode> = {
  groups: [
    {
      label: 'Duct System & Dimensions',
      fields: [
        { key: 'system', kind: 'enum', options: [...HvacDuctSystemEnum.options] },
        { key: 'shape', kind: 'enum', options: [...DuctShapeEnum.options], display: 'segmented' },
        { key: 'material', kind: 'enum', options: [...DuctMaterialEnum.options] },
        { key: 'width', kind: 'number', unit: 'in', min: 1, max: 60, step: 2 },
        { key: 'height', kind: 'number', unit: 'in', min: 1, max: 48, step: 2 },
        { key: 'diameter', kind: 'number', unit: 'in', min: 1, max: 36, step: 1 },
      ],
    },
    {
      label: 'Airflow, Insulation & Framing',
      fields: [
        { key: 'airflowCfm', kind: 'number', unit: 'CFM', min: 0, max: 15000, step: 10 },
        { key: 'insulationR', kind: 'number', unit: 'R', min: 0, max: 16, step: 2 },
        { key: 'showFramingClearances', kind: 'boolean', label: 'Show 3D Framing Penetration Collars' },
      ],
    },
  ],
}
