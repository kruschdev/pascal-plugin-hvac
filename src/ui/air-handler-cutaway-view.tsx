'use client'

/**
 * Interactive 3D Air Handler, Supply/Return Plenum & Joist-Bay Ductwork Cutaway (`src/ui/air-handler-cutaway-view.tsx`).
 * Persists a single WebGLRenderer, Scene, Camera, and orbit angle across scene edits, swapping only
 * the cutaway model Group when primitive props change, with ResizeObserver and full GPU disposal on unmount.
 */

import { useEffect, useRef, useState } from 'react'
import {
  AmbientLight,
  type BufferGeometry,
  Color,
  DirectionalLight,
  type Group,
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

function disposeGroup(group: Group): void {
  const geometries = new Set<BufferGeometry>()
  const materials = new Set<Material>()
  group.traverse((obj) => {
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
}

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
  const sceneRef = useRef<Scene | null>(null)
  const cameraRef = useRef<PerspectiveCamera | null>(null)
  const rendererRef = useRef<WebGLRenderer | null>(null)
  const modelRef = useRef<Group | null>(null)
  const rotYRef = useRef(-0.22)
  const [webglError, setWebglError] = useState<string | null>(null)

  // Stable primitive branch signature avoids rebuilding the cutaway on unrelated scene edits while reflecting real branches
  const branchSignature = branches.map((b) => `${b.side}:${b.label}:${b.cfm}:${b.diameterIn}`).join('|')
  const branchesRef = useRef<ReadonlyArray<DuctBranchAssignment>>(branches)
  branchesRef.current = branches

  // Mount-only WebGLRenderer + ResizeObserver + Orbit Controls
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

    let renderer: WebGLRenderer
    try {
      renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    } catch (err) {
      setWebglError(err instanceof Error ? err.message : 'WebGL context unavailable in this environment.')
      return
    }
    setWebglError(null)
    renderer.setSize(width, height)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    el.innerHTML = ''
    el.appendChild(renderer.domElement)

    scene.add(new AmbientLight(0xffffff, 1.25))
    const key = new DirectionalLight(0xffffff, 1.45)
    key.position.set(2.5, 3.5, 4)
    scene.add(key)
    const fill = new DirectionalLight(0xdbeafe, 0.95)
    fill.position.set(-2.2, 0.8, 3.6)
    scene.add(fill)

    sceneRef.current = scene
    cameraRef.current = camera
    rendererRef.current = renderer

    let dragging = false
    let prevX = 0

    const onDown = (e: PointerEvent) => {
      dragging = true
      prevX = e.clientX
    }
    const onMove = (e: PointerEvent) => {
      if (!dragging) return
      rotYRef.current += (e.clientX - prevX) * 0.01
      prevX = e.clientX
      if (modelRef.current) modelRef.current.rotation.y = rotYRef.current
      renderer.render(scene, camera)
    }
    const onUp = () => {
      dragging = false
    }

    renderer.domElement.addEventListener('pointerdown', onDown)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)

    const resizeObs =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            const w = Math.max(320, el.clientWidth || 520)
            camera.aspect = w / height
            camera.updateProjectionMatrix()
            renderer.setSize(w, height)
            renderer.render(scene, camera)
          })
        : null
    resizeObs?.observe(el)

    return () => {
      resizeObs?.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (modelRef.current) {
        scene.remove(modelRef.current)
        disposeGroup(modelRef.current)
        modelRef.current = null
      }
      scene.clear()
      renderer.dispose()
      if (typeof renderer.forceContextLoss === 'function') {
        renderer.forceContextLoss()
      }
      sceneRef.current = null
      cameraRef.current = null
      rendererRef.current = null
      el.innerHTML = ''
    }
  }, [])

  // Swap only the cutaway model Group when tonnage, viewMode, or real branch assignments change
  useEffect(() => {
    const scene = sceneRef.current
    const camera = cameraRef.current
    const renderer = rendererRef.current
    if (!scene || !camera || !renderer) return

    if (modelRef.current) {
      scene.remove(modelRef.current)
      disposeGroup(modelRef.current)
      modelRef.current = null
    }

    const model = buildWiredAirHandlerCutawayCad({
      coolingTons,
      viewMode,
      branches: branchesRef.current,
    })
    model.rotation.y = rotYRef.current
    scene.add(model)
    modelRef.current = model
    renderer.render(scene, camera)
    const rafId = typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame(() => renderer.render(scene, camera)) : 0
    return () => {
      if (rafId && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(rafId)
    }
  }, [coolingTons, viewMode, branchSignature])

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

      {webglError ? (
        <div
          style={{
            padding: 14,
            borderRadius: 8,
            border: '1px solid rgba(245,158,11,0.5)',
            background: 'rgba(245,158,11,0.12)',
            fontSize: 11,
          }}
        >
          3D WebGL preview unavailable ({webglError}). Branch takeoff assignments remain listed below.
        </div>
      ) : (
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
      )}

      {branches.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 11 }}>
          {branches.map((b) => (
            <span
              key={`${b.side}_${b.index}_${b.label}`}
              style={{
                padding: '3px 7px',
                borderRadius: 6,
                border: `1px solid ${b.side === 'return' ? 'rgba(124,58,237,0.55)' : 'rgba(56,189,248,0.55)'}`,
                background: b.side === 'return' ? 'rgba(124,58,237,0.14)' : 'rgba(56,189,248,0.12)',
              }}
            >
              {b.label} ({b.diameterIn}&quot; · {b.cfm} CFM)
            </span>
          ))}
        </div>
      )}

      <div style={{ fontSize: 11, opacity: 0.8 }}>
        Drag horizontally to orbit. Shows evaporator A-coil, ECM blower housing, MERV-13 filter rack, secondary galvanized
        overflow pan with SS2 float switch (IMC 307.2), blue supply plenum with manual balancing dampers, violet return
        drop, and overhead joist-bay clearance.
      </div>
    </div>
  )
}
