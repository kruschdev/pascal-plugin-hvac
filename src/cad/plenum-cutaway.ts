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
  const top = new Mesh(new BoxGeometry(cabW, 0.02, cabD), pool.cabinetSlate)
  top.position.set(0, 0.495, 0)
  g.add(back, left, right, bottom, top)

  if (viewMode === 'cabinet-closed') {
    const frontDoor = new Mesh(new BoxGeometry(cabW, cabH, 0.02), pool.cabinetLight)
    frontDoor.position.set(0, -0.08, cabD / 2)
    g.add(frontDoor)
  } else {
    // Exposed Internal Components: MERV-13 filter rack, ECM blower deck & housing, Evaporator A-Coil!
    const filter = new Mesh(new BoxGeometry(0.54, 0.06, 0.48), pool.filterBlue)
    filter.position.set(0, -0.52, -0.02)
    const blowerDeck = new Mesh(new BoxGeometry(0.54, 0.02, 0.5), pool.galvanizedSheet)
    blowerDeck.position.set(0, -0.4, -0.01)
    const blowerHousing = new Mesh(new CylinderGeometry(0.18, 0.18, 0.24, 18), pool.fanBlack)
    blowerHousing.rotation.z = Math.PI / 2
    blowerHousing.position.set(0, -0.22, -0.04)
    const coilDeck = new Mesh(new BoxGeometry(0.54, 0.025, 0.5), pool.galvanizedSheet)
    coilDeck.position.set(0, 0.03, -0.01)
    // Evaporator A-coil sloped slabs joined cleanly at apex and seated on coilDeck
    const coilL = new Mesh(new BoxGeometry(0.04, 0.38, 0.44), pool.coilAluminum)
    coilL.rotation.z = -0.36
    coilL.position.set(-0.075, 0.21, -0.02)
    const coilR = new Mesh(new BoxGeometry(0.04, 0.38, 0.44), pool.coilAluminum)
    coilR.rotation.z = 0.36
    coilR.position.set(0.075, 0.21, -0.02)
    const coilApex = new Mesh(new BoxGeometry(0.06, 0.03, 0.46), pool.galvanizedSheet)
    coilApex.position.set(0, 0.39, -0.02)
    // Copper refrigerant suction & liquid stubs anchored into coilR and exiting right cabinet wall
    const suction = new Mesh(new CylinderGeometry(0.018, 0.018, 0.4, 10), pool.copperInsulated)
    suction.rotation.z = Math.PI / 2
    suction.position.set(0.3, 0.18, 0.12)
    const liquid = new Mesh(new CylinderGeometry(0.009, 0.009, 0.4, 10), pool.copperBare)
    liquid.rotation.z = Math.PI / 2
    liquid.position.set(0.3, 0.12, 0.12)
    g.add(filter, blowerDeck, blowerHousing, coilDeck, coilL, coilR, coilApex, suction, liquid)
  }

  // Supply Plenum (Top - Blue) + Dynamic Main Supply Trunk Takeoff
  const supplyPlenum = new Mesh(new BoxGeometry(0.52, 0.34, 0.5), pool.supplyBlue)
  supplyPlenum.position.set(0, 0.66, 0)
  g.add(supplyPlenum)

  const supplyBranches = branches.filter((b) => b.side === 'supply')
  const branchCount = Math.max(3, Math.min(6, supplyBranches.length || 4))
  const lastBranchX = 0.38 + (branchCount - 1) * 0.22
  const trunkStartX = 0.22
  const trunkEndX = Math.max(1.17, lastBranchX + 0.16)
  const trunkLen = trunkEndX - trunkStartX

  const trunkW = coolingTons >= 4 ? 0.52 : 0.42
  const supplyTrunk = new Mesh(new BoxGeometry(trunkLen, 0.22, trunkW * 0.65), pool.supplyBlue)
  supplyTrunk.name = 'supply-trunk'
  supplyTrunk.position.set(trunkStartX + trunkLen / 2, 0.72, 0)
  g.add(supplyTrunk)

  // Supply Branch Collars & Manual Balancing Dampers seated flush on collar top (hoisted shared geometries)
  const branchCollarGeo = new CylinderGeometry(0.06, 0.06, 0.26, 12)
  const damperHandleGeo = new BoxGeometry(0.06, 0.012, 0.015)
  for (let i = 0; i < branchCount; i++) {
    const branch = supplyBranches[i]
    const diamIn = branch?.diameterIn ?? 6
    const rScale = Math.max(0.75, Math.min(1.25, diamIn / 6))
    const x = 0.38 + i * 0.22
    const collar = new Mesh(branchCollarGeo, pool.supplyBranchCyan)
    collar.name = branch ? `branch-collar-${branch.label}` : `branch-collar-${i + 1}`
    collar.rotation.x = Math.PI / 2
    collar.scale.set(rScale, 1, rScale)
    collar.position.set(x, 0.72, 0.24)
    const damperHandle = new Mesh(damperHandleGeo, pool.dangerRed)
    damperHandle.name = `damper-handle-${i + 1}`
    damperHandle.position.set(x, 0.72 + 0.06 * rScale + 0.004, 0.2)
    g.add(collar, damperHandle)
  }

  // Return Drop Plenum (Left - Violet)
  const returnDrop = new Mesh(new BoxGeometry(0.28, 1.05, 0.44), pool.returnViolet)
  returnDrop.position.set(-0.46, -0.1, 0)
  const returnBoot = new Mesh(new BoxGeometry(0.22, 0.32, 0.42), pool.returnViolet)
  returnBoot.position.set(-0.34, -0.48, 0)
  g.add(returnDrop, returnBoot)

  // Joist-bay wooden framing cutaway overhead seated cleanly with every joist inside subfloor X span
  if (viewMode === 'joist-bay-cutaway') {
    const joistGeo = new BoxGeometry(0.045, 0.24, 0.85)
    const firstJoistX = -0.45
    const joistSpacing = 0.4064
    const joistCount = Math.max(5, Math.ceil((trunkEndX - firstJoistX) / joistSpacing) + 1)
    let lastJoistX = firstJoistX
    for (let j = 0; j < joistCount; j++) {
      const jx = firstJoistX + j * joistSpacing
      lastJoistX = jx
      const joist = new Mesh(joistGeo, pool.woodJoist)
      joist.name = `joist-${j}`
      joist.position.set(jx, 0.945, 0)
      g.add(joist)
    }
    const subfloorMinX = firstJoistX - 0.12
    const subfloorMaxX = Math.max(trunkEndX + 0.12, lastJoistX + 0.12)
    const subfloorW = subfloorMaxX - subfloorMinX
    const subfloor = new Mesh(new BoxGeometry(subfloorW, 0.025, 0.88), pool.woodJoist)
    subfloor.name = 'subfloor'
    subfloor.position.set((subfloorMinX + subfloorMaxX) / 2, 1.075, 0)
    g.add(subfloor)
  }

  return g
}
