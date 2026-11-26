/**
 * Pure ACCA Manual J, Manual D, Manual S, ASHRAE 62.2, and IECC Envelope Sizing Engine (`src/imc/sizing.ts`).
 * Distilled and upgraded from `roughin-suite/packages/climacore/ai/{calculator,insulation-calculator}.js`.
 * Framework-free: zero React, Three.js, or `@pascal-app/*` imports.
 */

import {
  CLIMATE_ZONES,
  type ClimateZone,
  type DuctMaterial,
  type DuctShape,
  type HvacDuctSystem,
  type HvacSystemType,
  MAX_DUCT_VELOCITY_FPM,
  type OccupancyType,
  REFRIGERANT_LINESET_TABLE,
  ROUND_DUCT_SIZES_IN,
  type RefrigerantType,
  round2,
} from './tables'

export type ManualJRoomInput = {
  id: string
  name: string
  category: string
  areaSqft: number
  windowSqft?: number
  exteriorWallLf?: number
  ceilingHeightFt?: number
}

export type ManualJRoomResult = {
  roomId: string
  roomName: string
  areaSqft: number
  heatingBtuh: number
  coolingSensibleBtuh: number
  coolingLatentBtuh: number
  coolingTotalBtuh: number
  designCfm: number
  recommendedRegisters: number
}

export type ManualJLoadResult = {
  climateZone: ClimateZone
  climateLabel: string
  occupancy: OccupancyType
  conditionedSqft: number
  wallR: number
  atticR: number
  insulationEffectiveness: 'low' | 'medium' | 'high'
  totalHeatingBtuh: number
  totalCoolingSensibleBtuh: number
  totalCoolingLatentBtuh: number
  totalCoolingBtuh: number
  recommendedTons: number
  designTotalCfm: number
  rooms: ManualJRoomResult[]
  codeRef: string
}

/**
 * Simplified ACCA Manual J room-by-room and whole-building load calculation.
 * Mirrors ClimaCore climate factors + insulation multiplier + solar window gain + humid latent fraction.
 */
export function calculateManualJLoad(params: {
  rooms: ReadonlyArray<ManualJRoomInput>
  climateZone?: ClimateZone
  occupancy?: OccupancyType
  wallR?: number
  atticR?: number
  windowRatio?: number
}): ManualJLoadResult {
  const {
    rooms,
    climateZone = '4A',
    occupancy = 'residential',
    wallR = 19,
    atticR = 38,
    windowRatio = 0.14,
  } = params

  const zone = CLIMATE_ZONES[climateZone] ?? CLIMATE_ZONES['4A']
  const insFactor = wallR < 13 ? 1.3 : wallR > 25 && atticR >= 49 ? 0.8 : 1.0
  const occupancyMult = occupancy === 'commercial' ? 1.25 : 1.0
  const latentShare = zone.humid ? 0.25 : 0.12

  let totalSqft = 0
  let totalHeat = 0
  let totalCoolSensible = 0
  let totalCoolLatent = 0

  const roomResults: ManualJRoomResult[] = []

  for (const r of rooms) {
    if (r.areaSqft <= 1) continue
    const cat = r.category.toLowerCase()
    const isUnconditioned = /garage|porch|patio|deck|exterior|attic/.test(cat)
    if (isUnconditioned) continue

    const ceilingMult = Math.max(0.85, (r.ceilingHeightFt ?? 8.5) / 8.5)
    const baselineWinSqft = r.areaSqft * windowRatio
    // Base zone.coolingBtuPerSqft already includes typical baseline glazing & latent humidity;
    // only add excess solar gain when explicit windowSqft exceeds baseline glazing ratio.
    const excessWinSqft = typeof r.windowSqft === 'number' ? Math.max(0, r.windowSqft - baselineWinSqft) : 0
    const kitchenApplianceGain = /kitchen/.test(cat) ? 1200 : 0
    const bathGain = /bath/.test(cat) ? 350 : 0

    const heatBtuh = Math.round(r.areaSqft * zone.heatingBtuPerSqft * insFactor * ceilingMult * occupancyMult)
    const coolTotal = Math.round(
      (r.areaSqft * zone.coolingBtuPerSqft * insFactor * ceilingMult +
        excessWinSqft * 35 +
        kitchenApplianceGain +
        bathGain) *
        occupancyMult,
    )
    const coolLatent = Math.round(coolTotal * latentShare)
    const coolSensible = coolTotal - coolLatent

    totalSqft += r.areaSqft
    totalHeat += heatBtuh
    totalCoolSensible += coolSensible
    totalCoolLatent += coolLatent

    roomResults.push({
      roomId: r.id,
      roomName: r.name,
      areaSqft: round2(r.areaSqft),
      heatingBtuh: heatBtuh,
      coolingSensibleBtuh: coolSensible,
      coolingLatentBtuh: coolLatent,
      coolingTotalBtuh: coolTotal,
      designCfm: 0,
      recommendedRegisters: 1,
    })
  }

  const totalCoolingBtuh = totalCoolSensible + totalCoolLatent
  // Standard nominal HVAC tonnage increments (1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0 ... up to commercial)
  const rawTons = Math.max(1.5, totalCoolingBtuh / 12000)
  const recommendedTons =
    rawTons <= 5.0 ? Math.ceil(rawTons * 2) / 2 : Math.ceil(rawTons)
  const coolingCfm = Math.round(recommendedTons * 400)
  // For heating-dominated cold climates, ensure design airflow keeps furnace temperature rise <= 55°F (below 70°F limit)
  const heatingCfm = totalHeat > 0 ? Math.ceil(totalHeat / (1.08 * 55) / 25) * 25 : 0
  const designTotalCfm = Math.max(coolingCfm, heatingCfm)

  // Prorate system airflow (400 CFM/ton) across rooms by dominant cooling/heating load
  const sumWeight = roomResults.reduce((s, r) => s + Math.max(r.coolingTotalBtuh, r.heatingBtuh), 0) || 1
  for (const rr of roomResults) {
    const share = Math.max(rr.coolingTotalBtuh, rr.heatingBtuh) / sumWeight
    rr.designCfm = Math.max(45, Math.round((designTotalCfm * share) / 5) * 5)
    rr.recommendedRegisters = Math.max(1, Math.min(4, Math.ceil(rr.designCfm / 145)))
  }

  return {
    climateZone,
    climateLabel: zone.label,
    occupancy,
    conditionedSqft: round2(totalSqft),
    wallR,
    atticR,
    insulationEffectiveness: insFactor <= 0.8 ? 'high' : insFactor >= 1.3 ? 'low' : 'medium',
    totalHeatingBtuh: totalHeat,
    totalCoolingSensibleBtuh: totalCoolSensible,
    totalCoolingLatentBtuh: totalCoolLatent,
    totalCoolingBtuh,
    recommendedTons,
    designTotalCfm,
    rooms: roomResults,
    codeRef: 'ACCA Manual J (8th Ed.) / IMC 312',
  }
}

