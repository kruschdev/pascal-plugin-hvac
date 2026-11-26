/**
 * Pure Zod-only Agent Tool Contracts (`@kruschdev/pascal-plugin-hvac/agent-tools`).
 * Conforms to Pascal DECISIONS.md E-016: zero Three.js, React, viewer, or editor imports.
 */

import type { PluginAgentTools } from '@pascal-app/core/agent-tools'
import { z } from 'zod'

const Vec3 = z.tuple([z.number(), z.number(), z.number()])

const ClimateZone = z.enum(['1A', '2A', '2B', '3A', '3B', '3C', '4A', '4B', '4C', '5A', '5B', '6A', '6B', '7'])
const EquipmentKind = z.enum([
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
const PlenumKind = z.enum(['supply-plenum', 'return-plenum', 'mixing-box', 'zone-damper-manifold'])
const TerminalKind = z.enum([
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
const DuctSystem = z.enum([
  'supply-trunk',
  'supply-branch',
  'return-trunk',
  'return-branch',
  'fresh-air-erv',
  'exhaust-duct',
  'refrigerant-lineset',
  'condensate-drain',
])
const DuctMaterial = z.enum([
  'galvanized-sheet',
  'flex-r8',
  'flex-r6',
  'ductboard',
  'insulated-copper',
  'pvc-condensate',
])
const DuctShape = z.enum(['rectangular', 'round'])

export const hvacAgentTools: PluginAgentTools = {
  pluginId: 'krusch:hvac',
  apiVersion: 1,
  version: '0.1.0',
  instructions:
    'HVAC holds Priority #3 MEP right-of-way (1. Structural -> 2. Plumbing -> 3. HVAC -> 4. Electrical). HVAC ductwork yields around Structural beams/columns, Plumbing DWV gravity pipes/stacks, and NEC 110.26(E) Dedicated Electrical Space above panels. Every powered HVAC unit automatically publishes an `electricalDemand` payload so Electrical adds its breakers and 3D power runs, and gas furnaces publish `gasBtuh` for Plumbing IFGC gas sizing.',
  skills: [
    {
      name: 'imc-manual-j-d-hvac',
      summary: 'Residential & Light-Commercial ACCA Manual J/D/S, ASHRAE 62.2, and IECC HVAC workflow with Structural, Plumbing & Electrical coordination',
      body: [
        '1. Run `hvac_autopopulate` to compute room-by-room ACCA Manual J heating/cooling loads, size tonnage/CFM, place indoor air handler/furnace + outdoor condenser, route Priority #3 obstacle-aware supply/return trunks & branches, linesets, condensate drains, and optional ERV/exhaust.',
        '2. Add or customize mechanical equipment (`hvac_place_equipment`), plenums (`hvac_place_plenum`), terminals (`hvac_place_terminal`), or custom ducts (`hvac_route_duct`).',
        '3. Run `hvac_calculate_loads`, `hvac_generate_schedule`, and `hvac_audit_imc` to verify 0 IMC/IECC/Manual D/NEC 110.26(E) errors, check joist-bay & soffit framing clearances, and verify Electrical auto-breaker coordination.',
      ].join('\n'),
    },
  ],
  tools: [
    {
      name: 'hvac_place_equipment',
      title: 'Place HVAC mechanical equipment',
      description:
        'Place a heat pump condenser, AC condenser, air handler, condensing gas furnace, packaged RTU, mini-split, ERV, dehumidifier, or exhaust fan with automatic NEC Article 440 electricalDemand metadata.',
      runsIn: 'operation',
      input: {
        levelId: z.string().optional(),
        name: z.string().optional(),
        equipmentKind: EquipmentKind.default('air-handler'),
        position: Vec3,
        rotation: z.number().default(0),
        roomName: z.string().default('Mechanical'),
        coolingTons: z.number().min(0).max(30).optional(),
        gasBtuh: z.number().min(0).max(500000).optional(),
        heatStripKw: z.number().min(0).max(30).optional(),
        occupancy: z.enum(['residential', 'commercial']).default('residential'),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    {
      name: 'hvac_place_plenum',
      title: 'Place HVAC supply/return plenum or zone manifold',
      description: 'Place an insulated sheet-metal supply plenum, return plenum, mixing box, or motorized zone damper manifold.',
      runsIn: 'operation',
      input: {
        levelId: z.string().optional(),
        name: z.string().optional(),
        plenumKind: PlenumKind.default('supply-plenum'),
        position: Vec3,
        rotation: z.number().default(0),
        widthIn: z.number().min(6).max(60).default(18),
        heightIn: z.number().min(6).max(48).default(10),
        depthIn: z.number().min(6).max(60).default(24),
        airflowCfm: z.number().min(0).max(15000).default(1200),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    {
      name: 'hvac_place_terminal',
      title: 'Place HVAC supply register, return grille, or thermostat',
      description: 'Place any of 10 HVAC air terminals or controls (floor/wall/ceiling supply, return/transfer/exhaust grilles, fresh-air hood, mini-split head, thermostat, or sensor).',
      runsIn: 'operation',
      input: {
        levelId: z.string().optional(),
        name: z.string().optional(),
        terminalKind: TerminalKind.default('supply-ceiling-diffuser'),
        position: Vec3,
        rotation: z.number().default(0),
        roomName: z.string().default('Living Room'),
        designCfm: z.number().min(0).max(5000).optional(),
        neckSizeIn: z.number().min(0).max(24).optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    {
      name: 'hvac_route_duct',
      title: 'Route 3D HVAC duct, lineset, or condensate drain',
      description:
        'Route a 3D rectangular or round duct, refrigerant lineset, or sloped 3/4" PVC condensate drain yielding around Structural, Plumbing, and NEC 110.26(E) panel columns.',
      runsIn: 'operation',
      input: {
        levelId: z.string().optional(),
        name: z.string().optional(),
        from: Vec3,
        to: Vec3,
        system: DuctSystem.default('supply-branch'),
        shape: DuctShape.optional(),
        material: DuctMaterial.optional(),
        width: z.number().min(1).max(60).optional(),
        height: z.number().min(1).max(48).optional(),
        diameter: z.number().min(1).max(36).optional(),
        airflowCfm: z.number().min(0).max(15000).optional(),
        insulationR: z.number().min(0).max(16).optional(),
        plenumLocation: z.enum(['attic', 'crawlspace', 'basement', 'conditioned-soffit']).default('attic'),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    {
      name: 'hvac_autopopulate',
      title: 'One-click Manual J / D / IMC auto-populate HVAC',
      description:
        'Scan rooms, walls, and Priority #1/#2 obstacles to size Manual J heating/cooling loads, place indoor & outdoor HVAC equipment, route Manual D trunks & branches, linesets, condensate drains, ERV, and bath exhaust.',
      runsIn: 'operation',
      input: {
        levelId: z.string().optional(),
        codeEdition: z.enum(['IMC-2021', 'UMC-2021']).default('IMC-2021'),
        occupancy: z.enum(['residential', 'commercial']).default('residential'),
        climateZone: ClimateZone.default('4A'),
        systemType: z
          .enum(['split-heat-pump', 'split-gas-furnace', 'mini-split-multizone', 'rooftop-package'])
          .default('split-heat-pump'),
        plenumLocation: z.enum(['attic', 'crawlspace', 'basement', 'conditioned-soffit']).default('attic'),
        includeErv: z.boolean().default(true),
        includeExhaustFans: z.boolean().default(true),
        clearExisting: z.boolean().default(true),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    {
      name: 'hvac_calculate_loads',
      title: 'Calculate ACCA Manual J loads, ASHRAE 62.2 ventilation & IECC insulation',
      description:
        'Compute room-by-room heating/cooling BTU/h, recommended tonnage, CFM, SEER2/HSPF2 equipment sizing, ASHRAE 62.2 fresh-air CFM, IECC insulation takeoff, and cross-trade electrical/gas loads.',
      runsIn: 'operation',
      input: {
        codeEdition: z.enum(['IMC-2021', 'UMC-2021']).default('IMC-2021'),
        climateZone: ClimateZone.default('4A'),
        occupancy: z.enum(['residential', 'commercial']).default('residential'),
        systemType: z
          .enum(['split-heat-pump', 'split-gas-furnace', 'mini-split-multizone', 'rooftop-package'])
          .default('split-heat-pump'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    {
      name: 'hvac_generate_schedule',
      title: 'Generate Manual J airflow schedule, framing clearance list & priced BOM',
      description:
        'Generate the room-by-room Manual J/D schedule, duct takeoff summary, framing/soffit clearance schedule, electrical coordination table, and priced BOM + IECC insulation CSV.',
      runsIn: 'operation',
      input: {
        codeEdition: z.enum(['IMC-2021', 'UMC-2021']).default('IMC-2021'),
        climateZone: ClimateZone.default('4A'),
        occupancy: z.enum(['residential', 'commercial']).default('residential'),
        laborRateUsd: z.number().min(20).max(400).default(120),
        materialMarkupPct: z.number().min(0).max(100).default(0),
        salesTaxPct: z.number().min(0).max(25).default(0),
        includeInsulation: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    {
      name: 'hvac_audit_imc',
      title: 'Audit scene for IMC, UMC, ACCA Manual D, IECC & NEC 110.26(E) compliance',
      description:
        'Audit all HVAC equipment, terminals, and ducts for Manual D velocity limits, IECC R-8 attic duct insulation, IMC 307.2 condensate pans, NEC 440.14 disconnects, Priority #1/#2 trade clashes, and unwired electrical loads.',
      runsIn: 'operation',
      input: {
        codeEdition: z.enum(['IMC-2021', 'UMC-2021']).default('IMC-2021'),
        climateZone: ClimateZone.default('4A'),
        occupancy: z.enum(['residential', 'commercial']).default('residential'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
  ],
}
