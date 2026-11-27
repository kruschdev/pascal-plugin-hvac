/**
 * Layer 3 — Single-Source Declarative IMC / IECC / IRC HVAC Code Rule Table (`src/imc/rules.ts`).
 *
 * Encodes spatial, topological, material, and routing constraints ONCE as typed `DeclarativeRule[]`
 * consumed by BOTH `src/imc/autopopulate.ts` (placement / routing generation) and `src/imc/audit.ts`
 * (post-hoc compliance auditing), enforcing `INV-MEP-08` (placement is strictly at least as
 * conservative as audit via non-negative `placementMarginM`).
 *
 * Framework-free: zero React, Three.js, or `@pascal-app/*` imports (`INV-MEP-01`).
 */

import {
  type DeclarativeRule,
  type ElevationBandRule,
  type FixtureKeepoutRule,
  type MaterialPolicyRule,
  type ProhibitedZoneRule,
  type RoutingConstraintRule,
  type RuleTableValidationResult,
  effectivePlacementThreshold,
  validateRuleTable,
} from '@kruschdev/pascal-mep-kernel'
import type { DuctMaterial } from './tables'

export const IMC_PROHIBITED_RETURN_ZONES_RULE: ProhibitedZoneRule = {
  id: 'imc-601-5-prohibited-return-zones',
  kind: 'prohibited-zone',
  trade: 'hvac',
  codeRef: 'IMC 601.5 / IRC M1602.2',
  severity: 'error',
  category: 'return-air',
  title: 'Return air grille placed in prohibited zone',
  suggestedFix:
    'Relocate the return air grille into a conditioned hallway, living room, or other habitable space.',
  params: {
    targetKinds: ['return-grille'],
    prohibitedRoomCategories: [
      'bathroom',
      'garage',
      'kitchen',
      'utility',
      'closet',
      'exterior',
      'attic',
    ],
    requireBelowCeilingForAttic: true,
  },
}

export const IECC_ATTIC_DUCT_INSULATION_RULE: ElevationBandRule = {
  id: 'iecc-r403-3-1-attic-duct-insulation',
  kind: 'elevation-band',
  trade: 'hvac',
  codeRef: 'IECC R403.3.1',
  severity: 'error',
  category: 'insulation',
  title: 'Unconditioned attic duct insulation below IECC minimum',
  suggestedFix:
    'Upgrade attic duct wrap or flex duct to >= R-8 per IECC R403.3.1.',
  placementMarginM: 0.07,
  params: {
    targetKinds: ['supply-trunk', 'supply-branch', 'return-trunk', 'return-branch'],
    atticThresholdOffsetM: 0.05,
  },
}

export const IMC_CONDENSATE_SLOPE_RULE: RoutingConstraintRule = {
  id: 'imc-307-2-1-condensate-slope',
  kind: 'routing-constraint',
  trade: 'hvac',
  codeRef: 'IMC 307.2.1',
  severity: 'error',
  category: 'condensate',
  title: 'Condensate drain slope below 1/8"/ft minimum',
  suggestedFix:
    'Increase downward pitch to at least 1/8" to 1/4" per foot along the horizontal run.',
  placementMarginM: 0.005,
  params: {
    targetSystems: ['condensate-drain'],
    minSlopeInPerFt: 0.12,
  },
}

export const IMC_RANGE_HOOD_MATERIAL_RULE: MaterialPolicyRule = {
  id: 'imc-505-4-range-hood-material',
  kind: 'material-policy',
  trade: 'hvac',
  codeRef: 'IMC 505.4',
  severity: 'error',
  category: 'exhaust',
  title: 'Kitchen range hood exhaust uses non-metallic / flexible duct',
  suggestedFix:
    'Change kitchen exhaust duct material to galvanized-sheet (smooth rigid metal).',
  params: {
    targetSystems: ['range-hood-exhaust', 'kitchen-exhaust'],
    requiredMaterials: ['galvanized-sheet'],
    forbiddenMaterials: ['flex-r8', 'flex-r6', 'ductboard'],
  },
}