/**
 * Huebscher's equation for rectangular-to-round equivalent duct diameter (inches):
 * d_e = 1.30 * (a * b)^0.625 / (a + b)^0.25
 */
export function rectangularEquivalentDiameterIn(widthIn: number, heightIn: number): number {
  const a = Math.max(2, widthIn)
  const b = Math.max(2, heightIn)
  return round2((1.3 * Math.pow(a * b, 0.625)) / Math.pow(a + b, 0.25))
}

/**
 * Compute air velocity (FPM) and friction loss rate (" wc per 100 ft) using ACCA Manual D / ASHRAE Fundamentals
 * Darcy-Weisbach approximation for standard air (0.075 lb/ft3).
 */
export function calculateDuctHydraulics(params: {
  cfm: number
  shape: DuctShape
  diameterIn?: number
  widthIn?: number
  heightIn?: number
  material?: DuctMaterial
  system?: HvacDuctSystem
  isTrunk?: boolean
  isReturn?: boolean
  occupancy?: OccupancyType
}): {
  areaSqft: number
  velocityFpm: number
  maxVelocityFpm: number
  velocityOk: boolean
  equivalentDiameterIn: number
  frictionRateInWgPer100Ft: number
  codeRef: string
} {
  const {
    cfm,
    shape,
    diameterIn = 6,
    widthIn = 14,
    heightIn = 8,
    material = 'galvanized-sheet',
    system,
    isTrunk = false,
    isReturn = false,
    occupancy = 'residential',
  } = params

  const areaSqIn =
    shape === 'round' ? Math.PI * Math.pow(Math.max(2, diameterIn) / 2, 2) : Math.max(4, widthIn) * Math.max(4, heightIn)
  const areaSqft = areaSqIn / 144
  const velocityFpm = areaSqft > 0 ? Math.round(cfm / areaSqft) : 0
  const eqDiamIn = shape === 'round' ? Math.max(2, diameterIn) : rectangularEquivalentDiameterIn(widthIn, heightIn)

  const limits = MAX_DUCT_VELOCITY_FPM[occupancy]
  const maxVelocityFpm =
    system === 'exhaust-duct'
      ? limits.exhaust
      : system === 'fresh-air-erv'
        ? limits.freshAir
        : isReturn || system === 'return-trunk' || system === 'return-branch'
          ? isTrunk || system === 'return-trunk'
            ? limits.returnTrunk
            : limits.returnBranch
          : isTrunk || system === 'supply-trunk'
            ? limits.supplyTrunk
            : limits.supplyBranch

  // Roughness multiplier: galvanized sheet = 1.0, ductboard = 1.35, flex duct = 1.65 (ACCA Manual D)
  const roughMult =
    material === 'flex-r8' || material === 'flex-r6'
      ? 1.65
      : material === 'ductboard'
        ? 1.35
        : 1.0

  // ASHRAE / Manual D equal-friction fit: f_100 ≈ 0.109136 * Q^1.9 / d^5.02 * roughMult
  const frictionRate =
    cfm > 0
      ? round2(((0.109136 * Math.pow(cfm, 1.9)) / Math.pow(Math.max(3, eqDiamIn), 5.02)) * roughMult)
      : 0

  return {
    areaSqft: round2(areaSqft),
    velocityFpm,
    maxVelocityFpm,
    velocityOk: velocityFpm <= maxVelocityFpm,
    equivalentDiameterIn: eqDiamIn,
    frictionRateInWgPer100Ft: frictionRate,
    codeRef: 'ACCA Manual D / IMC 603',
  }
}

