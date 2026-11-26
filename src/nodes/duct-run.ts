/**
 * `hvac:duct-run` — 3D Supply/Return Sheet-Metal Trunks, Insulated Flex Branches,
 * ERV Fresh-Air Ducts, Exhaust Ducts, Refrigerant Linesets, & 3/4" PVC Condensate Drains.
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
import { buildDuctRunCad } from '../cad/ducts'
import { hvacSystemColorMeta } from '../cad/materials'
import {
  type SceneNodeLike,
  computeDuctFramingClearances,
  extractHvacFramingContext,
  resolveNodeLevelId,
} from '../imc/framing-interop'
import { extractWallSegments } from '../imc/routing'
import type { DuctMaterial, DuctShape, HvacDuctSystem } from '../imc/tables'

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()])

export const HvacDuctSystemEnum = z.enum([
  'supply-trunk',
  'supply-branch',
  'return-trunk',
  'return-branch',
  'fresh-air-erv',
  'exhaust-duct',
  'refrigerant-lineset',
  'condensate-drain',
])

export const DuctMaterialEnum = z.enum([
  'galvanized-sheet',
  'flex-r8',
  'flex-r6',
  'ductboard',
  'insulated-copper',
  'pvc-condensate',
])

export const DuctShapeEnum = z.enum(['rectangular', 'round'])

export const HvacDuctRunNode = BaseNode.extend({
  id: objectId('hvacduct'),
  type: nodeType('hvac:duct-run'),
  path: z.array(Vec3Schema).min(2),
  system: HvacDuctSystemEnum.default('supply-branch'),
  shape: DuctShapeEnum.default('round'),
  material: DuctMaterialEnum.default('flex-r8'),
  width: z.number().min(0.5).max(60).default(14),
  height: z.number().min(0.5).max(48).default(8),
  diameter: z.number().min(0.5).max(36).default(6),
  airflowCfm: z.number().min(0).max(15000).default(115),
  velocityFpm: z.number().min(0).max(5000).default(580),
  frictionRateInWgPer100Ft: z.number().min(0).max(2).default(0.08),
  insulationR: z.number().min(0).max(16).default(8),
  sourceNodeId: z.string().optional(),
  targetNodeId: z.string().optional(),
  showFramingClearances: z.boolean().default(true),
  framingRevision: z.number().int().min(0).optional(),
})

export type HvacDuctRunNode = z.infer<typeof HvacDuctRunNode>

function normDir(a: readonly [number, number, number], b: readonly [number, number, number], sign: 1 | -1): [number, number, number] {
  const dx = (b[0] - a[0]) * sign
  const dy = (b[1] - a[1]) * sign
  const dz = (b[2] - a[2]) * sign
  const len = Math.hypot(dx, dy, dz)
  return len < 1e-5 ? [0, 1, 0] : [dx / len, dy / len, dz / len]
}

export function getHvacDuctRunPorts(node: HvacDuctRunNode): NodePort[] {
  const start = node.path[0]
  const end = node.path[node.path.length - 1]
  if (!start || !end) return []
  const second = node.path[1] ?? end
  const prev = node.path[node.path.length - 2] ?? start
  const sys = node.system === 'refrigerant-lineset' ? 'refrigerant' : node.system === 'condensate-drain' ? 'dwv' : 'hvac'
  return [
    { id: 'start', position: start, direction: normDir(start, second, -1), diameter: node.diameter, system: sys },
    { id: 'end', position: end, direction: normDir(prev, end, 1), diameter: node.diameter, system: sys },
  ]
}

export function buildHvacDuctRunGeometry(node: HvacDuctRunNode, ctx: GeometryContext): Group {
  let clearances: ReturnType<typeof computeDuctFramingClearances> = []
  if (node.showFramingClearances && ctx && typeof ctx === 'object' && 'nodes' in ctx && ctx.nodes) {
    const record = ctx.nodes as unknown as Readonly<Record<string, SceneNodeLike>>
    const levelId = resolveNodeLevelId(record, node as unknown as SceneNodeLike) ?? node.parentId ?? null
    const walls = extractWallSegments(record, levelId)
    const framingContext = extractHvacFramingContext(record, levelId)
    clearances = computeDuctFramingClearances({
      ductRunId: node.id,
      path: node.path,
      shape: node.shape as DuctShape,
      widthIn: node.width,
      heightIn: node.height,
      diameterIn: node.diameter,
      walls,
      framingContext,
    })
  }

  return buildDuctRunCad({
    id: node.id,
    path: node.path,
    system: node.system as HvacDuctSystem,
    shape: node.shape as DuctShape,
    material: node.material as DuctMaterial,
    widthIn: node.width,
    heightIn: node.height,
    diameterIn: node.diameter,
    clearances,
  })
}

export function buildHvacDuctRunFloorplan(node: HvacDuctRunNode, ctx: GeometryContext): FloorplanGeometry {
  const view = ctx.viewState
  const selected = (view?.selected || view?.highlighted) ?? false
  const meta = hvacSystemColorMeta(node.system as HvacDuctSystem)
  const stroke = selected && view?.palette ? view.palette.selectedStroke : meta.hex
  const children: FloorplanGeometry[] = []

  for (let i = 0; i < node.path.length - 1; i++) {
    const a = node.path[i]!
    const b = node.path[i + 1]!
    if (Math.hypot(b[0] - a[0], b[2] - a[2]) < 1e-3) continue
    children.push({
      kind: 'line',
      x1: a[0],
      y1: a[2],
      x2: b[0],
      y2: b[2],
      stroke,
      strokeWidth: selected ? 0.055 : node.shape === 'rectangular' ? 0.045 : 0.028,
      strokeDasharray: meta.dash2d ? '0.16 0.08' : undefined,
    })
  }

  const start = node.path[0]
  if (selected && start) children.push({ kind: 'move-handle', point: [start[0], start[2]] })
  return { kind: 'group', children }
}

export const hvacDuctRunRenderDefinition: NodeDefinition<typeof HvacDuctRunNode> = {
  kind: 'hvac:duct-run',
  schemaVersion: 1,
  schema: HvacDuctRunNode,
  category: 'utility',
  distributionRole: 'run',
  defaults: () => ({
    object: 'node',
    parentId: null,
    visible: true,
    metadata: {},
    name: 'Supply Branch (6" R-8)',
    path: [
      [0, 2.8, 0],
      [2, 2.8, 0],
    ],
    system: 'supply-branch',
    shape: 'round',
    material: 'flex-r8',
    width: 6,
    height: 6,
    diameter: 6,
    airflowCfm: 115,
    velocityFpm: 580,
    frictionRateInWgPer100Ft: 0.08,
    insulationR: 8,
    showFramingClearances: true,
  }),
  capabilities: {
    selectable: { hitVolume: 'bbox' },
    duplicable: true,
    deletable: true,
    snappable: {},
  },
  geometry: buildHvacDuctRunGeometry,
  geometryKey: (n) =>
    JSON.stringify([
      n.path,
      n.system,
      n.shape,
      n.material,
      n.width,
      n.height,
      n.diameter,
      n.showFramingClearances,
      n.framingRevision ?? 0,
    ]),
  ports: getHvacDuctRunPorts,
  floorplan: buildHvacDuctRunFloorplan,
  presentation: {
    label: 'HVAC Duct Run',
    description: 'Rectangular/round supply & return ducts, ERV fresh-air, exhaust ducts, refrigerant linesets, and condensate drains.',
    icon: { kind: 'iconify', name: 'lucide:git-fork' },
    paletteSection: 'structure',
  },
  mcp: {
    description: '3D HVAC duct, lineset, or condensate polyline in level-local meters tracking shape, width/height/diameter, CFM, velocity, and R-value.',
  },
}