export const IMC_CONDENSER_DOOR_CLEARANCE_RULE: FixtureKeepoutRule = {
  id: 'imc-condenser-door-clearance',
  kind: 'fixture-keepout',
  trade: 'hvac',
  codeRef: 'IMC 304 / M1403',
  severity: 'warning',
  category: 'equipment-clearance',
  title: 'Outdoor condenser too close to entry door',
  suggestedFix:
    'Relocate outdoor condenser at least 2.4 m (8 ft) clear of entry doors and walkways.',
  params: {
    targetRoles: [
      'outdoor-condenser',
      'heat-pump-condenser',
      'ac-condenser',
      'mini-split-outdoor',
    ],
    fixtureKinds: ['door', 'entry-door'],
    minHorizontalM: 2.4,
  },
}

export const IMC_CONDENSER_WINDOW_PLUMBING_CLEARANCE_RULE: FixtureKeepoutRule = {
  id: 'imc-condenser-window-plumbing-clearance',
  kind: 'fixture-keepout',
  trade: 'hvac',
  codeRef: 'IMC 304 / M1403',
  severity: 'warning',
  category: 'equipment-clearance',
  title: 'Outdoor condenser too close to window or fuel-gas/plumbing opening',
  suggestedFix:
    'Maintain at least 1.2 m (4 ft) horizontal clearance from windows and exterior fuel-gas/plumbing equipment.',
  params: {
    targetRoles: [
      'outdoor-condenser',
      'heat-pump-condenser',
      'ac-condenser',
      'mini-split-outdoor',
    ],
    fixtureKinds: ['window', 'plumbing', 'fuel-gas'],
    minHorizontalM: 1.2,
  },
}

export const IMC_CONDENSER_SIBLING_CLEARANCE_RULE: FixtureKeepoutRule = {
  id: 'imc-condenser-sibling-clearance',
  kind: 'fixture-keepout',
  trade: 'hvac',
  codeRef: 'IMC 304 / M1403',
  severity: 'warning',
  category: 'equipment-clearance',
  title: 'Outdoor condenser too close to sibling outdoor unit',
  suggestedFix:
    'Maintain at least 1.5 m (5 ft) horizontal airflow & service separation between sibling outdoor condensers.',
  params: {
    targetRoles: [
      'outdoor-condenser',
      'heat-pump-condenser',
      'ac-condenser',
      'mini-split-outdoor',
    ],
    fixtureKinds: [
      'outdoor-condenser',
      'heat-pump-condenser',
      'ac-condenser',
      'mini-split-outdoor',
      'sibling-condenser',
    ],
    minHorizontalM: 1.5,
  },
}

/**
 * Authoritative single-source declarative IMC / IECC / IRC HVAC rule table (`INV-MEP-08`).
 */
export const IMC_DECLARATIVE_RULES: readonly DeclarativeRule[] = Object.freeze([
  IMC_PROHIBITED_RETURN_ZONES_RULE,
  IECC_ATTIC_DUCT_INSULATION_RULE,
  IMC_CONDENSATE_SLOPE_RULE,
  IMC_RANGE_HOOD_MATERIAL_RULE,
  IMC_CONDENSER_DOOR_CLEARANCE_RULE,
  IMC_CONDENSER_WINDOW_PLUMBING_CLEARANCE_RULE,
  IMC_CONDENSER_SIBLING_CLEARANCE_RULE,
])

export const IMC_RULE_TABLE_VALIDATION: RuleTableValidationResult =
  validateRuleTable(IMC_DECLARATIVE_RULES)

if (!IMC_RULE_TABLE_VALIDATION.valid) {
  throw new Error(
    `Invalid IMC_DECLARATIVE_RULES table: ${IMC_RULE_TABLE_VALIDATION.errors.join('; ')}`,
  )
}

const IMC_RULES_BY_ID: ReadonlyMap<string, DeclarativeRule> = new Map(
  IMC_DECLARATIVE_RULES.map((rule) => [rule.id, rule]),
)

