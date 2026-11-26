/**
 * Interactive 3D Air Handler, Supply/Return Plenum & Joist-Bay Ductwork Cutaway (`src/ui/air-handler-cutaway-view.tsx`).
 * HVAC's signature interactive 3D cutaway view inside the split-pane HVAC Schedule.
 * Disposes every BufferGeometry, Material, and WebGLRenderer cleanly on unmount/re-render.
 */

import { useEffect, useRef } from 'react'
import {
  AmbientLight,
  type BufferGeometry,
  Color,
  DirectionalLight,
  type Material,
  Mesh,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three'
import {
  type DuctBranchAssignment,
  type HvacCutawayViewMode,
  buildWiredAirHandlerCutawayCad,
} from '../cad/plenum-cutaway'

export default function AirHandlerCutawayView({
  coolingTons,
  viewMode,
  branches,
  onChangeViewMode,
}: {
  coolingTons: number
  viewMode: HvacCutawayViewMode
  branches: ReadonlyArray<DuctBranchAssignment>
  onChangeViewMode: (m: HvacCutawayViewMode) => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const width = Math.max(320, el.clientWidth || 520)
    const height = 340

    const scene = new Scene()
    scene.background = new Color(0x0f172a)

    const camera = new PerspectiveCamera(42, width / height, 0.05, 25)
    camera.position.set(0.55, 0.25, 2.35)
    camera.lookAt(0.2, 0.15, 0)

    const renderer = new WebGLRenderer({ antialias: true })
    renderer.setSize(width, height)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    el.innerHTML = ''
    el.appendChild(renderer.domElement)

    scene.add(new AmbientLight(0xffffff, 0.88))
    const key = new DirectionalLight(0xffffff, 1.35)
    key.position.set(2.5, 3.5, 4)
    scene.add(key)

    const model = buildWiredAirHandlerCutawayCad({
      coolingTons,
      viewMode,
      branches,
    })
    scene.add(model)

    let dragging = false
    let prevX = 0
    let rotY = -0.22
    model.rotation.y = rotY

    const onDown = (e: PointerEvent) => {
      dragging = true
      prevX = e.clientX
    }
    const onMove = (e: PointerEvent) => {
      if (!dragging) return
      rotY += (e.clientX - prevX) * 0.01
      prevX = e.clientX
      model.rotation.y = rotY
      renderer.render(scene, camera)
    }
    const onUp = () => {
      dragging = false
    }

    renderer.domElement.addEventListener('pointerdown', onDown)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    renderer.render(scene, camera)

    return () => {
      renderer.domElement.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const geometries = new Set<BufferGeometry>()
      const materials = new Set<Material>()
      model.traverse((obj) => {
        if (obj instanceof Mesh) {
          if (obj.geometry) geometries.add(obj.geometry as BufferGeometry)
          if (Array.isArray(obj.material)) {
            for (const m of obj.material) materials.add(m as Material)
          } else if (obj.material) {
            materials.add(obj.material as Material)
          }
        }
      })
      for (const geo of geometries) geo.dispose()
      for (const mat of materials) mat.dispose()
      scene.clear()
      renderer.dispose()
      el.innerHTML = ''
    }
  }, [coolingTons, viewMode, branches])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 12 }}>3D Cutaway Mode:</strong>
        {(
          [
            ['joist-bay-cutaway', 'Joist-Bay & Open Air Handler'],
            ['open-plenum', 'Cabinet Cover Off'],
            ['cabinet-closed', 'Cabinet Door Closed'],
          ] as const
        ).map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            onClick={() => onChangeViewMode(mode)}
            style={{
              padding: '4px 9px',
              borderRadius: 6,
              fontSize: 11,
              cursor: 'pointer',
              border: '1px solid rgba(56,189,248,0.5)',
              background: viewMode === mode ? 'rgba(56,189,248,0.25)' : 'transparent',
              color: 'inherit',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: 340,
          borderRadius: 8,
          overflow: 'hidden',
          border: '1px solid var(--border, rgba(255,255,255,0.16))',
          cursor: 'grab',
        }}
      />

      <div style={{ fontSize: 11, opacity: 0.8 }}>
        Drag horizontally to orbit. Shows evaporator A-coil, ECM blower housing, MERV-13 filter rack, secondary galvanized
        overflow pan with SS2 float switch (IMC 307.2), blue supply plenum with manual balancing dampers, violet return
        drop, and overhead joist-bay clearance.
      </div>
    </div>
  )
}
