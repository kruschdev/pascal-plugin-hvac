/**
 * InspectorExtension card for `hvac:*` nodes:
 * Shows live NOT TO CODE / COMPLIANT status, ACCA Manual D velocity/friction,
 * framing clearance count, cross-trade Electrical/Gas demand, and 3D Cutaway shortcut.
 */

import type { AnyNode } from '@pascal-app/core'
import { openEditorView, useScene } from '@pascal-app/editor'
import { useMemo } from 'react'
import { auditSceneHvac } from '../imc/audit'
import {
  type ElectricalPowerDemand,
  type SceneNodeLike,
  type Vec3,
  computeDuctFramingClearances,
  extractHvacFramingContext,
  resolveNodeLevelId,
} from '../imc/framing-interop'
import { extractWallSegments, polylineLengthM } from '../imc/routing'
import { calculateDuctHydraulics } from '../imc/sizing'
import { type DuctMaterial, type DuctShape, METERS_TO_FEET, round2 } from '../imc/tables'
import { HVAC_SCHEDULE_VIEW_ID } from './hvac-panel'
import { useHvacUi } from './store'

export default function HvacInspectorCard({ node }: { node?: AnyNode }) {
  const nodes = useScene((s) => s.nodes) as unknown as Readonly<Record<string, SceneNodeLike>>
  const codeEdition = useHvacUi((s) => s.codeEdition)
  const climateZone = useHvacUi((s) => s.climateZone)
  const occupancy = useHvacUi((s) => s.occupancy)
  const setActiveTab = useHvacUi((s) => s.setActiveTab)
  const setSelectedEquipmentId = useHvacUi((s) => s.setSelectedEquipmentId)

  const audit = useMemo(
    () => auditSceneHvac(nodes, { codeEdition, climateZone, occupancy }),
    [nodes, codeEdition, climateZone, occupancy],
  )
  const raw = node as unknown as SceneNodeLike | undefined
  const nodeFindings = useMemo(
    () => (raw ? audit.findings.filter((f) => f.nodeIds.includes(raw.id)) : []),
    [audit, raw],
  )

  const ductMetrics = useMemo(() => {
    if (!raw || raw.type !== 'hvac:duct-run' || !Array.isArray(raw.path)) return null
    const path = raw.path as ReadonlyArray<Vec3>
    const shape = (raw.shape as DuctShape) || 'round'
    const material = (raw.material as DuctMaterial) || 'galvanized-sheet'
    const widthIn = typeof raw.width === 'number' ? raw.width : 14
    const heightIn = typeof raw.height === 'number' ? raw.height : 8
    const diameterIn = typeof raw.diameter === 'number' ? raw.diameter : 6
    const cfm = typeof raw.airflowCfm === 'number' ? raw.airflowCfm : 0
    const sys = String(raw.system ?? 'supply-branch')
    const lengthFt = round2(polylineLengthM(path) * METERS_TO_FEET)
    const hydraulics =
      cfm > 0
        ? calculateDuctHydraulics({
            cfm,
            shape,
            diameterIn,
            widthIn,
            heightIn,
            material,
            isTrunk: sys === 'supply-trunk' || sys === 'return-trunk',
            isReturn: sys === 'return-trunk' || sys === 'return-branch',
            occupancy,
          })
        : null
    const lvlId = resolveNodeLevelId(nodes, raw)
    const walls = extractWallSegments(nodes, lvlId)
    const framingContext = extractHvacFramingContext(nodes, lvlId)
    const clearances = computeDuctFramingClearances({
      ductRunId: raw.id,
      path,
      shape,
      widthIn,
      heightIn,
      diameterIn,
      walls,
      framingContext,
    })
    return { lengthFt, hydraulics, clearances, sizeLabel: shape === 'rectangular' ? `${widthIn}"x${heightIn}"` : `${diameterIn}" dia` }
  }, [nodes, raw, occupancy])

  if (!raw) return null

  const openTab = (tab: 'audit' | 'framing' | 'cutaway') => {
    setActiveTab(tab)
    openEditorView(HVAC_SCHEDULE_VIEW_ID, { beside: true })
  }

  const demand = raw.electricalDemand as ElectricalPowerDemand | null | undefined
  const gasBtuh = typeof raw.gasBtuh === 'number' ? raw.gasBtuh : 0

  return (
    <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
      <div
        style={{
          padding: '6px 8px',
          borderRadius: 6,
          background: nodeFindings.some((f) => f.severity === 'error')
            ? 'rgba(239,68,68,0.18)'
            : nodeFindings.length > 0
              ? 'rgba(245,158,11,0.18)'
              : 'rgba(34,197,94,0.15)',
          border: `1px solid ${
            nodeFindings.some((f) => f.severity === 'error')
              ? '#ef4444'
              : nodeFindings.length > 0
                ? '#f59e0b'
                : '#22c55e'
          }`,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontWeight: 600,
          fontSize: 11,
        }}
      >
        <span>
          {nodeFindings.some((f) => f.severity === 'error')
            ? `NOT TO CODE (${nodeFindings.length})`
            : nodeFindings.length > 0
              ? `WARNINGS (${nodeFindings.length})`
              : `${codeEdition} COMPLIANT`}
        </span>
        <button
          type="button"
          onClick={() => openTab('audit')}
          style={{ background: 'transparent', border: 'none', color: '#38bdf8', cursor: 'pointer', fontSize: 11 }}
        >
          Audit
        </button>
      </div>

      {ductMetrics && (
        <>
          <Row label="System / Size" value={`${String(raw.system)} · ${ductMetrics.sizeLabel}`} />
          <Row label="Run Length / R-Value" value={`${ductMetrics.lengthFt} ft · R-${String(raw.insulationR ?? 0)}`} />
          {ductMetrics.hydraulics && (
            <Row
              label="Airflow Velocity"
              value={`${ductMetrics.hydraulics.velocityFpm} FPM (${ductMetrics.hydraulics.frictionRateInWgPer100Ft}" wc)`}
              warn={!ductMetrics.hydraulics.velocityOk}
            />
          )}
          <Row label="Framing Clearances" value={`${ductMetrics.clearances.length} chase / penetration(s)`} />
          {ductMetrics.clearances.length > 0 && (
            <button type="button" onClick={() => openTab('framing')} style={linkBtnStyle}>
              View Framing &amp; Soffit Schedule
            </button>
          )}
        </>
      )}

      {raw.type === 'hvac:equipment' && (
        <>
          <Row
            label="Capacity / Airflow"
            value={`${String(raw.coolingTons ?? 0)} Ton · ${String(raw.airflowCfm ?? 0)} CFM`}
          />
          {gasBtuh > 0 && <Row label="Fuel Gas Input" value={`${Math.round(gasBtuh / 1000)} kBTU/h (IFGC)`} />}
          {(raw.equipmentKind === 'air-handler' ||
            raw.equipmentKind === 'gas-furnace-96' ||
            raw.equipmentKind === 'gas-furnace-80') && (
            <button
              type="button"
              onClick={() => {
                setSelectedEquipmentId(raw.id)
                openTab('cutaway')
              }}
              style={linkBtnStyle}
            >
              Open 3D Air Handler &amp; Plenum Cutaway
            </button>
          )}
        </>
      )}

      {raw.type === 'hvac:terminal' && (
        <>
          <Row label="Design Airflow" value={`${String(raw.designCfm ?? 0)} CFM`} />
          <Row label="Neck / Throw" value={`${String(raw.neckSizeIn ?? 0)}" · ${String(raw.throwFt ?? 0)} ft`} />
        </>
      )}

      {raw.type === 'hvac:plenum' && (
        <>
          <Row
            label="Plenum Dimensions"
            value={`${String(raw.widthIn ?? 18)}"×${String(raw.heightIn ?? 10)}"×${String(raw.depthIn ?? 24)}"`}
          />
          <Row label="Airflow / Insulation" value={`${String(raw.airflowCfm ?? 0)} CFM · R-${String(raw.insulationR ?? 8)}`} />
        </>
      )}

      {demand?.required && (
        <div style={{ padding: 6, borderRadius: 6, background: 'rgba(245,158,11,0.12)', fontSize: 11 }}>
          <strong>Electrical Coordination:</strong> {demand.voltage}V {demand.poles}P {demand.breakerAmps}A ({demand.loadVa} VA
          {demand.dedicatedCircuit ? ', Dedicated' : ''}
          {demand.gfciRequired ? ', GFCI' : ''})
        </div>
      )}

      {nodeFindings.slice(0, 3).map((f) => (
        <div key={f.id} style={{ fontSize: 11, opacity: 0.9 }}>
          <strong>{f.codeRef}:</strong> {f.title}
        </div>
      ))}
    </div>
  )
}

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
      <span style={{ opacity: 0.78 }}>{label}</span>
      <strong style={{ color: warn ? '#ef4444' : 'inherit' }}>{value}</strong>
    </div>
  )
}

const linkBtnStyle = {
  padding: '4px 8px',
  borderRadius: 5,
  border: '1px solid rgba(56,189,248,0.45)',
  background: 'rgba(56,189,248,0.12)',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 11,
}
