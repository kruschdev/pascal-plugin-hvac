/**
 * 9 Duct Fittings + 5 Lineset/Condensate/Controls Accessories + Swept 3D `buildDuctRunCad` (`src/cad/ducts.ts`).
 * Uses shared unit geometries + lazy material pool for minimal GPU overhead.
 * Editor-free and React-free: zero React or `@pascal-app/*` imports.
 */

import { BoxGeometry, CylinderGeometry, Group, Matrix4, Mesh, Quaternion, SphereGeometry, Vector3 } from 'three'
import type { Vec3 } from '../imc/framing-interop'
import { type DuctMaterial, type DuctShape, type HvacDuctSystem, INCHES_TO_METERS } from '../imc/tables'
import { createHvacMaterialPool, ductMaterialForSystem } from './materials'

export type HvacFittingCadKind =
  | 'rect-elbow-90'
  | 'rect-transition-reducer'
  | 'round-wye-branch'
  | 'start-collar-damper'
  | 'end-boot-floor'
  | 'ceiling-register-box'
  | 'zone-damper-round'
  | 'flex-duct-coil'
  | 'roof-jack-vent-cap'
  | 'condenser-pad'
  | 'ac-disconnect-box'
  | 'lineset-port-kit'
  | 'condensate-p-trap-ss2'
  | 'merv13-filter-rack'

export function buildHvacFittingCad(kind: HvacFittingCadKind): Group {
  const pool = createHvacMaterialPool()
  const g = new Group()
  g.name = `hvac-fitting-${kind}`

  switch (kind) {
    case 'rect-elbow-90': {
      const a = new Mesh(new BoxGeometry(0.36, 0.2, 0.28), pool.galvanizedSheet)
      a.position.set(0, 0, 0.14)
      const b = new Mesh(new BoxGeometry(0.28, 0.2, 0.36), pool.galvanizedSheet)
      b.position.set(0.14, 0, 0)
      g.add(a, b)
      break
    }
    case 'rect-transition-reducer': {
      const wide = new Mesh(new BoxGeometry(0.46, 0.2, 0.18), pool.galvanizedSheet)
      wide.position.z = -0.13
      const mid = new Mesh(new BoxGeometry(0.39, 0.2, 0.08), pool.galvanizedSheet)
      mid.position.z = -0.03
      const narrow = new Mesh(new BoxGeometry(0.32, 0.2, 0.24), pool.galvanizedSheet)
      narrow.position.z = 0.09
      g.add(wide, mid, narrow)
      break
    }
    case 'round-wye-branch': {
      const main = new Mesh(new CylinderGeometry(0.09, 0.09, 0.36, 14), pool.galvanizedSheet)
      const branch = new Mesh(new CylinderGeometry(0.075, 0.075, 0.24, 14), pool.galvanizedSheet)
      branch.rotation.z = -Math.PI / 4
      branch.position.set(0.1, 0.06, 0)
      g.add(main, branch)
      break
    }
    case 'start-collar-damper': {
      const collar = new Mesh(new CylinderGeometry(0.08, 0.08, 0.16, 14), pool.galvanizedSheet)
      const handle = new Mesh(new BoxGeometry(0.09, 0.015, 0.025), pool.dangerRed)
      handle.position.set(0.1, 0, 0)
      g.add(collar, handle)
      break
    }
    case 'end-boot-floor': {
      const rect = new Mesh(new BoxGeometry(0.25, 0.12, 0.1), pool.galvanizedSheet)
      rect.position.y = 0.06
      const round = new Mesh(new CylinderGeometry(0.075, 0.075, 0.14, 14), pool.galvanizedSheet)
      round.position.y = -0.06
      g.add(rect, round)
      break
    }
    case 'ceiling-register-box': {
      const box = new Mesh(new BoxGeometry(0.28, 0.18, 0.28), pool.ductboardYellow)
      const collar = new Mesh(new CylinderGeometry(0.08, 0.08, 0.1, 14), pool.galvanizedSheet)
      collar.position.y = 0.13
      g.add(box, collar)
      break
    }
    case 'zone-damper-round': {
      const barrel = new Mesh(new CylinderGeometry(0.1, 0.1, 0.22, 16), pool.galvanizedSheet)
      const actuator = new Mesh(new BoxGeometry(0.09, 0.08, 0.08), pool.supplyBlue)
      actuator.position.set(0.13, 0, 0)
      g.add(barrel, actuator)
      break
    }
    case 'flex-duct-coil': {
      const outer = new Mesh(new CylinderGeometry(0.12, 0.12, 0.42, 16), pool.flexSilver)
      outer.rotation.z = Math.PI / 2
      g.add(outer)
      break
    }
    case 'roof-jack-vent-cap': {
      const flange = new Mesh(new BoxGeometry(0.36, 0.02, 0.36), pool.cabinetSlate)
      const pipe = new Mesh(new CylinderGeometry(0.075, 0.075, 0.24, 14), pool.galvanizedSheet)
      pipe.position.y = 0.12
      const cap = new Mesh(new CylinderGeometry(0.13, 0.13, 0.04, 16), pool.cabinetSlate)
      cap.position.y = 0.25
      g.add(flange, pipe, cap)
      break
    }
    case 'condenser-pad': {
      const pad = new Mesh(new BoxGeometry(0.92, 0.07, 0.92), pool.concretePad)
      pad.position.y = 0.035
      g.add(pad)
      break
    }
    case 'ac-disconnect-box': {
      const box = new Mesh(new BoxGeometry(0.16, 0.24, 0.1), pool.cabinetSlate)
      const handle = new Mesh(new BoxGeometry(0.04, 0.08, 0.03), pool.dangerRed)
      handle.position.set(0, 0, 0.06)
      g.add(box, handle)
      break
    }
    case 'lineset-port-kit': {
      const suction = new Mesh(new CylinderGeometry(0.026, 0.026, 0.55, 12), pool.copperInsulated)
      const liquid = new Mesh(new CylinderGeometry(0.01, 0.01, 0.55, 10), pool.copperBare)
      liquid.position.x = 0.045
      const clampGeo = new BoxGeometry(0.09, 0.025, 0.056)
      const clampLow = new Mesh(clampGeo, pool.cabinetSlate)
      clampLow.position.set(0.015, -0.16, 0)
      const clampHigh = new Mesh(clampGeo, pool.cabinetSlate)
      clampHigh.position.set(0.015, 0.16, 0)
      g.add(suction, liquid, clampLow, clampHigh)
      break
    }
    case 'condensate-p-trap-ss2': {
      const trap = new Mesh(new CylinderGeometry(0.016, 0.016, 0.22, 10), pool.condensateWhite)
      const teeBranch = new Mesh(new CylinderGeometry(0.016, 0.016, 0.075, 10), pool.condensateWhite)
      teeBranch.rotation.z = Math.PI / 2
      teeBranch.position.set(0.03, 0.04, 0)
      const switchRiser = new Mesh(new CylinderGeometry(0.016, 0.016, 0.04, 10), pool.condensateWhite)
      switchRiser.position.set(0.06, 0.05, 0)
      const switchCap = new Mesh(new CylinderGeometry(0.024, 0.024, 0.07, 12), pool.dangerRed)
      switchCap.position.set(0.06, 0.085, 0)
      g.add(trap, teeBranch, switchRiser, switchCap)
      break
    }
    case 'merv13-filter-rack': {
      const cabinet = new Mesh(new BoxGeometry(0.56, 0.62, 0.16), pool.galvanizedSheet)
      const media = new Mesh(new BoxGeometry(0.5, 0.56, 0.1), pool.filterBlue)
      media.position.z = 0.04
      g.add(cabinet, media)
      break
    }
  }

  return g
}

