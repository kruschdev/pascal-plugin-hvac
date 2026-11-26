import { describe, expect, test } from 'bun:test'
import {
  CLIMATE_ZONES,
  calculateAshrae622Ventilation,
  calculateDuctHydraulics,
  calculateIeccInsulationTakeoff,
  calculateManualJLoad,
  rectangularEquivalentDiameterIn,
  sizeDuctForCfm,
  sizeHvacEquipment,
} from '../imc'

describe('IMC / ACCA Manual J-D-S / ASHRAE 62.2 / IECC Sizing Engine', () => {
  test('All 14 ASHRAE climate zones (1A..7) are defined with valid IECC R-values', () => {
    const zones = Object.keys(CLIMATE_ZONES)
    expect(zones.length).toBe(14)
    for (const z of zones) {
      const spec = CLIMATE_ZONES[z as keyof typeof CLIMATE_ZONES]
      expect(spec.ieccAtticDuctR).toBeGreaterThanOrEqual(8)
      expect(spec.ieccWallR).toBeGreaterThanOrEqual(13)
      expect(spec.ieccAtticR).toBeGreaterThanOrEqual(30)
      expect(spec.heatingBtuPerSqft).toBeGreaterThan(0)
      expect(spec.coolingBtuPerSqft).toBeGreaterThan(0)
    }
  })

  test('Simplified ACCA Manual J scales sensibly with climate zone, area, and ceiling height', () => {
    const rooms = [
      { id: 'r1', name: 'Living Room', category: 'living' as const, areaSqft: 450, ceilingHeightFt: 9 },
      { id: 'r2', name: 'Kitchen', category: 'kitchen' as const, areaSqft: 250, ceilingHeightFt: 9 },
      { id: 'r3', name: 'Primary Bedroom', category: 'bedroom' as const, areaSqft: 300, ceilingHeightFt: 9 },
      { id: 'r4', name: 'Bedroom 2', category: 'bedroom' as const, areaSqft: 200, ceilingHeightFt: 9 },
      { id: 'r5', name: 'Bathroom', category: 'bathroom' as const, areaSqft: 100, ceilingHeightFt: 9 },
    ]
    const miami = calculateManualJLoad({ rooms, climateZone: '1A', occupancy: 'residential' })
    const minneapolis = calculateManualJLoad({ rooms, climateZone: '6A', occupancy: 'residential' })

    expect(miami.conditionedSqft).toBe(1300)
    expect(miami.totalCoolingBtuh).toBeGreaterThan(minneapolis.totalCoolingBtuh)
    expect(minneapolis.totalHeatingBtuh).toBeGreaterThan(miami.totalHeatingBtuh)
    expect(miami.recommendedTons).toBeGreaterThanOrEqual(1.5)
    expect(miami.designTotalCfm).toBeGreaterThanOrEqual(600)
    expect(miami.rooms.length).toBe(5)
    for (const r of miami.rooms) {
      expect(r.coolingSensibleBtuh + r.coolingLatentBtuh).toBe(r.coolingTotalBtuh)
      expect(r.designCfm).toBeGreaterThan(0)
      expect(r.recommendedRegisters).toBeGreaterThanOrEqual(1)
    }
  })

  test('Huebscher rectangular equivalent diameter and Manual D equal-friction duct sizing respect quiet velocity caps', () => {
    // 14" x 8" rectangular duct Deq ~= 11.4"
    const deq = rectangularEquivalentDiameterIn(14, 8)
    expect(deq).toBeGreaterThan(11.0)
    expect(deq).toBeLessThan(12.0)

    // 1200 CFM residential supply trunk -> velocity <= 900 FPM
    const trunk = sizeDuctForCfm({
      cfm: 1200,
      shape: 'rectangular',
      material: 'galvanized-sheet',
      isTrunk: true,
      isReturn: false,
      occupancy: 'residential',
      maxHeightIn: 8,
    })
    expect(trunk.velocityFpm).toBeLessThanOrEqual(900)
    expect(trunk.heightIn).toBeLessThanOrEqual(8)
    expect(trunk.widthIn).toBeGreaterThanOrEqual(16)

    // 140 CFM residential supply branch -> flex R-8 round <= 700 FPM
    const branch = sizeDuctForCfm({
      cfm: 140,
      shape: 'round',
      material: 'flex-r8',
      isTrunk: false,
      isReturn: false,
      occupancy: 'residential',
    })
    expect(branch.diameterIn).toBeGreaterThanOrEqual(6)
    expect(branch.velocityFpm).toBeLessThanOrEqual(700)

    // Deliberately undersized 4" duct at 250 CFM must fail velocity check
    const undersized = calculateDuctHydraulics({
      cfm: 250,
      shape: 'round',
      diameterIn: 4,
      material: 'galvanized-sheet',
      isTrunk: false,
      isReturn: false,
      occupancy: 'residential',
    })
    expect(undersized.velocityOk).toBe(false)
    expect(undersized.velocityFpm).toBeGreaterThan(700)
  })

  test('ACCA Manual S selects linesets, furnace BTU, SEER2/HSPF2, and thermostat cable', () => {
    const hp = sizeHvacEquipment({
      coolingTons: 3.5,
      heatingBtuh: 42000,
      systemType: 'split-heat-pump',
      refrigerant: 'R-454B',
      climateZone: '4A',
    })
    expect(hp.coolingTons).toBe(3.5)
    expect(hp.furnaceInputBtuh).toBe(0)
    expect(hp.liquidLineIn).toBe('3/8"')
    expect(hp.suctionLineIn).toBe('7/8"')
    expect(hp.thermostatCable).toContain('18/8')

    const gas = sizeHvacEquipment({
      coolingTons: 3,
      heatingBtuh: 68000,
      systemType: 'split-gas-furnace',
      climateZone: '5A',
    })
    expect(gas.furnaceInputBtuh).toBeGreaterThanOrEqual(80000)
    expect(gas.heatingOutputBtuh).toBeGreaterThanOrEqual(68000)
  })

  test('ASHRAE 62.2 ventilation and IECC envelope insulation takeoff produce realistic counts', () => {
    const vent = calculateAshrae622Ventilation({
      conditionedSqft: 2000,
      bedrooms: 3,
      bathrooms: 2,
      hasKitchen: true,
    })
    // 0.03 * 2000 + 7.5 * (3 + 1) = 60 + 30 = 90 CFM
    expect(vent.continuousFreshAirCfm).toBe(90)
    expect(vent.recommendedErvCfm).toBeGreaterThanOrEqual(90)
    expect(vent.bathExhaustCfmEach).toBe(50)
    expect(vent.kitchenExhaustCfm).toBe(100)

    const ins = calculateIeccInsulationTakeoff({
      conditionedSqft: 2000,
      exteriorWallSqft: 1600,
      perimeterLf: 180,
      climateZone: '5A',
    })
    expect(ins.wallBattRolls).toBeGreaterThan(20)
    expect(ins.blownInBags).toBeGreaterThan(40)
    expect(ins.sprayFoamKits).toBeGreaterThanOrEqual(1)
    expect(ins.atticRValue).toContain('R-49')
  })
})
