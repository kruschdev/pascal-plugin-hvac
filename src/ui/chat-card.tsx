/**
 * Persisted ChatToolCard for `krusch:hvac` (`PluginChatExtension`).
 */

import type { ChatToolCardProps } from '@pascal-app/editor'
import { HVAC_SCHEDULE_VIEW_ID } from './hvac-panel'

export default function HvacChatCard({ toolName, output, state, actions }: ChatToolCardProps) {
  const data = output?.data as Record<string, unknown> | undefined
  const findings = Array.isArray(data?.findings)
    ? (data.findings as Array<{ id: string; title: string; codeRef: string; nodeIds?: string[] }>)
    : []
  const scheduleObj = data?.schedule as
    | {
        manualJ?: { recommendedTons?: number; designTotalCfm?: number; totalCoolingBtuh?: number; totalHeatingBtuh?: number }
      }
    | undefined
  const directManualJ = data?.manualJ as
    | { recommendedTons?: number; designTotalCfm?: number; totalCoolingBtuh?: number; totalHeatingBtuh?: number }
    | undefined
  const manualJ = scheduleObj?.manualJ ?? directManualJ
  const autoTons = typeof data?.recommendedTons === 'number' ? data.recommendedTons : null
  const autoCfm = typeof data?.designTotalCfm === 'number' ? data.designTotalCfm : null
  const autoSummary = typeof data?.summary === 'string' ? data.summary : null
  const bomObj = data?.bom as { grandTotalUsd?: number; totalLaborHours?: number } | undefined
  const clearances = Array.isArray(data?.clearances) ? data.clearances : null
  const routedNodeId = typeof data?.nodeId === 'string' ? data.nodeId : null
  const lengthFt = typeof data?.lengthFt === 'number' ? data.lengthFt : null
  const velocityFpm = typeof data?.velocityFpm === 'number' ? data.velocityFpm : null

  return (
    <div
      style={{
        padding: 10,
        borderRadius: 8,
        border: '1px solid var(--border, rgba(255,255,255,0.16))',
        fontSize: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
        <span>{toolName}</span>
        <span style={{ fontSize: 11, opacity: 0.75 }}>{state}</span>
      </div>
      {output?.text && <div style={{ opacity: 0.85 }}>{output.text}</div>}

      {/* Summary for hvac_autopopulate */}
      {(autoSummary || autoTons !== null) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 }}>
          {autoSummary && <div>{autoSummary}</div>}
          {autoTons !== null && (
            <div>
              <strong>Sized System:</strong> {autoTons} Ton{autoCfm !== null ? ` · ${autoCfm} CFM` : ''}
            </div>
          )}
        </div>
      )}

      {/* Summary for hvac_generate_schedule & hvac_calculate_loads */}
      {(manualJ || bomObj) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 }}>
          {manualJ && (
            <div>
              <strong>Manual J:</strong> {manualJ.recommendedTons ?? 0} Ton ·{' '}
              {manualJ.designTotalCfm ?? 0} CFM · Cool{' '}
              {(manualJ.totalCoolingBtuh ?? 0).toLocaleString()} BTU/h
              {typeof manualJ.totalHeatingBtuh === 'number'
                ? ` · Heat ${manualJ.totalHeatingBtuh.toLocaleString()} BTU/h`
                : ''}
            </div>
          )}
          {bomObj && typeof bomObj.grandTotalUsd === 'number' && (
            <div>
              <strong>Estimated BOM:</strong> ${bomObj.grandTotalUsd.toLocaleString(undefined, { minimumFractionDigits: 2 })} (
              {bomObj.totalLaborHours ?? 0} labor hrs)
            </div>
          )}
          {clearances && (
            <div>
              <strong>Framing Clearances:</strong> {clearances.length} chase / penetration(s)
            </div>
          )}
        </div>
      )}

      {/* Summary for hvac_place_equipment, hvac_place_plenum, hvac_place_terminal */}
      {routedNodeId && lengthFt === null && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11 }}>
          <span>
            <strong>Placed:</strong> {typeof data?.name === 'string' ? data.name : routedNodeId}
            {typeof data?.designCfm === 'number' && data.designCfm > 0 ? ` · ${data.designCfm} CFM` : ''}
          </span>
          <button
            type="button"
            onClick={() => actions.select([routedNodeId])}
            style={{ background: 'transparent', border: 'none', color: '#38bdf8', cursor: 'pointer', fontSize: 11 }}
          >
            Select
          </button>
        </div>
      )}

      {/* Summary for hvac_route_duct */}
      {lengthFt !== null && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11 }}>
          <span>
            <strong>Routed Duct:</strong> {lengthFt} ft
            {velocityFpm !== null && velocityFpm > 0 ? ` · ${velocityFpm} FPM` : ''}
            {clearances ? ` · ${clearances.length} clearance(s)` : ''}
          </span>
          {routedNodeId && (
            <button
              type="button"
              onClick={() => actions.select([routedNodeId])}
              style={{ background: 'transparent', border: 'none', color: '#38bdf8', cursor: 'pointer', fontSize: 11 }}
            >
              Select
            </button>
          )}
        </div>
      )}

      {/* Summary for hvac_audit_imc */}
      {findings.slice(0, 4).map((f) => (
        <div key={f.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
          <span>
            <strong>{f.codeRef}</strong>: {f.title}
          </span>
          {f.nodeIds && f.nodeIds.length > 0 && (
            <button
              type="button"
              onClick={() => actions.select(f.nodeIds!)}
              style={{ background: 'transparent', border: 'none', color: '#38bdf8', cursor: 'pointer', fontSize: 11 }}
            >
              Select
            </button>
          )}
        </div>
      ))}

      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button
          type="button"
          onClick={() => actions.openView(HVAC_SCHEDULE_VIEW_ID, { beside: true })}
          style={{
            padding: '4px 8px',
            borderRadius: 5,
            border: '1px solid rgba(2,132,199,0.55)',
            background: 'rgba(2,132,199,0.18)',
            color: 'inherit',
            cursor: 'pointer',
            fontSize: 11,
          }}
        >
          Open HVAC Schedule
        </button>
      </div>
    </div>
  )
}
