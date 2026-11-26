/**
 * 10 Clean-Room MIT Procedural 3D CAD Builders for HVAC Registers, Grilles, Mini-Split Heads,
 * & Smart Thermostats (`src/cad/terminals.ts`).
 * Editor-free and React-free: zero React or `@pascal-app/*` imports.
 */

import { BoxGeometry, CylinderGeometry, Group, Mesh } from 'three'
import type { HvacTerminalKind } from '../imc/tables'
import { createHvacMaterialPool } from './materials'

export function buildHvacTerminalCad(params: {
  terminalKind: HvacTerminalKind
  neckSizeIn?: number
}): Group {
  const { terminalKind, neckSizeIn = 6 } = params
  const pool = createHvacMaterialPool()
  const g = new Group()
  g.name = `hvac-terminal-${terminalKind}`

  if (terminalKind === 'smart-thermostat' || terminalKind === 'zone-sensor') {
    const isStat = terminalKind === 'smart-thermostat'
    const back = new Mesh(new BoxGeometry(isStat ? 0.125 : 0.06, isStat ? 0.095 : 0.06, 0.022), pool.enamelWhite)
    g.add(back)
    const screen = new Mesh(new BoxGeometry(isStat ? 0.085 : 0.032, isStat ? 0.065 : 0.032, 0.008), pool.fanBlack)
    screen.position.z = 0.012
    g.add(screen)
    return g
  }

  if (terminalKind === 'mini-split-wall-head') {
    const body = new Mesh(new BoxGeometry(0.88, 0.3, 0.24), pool.enamelWhite)
    g.add(body)
    const accent = new Mesh(new BoxGeometry(0.78, 0.035, 0.03), pool.supplyBlue)
    accent.position.set(0, -0.09, 0.115)
    g.add(accent)
    return g
  }

  if (terminalKind === 'return-grille' || terminalKind === 'transfer-grille') {
    const w = terminalKind === 'return-grille' ? 0.54 : 0.36
    const h = terminalKind === 'return-grille' ? 0.54 : 0.16
    const frame = new Mesh(new BoxGeometry(w, h, 0.03), pool.enamelWhite)
    g.add(frame)
    const bladeCount = terminalKind === 'return-grille' ? 7 : 3
    const bladeGeo = new BoxGeometry(w - 0.06, 0.014, 0.024)
    for (let i = 0; i < bladeCount; i++) {
      const y = -h * 0.35 + (i / Math.max(1, bladeCount - 1)) * (h * 0.7)
      const blade = new Mesh(bladeGeo, pool.returnViolet)
      blade.position.set(0, y, 0.01)
      g.add(blade)
    }
    return g
  }

  if (terminalKind === 'fresh-air-intake') {
    const flange = new Mesh(new BoxGeometry(0.22, 0.22, 0.02), pool.galvanizedSheet)
    g.add(flange)
    const hood = new Mesh(new BoxGeometry(0.18, 0.16, 0.12), pool.freshGreen)
    hood.position.set(0, 0.01, 0.065)
    g.add(hood)
    return g
  }

  if (terminalKind === 'supply-ceiling-diffuser' || terminalKind === 'exhaust-grille') {
    const isExhaust = terminalKind === 'exhaust-grille'
    const plate = new Mesh(new BoxGeometry(0.32, 0.025, 0.32), pool.enamelWhite)
    g.add(plate)
    const inner = new Mesh(
      new BoxGeometry(0.22, 0.03, 0.22),
      isExhaust ? pool.exhaustAmber : pool.supplyBranchCyan,
    )
    inner.position.y = -0.008
    g.add(inner)
    const r = Math.max(0.05, (neckSizeIn * 0.0254) / 2)
    const collar = new Mesh(new CylinderGeometry(r, r, 0.1, 14), pool.galvanizedSheet)
    collar.position.y = 0.06
    g.add(collar)
    return g
  }

  if (terminalKind === 'supply-wall-register') {
    const face = new Mesh(new BoxGeometry(0.3, 0.16, 0.025), pool.enamelWhite)
    g.add(face)
    const core = new Mesh(new BoxGeometry(0.24, 0.11, 0.02), pool.supplyBlue)
    core.position.z = 0.006
    g.add(core)
    return g
  }

  // supply-floor-register
  const face = new Mesh(new BoxGeometry(0.28, 0.02, 0.14), pool.enamelWhite)
  g.add(face)
  const core = new Mesh(new BoxGeometry(0.23, 0.024, 0.095), pool.supplyBlue)
  g.add(core)
  const boot = new Mesh(new BoxGeometry(0.24, 0.14, 0.1), pool.galvanizedSheet)
  boot.position.y = -0.075
  g.add(boot)
  return g
}
