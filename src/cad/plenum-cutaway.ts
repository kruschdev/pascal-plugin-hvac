/**
 * 4 Plenum Builders + Signature Interactive 3D Air Handler, Supply/Return Plenum,
 * & Joist-Bay Ductwork Cutaway (`src/cad/plenum-cutaway.ts`).
 * Built open-front so the evaporator A-coil, blower wheel, MERV-13 filter rack, secondary pan,
 * and blue/violet plenums are cleanly visible with zero backbox occlusion!
 * Editor-free and React-free: zero React or `@pascal-app/*` imports.
 */

import { BoxGeometry, CylinderGeometry, Group, Mesh } from 'three'
import type { HvacPlenumKind } from '../imc/tables'
import { createHvacMaterialPool } from './materials'

export type HvacCutawayViewMode = 'joist-bay-cutaway' | 'open-plenum' | 'cabinet-closed'

export type DuctBranchAssignment = {
  index: number
  label: string
  cfm: number
  diameterIn: number
  side: 'supply' | 'return'
}

export function buildHvacPlenumCad(params: {
  plenumKind: HvacPlenumKind
  widthIn?: number
  heightIn?: number
  depthIn?: number
}): Group {
  const { plenumKind, widthIn = 18, heightIn = 10, depthIn = 22 } = params
  const pool = createHvacMaterialPool()
  const g = new Group()
  g.name = `hvac-plenum-${plenumKind}`

  const w = Math.max(0.24, widthIn * 0.0254)
  const h = Math.max(0.2, heightIn * 0.0254)
  const d = Math.max(0.24, depthIn * 0.0254)

  const mat =
    plenumKind === 'supply-plenum'
      ? pool.supplyBlue
      : plenumKind === 'return-plenum'
        ? pool.returnViolet
        : plenumKind === 'zone-damper-manifold'
          ? pool.galvanizedSheet
          : pool.freshGreen

  const box = new Mesh(new BoxGeometry(w, h, d), mat)
  g.add(box)

  if (plenumKind === 'zone-damper-manifold') {
    for (const dx of [-w * 0.3, 0, w * 0.3]) {
      const collar = new Mesh(new CylinderGeometry(0.075, 0.075, 0.14, 12), pool.galvanizedSheet)
      collar.position.set(dx, h / 2 + 0.07, 0)
      const actuator = new Mesh(new BoxGeometry(0.06, 0.06, 0.06), pool.supplyBlue)
      actuator.position.set(dx + 0.09, h / 2 + 0.07, 0)
      g.add(collar, actuator)
    }
  }
  return g
}

/**
 * Interactive 3D Air Handler, Supply/Return Plenum & Open-Front Joist-Bay Ductwork Cutaway.
 */