/**
 * Size a round or rectangular duct for a target airflow (CFM) honoring ACCA Manual D equal-friction
 * (<= 0.10" wc/100ft) and maximum quiet velocity caps.
 */
export function sizeDuctForCfm(params: {
  cfm: number
  shape?: DuctShape
  material?: DuctMaterial
  isTrunk?: boolean
  isReturn?: boolean
  occupancy?: OccupancyType
  maxHeightIn?: number
  targetFrictionRate?: number
}): {
  shape: DuctShape
  diameterIn: number
  widthIn: number
  heightIn: number
  velocityFpm: number
  frictionRateInWgPer100Ft: number
  codeRef: string
} {
  const {
    cfm,
    shape = 'round',
    material = 'galvanized-sheet',
    isTrunk = false,
    isReturn = false,
    occupancy = 'residential',
    maxHeightIn = 8,
    targetFrictionRate = 0.1,
  } = params

  const safeCfm = Math.max(30, cfm)

  if (shape === 'round') {
    for (const d of ROUND_DUCT_SIZES_IN) {
      const hyd = calculateDuctHydraulics({
        cfm: safeCfm,
        shape: 'round',
        diameterIn: d,
        material,
        isTrunk,
        isReturn,
        occupancy,
      })
      if (hyd.velocityOk && hyd.frictionRateInWgPer100Ft <= targetFrictionRate * 1.15) {
        return {
          shape: 'round',
          diameterIn: d,
          widthIn: d,
          heightIn: d,
          velocityFpm: hyd.velocityFpm,
          frictionRateInWgPer100Ft: hyd.frictionRateInWgPer100Ft,
          codeRef: hyd.codeRef,
        }
      }
    }
    const maxD = ROUND_DUCT_SIZES_IN[ROUND_DUCT_SIZES_IN.length - 1]!
    const hyd = calculateDuctHydraulics({ cfm: safeCfm, shape: 'round', diameterIn: maxD, material, isTrunk, isReturn, occupancy })
    return {
      shape: 'round',
      diameterIn: maxD,
      widthIn: maxD,
      heightIn: maxD,
      velocityFpm: hyd.velocityFpm,
      frictionRateInWgPer100Ft: hyd.frictionRateInWgPer100Ft,
      codeRef: hyd.codeRef,
    }
  }

  // Rectangular trunk sizing (prefer height <= maxHeightIn, step width in 2" increments, aspect ratio <= 4:1 per Manual D;
  // step height up in 2" increments if airflow exceeds what maxHeightIn can carry quietly).
  const baseHeight = Math.max(6, Math.min(14, Math.floor(maxHeightIn / 2) * 2))
  for (let height = baseHeight; height <= 24; height += 2) {
    const maxW = Math.min(48, height * 4)
    for (let width = Math.max(8, height); width <= maxW; width += 2) {
      const hyd = calculateDuctHydraulics({
        cfm: safeCfm,
        shape: 'rectangular',
        widthIn: width,
        heightIn: height,
        material,
        isTrunk,
        isReturn,
        occupancy,
      })
      if (hyd.velocityOk && hyd.frictionRateInWgPer100Ft <= targetFrictionRate * 1.15) {
        return {
          shape: 'rectangular',
          diameterIn: Math.ceil(hyd.equivalentDiameterIn),
          widthIn: width,
          heightIn: height,
          velocityFpm: hyd.velocityFpm,
          frictionRateInWgPer100Ft: hyd.frictionRateInWgPer100Ft,
          codeRef: hyd.codeRef,
        }
      }
    }
  }

  const fallbackW = 48
  const fallbackH = 24
  const hyd = calculateDuctHydraulics({
    cfm: safeCfm,
    shape: 'rectangular',
    widthIn: fallbackW,
    heightIn: fallbackH,
    material,
    isTrunk,
    isReturn,
    occupancy,
  })
  return {
    shape: 'rectangular',
    diameterIn: Math.ceil(hyd.equivalentDiameterIn),
    widthIn: fallbackW,
    heightIn: fallbackH,
    velocityFpm: hyd.velocityFpm,
    frictionRateInWgPer100Ft: hyd.frictionRateInWgPer100Ft,
    codeRef: hyd.codeRef,
  }
}

