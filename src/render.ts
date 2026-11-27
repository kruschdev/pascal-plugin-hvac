/**
 * Read-only viewer entry (`@kruschdev/pascal-plugin-hvac/render`).
 * Strictly editor-free: zero `@pascal-app/editor` or `next` imports (verified by `bun run check:render`).
 */

import type { AnyNodeDefinition, Plugin } from '@pascal-app/core'
import { hvacDuctRunRenderDefinition } from './nodes/duct-run'
import { hvacEquipmentRenderDefinition } from './nodes/equipment'
import { hvacPlenumRenderDefinition } from './nodes/plenum'
import { hvacTerminalRenderDefinition } from './nodes/terminal'

export const HVAC_PLUGIN_ID = 'krusch:hvac' as const
export const HVAC_SCHEDULE_VIEW_ID = 'krusch:hvac:schedule' as const

export const hvacRenderPlugin: Plugin = {
  id: HVAC_PLUGIN_ID,
  apiVersion: 1,
  nodes: [
    hvacEquipmentRenderDefinition as unknown as AnyNodeDefinition,
    hvacPlenumRenderDefinition as unknown as AnyNodeDefinition,
    hvacTerminalRenderDefinition as unknown as AnyNodeDefinition,
    hvacDuctRunRenderDefinition as unknown as AnyNodeDefinition,
  ],
}

export default hvacRenderPlugin
export {
  HvacEquipmentNode,
  hvacEquipmentRenderDefinition,
  buildHvacEquipmentGeometry,
  buildHvacEquipmentFloorplan,
  getHvacEquipmentPorts,
} from './nodes/equipment'
export {
  HvacPlenumNode,
  hvacPlenumRenderDefinition,
  buildHvacPlenumGeometry,
  buildHvacPlenumFloorplan,
  getHvacPlenumPorts,
} from './nodes/plenum'
export {
  HvacTerminalNode,
  hvacTerminalRenderDefinition,
  buildHvacTerminalGeometry,
  buildHvacTerminalFloorplan,
  getHvacTerminalPorts,
} from './nodes/terminal'
export {
  HvacDuctRunNode,
  hvacDuctRunRenderDefinition,
  buildHvacDuctRunGeometry,
  buildHvacDuctRunFloorplan,
  getHvacDuctRunPorts,
} from './nodes/duct-run'