export function buildWiredAirHandlerCutawayCad(params: {
  coolingTons?: number
  viewMode?: HvacCutawayViewMode
  branches?: ReadonlyArray<DuctBranchAssignment>
}): Group {
  const { coolingTons = 3, viewMode = 'joist-bay-cutaway', branches = [] } = params
  const pool = createHvacMaterialPool()
  const g = new Group()
  g.name = `hvac-air-handler-cutaway-${viewMode}`

  // Secondary galvanized overflow pan + SS2 float switch
  const pan = new Mesh(new BoxGeometry(0.76, 0.04, 0.68), pool.galvanizedSheet)
  pan.position.set(0, -0.68, 0)
  const floatSw = new Mesh(new CylinderGeometry(0.025, 0.025, 0.08, 12), pool.dangerRed)
  floatSw.position.set(0.32, -0.64, 0.24)
  g.add(pan, floatSw)

  // Open-front 5-sided Air Handler cabinet (back, left, right, top, bottom — front open unless cabinet-closed!)
  const cabW = 0.56
  const cabH = 1.15
  const cabD = 0.54
  const back = new Mesh(new BoxGeometry(cabW, cabH, 0.02), pool.cabinetSlate)
  back.position.set(0, -0.08, -cabD / 2)
  const left = new Mesh(new BoxGeometry(0.02, cabH, cabD), pool.cabinetSlate)
  left.position.set(-cabW / 2, -0.08, 0)
  const right = new Mesh(new BoxGeometry(0.02, cabH, cabD), pool.cabinetSlate)
  right.position.set(cabW / 2, -0.08, 0)
  const bottom = new Mesh(new BoxGeometry(cabW, 0.02, cabD), pool.cabinetSlate)
  bottom.position.set(0, -0.65, 0)
  g.add(back, left, right, bottom)

  if (viewMode === 'cabinet-closed') {
    const frontDoor = new Mesh(new BoxGeometry(cabW, cabH, 0.02), pool.cabinetLight)
    frontDoor.position.set(0, -0.08, cabD / 2)
    g.add(frontDoor)
  } else {
    // Exposed Internal Components: MERV-13 filter rack, ECM blower wheel, Evaporator A-Coil!
    const filter = new Mesh(new BoxGeometry(0.46, 0.06, 0.44), pool.filterBlue)
    filter.position.set(0, -0.52, 0)
    const blowerHousing = new Mesh(new CylinderGeometry(0.18, 0.18, 0.24, 18), pool.fanBlack)
    blowerHousing.rotation.z = Math.PI / 2
    blowerHousing.position.set(0, -0.22, -0.04)
    // Evaporator A-coil sloped slabs
    const coilL = new Mesh(new BoxGeometry(0.04, 0.36, 0.42), pool.coilAluminum)
    coilL.rotation.z = -0.34
    coilL.position.set(-0.1, 0.22, 0)
    const coilR = new Mesh(new BoxGeometry(0.04, 0.36, 0.42), pool.coilAluminum)
    coilR.rotation.z = 0.34
    coilR.position.set(0.1, 0.22, 0)
    // Copper refrigerant suction & liquid stubs
    const suction = new Mesh(new CylinderGeometry(0.018, 0.018, 0.32, 10), pool.copperInsulated)
    suction.rotation.z = Math.PI / 2
    suction.position.set(0.36, 0.18, 0.12)
    const liquid = new Mesh(new CylinderGeometry(0.009, 0.009, 0.32, 10), pool.copperBare)
    liquid.rotation.z = Math.PI / 2
    liquid.position.set(0.36, 0.12, 0.12)
    g.add(filter, blowerHousing, coilL, coilR, suction, liquid)
  }

  // Supply Plenum (Top — Blue) + Main Supply Trunk Takeoff
  const supplyPlenum = new Mesh(new BoxGeometry(0.52, 0.34, 0.5), pool.supplyBlue)
  supplyPlenum.position.set(0, 0.66, 0)
  g.add(supplyPlenum)

  const trunkW = coolingTons >= 4 ? 0.52 : 0.42
  const supplyTrunk = new Mesh(new BoxGeometry(0.95, 0.22, trunkW * 0.65), pool.supplyBlue)
  supplyTrunk.position.set(0.7, 0.72, 0)
  g.add(supplyTrunk)

  // Supply Branch Collars & Manual Balancing Dampers
  const branchCount = Math.max(3, Math.min(6, branches.filter((b) => b.side === 'supply').length || 4))
  for (let i = 0; i < branchCount; i++) {
    const x = 0.38 + i * 0.22
    const collar = new Mesh(new CylinderGeometry(0.06, 0.06, 0.26, 12), pool.supplyBranchCyan)
    collar.rotation.x = Math.PI / 2
    collar.position.set(x, 0.72, 0.24)
    const damperHandle = new Mesh(new BoxGeometry(0.06, 0.012, 0.015), pool.dangerRed)
    damperHandle.position.set(x, 0.79, 0.2)
    g.add(collar, damperHandle)
  }

  // Return Drop Plenum (Left — Violet)
  const returnDrop = new Mesh(new BoxGeometry(0.28, 1.05, 0.44), pool.returnViolet)
  returnDrop.position.set(-0.46, -0.1, 0)
  const returnBoot = new Mesh(new BoxGeometry(0.22, 0.32, 0.42), pool.returnViolet)
  returnBoot.position.set(-0.34, -0.48, 0)
  g.add(returnDrop, returnBoot)

  // Joist-bay wooden framing cutaway overhead when in `joist-bay-cutaway` mode
  if (viewMode === 'joist-bay-cutaway') {
    for (let j = -1; j <= 3; j++) {
      const joist = new Mesh(new BoxGeometry(0.045, 0.24, 0.85), pool.woodJoist)
      joist.position.set(-0.45 + j * 0.4064, 0.96, 0)
      g.add(joist)
    }
    const subfloor = new Mesh(new BoxGeometry(1.9, 0.025, 0.88), pool.woodJoist)
    subfloor.position.set(0.25, 1.09, 0)
    g.add(subfloor)
  }

  return g
}
