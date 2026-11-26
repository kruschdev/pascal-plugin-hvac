/**
 * `hvac:equipment` — Heat Pumps, AC Condensers, Air Handlers, Condensing Gas Furnaces,
 * Packaged RTUs, Mini-Splits, ERVs, Whole-House Dehumidifiers, & Exhaust Fans.
 * Render-safe module: zero `@pascal-app/editor` imports.
 */

import {
  BaseNode,
  type FloorplanGeometry,
  type GeometryContext,
  type NodeDefinition,
  type NodePort,
  nodeType,
  objectId,
} from '@pascal-app/core'
import { Group } from 'three'
import { z } from 'zod'
import { buildHvacEquipmentCad } from '../cad/equipment'
import { getHvacEquipmentElectricalDemand } from '../imc/framing-interop'
import { HVAC_EQUIPMENT_SPECS, type HvacEquipmentKind } from '../imc/tables'

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()])

export const ElectricalDemandSchema = z.object({
  required: z.boolean().default(true),
  voltage: z.union([z.literal(120), z.literal(208), z.literal(240), z.literal(480)]).default(240),
  poles: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  breakerAmps: z.number().min(15).max(200).default(35),
  loadVa: z.number().min(0).max(100000).default(4350),
  continuous: z.boolean().default(true),
  dedicatedCircuit: z.boolean().default(true),
  gfciRequired: z.boolean().default(false),
  afciRequired: z.boolean().default(false),
  loadCategory: z
    .enum(['fixed', 'appliance', 'motor', 'hvac-heating', 'hvac-cooling', 'heat-pump'])
    .default('heat-pump'),
  label: z.string().default('HVAC Equipment'),
})

export const HvacEquipmentKindEnum = z.enum([
  'heat-pump-condenser',
  'ac-condenser',
  'air-handler',
  'gas-furnace-96',
  'gas-furnace-80',
  'rooftop-package-unit',
  'mini-split-outdoor',
  'mini-split-indoor',
  'erv-ventilator',
  'dehumidifier-whole-house',
  'bath-exhaust-fan',
  'range-hood',
])

export const RefrigerantTypeEnum = z.enum(['R-454B', 'R-32', 'R-410A'])

export const HvacEquipmentNode = BaseNode.extend({
  id: objectId('hvaceq'),
  type: nodeType('hvac:equipment'),
  position: Vec3Schema.default([0, 0, 0]),
  rotation: z.number().default(0),
  equipmentKind: HvacEquipmentKindEnum.default('air-handler'),
  roomName: z.string().default('Mechanical'),
  coolingTons: z.number().min(0).max(30).default(3),
  heatingBtuh: z.number().min(0).max(500000).default(36000),
  gasBtuh: z.number().min(0).max(500000).default(0),
  airflowCfm: z.number().min(0).max(15000).default(1200),
  seer2: z.number().min(0).max(35).default(15.2),
  hspf2: z.number().min(0).max(18).default(7.5),
  refrigerant: RefrigerantTypeEnum.default('R-454B'),
  hasSecondaryDrainPan: z.boolean().default(true),
  hasFloatSwitch: z.boolean().default(true),
  hasDisconnectWithinSight: z.boolean().default(true),
  orientation: z.enum(['vertical', 'horizontal']).optional(),
  heightM: z.number().positive().optional(),
  electricalDemand: ElectricalDemandSchema.nullable().optional(),
})

export type HvacEquipmentNode = z.infer<typeof HvacEquipmentNode>

function rot2d(cx: number, cz: number, lx: number, lz: number, rot: number): [number, number] {
  const c = Math.cos(rot)
  const s = Math.sin(rot)
  return [cx + lx * c + lz * s, cz - lx * s + lz * c]
}

export function getHvacEquipmentPorts(node: HvacEquipmentNode): NodePort[] {
  const [x, y, zPos] = node.position
  const rot = node.rotation ?? 0
  const kind = node.equipmentKind as HvacEquipmentKind
  const spec = HVAC_EQUIPMENT_SPECS[kind]
  const [wM, hM, dM] = spec?.dimensionsM ?? [0.6, 1.35, 0.6]

  if (spec?.isOutdoor) {
    const [lx, lz] = rot2d(x, zPos, -wM / 2, 0, rot)
    return [
      {
        id: 'lineset',
        position: [lx, y + Math.min(0.35, hM * 0.35), lz],
        direction: [-Math.cos(rot), 0, Math.sin(rot)],
        diameter: 1,
        system: 'refrigerant',
      },
    ]
  }
  if (kind === 'mini-split-indoor') {
    const [bx, bz] = rot2d(x, zPos, 0, -dM / 2, rot)
    return [
      {
        id: 'lineset',
        position: [bx, y, bz],
        direction: [-Math.sin(rot), 0, -Math.cos(rot)],
        diameter: 1,
        system: 'refrigerant',
      },
    ]
  }
  if (kind === 'erv-ventilator' || kind === 'dehumidifier-whole-house') {
    const [lx, lz] = rot2d(x, zPos, -wM / 2, 0, rot)
    const [rx, rz] = rot2d(x, zPos, wM / 2, 0, rot)
    return [
      { id: 'fresh-in', position: [lx, y + hM * 0.5, lz], direction: [-Math.cos(rot), 0, Math.sin(rot)], diameter: 6, system: 'hvac' },
      { id: 'supply-out', position: [rx, y + hM * 0.5, rz], direction: [Math.cos(rot), 0, -Math.sin(rot)], diameter: 6, system: 'hvac' },
    ]
  }
  if (kind === 'bath-exhaust-fan' || kind === 'range-hood') {
    return [
      {
        id: 'exhaust-out',
        position: [x, y + hM * 0.5, zPos],
        direction: [0, 1, 0],
        diameter: kind === 'range-hood' ? 6 : 4,
        system: 'hvac',
      },
    ]
  }
  if (node.orientation === 'horizontal') {
    const horizLen = 1.32
    const horizH = node.heightM ?? 0.52
    const [sx, sz] = rot2d(x, zPos, horizLen / 2, 0, rot)
    const [rx, rz] = rot2d(x, zPos, -horizLen / 2, 0, rot)
    return [
      { id: 'supply-out', position: [sx, y + horizH * 0.5, sz], direction: [Math.cos(rot), 0, -Math.sin(rot)], diameter: 14, system: 'hvac' },
      { id: 'return-in', position: [rx, y + horizH * 0.5, rz], direction: [-Math.cos(rot), 0, Math.sin(rot)], diameter: 14, system: 'hvac' },
    ]
  }
  const [rx, rz] = rot2d(x, zPos, -wM / 2, 0, rot)
  return [
    { id: 'supply-out', position: [x, y + hM, zPos], direction: [0, 1, 0], diameter: 14, system: 'hvac' },
    { id: 'return-in', position: [rx, y + Math.min(0.35, hM * 0.25), rz], direction: [-Math.cos(rot), 0, Math.sin(rot)], diameter: 14, system: 'hvac' },
  ]
}

