/**
 * `hvac:terminal` — Supply Registers/Diffusers, Return/Transfer/Exhaust Grilles,
 * Mini-Split Wall Heads, Smart Thermostats, & Zone Sensors.
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
import { buildHvacTerminalCad } from '../cad/terminals'
import { HVAC_TERMINAL_SPECS, type HvacTerminalKind } from '../imc/tables'

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()])

export const HvacTerminalKindEnum = z.enum([
  'supply-floor-register',
  'supply-ceiling-diffuser',
  'supply-wall-register',
  'return-grille',
  'transfer-grille',
  'exhaust-grille',
  'fresh-air-intake',
  'mini-split-wall-head',
  'smart-thermostat',
  'zone-sensor',
])

export const HvacTerminalNode = BaseNode.extend({
  id: objectId('hvacterm'),
  type: nodeType('hvac:terminal'),
  position: Vec3Schema.default([0, 2.58, 0]),
  rotation: z.number().default(0),
  terminalKind: HvacTerminalKindEnum.default('supply-ceiling-diffuser'),
  roomName: z.string().default('Living Room'),
  designCfm: z.number().min(0).max(5000).default(115),
  neckSizeIn: z.number().min(0).max(24).default(6),
  throwFt: z.number().min(0).max(40).default(10),
})

export type HvacTerminalNode = z.infer<typeof HvacTerminalNode>

function rot2d(cx: number, cz: number, lx: number, lz: number, rot: number): [number, number] {
  const c = Math.cos(rot)
  const s = Math.sin(rot)
  return [cx + lx * c + lz * s, cz - lx * s + lz * c]
}

export function getHvacTerminalPorts(node: HvacTerminalNode): NodePort[] {
  if (node.terminalKind === 'smart-thermostat' || node.terminalKind === 'zone-sensor') return []
  const [x, y, zPos] = node.position
  const rot = node.rotation ?? 0
  const isCeiling = node.terminalKind === 'supply-ceiling-diffuser' || node.terminalKind === 'exhaust-grille'
  const isFloor = node.terminalKind === 'supply-floor-register'
  return [
    {
      id: 'duct-neck',
      position: [x, y, zPos],
      direction: isCeiling ? [0, 1, 0] : isFloor ? [0, -1, 0] : [-Math.sin(rot), 0, -Math.cos(rot)],
      diameter: Math.max(4, node.neckSizeIn),
      system: 'hvac',
    },
  ]
}

export function buildHvacTerminalGeometry(node: HvacTerminalNode, _ctx: GeometryContext): Group {
  const group = new Group()
  group.name = `hvac-terminal-${node.id}`
  group.add(
    buildHvacTerminalCad({
      terminalKind: node.terminalKind as HvacTerminalKind,
      neckSizeIn: node.neckSizeIn,
    }),
  )
  return group
}

export function buildHvacTerminalFloorplan(node: HvacTerminalNode, ctx: GeometryContext): FloorplanGeometry {
  const view = ctx.viewState
  const selected = (view?.selected || view?.highlighted) ?? false
  const [cx, , cz] = node.position
  const rot = node.rotation ?? 0
  const spec = HVAC_TERMINAL_SPECS[node.terminalKind as HvacTerminalKind]
  const hw = Math.max(0.08, (spec?.dimensionsM[0] ?? 0.3) / 2)
  const hd = Math.max(0.08, (spec?.dimensionsM[2] ?? 0.3) / 2)
  const baseStroke =
    node.terminalKind === 'return-grille' || node.terminalKind === 'transfer-grille'
      ? '#7c3aed'
      : node.terminalKind === 'exhaust-grille'
        ? '#f59e0b'
        : node.terminalKind === 'fresh-air-intake'
          ? '#10b981'
          : '#0284c7'
  const stroke = selected && view?.palette ? view.palette.selectedStroke : baseStroke

  const p0 = rot2d(cx, cz, -hw, -hd, rot)
  const p1 = rot2d(cx, cz, hw, -hd, rot)
  const p2 = rot2d(cx, cz, hw, hd, rot)
  const p3 = rot2d(cx, cz, -hw, hd, rot)

  const children: FloorplanGeometry[] = [
    { kind: 'polygon', points: [p0, p1, p2, p3], fill: baseStroke, fillOpacity: 0.16, stroke, strokeWidth: 0.02 },
    { kind: 'line', x1: p0[0], y1: p0[1], x2: p2[0], y2: p2[1], stroke, strokeWidth: 0.015 },
  ]
  if (selected) children.push({ kind: 'move-handle', point: [cx, cz] })
  return { kind: 'group', children }
}

export const hvacTerminalRenderDefinition: NodeDefinition<typeof HvacTerminalNode> = {
  kind: 'hvac:terminal',
  schemaVersion: 1,
  schema: HvacTerminalNode,
  category: 'utility',
  distributionRole: 'terminal',
  facingIndicator: true,
  defaults: () => ({
    object: 'node',
    parentId: null,
    visible: true,
    metadata: {},
    name: 'Ceiling 4-Way Diffuser (115 CFM)',
    position: [0, 2.58, 0],
    rotation: 0,
    terminalKind: 'supply-ceiling-diffuser',
    roomName: 'Living Room',
    designCfm: 115,
    neckSizeIn: 6,
    throwFt: 10,
  }),
  capabilities: {
    selectable: { hitVolume: 'bbox' },
    movable: { axes: ['x', 'y', 'z'], gridSnap: true },
    rotatable: { axes: ['y'], snapAngles: [Math.PI / 2] },
    duplicable: true,
    deletable: true,
    snappable: {},
  },
  geometry: buildHvacTerminalGeometry,
  geometryKey: (n) => JSON.stringify([n.terminalKind, n.neckSizeIn]),
  ports: getHvacTerminalPorts,
  floorplan: buildHvacTerminalFloorplan,
  presentation: {
    label: 'HVAC Terminal',
    description: 'Supply registers/diffusers, return/transfer/exhaust grilles, mini-split wall heads, and smart thermostats.',
    icon: { kind: 'iconify', name: 'lucide:wind' },
    paletteSection: 'structure',
  },
  mcp: {
    description: 'HVAC supply/return/exhaust air terminal or thermostat node.',
  },
}
