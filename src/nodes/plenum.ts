/**
 * `hvac:plenum` — Insulated Supply/Return Sheet-Metal Plenums, Mixing Boxes, & Zone Damper Manifolds.
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
import { buildHvacPlenumCad } from '../cad/plenum-cutaway'
import { type HvacPlenumKind, INCHES_TO_METERS } from '../imc/tables'

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()])

export const HvacPlenumKindEnum = z.enum([
  'supply-plenum',
  'return-plenum',
  'mixing-box',
  'zone-damper-manifold',
])

export const HvacPlenumNode = BaseNode.extend({
  id: objectId('hvacpl'),
  type: nodeType('hvac:plenum'),
  position: Vec3Schema.default([0, 1.72, 0]),
  rotation: z.number().default(0),
  plenumKind: HvacPlenumKindEnum.default('supply-plenum'),
  widthIn: z.number().min(6).max(60).default(18),
  heightIn: z.number().min(6).max(48).default(10),
  depthIn: z.number().min(6).max(60).default(24),
  airflowCfm: z.number().min(0).max(15000).default(1200),
  staticPressureInWg: z.number().min(-2).max(2).default(0.25),
  insulationR: z.number().min(0).max(16).default(8),
  heightM: z.number().positive().optional(),
})

export type HvacPlenumNode = z.infer<typeof HvacPlenumNode>

function rot2d(cx: number, cz: number, lx: number, lz: number, rot: number): [number, number] {
  const c = Math.cos(rot)
  const s = Math.sin(rot)
  return [cx + lx * c + lz * s, cz - lx * s + lz * c]
}

export function getHvacPlenumPorts(node: HvacPlenumNode): NodePort[] {
  const [x, y, zPos] = node.position
  const rot = node.rotation ?? 0
  const hw = (node.widthIn * INCHES_TO_METERS) / 2
  const [ox, oz] = rot2d(x, zPos, hw, 0, rot)
  const [ix, iz] = rot2d(x, zPos, -hw, 0, rot)
  return [
    { id: 'equipment-in', position: [ix, y, iz], direction: [-Math.cos(rot), 0, Math.sin(rot)], diameter: node.heightIn, system: 'hvac' },
    { id: 'trunk-out', position: [ox, y, oz], direction: [Math.cos(rot), 0, -Math.sin(rot)], diameter: node.heightIn, system: 'hvac' },
  ]
}

export function buildHvacPlenumGeometry(node: HvacPlenumNode, _ctx: GeometryContext): Group {
  const group = new Group()
  group.name = `hvac-plenum-${node.id}`
  group.add(
    buildHvacPlenumCad({
      plenumKind: node.plenumKind as HvacPlenumKind,
      widthIn: node.widthIn,
      heightIn: node.heightIn,
      depthIn: node.depthIn,
    }),
  )
  return group
}

export function buildHvacPlenumFloorplan(node: HvacPlenumNode, ctx: GeometryContext): FloorplanGeometry {
  const view = ctx.viewState
  const selected = (view?.selected || view?.highlighted) ?? false
  const [cx, , cz] = node.position
  const rot = node.rotation ?? 0
  const hw = Math.max(0.15, (node.widthIn * INCHES_TO_METERS) / 2)
  const hd = Math.max(0.15, (node.depthIn * INCHES_TO_METERS) / 2)
  const baseStroke = node.plenumKind === 'return-plenum' ? '#7c3aed' : '#0284c7'
  const stroke = selected && view?.palette ? view.palette.selectedStroke : baseStroke

  const p0 = rot2d(cx, cz, -hw, -hd, rot)
  const p1 = rot2d(cx, cz, hw, -hd, rot)
  const p2 = rot2d(cx, cz, hw, hd, rot)
  const p3 = rot2d(cx, cz, -hw, hd, rot)

  const children: FloorplanGeometry[] = [
    { kind: 'polygon', points: [p0, p1, p2, p3], fill: baseStroke, fillOpacity: 0.16, stroke, strokeWidth: 0.024 },
  ]
  if (selected) children.push({ kind: 'move-handle', point: [cx, cz] })
  return { kind: 'group', children }
}

export const hvacPlenumRenderDefinition: NodeDefinition<typeof HvacPlenumNode> = {
  kind: 'hvac:plenum',
  schemaVersion: 1,
  schema: HvacPlenumNode,
  category: 'utility',
  distributionRole: 'equipment',
  facingIndicator: true,
  defaults: () => ({
    object: 'node',
    parentId: null,
    visible: true,
    metadata: {},
    name: 'Supply Plenum (18"x10")',
    position: [0, 1.72, 0],
    rotation: 0,
    plenumKind: 'supply-plenum',
    widthIn: 18,
    heightIn: 10,
    depthIn: 24,
    airflowCfm: 1200,
    staticPressureInWg: 0.25,
    insulationR: 8,
  }),
  capabilities: {
    selectable: { hitVolume: 'bbox' },
    movable: { axes: ['x', 'y', 'z'], gridSnap: true },
    rotatable: { axes: ['y'], snapAngles: [Math.PI / 2] },
    duplicable: true,
    deletable: true,
    snappable: {},
  },
  geometry: buildHvacPlenumGeometry,
  geometryKey: (n) => JSON.stringify([n.plenumKind, n.widthIn, n.heightIn, n.depthIn]),
  ports: getHvacPlenumPorts,
  floorplan: buildHvacPlenumFloorplan,
  presentation: {
    label: 'HVAC Plenum',
    description: 'Supply and return sheet-metal plenums, fresh-air mixing boxes, and motorized zone damper manifolds.',
    icon: { kind: 'iconify', name: 'lucide:box' },
    paletteSection: 'structure',
  },
  mcp: {
    description: 'HVAC supply/return plenum or zone damper manifold.',
  },
}