/**
 * Size HVAC equipment specifications (ACCA Manual S, SEER2/HSPF2, NEC 440 MCA/MOP breaker, refrigerant lineset).
 */
export function sizeHvacEquipment(params: {
  coolingTons: number
  heatingBtuh: number
  systemType?: HvacSystemType
  refrigerant?: RefrigerantType
  climateZone?: ClimateZone
}): {
  coolingTons: number
  coolingBtuh: number
  heatingOutputBtuh: number
  furnaceInputBtuh: number
  minSeer2: number
  minHspf2: number
  condenserBreakerAmps: number
  airHandlerBreakerAmps: number
  liquidLineIn: string
  suctionLineIn: string
  maxLinesetEquivFt: number
  refrigerant: RefrigerantType
  condenserPadIn: string
  thermostatCable: '18/8' | '18/5'
  codeRef: string
} {
  const {
    coolingTons,
    heatingBtuh,
    systemType = 'split-heat-pump',
    refrigerant = 'R-454B',
    climateZone = '4A',
  } = params

  const tons = Math.max(1.5, coolingTons)
  const isSouth = climateZone.startsWith('1') || climateZone.startsWith('2') || climateZone.startsWith('3')
  const minSeer2 = isSouth ? (tons < 3.75 ? 15.2 : 14.3) : 14.3
  const minHspf2 = 7.5
  const coolingBtuh = Math.round(tons * 12000)

  // Standard residential/light-commercial condenser MOP breaker sizing (NEC 440.22 / 440.32)
  const condenserBreakerAmps =
    tons <= 2.0 ? 25 : tons <= 3.0 ? 35 : tons <= 4.0 ? 45 : tons <= 5.0 ? 60 : Math.min(125, Math.ceil((tons * 12) / 10) * 10)

  // Electric air handler backup heat-strip kit (5/10/15/20 kW) vs gas furnace blower (120V 15A)
  const airHandlerBreakerAmps =
    systemType === 'split-gas-furnace'
      ? 15
      : tons <= 2.5
        ? 40
        : tons <= 3.5
          ? 60
          : tons <= 5.0
            ? 90
            : 125

  // Furnace input capacity (96% AFUE, rounded to standard 20 kBTU/h steps)
  const furnaceInputBtuh =
    systemType === 'split-gas-furnace'
      ? Math.max(40000, Math.ceil((heatingBtuh / 0.96) / 20000) * 20000)
      : 0

  const lineset =
    REFRIGERANT_LINESET_TABLE.find((r) => tons <= r.maxTons) ??
    REFRIGERANT_LINESET_TABLE[REFRIGERANT_LINESET_TABLE.length - 1]!

  return {
    coolingTons: tons,
    coolingBtuh,
    heatingOutputBtuh: systemType === 'split-gas-furnace' ? Math.round(furnaceInputBtuh * 0.96) : coolingBtuh,
    furnaceInputBtuh,
    minSeer2,
    minHspf2,
    condenserBreakerAmps,
    airHandlerBreakerAmps,
    liquidLineIn: lineset.liquidIn,
    suctionLineIn: lineset.suctionIn,
    maxLinesetEquivFt: lineset.maxEquivLengthFt,
    refrigerant,
    condenserPadIn: tons <= 3.0 ? '30" x 30"' : '36" x 36"',
    thermostatCable: systemType === 'split-heat-pump' ? '18/8' : '18/5',
    codeRef: 'ACCA Manual S / DOE 2023 SEER2 / NEC Art. 440',
  }
}