/**
 * Look up a canonical IMC/IECC declarative rule by its stable rule ID.
 */
export function getImcRuleById(id: string): DeclarativeRule | undefined {
  return IMC_RULES_BY_ID.get(id)
}

/**
 * Single-source prohibited return-air room category set (`IMC 601.5 / IRC M1602.2`),
 * derived directly from `IMC_PROHIBITED_RETURN_ZONES_RULE`.
 */
export const IMC_PROHIBITED_RETURN_CATEGORIES: ReadonlySet<string> = new Set(
  IMC_PROHIBITED_RETURN_ZONES_RULE.params.prohibitedRoomCategories,
)

const round3 = (n: number): number => Math.round(n * 1000) / 1000

const atticThresholdAuditOffsetM =
  IECC_ATTIC_DUCT_INSULATION_RULE.params.atticThresholdOffsetM ?? 0.05
const atticPlacementMarginM = IECC_ATTIC_DUCT_INSULATION_RULE.placementMarginM ?? 0.07
const condensateMinSlopeAudit = IMC_CONDENSATE_SLOPE_RULE.params.minSlopeInPerFt ?? 0.12
const condensateSlopePlacementMargin = IMC_CONDENSATE_SLOPE_RULE.placementMarginM ?? 0.005

/**
 * Typed numeric & material thresholds derived directly from `IMC_DECLARATIVE_RULES`
 * via `effectivePlacementThreshold` so placement and audit can never drift (`INV-MEP-08`).
 */
export const IMC_RULE_THRESHOLDS = Object.freeze({
  /** Audit attic threshold offset above ceiling height (`levelH + 0.05m`, IECC R403.3.1). */
  atticThresholdOffsetM: atticThresholdAuditOffsetM,
  /** Placement safety cushion applied inward from the audit attic threshold (`0.07m`). */
  atticPlacementMarginM,
  /** Conservative placement attic threshold offset (`levelH - 0.02m`). */
  atticPlacementOffsetM: round3(
    effectivePlacementThreshold(atticThresholdAuditOffsetM, atticPlacementMarginM, 'max'),
  ),
  /** Audit minimum condensate gravity slope (`0.12"/ft`, IMC 307.2.1). */
  condensateMinSlopeAuditInPerFt: condensateMinSlopeAudit,
  /** Conservative placement minimum condensate slope (`0.125"/ft`, exact 1/8"/ft). */
  condensateMinSlopePlacementInPerFt: round3(
    effectivePlacementThreshold(condensateMinSlopeAudit, condensateSlopePlacementMargin, 'min'),
  ),
  /** Required smooth rigid metallic duct material for domestic kitchen range hoods (IMC 505.4). */
  rangeHoodRequiredMaterial: (IMC_RANGE_HOOD_MATERIAL_RULE.params.requiredMaterials?.[0] ??
    'galvanized-sheet') as DuctMaterial,
  /** Forbidden non-metallic/flexible materials for kitchen range hood exhaust (IMC 505.4). */
  rangeHoodForbiddenMaterials: new Set<string>(
    IMC_RANGE_HOOD_MATERIAL_RULE.params.forbiddenMaterials ?? [],
  ) as ReadonlySet<string>,
  /** Minimum horizontal condenser clearance from entry doors (`2.4m`, IMC 304 / M1403). */
  condenserDoorClearanceM: IMC_CONDENSER_DOOR_CLEARANCE_RULE.params.minHorizontalM,
  /** Minimum horizontal condenser clearance from windows & exterior plumbing (`1.2m`). */
  condenserWindowPlumbingClearanceM:
    IMC_CONDENSER_WINDOW_PLUMBING_CLEARANCE_RULE.params.minHorizontalM,
  /** Minimum horizontal airflow/service separation between sibling condensers (`1.5m`). */
  condenserSiblingClearanceM: IMC_CONDENSER_SIBLING_CLEARANCE_RULE.params.minHorizontalM,
})
