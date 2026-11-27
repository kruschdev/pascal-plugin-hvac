'use client'

/**
 * Full-pane EditorHostView (`krusch:hvac:schedule`) that opens beside the 3D/2D scene:
 * 6 Tabs: Manual J & Airflow | Loads & Power/Gas | IMC / IECC Audit | Framing & Soffits | Priced BOM & Insulation | 3D Air Handler Cutaway.
 */

import { useScene, useViewer } from '@pascal-app/editor'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DuctBranchAssignment } from '../cad/plenum-cutaway'
import { auditSceneHvac } from '../imc/audit'
import type { DuctFramingClearance, SceneNodeLike } from '../imc/framing-interop'
import { buildHvacBom, formatHvacBomCsv } from '../imc/pricing'
import { collectSceneFramingClearances } from '../imc/routing'
import { buildHvacSchedule, formatHvacScheduleCsv } from '../imc/schedule'
import AirHandlerCutawayView from './air-handler-cutaway-view'
import { type HvacScheduleTab, useHvacUi } from './store'

export default function HvacScheduleView() {
  const nodes = useScene((s) => s.nodes)
  const setSelection = useViewer((s) => s.setSelection)
  const {
    codeEdition,
    climateZone,
    occupancy,
    systemType,
    activeTab,
    setActiveTab,
    selectedEquipmentId,
    setSelectedEquipmentId,
    cutawayViewMode,
    setCutawayViewMode,
  } = useHvacUi()

  const [laborRateUsd, setLaborRateUsd] = useState(120)
  const [materialMarkupPct, setMaterialMarkupPct] = useState(0)
  const [salesTaxPct, setSalesTaxPct] = useState(0)
  const [includeInsulation, setIncludeInsulation] = useState(true)
  const [copiedMsg, setCopiedMsg] = useState<string | null>(null)

  const record = nodes as unknown as Readonly<Record<string, SceneNodeLike>>
  const schedule = useMemo(
    () => buildHvacSchedule(record, { codeEdition, climateZone, occupancy, systemType }),
    [record, codeEdition, climateZone, occupancy, systemType],
  )
  const audit = useMemo(
    () => auditSceneHvac(record, { codeEdition, climateZone, occupancy }),
    [record, codeEdition, climateZone, occupancy],
  )
  const bom = useMemo(
    () =>
      buildHvacBom(record, {
        codeEdition,
        climateZone,
        occupancy,
        laborRateUsd,
        materialMarkupPct,
        salesTaxPct,
        includeInsulation,
        schedule,
      }),
    [record, codeEdition, climateZone, occupancy, laborRateUsd, materialMarkupPct, salesTaxPct, includeInsulation, schedule],
  )

  const clearances = useMemo<DuctFramingClearance[]>(() => {
    if (activeTab !== 'framing') return []
    return collectSceneFramingClearances(record)
  }, [record, activeTab])

  const indoorUnits = useMemo(
    () =>
      Object.values(record).filter(
        (n) =>
          n.type === 'hvac:equipment' &&
          (n.equipmentKind === 'air-handler' ||
            n.equipmentKind === 'gas-furnace-96' ||
            n.equipmentKind === 'gas-furnace-80' ||
            n.equipmentKind === 'rooftop-package-unit'),
      ),
    [record],
  )
  const activeUnit = useMemo(
    () => (selectedEquipmentId ? indoorUnits.find((u) => u.id === selectedEquipmentId) : undefined) ?? indoorUnits[0] ?? null,
    [indoorUnits, selectedEquipmentId],
  )
  const cutawayBranches = useMemo<DuctBranchAssignment[]>(() => {
    if (activeTab !== 'cutaway') return []
    const out: DuctBranchAssignment[] = []
    let idx = 0
    for (const n of Object.values(record)) {
      if (n.type !== 'hvac:duct-run') continue
      const sys = String(n.system ?? '')
      if (sys !== 'supply-branch' && sys !== 'return-branch') continue
      out.push({
        index: idx++,
        label: typeof n.name === 'string' && n.name ? n.name : n.id,
        cfm: typeof n.airflowCfm === 'number' ? n.airflowCfm : 120,
        diameterIn: typeof n.diameter === 'number' ? n.diameter : 6,
        side: sys === 'return-branch' ? 'return' : 'supply',
      })
    }
    return out
  }, [record, activeTab])

  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    }
  }, [])

  const copyCsv = (label: string, csv: string) => {
    navigator.clipboard?.writeText(csv).catch(() => {})
    setCopiedMsg(`Copied ${label} CSV`)
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    copyTimerRef.current = setTimeout(() => {
      setCopiedMsg(null)
      copyTimerRef.current = null
    }, 2000)
  }

  const tabs: ReadonlyArray<[HvacScheduleTab, string]> = [
    ['manual-j', `Manual J (${schedule.manualJ.rooms.length})`],
    ['loads', 'Loads & Power/Gas'],
    ['audit', `IMC Audit (${audit.errorCount}/${audit.warningCount})`],
    ['framing', activeTab === 'framing' ? `Framing & Soffits (${clearances.length})` : 'Framing & Soffits'],
    ['bom', `BOM ($${Math.round(bom.grandTotalUsd).toLocaleString()})`],
    ['cutaway', '3D Air Handler Cutaway'],
  ]

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, fontSize: 12, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <strong style={{ fontSize: 15 }}>HVAC Engineering Schedule ({codeEdition} · Zone {climateZone})</strong>
          <div style={{ fontSize: 11, opacity: 0.75 }}>
            {schedule.manualJ.recommendedTons} Ton ({schedule.manualJ.designTotalCfm} CFM) · Cool{' '}
            {schedule.manualJ.totalCoolingBtuh.toLocaleString()} BTU/h · Heat{' '}
            {schedule.manualJ.totalHeatingBtuh.toLocaleString()} BTU/h · ERV {schedule.ventilation.recommendedErvCfm} CFM
          </div>
        </div>
        {copiedMsg && <span style={{ color: '#22c55e', fontSize: 11 }}>{copiedMsg}</span>}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', borderBottom: '1px solid var(--border, rgba(255,255,255,0.14))', paddingBottom: 8 }}>
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setActiveTab(id)}
            style={{
              padding: '5px 10px',
              borderRadius: 6,
              border: '1px solid var(--border, rgba(255,255,255,0.18))',
              background: activeTab === id ? 'rgba(2,132,199,0.28)' : 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: activeTab === id ? 600 : 400,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Tab 1: Manual J Room-by-Room Load & Airflow Schedule */}
      {activeTab === 'manual-j' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => copyCsv('Manual J Schedule', formatHvacScheduleCsv(schedule))} style={btnStyle}>
              Copy CSV
            </button>
          </div>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Room</th>
                <th style={thStyle}>Area (sq ft)</th>
                <th style={thStyle}>Heating (BTU/h)</th>
                <th style={thStyle}>Cooling Sens / Lat</th>
                <th style={thStyle}>Cooling Total</th>
                <th style={thStyle}>Design CFM</th>
                <th style={thStyle}>Registers</th>
              </tr>
            </thead>
            <tbody>
              {schedule.manualJ.rooms.map((r) => (
                <tr key={r.roomId}>
                  <td style={tdStyle}>{r.roomName}</td>
                  <td style={tdStyle}>{r.areaSqft}</td>
                  <td style={tdStyle}>{r.heatingBtuh.toLocaleString()}</td>
                  <td style={tdStyle}>
                    {r.coolingSensibleBtuh.toLocaleString()} / {r.coolingLatentBtuh.toLocaleString()}
                  </td>
                  <td style={tdStyle}><strong>{r.coolingTotalBtuh.toLocaleString()}</strong></td>
                  <td style={tdStyle}>{r.designCfm} CFM</td>
                  <td style={tdStyle}>{r.recommendedRegisters}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {schedule.ductSummary.length > 0 && (
            <>
              <strong style={{ marginTop: 6 }}>Installed Ductwork &amp; Lineset Summary</strong>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>System</th>
                    <th style={thStyle}>Size</th>
                    <th style={thStyle}>Material</th>
                    <th style={thStyle}>Runs</th>
                    <th style={thStyle}>Total Length</th>
                    <th style={thStyle}>Peak Velocity</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.ductSummary.map((d, idx) => (
                    <tr key={`${d.system}_${d.sizeLabel}_${idx}`}>
                      <td style={tdStyle}>{d.system}</td>
                      <td style={tdStyle}>{d.sizeLabel}</td>
                      <td style={tdStyle}>{d.material}</td>
                      <td style={tdStyle}>{d.runCount}</td>
                      <td style={tdStyle}>{d.totalLengthFt} ft</td>
                      <td style={tdStyle}>{d.maxVelocityFpm > 0 ? `${d.maxVelocityFpm} FPM` : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}

      {/* Tab 2: Equipment Sizing, Electrical Power Handoff & Fuel Gas */}
      {activeTab === 'loads' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 8 }}>
            <MetricCard
              title="Manual S Capacity"
              value={`${schedule.equipmentRec.coolingTons} Ton`}
              sub={`Min ${schedule.equipmentRec.minSeer2} SEER2 · ${schedule.equipmentRec.refrigerant}`}
            />
            <MetricCard
              title="Refrigerant Lineset"
              value={`${schedule.equipmentRec.liquidLineIn} / ${schedule.equipmentRec.suctionLineIn}`}
              sub={`Wire: ${schedule.equipmentRec.thermostatCable}`}
            />
            <MetricCard
              title="ASHRAE 62.2 ERV"
              value={`${schedule.ventilation.continuousFreshAirCfm} CFM`}
              sub={`Rec ERV: ${schedule.ventilation.recommendedErvCfm} CFM · Bath ${schedule.ventilation.bathExhaustCfmEach} CFM`}
            />
            <MetricCard
              title="Furnace Gas Input"
              value={schedule.totalFurnaceGasBtuh > 0 ? `${Math.round(schedule.totalFurnaceGasBtuh / 1000)} kBTU/h` : 'All-Electric'}
              sub={schedule.totalFurnaceGasBtuh > 0 ? 'Synced to Plumbing IFGC Gas Main' : 'Heat pump / electric aux'}
            />
          </div>

          <strong>Cross-Trade Electrical Power Coordination (NEC Art. 440 / Auto-Breaker Handoff)</strong>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Powered HVAC Equipment</th>
                <th style={thStyle}>Circuit</th>
                <th style={thStyle}>Load</th>
                <th style={thStyle}>Protection</th>
                <th style={thStyle}>Electrical Status</th>
              </tr>
            </thead>
            <tbody>
              {schedule.electricalCoordination.map((c) => (
                <tr key={c.sourceNodeId} onClick={() => setSelection({ selectedIds: [c.sourceNodeId] })} style={{ cursor: 'pointer' }}>
                  <td style={tdStyle}>{c.label}</td>
                  <td style={tdStyle}>{c.voltage}V {c.poles}P {c.breakerAmps}A</td>
                  <td style={tdStyle}>{c.loadVa} VA</td>
                  <td style={tdStyle}>{[c.dedicatedCircuit ? 'Dedicated' : 'Shared', c.gfciRequired ? 'GFCI' : ''].filter(Boolean).join(' · ')}</td>
                  <td style={{ ...tdStyle, color: c.wired ? '#22c55e' : '#f59e0b', fontWeight: 600 }}>
                    {c.wired ? `WIRED (CKT-${c.matchedCircuitNumber ?? '?'})` : 'NEEDS BREAKER'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Tab 3: IMC / IECC / Manual D / NEC 110.26(E) Audit */}
      {activeTab === 'audit' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {audit.findings.length === 0 && (
            <div style={{ padding: 12, borderRadius: 8, background: 'rgba(34,197,94,0.14)', border: '1px solid #22c55e' }}>
              0 Errors · 0 Warnings · 0 Info: All IMC / ACCA Manual D / IECC / NEC 110.26(E) &amp; Trade-Priority checks passed!
            </div>
          )}
          {audit.findings.map((f) => (
            <div
              key={f.id}
              onClick={() => f.nodeIds.length > 0 && setSelection({ selectedIds: f.nodeIds })}
              style={{
                padding: 10,
                borderRadius: 8,
                cursor: f.nodeIds.length > 0 ? 'pointer' : 'default',
                border: `1px solid ${f.severity === 'error' ? '#ef4444' : f.severity === 'warning' ? '#f59e0b' : '#38bdf8'}`,
                background:
                  f.severity === 'error'
                    ? 'rgba(239,68,68,0.12)'
                    : f.severity === 'warning'
                      ? 'rgba(245,158,11,0.12)'
                      : 'rgba(56,189,248,0.1)',
              }}
            >
              <div style={{ fontWeight: 600 }}>
                [{f.codeRef}] {f.title}
              </div>
              <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>{f.detail}</div>
              <div style={{ fontSize: 11, color: '#38bdf8', marginTop: 4 }}>Fix: {f.suggestedFix}</div>
            </div>
          ))}
        </div>
      )}

      {/* Tab 4: Structural Framing, Joist Bays & Soffit Clearances */}
      {activeTab === 'framing' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 11, opacity: 0.8 }}>
            Wall penetration openings, double top-plate straps, and dropped-soffit chases coordinated with{' '}
            <code>@kruschdev/pascal-plugin-structural</code> and <code>@pascal-app/plugin-bones</code> (IRC R502.8 / R602.6 / R302.11).
          </div>
          {clearances.length === 0 ? (
            <div style={{ padding: 10, borderRadius: 8, border: '1px solid rgba(255,255,255,0.14)', opacity: 0.8 }}>
              No framing penetrations or dropped soffits detected on current duct paths.
            </div>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Member / Chase</th>
                  <th style={thStyle}>Opening (W×H)</th>
                  <th style={thStyle}>Soffit / Header</th>
                  <th style={thStyle}>Code Ref</th>
                  <th style={thStyle}>Status</th>
                </tr>
              </thead>
              <tbody>
                {clearances.map((c) => (
                  <tr key={c.id} onClick={() => setSelection({ selectedIds: [c.ductRunId] })} style={{ cursor: 'pointer' }}>
                    <td style={tdStyle}>
                      <div>{c.memberLabel}</div>
                      {c.note && <div style={{ fontSize: 10, opacity: 0.72 }}>{c.note}</div>}
                    </td>
                    <td style={tdStyle}><strong>{c.openingWidthIn}&quot;×{c.openingHeightIn}&quot;</strong></td>
                    <td style={tdStyle}>{c.needsSoffitOrChase ? 'Required' : 'Standard'}</td>
                    <td style={tdStyle}>{c.codeRef}</td>
                    <td style={{ ...tdStyle, color: c.codeCompliant ? '#22c55e' : '#ef4444', fontWeight: 600 }}>
                      {c.codeCompliant ? 'PASS' : 'HEADER REQ'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Tab 5: Priced BOM & IECC Envelope Insulation Takeoff */}
      {activeTab === 'bom' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <label>
              Labor $/hr:{' '}
              <input type="number" value={laborRateUsd} onChange={(e) => setLaborRateUsd(Number(e.target.value) || 0)} style={numInputStyle} />
            </label>
            <label>
              Markup %:{' '}
              <input type="number" value={materialMarkupPct} onChange={(e) => setMaterialMarkupPct(Number(e.target.value) || 0)} style={numInputStyle} />
            </label>
            <label>
              Tax %:{' '}
              <input type="number" value={salesTaxPct} onChange={(e) => setSalesTaxPct(Number(e.target.value) || 0)} style={numInputStyle} />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={includeInsulation} onChange={(e) => setIncludeInsulation(e.target.checked)} />
              Include IECC Insulation ({schedule.insulation.wallRValue} / {schedule.insulation.atticRValue})
            </label>
            <button type="button" onClick={() => copyCsv('HVAC BOM', formatHvacBomCsv(bom))} style={btnStyle}>
              Copy BOM CSV
            </button>
          </div>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Category</th>
                <th style={thStyle}>Item</th>
                <th style={thStyle}>Qty</th>
                <th style={thStyle}>Material</th>
                <th style={thStyle}>Labor</th>
                <th style={thStyle}>Total</th>
              </tr>
            </thead>
            <tbody>
              {bom.lines.map((l, idx) => (
                <tr key={`${l.item}_${idx}`}>
                  <td style={tdStyle}>{l.category}</td>
                  <td style={tdStyle}>{l.item}</td>
                  <td style={tdStyle}>{l.quantity} {l.unit}</td>
                  <td style={tdStyle}>${l.materialUsd.toFixed(2)}</td>
                  <td style={tdStyle}>${l.laborUsd.toFixed(2)} ({l.laborHours}h)</td>
                  <td style={tdStyle}><strong>${l.totalUsd.toFixed(2)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, fontSize: 12 }}>
            <div>
              Material Subtotal: <strong>${bom.subtotalMaterialUsd.toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong>
            </div>
            {bom.markupUsd > 0 && (
              <div>
                Markup ({materialMarkupPct}%): <strong>${bom.markupUsd.toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong>
              </div>
            )}
            {bom.taxUsd > 0 && (
              <div>
                Sales Tax ({salesTaxPct}%): <strong>${bom.taxUsd.toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong>
              </div>
            )}
            <div>
              Labor Subtotal ({bom.totalLaborHours}h):{' '}
              <strong>${bom.subtotalLaborUsd.toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong>
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, marginTop: 4 }}>
              Grand Total: ${bom.grandTotalUsd.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </div>
          </div>
        </div>
      )}

      {/* Tab 6: 3D Air Handler, Plenum & Joist-Bay Cutaway */}
      {activeTab === 'cutaway' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {indoorUnits.length > 1 && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11 }}>
              <strong>Air Handler / Furnace:</strong>
              <select
                value={activeUnit?.id ?? ''}
                onChange={(e) => setSelectedEquipmentId(e.target.value || null)}
                style={{ padding: '3px 6px', borderRadius: 5, border: '1px solid rgba(255,255,255,0.2)', background: 'transparent', color: 'inherit', fontSize: 11 }}
              >
                {indoorUnits.map((u) => (
                  <option key={u.id} value={u.id}>
                    {String(u.name ?? u.id)} ({String(u.coolingTons ?? 3)}-Ton)
                  </option>
                ))}
              </select>
            </div>
          )}
          <AirHandlerCutawayView
            coolingTons={typeof activeUnit?.coolingTons === 'number' && activeUnit.coolingTons > 0 ? activeUnit.coolingTons : schedule.manualJ.recommendedTons}
            viewMode={cutawayViewMode}
            branches={cutawayBranches}
            onChangeViewMode={setCutawayViewMode}
          />
        </div>
      )}
    </div>
  )
}

function MetricCard({ title, value, sub }: { title: string; value: string; sub: string }) {
  return (
    <div style={{ padding: 10, borderRadius: 8, border: '1px solid var(--border, rgba(255,255,255,0.14))' }}>
      <div style={{ fontSize: 10, opacity: 0.72 }}>{title}</div>
      <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>{value}</div>
      <div style={{ fontSize: 11, opacity: 0.8 }}>{sub}</div>
    </div>
  )
}

const tableStyle = { width: '100%', borderCollapse: 'collapse' as const, fontSize: 11 }
const thStyle = { textAlign: 'left' as const, padding: '6px 8px', borderBottom: '1px solid rgba(255,255,255,0.16)', opacity: 0.8 }
const tdStyle = { padding: '6px 8px', borderBottom: '1px solid rgba(255,255,255,0.08)' }
const btnStyle = { padding: '4px 9px', borderRadius: 6, border: '1px solid rgba(56,189,248,0.5)', background: 'rgba(56,189,248,0.16)', color: 'inherit', cursor: 'pointer', fontSize: 11 }
const numInputStyle = { width: 58, padding: '3px 5px', borderRadius: 5, border: '1px solid rgba(255,255,255,0.2)', background: 'transparent', color: 'inherit', fontSize: 11 }