/**
 * ASHRAE 62.2 / IMC 403.3 whole-house mechanical ventilation & local spot exhaust requirements.
 */
export function calculateAshrae622Ventilation(params: {
  conditionedSqft: number
  bedrooms: number
  bathrooms: number
  hasKitchen?: boolean
}): {
  continuousFreshAirCfm: number
  bathExhaustCfmEach: number
  kitchenExhaustCfm: number
  recommendedErvCfm: number
  codeRef: string
} {
  const { conditionedSqft, bedrooms, bathrooms, hasKitchen = true } = params
  // ASHRAE 62.2-2022: Q_tot = 0.03 * A_floor + 7.5 * (N_br + 1)
  const continuousFreshAirCfm = Math.max(
    30,
    Math.ceil((0.03 * conditionedSqft + 7.5 * (Math.max(1, bedrooms) + 1)) / 5) * 5,
  )
  return {
    continuousFreshAirCfm,
    bathExhaustCfmEach: bathrooms > 0 ? 50 : 0, // 50 CFM intermittent or 20 CFM continuous (IMC Table 403.3.1.1)
    kitchenExhaustCfm: hasKitchen ? 100 : 0, // 100 CFM intermittent range hood (ASHRAE 62.2)
    recommendedErvCfm: Math.max(70, Math.ceil((continuousFreshAirCfm * 1.25) / 10) * 10),
    codeRef: 'ASHRAE 62.2 / IMC Table 403.3.1.1',
  }
}

/**
 * IECC Building Envelope & Insulation Takeoff (distilled from `climacore/ai/insulation-calculator.js`).
 */
export type InsulationTakeoffResult = {
  climateZone: ClimateZone
  wallRValue: string
  atticRValue: string
  wallNetSqft: number
  wallBattRolls: number
  atticSqft: number
  blownInBags: number
  rimJoistBoardFt: number
  sprayFoamKits: number
  expandingFoamCans: number
  acousticCaulkTubes: number
  vaporBarrierRolls: number
  codeRef: string
}

export function calculateIeccInsulationTakeoff(params: {
  conditionedSqft: number
  exteriorWallSqft: number
  perimeterLf: number
  climateZone?: ClimateZone
  hasCrawlspace?: boolean
  mepPenetrationCount?: number
}): InsulationTakeoffResult {
  const {
    conditionedSqft,
    exteriorWallSqft,
    perimeterLf,
    climateZone = '4A',
    hasCrawlspace = false,
    mepPenetrationCount = 24,
  } = params

  const zone = CLIMATE_ZONES[climateZone] ?? CLIMATE_ZONES['4A']
  const wallR = zone.ieccWallR
  const atticR = zone.ieccAtticR

  // Batt roll coverage (sqft/roll at 15" width with 5% waste)
  const battCoverage = wallR >= 20 ? 40 : 49
  const wallNetSqft = round2(Math.max(0, exteriorWallSqft * 0.85))
  const wallBattRolls = Math.ceil((wallNetSqft / battCoverage) * 1.05)

  // Blown-in cellulose coverage (sqft/bag)
  const blownCoverage = atticR >= 60 ? 26 : atticR >= 49 ? 31 : atticR >= 38 ? 40 : 53
  const atticSqft = round2(Math.max(0, conditionedSqft))
  const blownInBags = Math.ceil(atticSqft / blownCoverage)

  // Rim joist closed-cell spray foam (2" thick, 10" rim height, 600 bd-ft/kit)
  const rimJoistSqft = perimeterLf * (10 / 12)
  const rimJoistBoardFt = round2(rimJoistSqft * 2)
  const sprayFoamKits = rimJoistBoardFt > 0 ? Math.ceil(rimJoistBoardFt / 600) : 0
  const expandingFoamCans = Math.max(2, Math.ceil(mepPenetrationCount / 15))
  const acousticCaulkTubes = Math.max(2, Math.ceil((perimeterLf * 2) / 30))
  const vaporBarrierRolls = hasCrawlspace ? Math.ceil((conditionedSqft * 1.1) / 1000) : 0

  return {
    climateZone,
    wallRValue: `R-${wallR}`,
    atticRValue: `R-${atticR}`,
    wallNetSqft,
    wallBattRolls,
    atticSqft,
    blownInBags,
    rimJoistBoardFt,
    sprayFoamKits,
    expandingFoamCans,
    acousticCaulkTubes,
    vaporBarrierRolls,
    codeRef: 'IECC Table R402.1.3',
  }
}
