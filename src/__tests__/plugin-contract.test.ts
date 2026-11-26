import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { hvacAgentOperations } from '../agent-operations'
import { hvacAgentTools } from '../agent-tools'
import {
  HVAC_PLUGIN_ID,
  hvacChatExtension,
  hvacHostPanel,
  hvacPlugin,
  hvacRenderPlugin,
  hvacScheduleView,
} from '../index'
import { HvacDuctRunNode } from '../nodes/duct-run'
import {
  HvacEquipmentNode,
  buildHvacEquipmentFloorplan,
  getHvacEquipmentPorts,
} from '../nodes/equipment'
import { HvacPlenumNode, getHvacPlenumPorts } from '../nodes/plenum'
import { HvacTerminalNode, buildHvacTerminalFloorplan, getHvacTerminalPorts } from '../nodes/terminal'

describe('Pascal Plugin API v1 Contract, Zod Round-Trip & E-016 Agent Operations', () => {
  test('Manifest IDs, API version, 4 node definitions, panel, schedule view, and chat extension align', () => {
    expect(HVAC_PLUGIN_ID).toBe('krusch:hvac')
    expect(hvacRenderPlugin.id).toBe('krusch:hvac')
    expect(hvacRenderPlugin.apiVersion).toBe(1)
    expect(hvacRenderPlugin.nodes?.length).toBe(4)

    expect(hvacPlugin.id).toBe('krusch:hvac')
    expect(hvacPlugin.apiVersion).toBe(1)
    expect(hvacPlugin.nodes?.length).toBe(4)
    expect(hvacPlugin.inspectorExtensions?.length).toBe(1)

    expect(hvacHostPanel.pluginId).toBe('krusch:hvac')
    expect(hvacScheduleView.pluginId).toBe('krusch:hvac')
    expect(hvacChatExtension.pluginId).toBe('krusch:hvac')
    expect(Object.keys(hvacChatExtension.cards ?? {})).toEqual([
      'hvac_audit_imc',
      'hvac_generate_schedule',
      'hvac_route_duct',
      'hvac_autopopulate',
      'hvac_calculate_loads',
    ])
  })

  test('All 4 hvac:* Zod v4 schemas parse cleanly and rotate 2D ports properly', () => {
    const mockCtx = { nodes: {} } as never
    const eq = HvacEquipmentNode.parse({
      id: 'hvaceq_1',
      parentId: 'level_0',
      equipmentKind: 'air-handler',
      position: [2, 0, 3],
      rotation: Math.PI / 2,
    })
    expect(eq.type).toBe('hvac:equipment')
    expect(getHvacEquipmentPorts(eq).length).toBeGreaterThanOrEqual(2)
    expect(buildHvacEquipmentFloorplan(eq, mockCtx).kind).toBeDefined()

    const pl = HvacPlenumNode.parse({
      id: 'hvacpl_1',
      parentId: 'level_0',
      plenumKind: 'supply-plenum',
      position: [2, 1.7, 3],
      rotation: Math.PI / 4,
    })
    expect(pl.type).toBe('hvac:plenum')
    expect(getHvacPlenumPorts(pl).length).toBeGreaterThanOrEqual(2)

    const term = HvacTerminalNode.parse({
      id: 'hvacterm_1',
      parentId: 'level_0',
      terminalKind: 'supply-ceiling-diffuser',
      position: [4, 2.6, 2],
      rotation: Math.PI / 2,
    })
    expect(term.type).toBe('hvac:terminal')
    expect(getHvacTerminalPorts(term).length).toBe(1)
    expect(buildHvacTerminalFloorplan(term, mockCtx).kind).toBeDefined()

    const duct = HvacDuctRunNode.parse({
      id: 'hvacduct_1',
      parentId: 'level_0',
      system: 'supply-trunk',
      shape: 'rectangular',
      width: 16,
      height: 8,
      path: [
        [2, 2.8, 3],
        [6, 2.8, 3],
      ],
    })
    expect(duct.type).toBe('hvac:duct-run')
    expect(duct.path.length).toBe(2)
  })

  test('All 8 E-016 Agent Tools exist, keep system-dependent fields optional, and execute via hvacAgentOperations', () => {
    expect(hvacAgentTools.tools.length).toBe(8)
    const names = hvacAgentTools.tools.map((t) => t.name)
    for (const name of names) {
      expect(typeof (hvacAgentOperations as Record<string, unknown>)[name]).toBe('function')
    }

    // Verify hvac_route_duct tool schema does NOT hard-default shape/material so condensate-drain picks pvc-condensate
    const routeTool = hvacAgentTools.tools.find((t) => t.name === 'hvac_route_duct')!
    const parsedCondensate = z.object(routeTool.input).parse({
      from: [1, 1.0, 1],
      to: [4, 0.1, 1],
      system: 'condensate-drain',
    }) as Record<string, unknown>
    expect(parsedCondensate.material).toBeUndefined()
    expect(parsedCondensate.shape).toBeUndefined()

    const scene = {
      level_0: { object: 'node', id: 'level_0', type: 'level', name: 'Level 1', height: 2.7, visible: true, metadata: {} },
      r_liv: {
        object: 'node',
        id: 'r_liv',
        type: 'zone',
        name: 'Living Room',
        parentId: 'level_0',
        polygon: [[0, 0], [8, 0], [8, 6], [0, 6]],
        visible: true,
        metadata: {},
      },
    } as never

    const condRes = hvacAgentOperations.hvac_route_duct(
      scene,
      { from: [1, 1.0, 1], to: [4, 0.1, 1], system: 'condensate-drain' },
      { activeLevelId: 'level_0' },
    )
    const condNode = condRes.changes?.create?.[0]?.node as unknown as Record<string, unknown>
    expect(condNode.material).toBe('pvc-condensate')
    expect(condNode.shape).toBe('round')

    // Execute hvac_autopopulate -> hvac_calculate_loads -> hvac_generate_schedule -> hvac_audit_imc
    const autoRes = hvacAgentOperations.hvac_autopopulate(
      scene,
      { levelId: 'level_0', climateZone: '4A', systemType: 'split-heat-pump' },
      { activeLevelId: 'level_0' },
    )
    expect(autoRes.result.equipmentCount).toBeGreaterThanOrEqual(2)
    expect(autoRes.result.audit.errorCount).toBe(0)

    const populated: Record<string, unknown> = { ...(scene as Record<string, unknown>) }
    for (const c of autoRes.changes?.create ?? []) {
      populated[(c.node as { id: string }).id] = c.node
    }

    const loadsRes = hvacAgentOperations.hvac_calculate_loads(populated as never, { climateZone: '4A' })
    expect(loadsRes.result.manualJ.recommendedTons).toBeGreaterThanOrEqual(1.5)

    const schedRes = hvacAgentOperations.hvac_generate_schedule(populated as never, {
      climateZone: '4A',
      includeInsulation: true,
    })
    expect(schedRes.result.bom.grandTotalUsd).toBeGreaterThan(2000)

    const auditRes = hvacAgentOperations.hvac_audit_imc(populated as never, { climateZone: '4A' })
    expect(auditRes.result.errorCount).toBe(0)
  })
})
