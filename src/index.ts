/**
 * Main browser entry (`@kruschdev/pascal-plugin-hvac`).
 *
 * Exports the full Pascal Plugin API v1 surface:
 * - `hvacPlugin`: Core `Plugin` manifest (`apiVersion: 1`, 4 `hvac:*` node kinds + InspectorExtension)
 * - `hvacHostPanel`: Left-rail `EditorHostPanel`
 * - `hvacScheduleView`: Full-pane `EditorHostView` (Manual J, Loads & Power/Gas, IMC Audit, Framing & Soffits, BOM & Insulation, 3D Air Handler Cutaway)
 * - `hvacChatExtension`: `PluginChatExtension` (`/` actions + lazy tool result cards)
 */

import type { AnyNodeDefinition, InspectorExtension, Plugin } from '@pascal-app/core'
import type { EditorHostPanel, EditorHostView, PluginChatExtension } from '@pascal-app/editor'
import { hvacDuctRunRenderDefinition } from './nodes/duct-run'
import { hvacEquipmentRenderDefinition } from './nodes/equipment'
import {
  hvacDuctRunParametrics,
  hvacEquipmentParametrics,
  hvacPlenumParametrics,
  hvacTerminalParametrics,
} from './nodes/parametrics'
import { hvacPlenumRenderDefinition } from './nodes/plenum'
import { hvacTerminalRenderDefinition } from './nodes/terminal'
import { HVAC_PLUGIN_ID, hvacRenderPlugin } from './render'
import { HVAC_SCHEDULE_VIEW_ID } from './ui/hvac-panel'

export const hvacInspectorExtensions: InspectorExtension[] = [
  {
    id: `${HVAC_PLUGIN_ID}:imc-diagnostics`,
    pluginId: HVAC_PLUGIN_ID,
    kinds: ['hvac:equipment', 'hvac:plenum', 'hvac:terminal', 'hvac:duct-run'],
    icon: { kind: 'iconify', name: 'lucide:wind' },
    title: 'IMC / ACCA Engineering',
    component: () => import('./ui/inspector-card'),
  },
]

export const hvacEquipmentDefinition: AnyNodeDefinition = {
  ...hvacEquipmentRenderDefinition,
  snapProfile: 'item' as const,
  parametrics: hvacEquipmentParametrics,
} as unknown as AnyNodeDefinition

export const hvacPlenumDefinition: AnyNodeDefinition = {
  ...hvacPlenumRenderDefinition,
  snapProfile: 'item' as const,
  parametrics: hvacPlenumParametrics,
} as unknown as AnyNodeDefinition

export const hvacTerminalDefinition: AnyNodeDefinition = {
  ...hvacTerminalRenderDefinition,
  snapProfile: 'item' as const,
  parametrics: hvacTerminalParametrics,
} as unknown as AnyNodeDefinition

export const hvacDuctRunDefinition: AnyNodeDefinition = {
  ...hvacDuctRunRenderDefinition,
  snapProfile: 'structural' as const,
  parametrics: hvacDuctRunParametrics,
} as unknown as AnyNodeDefinition

export const hvacPlugin: Plugin = {
  ...hvacRenderPlugin,
  nodes: [
    hvacEquipmentDefinition,
    hvacPlenumDefinition,
    hvacTerminalDefinition,
    hvacDuctRunDefinition,
  ],
  inspectorExtensions: hvacInspectorExtensions,
}

export const hvacHostPanel: EditorHostPanel = {
  id: `${HVAC_PLUGIN_ID}:panel`,
  pluginId: HVAC_PLUGIN_ID,
  label: 'HVAC',
  summary:
    'Residential & Light-Commercial IMC/ACCA Manual J-D-S loads, 3D ductwork, ASHRAE 62.2 ERV, IECC insulation & cross-trade MEP coordination.',
  description:
    'Author editable residential and light-commercial HVAC systems with room-by-room ACCA Manual J heating/cooling loads, Manual D equal-friction ductwork, Manual S equipment & R-454B/R-32/R-410A lineset sizing, ASHRAE 62.2 ERV ventilation, IECC building envelope insulation takeoffs, Priority #3 obstacle-aware routing, Structural/Bones joist-bay & soffit coordination, and automatic Electrical panel breaker handoff.',
  category: 'MEP & Engineering',
  creator: {
    name: 'Kevin Ruschman (@kruschdev)',
    url: 'https://github.com/kruschdev',
  },
  pluginUrl: 'https://github.com/kruschdev/pascal-plugin-hvac',
  icon: { kind: 'iconify', name: 'lucide:wind' },
  component: () => import('./ui/hvac-panel'),
  defaultInstalled: false,
}

export const hvacScheduleView: EditorHostView = {
  id: HVAC_SCHEDULE_VIEW_ID,
  pluginId: HVAC_PLUGIN_ID,
  label: 'HVAC Schedule',
  description:
    'Manual J room loads, Manual S sizing, Electrical/Gas coordination, IMC/IECC audit, framing & soffit clearances, priced BOM + IECC insulation, and 3D air handler cutaway.',
  icon: { kind: 'iconify', name: 'lucide:wind' },
  component: () => import('./ui/schedule-view'),
  workspaces: ['edit'],
  defaultPinned: false,
}

export const hvacChatExtension: PluginChatExtension = {
  pluginId: HVAC_PLUGIN_ID,
  cards: {
    hvac_place_equipment: () => import('./ui/chat-card'),
    hvac_place_plenum: () => import('./ui/chat-card'),
    hvac_place_terminal: () => import('./ui/chat-card'),
    hvac_audit_imc: () => import('./ui/chat-card'),
    hvac_generate_schedule: () => import('./ui/chat-card'),
    hvac_route_duct: () => import('./ui/chat-card'),
    hvac_autopopulate: () => import('./ui/chat-card'),
    hvac_calculate_loads: () => import('./ui/chat-card'),
  },
  actions: [
    {
      id: 'imc-audit',
      label: 'IMC & IECC Audit',
      hint: 'Check Manual D velocity, IECC R-8 attic ducts, IMC 307.2 pans, NEC 440.14 & trade clashes',
      prompt:
        'Run hvac_audit_imc on this scene and summarize any IMC, IECC, framing clearance, or cross-trade MEP coordination issues.',
    },
    {
      id: 'hvac-schedule',
      label: 'Manual J Schedule & BOM',
      hint: 'Generate room-by-room loads, duct summary, framing clearances, IECC insulation & priced BOM',
      prompt: 'Run hvac_generate_schedule and open the HVAC schedule view.',
    },
    {
      id: 'hvac-loads',
      label: 'Manual J / S / ERV Calc',
      hint: 'Calculate heating/cooling BTU/h, tonnage, CFM, lineset sizing & ASHRAE 62.2 ventilation',
      prompt: 'Run hvac_calculate_loads for this building and summarize equipment tonnage, airflow, and power requirements.',
    },
  ],
}

export {
  HVAC_PLUGIN_ID,
  hvacRenderPlugin,
  HvacEquipmentNode,
  HvacPlenumNode,
  HvacTerminalNode,
  HvacDuctRunNode,
} from './render'
export { HVAC_SCHEDULE_VIEW_ID } from './ui/hvac-panel'
export * from './imc'