export function buildHvacEquipmentGeometry(node: HvacEquipmentNode, _ctx: GeometryContext): Group {
  const group = new Group()
  group.name = `hvac-equipment-${node.id}`
  group.add(
    buildHvacEquipmentCad({
      equipmentKind: node.equipmentKind as HvacEquipmentKind,
      coolingTons: node.coolingTons,
      hasSecondaryDrainPan: node.hasSecondaryDrainPan,
      orientation: node.orientation,
    }),
  )
  return group
}

export function buildHvacEquipmentFloorplan(node: HvacEquipmentNode, ctx: GeometryContext): FloorplanGeometry {
  const view = ctx.viewState
  const selected = (view?.selected || view?.highlighted) ?? false
  const [cx, , cz] = node.position
  const rot = node.rotation ?? 0
  const spec = HVAC_EQUIPMENT_SPECS[node.equipmentKind as HvacEquipmentKind]
  const hw = node.orientation === 'horizontal' ? 0.66 : (spec?.dimensionsM[0] ?? 0.6) / 2
  const hd = node.orientation === 'horizontal' ? 0.28 : (spec?.dimensionsM[2] ?? 0.6) / 2
  const baseStroke = spec?.isOutdoor ? '#ea580c' : '#0284c7'
  const stroke = selected && view?.palette ? view.palette.selectedStroke : baseStroke

  const p0 = rot2d(cx, cz, -hw, -hd, rot)
  const p1 = rot2d(cx, cz, hw, -hd, rot)
  const p2 = rot2d(cx, cz, hw, hd, rot)
  const p3 = rot2d(cx, cz, -hw, hd, rot)

  const children: FloorplanGeometry[] = [
    { kind: 'polygon', points: [p0, p1, p2, p3], fill: baseStroke, fillOpacity: 0.14, stroke, strokeWidth: 0.025 },
    { kind: 'line', x1: p0[0], y1: p0[1], x2: p2[0], y2: p2[1], stroke, strokeWidth: 0.018 },
    { kind: 'line', x1: p1[0], y1: p1[1], x2: p3[0], y2: p3[1], stroke, strokeWidth: 0.018 },
  ]
  if (selected) children.push({ kind: 'move-handle', point: [cx, cz] })
  return { kind: 'group', children }
}

export const hvacEquipmentRenderDefinition: NodeDefinition<typeof HvacEquipmentNode> = {
  kind: 'hvac:equipment',
  schemaVersion: 1,
  schema: HvacEquipmentNode,
  category: 'utility',
  distributionRole: 'equipment',
  facingIndicator: true,
  defaults: () => ({
    object: 'node',
    parentId: null,
    visible: true,
    metadata: {},
    name: 'Air Handler (3-Ton)',
    position: [0, 0, 0],
    rotation: 0,
    equipmentKind: 'air-handler',
    roomName: 'Mechanical',
    coolingTons: 3,
    heatingBtuh: 36000,
    gasBtuh: 0,
    airflowCfm: 1200,
    seer2: 15.2,
    hspf2: 7.5,
    refrigerant: 'R-454B',
    hasSecondaryDrainPan: true,
    hasFloatSwitch: true,
    hasDisconnectWithinSight: true,
    electricalDemand: getHvacEquipmentElectricalDemand({ kind: 'air-handler', coolingTons: 3, heatStripKw: 10 }),
  }),
  capabilities: {
    selectable: { hitVolume: 'bbox' },
    movable: { axes: ['x', 'y', 'z'], gridSnap: true },
    rotatable: { axes: ['y'], snapAngles: [Math.PI / 2] },
    duplicable: true,
    deletable: true,
    snappable: {},
  },
  geometry: buildHvacEquipmentGeometry,
  geometryKey: (n) => JSON.stringify([n.equipmentKind, n.coolingTons, n.hasSecondaryDrainPan, n.orientation ?? 'vertical']),
  ports: getHvacEquipmentPorts,
  floorplan: buildHvacEquipmentFloorplan,
  presentation: {
    label: 'HVAC Equipment',
    description: 'Heat pump/AC condensers, air handlers, condensing gas furnaces, RTUs, mini-splits, ERVs, and exhaust fans.',
    icon: { kind: 'iconify', name: 'lucide:fan' },
    paletteSection: 'structure',
  },
  mcp: {
    description: 'HVAC mechanical equipment node publishing standardized electricalDemand & gasBtuh cross-trade metadata.',
  },
}