const UP = new Vector3(0, 1, 0)

/**
 * Build a swept 3D rectangular or round HVAC duct / refrigerant lineset / condensate run
 * with shared unit geometries and optional 3D framing clearance collars.
 */
export function buildDuctRunCad(params: {
  id: string
  path: ReadonlyArray<Vec3>
  system: HvacDuctSystem
  shape: DuctShape
  material: DuctMaterial
  widthIn: number
  heightIn: number
  diameterIn: number
  clearances?: ReadonlyArray<{
    memberKind?: 'stud' | 'top-plate' | 'sole-plate' | 'joist-bay' | 'dropped-soffit'
    position: Vec3
    ductDirection?: Vec3
    wallNormal: readonly [number, number]
    openingWidthIn: number
    openingHeightIn: number
    codeCompliant: boolean
  }>
}): Group {
  const { id, path, system, shape, material, widthIn, heightIn, diameterIn, clearances = [] } = params
  const pool = createHvacMaterialPool()
  const g = new Group()
  g.name = `hvac-duct-run-${id}`

  if (path.length < 2) return g

  const mat = ductMaterialForSystem(pool, system, material)
  const wM = Math.max(0.04, widthIn * INCHES_TO_METERS)
  const hM = Math.max(0.04, heightIn * INCHES_TO_METERS)
  const rM = Math.max(0.018, (diameterIn * INCHES_TO_METERS) / 2)

  // Shared unit geometries reused across all segments and collars
  const unitSegGeo =
    shape === 'rectangular'
      ? new BoxGeometry(wM, 1, hM)
      : new CylinderGeometry(rM, rM, 1, 14)
  let jointGeo: SphereGeometry | BoxGeometry | null = null
  const rotMat = new Matrix4()

  for (let i = 1; i < path.length; i++) {
    const a = new Vector3(path[i - 1]![0], path[i - 1]![1], path[i - 1]![2])
    const b = new Vector3(path[i]![0], path[i]![1], path[i]![2])
    const delta = new Vector3().subVectors(b, a)
    const len = delta.length()
    if (len < 0.01) continue

    const dir = delta.clone().normalize()
    const quat = new Quaternion()
    if (shape === 'rectangular' && Math.abs(dir.y) < 0.99) {
      // Right-handed orthonormal basis (det = +1): local X (wM) horizontal, local Y along dir, local Z (hM) upright
      const basisX = new Vector3().crossVectors(UP, dir).normalize()
      const basisZ = new Vector3().crossVectors(basisX, dir).normalize()
      rotMat.makeBasis(basisX, dir, basisZ)
      quat.setFromRotationMatrix(rotMat)
    } else if (dir.y <= -0.99) {
      quat.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI)
    } else {
      quat.setFromUnitVectors(UP, dir)
    }
    const mid = new Vector3().addVectors(a, b).multiplyScalar(0.5)

    const seg = new Mesh(unitSegGeo, mat)
    seg.position.copy(mid)
    seg.quaternion.copy(quat)
    seg.scale.set(1, len, 1)
    seg.castShadow = true
    seg.receiveShadow = true
    g.add(seg)

    if (i < path.length - 1) {
      jointGeo ??=
        shape === 'rectangular'
          ? new BoxGeometry(wM * 1.04, hM * 1.04, wM * 1.04)
          : new SphereGeometry(rM * 1.08, 12, 10)
      const joint = new Mesh(jointGeo, mat)
      joint.position.copy(b)
      g.add(joint)
    }
  }

  // Hollow 4-bar framing penetration / firestop collars that wrap around ducts (never slice across as baffles)
  if (clearances.length > 0) {
    const unitCollarGeo = new BoxGeometry(1, 1, 1)
    const barThick = 0.025
    const barDepth = 0.035
    for (const clr of clearances) {
      const frameW = Math.max(0.08, clr.openingWidthIn * INCHES_TO_METERS)
      const frameH = Math.max(0.08, clr.openingHeightIn * INCHES_TO_METERS)
      const collarMat = clr.codeCompliant ? pool.galvanizedSheet : pool.dangerRed
      const collarGroup = new Group()
      collarGroup.name = `hvac-collar-${clr.memberKind ?? 'stud'}`
      collarGroup.position.set(clr.position[0], clr.position[1], clr.position[2])

      const topBar = new Mesh(unitCollarGeo, collarMat)
      topBar.scale.set(frameW + 2 * barThick, barThick, barDepth)
      topBar.position.set(0, frameH / 2 + barThick / 2, 0)

      const botBar = new Mesh(unitCollarGeo, collarMat)
      botBar.scale.set(frameW + 2 * barThick, barThick, barDepth)
      botBar.position.set(0, -frameH / 2 - barThick / 2, 0)

      const leftBar = new Mesh(unitCollarGeo, collarMat)
      leftBar.scale.set(barThick, frameH, barDepth)
      leftBar.position.set(-frameW / 2 - barThick / 2, 0, 0)

      const rightBar = new Mesh(unitCollarGeo, collarMat)
      rightBar.scale.set(barThick, frameH, barDepth)
      rightBar.position.set(frameW / 2 + barThick / 2, 0, 0)

      collarGroup.add(topBar, botBar, leftBar, rightBar)

      const [nx, nz] = clr.wallNormal
      if (clr.memberKind === 'top-plate' || clr.memberKind === 'sole-plate') {
        // Vertical duct piercing horizontal top/sole plate -> collar lies flat in XZ around duct perimeter
        collarGroup.rotation.order = 'YXZ'
        collarGroup.rotation.y = Math.atan2(nx, nz)
        collarGroup.rotation.x = Math.PI / 2
      } else if (clr.memberKind === 'dropped-soffit' && clr.ductDirection) {
        // Horizontal under-joist chase -> collar plane perpendicular to duct travel direction
        collarGroup.rotation.y = Math.atan2(clr.ductDirection[0], clr.ductDirection[2])
      } else {
        collarGroup.rotation.y = Math.atan2(nx, nz)
      }
      g.add(collarGroup)
    }
  }

  return g
}
