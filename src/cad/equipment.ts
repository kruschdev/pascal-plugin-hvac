/**
 * 12 Clean-Room MIT Procedural 3D CAD Builders for HVAC Mechanical Equipment (`src/cad/equipment.ts`).
 * Editor-free and React-free: zero React or `@pascal-app/*` imports.
 */

import { BoxGeometry, CylinderGeometry, Group, Mesh } from 'three'
import type { HvacEquipmentKind } from '../imc/tables'
import { createHvacMaterialPool } from './materials'

export function buildHvacEquipmentCad(params: {
  equipmentKind: HvacEquipmentKind
  coolingTons?: number
  hasSecondaryDrainPan?: boolean
}): Group {
  const { equipmentKind, coolingTons = 3, hasSecondaryDrainPan = true } = params
  const pool = createHvacMaterialPool()
  const g = new Group()
  g.name = `hvac-equipment-${equipmentKind}`

  const scale = coolingTons >= 4 ? 1.12 : coolingTons <= 2 ? 0.92 : 1.0

  if (equipmentKind === 'heat-pump-condenser' || equipmentKind === 'ac-condenser') {
    const w = 0.8 * scale
    const h = 0.88 * scale
    // Composite condenser pad
    const pad = new Mesh(new BoxGeometry(w + 0.14, 0.06, w + 0.14), pool.concretePad)
    pad.position.y = 0.03
    g.add(pad)
    // Louvered outer condenser cabinet
    const body = new Mesh(new BoxGeometry(w, h, w), pool.cabinetSlate)
    body.position.y = 0.06 + h / 2
    g.add(body)
    // Top fan shroud & blades
    const shroud = new Mesh(new CylinderGeometry(w * 0.36, w * 0.38, 0.05, 20), pool.fanBlack)
    shroud.position.y = 0.06 + h + 0.025
    g.add(shroud)
    // Service valves & copper stubs on side
    for (const dz of [-0.08, 0.08]) {
      const stub = new Mesh(new CylinderGeometry(0.015, 0.015, 0.12, 10), pool.copperBare)
      stub.rotation.z = Math.PI / 2
      stub.position.set(-w / 2 - 0.05, 0.24, dz)
      g.add(stub)
    }
    return g
  }

  if (equipmentKind === 'air-handler' || equipmentKind === 'gas-furnace-96' || equipmentKind === 'gas-furnace-80') {
    const w = 0.54 * scale
    const h = 1.38
    const d = equipmentKind === 'air-handler' ? 0.56 : 0.72
    if (hasSecondaryDrainPan) {
      const pan = new Mesh(new BoxGeometry(w + 0.12, 0.05, d + 0.12), pool.galvanizedSheet)
      pan.position.y = 0.025
      g.add(pan)
    }
    const cabinet = new Mesh(
      new BoxGeometry(w, h, d),
      equipmentKind === 'air-handler' ? pool.cabinetSlate : pool.cabinetLight,
    )
    cabinet.position.y = 0.05 + h / 2
    g.add(cabinet)
    // Evaporator A-coil section badge at top
    const coilCap = new Mesh(new BoxGeometry(w + 0.01, 0.36, d + 0.01), pool.galvanizedSheet)
    coilCap.position.y = 0.05 + h - 0.18
    g.add(coilCap)
    // Condensate 3/4" PVC stub
    const cond = new Mesh(new CylinderGeometry(0.014, 0.014, 0.14, 10), pool.condensateWhite)
    cond.rotation.z = Math.PI / 2
    cond.position.set(w / 2 + 0.06, 0.95, 0.08)
    g.add(cond)
    // Flue pipe for gas furnaces
    if (equipmentKind === 'gas-furnace-96' || equipmentKind === 'gas-furnace-80') {
      const flueMat = equipmentKind === 'gas-furnace-96' ? pool.condensateWhite : pool.galvanizedSheet
      const flue = new Mesh(new CylinderGeometry(0.04, 0.04, 0.45, 12), flueMat)
      flue.position.set(-w * 0.22, 0.05 + h + 0.22, -d * 0.2)
      g.add(flue)
    }
    return g
  }

  if (equipmentKind === 'rooftop-package-unit') {
    const curb = new Mesh(new BoxGeometry(1.5, 0.25, 1.1), pool.galvanizedSheet)
    curb.position.y = 0.125
    g.add(curb)
    const body = new Mesh(new BoxGeometry(1.55, 0.95, 1.15), pool.cabinetLight)
    body.position.y = 0.25 + 0.475
    g.add(body)
    for (const dx of [-0.35, 0.35]) {
      const fan = new Mesh(new CylinderGeometry(0.28, 0.3, 0.06, 18), pool.fanBlack)
      fan.position.set(dx, 1.23, 0)
      g.add(fan)
    }
    return g
  }

  if (equipmentKind === 'mini-split-outdoor') {
    const pad = new Mesh(new BoxGeometry(1.0, 0.05, 0.45), pool.concretePad)
    pad.position.y = 0.025
    g.add(pad)
    const body = new Mesh(new BoxGeometry(0.92, 0.76, 0.36), pool.enamelWhite)
    body.position.y = 0.05 + 0.38
    g.add(body)
    const grille = new Mesh(new CylinderGeometry(0.24, 0.24, 0.03, 18), pool.fanBlack)
    grille.rotation.x = Math.PI / 2
    grille.position.set(-0.14, 0.45, 0.185)
    g.add(grille)
    return g
  }

  if (equipmentKind === 'mini-split-indoor') {
    const body = new Mesh(new BoxGeometry(0.88, 0.3, 0.24), pool.enamelWhite)
    g.add(body)
    const louver = new Mesh(new BoxGeometry(0.76, 0.04, 0.04), pool.cabinetSlate)
    louver.position.set(0, -0.1, 0.11)
    g.add(louver)
    return g
  }

  if (equipmentKind === 'erv-ventilator' || equipmentKind === 'dehumidifier-whole-house') {
    const body = new Mesh(
      new BoxGeometry(0.62, 0.46, 0.42),
      equipmentKind === 'erv-ventilator' ? pool.freshGreen : pool.cabinetSlate,
    )
    g.add(body)
    for (const dx of [-0.18, 0.18]) {
      const collar = new Mesh(new CylinderGeometry(0.075, 0.075, 0.12, 12), pool.galvanizedSheet)
      collar.rotation.z = Math.PI / 2
      collar.position.set(dx >= 0 ? 0.36 : -0.36, 0.06, 0)
      g.add(collar)
    }
    return g
  }

  if (equipmentKind === 'bath-exhaust-fan') {
    const housing = new Mesh(new BoxGeometry(0.28, 0.16, 0.28), pool.galvanizedSheet)
    housing.position.y = 0.08
    g.add(housing)
    const grille = new Mesh(new BoxGeometry(0.32, 0.025, 0.32), pool.enamelWhite)
    grille.position.y = -0.01
    g.add(grille)
    return g
  }

  // range-hood
  const canopy = new Mesh(new BoxGeometry(0.76, 0.18, 0.5), pool.galvanizedSheet)
  g.add(canopy)
  const chimney = new Mesh(new BoxGeometry(0.26, 0.55, 0.24), pool.galvanizedSheet)
  chimney.position.set(0, 0.36, -0.12)
  g.add(chimney)
  return g
}
