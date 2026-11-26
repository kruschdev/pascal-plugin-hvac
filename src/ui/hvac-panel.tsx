/**
 * Left-rail EditorHostPanel for `krusch:hvac`.
 * Uses scoped inline styles and Pascal CSS variables so zero global CSS leaks.
 */

import { type AnyNode, runAsSingleSceneHistoryStep } from '@pascal-app/core'
import { openEditorView, useScene, useViewer } from '@pascal-app/editor'
import { useMemo, useState } from 'react'
import { hvacAgentOperations } from '../agent-operations'
import { auditSceneHvac } from '../imc/audit'
import { type SceneNodeLike, belongsToLevel } from '../imc/framing-interop'
import { buildHvacSchedule } from '../imc/schedule'
import {
  CLIMATE_ZONES,
  type ClimateZone,
  type CodeEdition,
  type DuctPlenumLocation,
  HVAC_EQUIPMENT_SPECS,
  HVAC_SYSTEM_COLORS,
  HVAC_TERMINAL_SPECS,
  type HvacDuctSystem,
  type HvacEquipmentKind,
  type HvacSystemType,
  type HvacTerminalKind,
  type OccupancyType,
} from '../imc/tables'
import { useHvacUi } from './store'

export const HVAC_SCHEDULE_VIEW_ID = 'krusch:hvac:schedule'

function activeLevelOf(nodes: Readonly<Record<string, AnyNode>>, selectedLevelId: string | null): string | null {
  if (selectedLevelId && nodes[selectedLevelId]) return selectedLevelId
  for (const n of Object.values(nodes)) {
    if (n.type === 'level') return n.id
  }
  return null
}

const QUICK_EQUIPMENT: ReadonlyArray<{ kind: HvacEquipmentKind; label: string }> = [
  { kind: 'air-handler', label: 'Variable-Speed Air Handler (A-Coil)' },
  { kind: 'heat-pump-condenser', label: 'Split Heat Pump Condenser (SEER2)' },
  { kind: 'gas-furnace-96', label: '96% Condensing Gas Furnace' },
  { kind: 'gas-furnace-80', label: '80% Standard Gas Furnace' },
  { kind: 'ac-condenser', label: 'Split AC Condenser (SEER2)' },
  { kind: 'mini-split-outdoor', label: 'Multi-Zone Mini-Split Outdoor' },
  { kind: 'rooftop-package-unit', label: 'Packaged Rooftop Unit (RTU)' },
  { kind: 'erv-ventilator', label: 'ASHRAE 62.2 ERV Ventilator' },
  { kind: 'dehumidifier-whole-house', label: 'Whole-House Ducted Dehumidifier' },
  { kind: 'bath-exhaust-fan', label: 'Ultra-Quiet Bath Exhaust Fan' },
  { kind: 'range-hood', label: 'Vented Kitchen Range Hood' },
]

const QUICK_TERMINALS: ReadonlyArray<{ kind: HvacTerminalKind; label: string }> = [
  { kind: 'supply-ceiling-diffuser', label: 'Ceiling 4-Way Supply Diffuser' },
  { kind: 'supply-floor-register', label: '4x10 Floor Supply Register' },
  { kind: 'supply-wall-register', label: 'High-Sidewall Supply Register' },
  { kind: 'return-grille', label: 'Filter-Back Return Air Grille' },
  { kind: 'transfer-grille', label: 'Bedroom Return Transfer Grille' },
  { kind: 'mini-split-wall-head', label: 'Mini-Split Wall Head' },
  { kind: 'smart-thermostat', label: 'Smart Wi-Fi Thermostat (18/8)' },
  { kind: 'zone-sensor', label: 'Remote Room Temp / RH Sensor' },
  { kind: 'exhaust-grille', label: 'Exhaust Air Grille' },
  { kind: 'fresh-air-intake', label: 'Exterior Fresh-Air Intake Hood' },
]

export default function HvacHostPanel() {
  const nodes = useScene((s) => s.nodes)
  const createNode = useScene((s) => s.createNode)
  const createNodes = useScene((s) => s.createNodes)
  const deleteNodes = useScene((s) => s.deleteNodes)
  const updateNodes = useScene((s) => s.updateNodes)
  const selectedLevelId = useViewer((s) => s.selection.levelId)

  const {
    codeEdition,
    setCodeEdition,
    occupancy,
    setOccupancy,
    climateZone,
    setClimateZone,
    systemType,
    setSystemType,
    plenumLocation,
    setPlenumLocation,
    includeErv,
    setIncludeErv,
    includeExhaustFans,
    setIncludeExhaustFans,
    hiddenSystems,
    toggleSystemVisibility,
    setActiveTab,
  } = useHvacUi()

  const [selectedEq, setSelectedEq] = useState<HvacEquipmentKind>('air-handler')
  const [selectedTerm, setSelectedTerm] = useState<HvacTerminalKind>('supply-ceiling-diffuser')
  const [statusMsg, setStatusMsg] = useState<string | null>(null)

  const record = nodes as unknown as Readonly<Record<string, SceneNodeLike>>
  const levelId = activeLevelOf(nodes, selectedLevelId)

  const audit = useMemo(
    () => auditSceneHvac(record, { codeEdition, climateZone, occupancy }),
    [record, codeEdition, climateZone, occupancy],
  )
  const schedule = useMemo(
    () => buildHvacSchedule(record, { codeEdition, climateZone, occupancy, systemType }),
    [record, codeEdition, climateZone, occupancy, systemType],
  )

  const unwiredPowerCount = schedule.electricalCoordination.filter((c) => !c.wired).length

  const runAutoPopulate = () => {
    if (!levelId) {
      setStatusMsg('Create a building level first before auto-populating HVAC.')
      return
    }
    const outcome = hvacAgentOperations.hvac_autopopulate(
      nodes,
      {
        levelId,
        codeEdition,
        occupancy,
        climateZone,
        systemType,
        plenumLocation,
        includeErv,
        includeExhaustFans,
        clearExisting: true,
      },
      { activeLevelId: levelId },
    )
    runAsSingleSceneHistoryStep(useScene, () => {
      if (outcome.changes?.delete && outcome.changes.delete.length > 0) {
        deleteNodes(outcome.changes.delete as never)
      }
      if (outcome.changes?.create && outcome.changes.create.length > 0) {
        createNodes(outcome.changes.create as never)
      }
    })
    setStatusMsg(String(outcome.result.summary))
  }

  const clearHvac = () => {
    const ids = Object.values(record)
      .filter((n) => n.type.startsWith('hvac:') && belongsToLevel(record, n, levelId))
      .map((n) => n.id)
    if (ids.length === 0) return
    runAsSingleSceneHistoryStep(useScene, () => {
      deleteNodes(ids as never)
    })
    setStatusMsg(`Cleared ${ids.length} HVAC node(s) on active level.`)
  }

  const toggleSystem = (sys: HvacDuctSystem) => {
    const willHide = !hiddenSystems[sys]
    toggleSystemVisibility(sys)
    const updates = Object.values(record)
      .filter((n) => n.type === 'hvac:duct-run' && n.system === sys && belongsToLevel(record, n, levelId))
      .map((n) => ({ id: n.id, data: { visible: !willHide } }))
    if (updates.length > 0) {
      updateNodes(updates as never)
    }
  }

  const placeEquipment = () => {
    if (!levelId) {
      setStatusMsg('Create a building level first before placing HVAC equipment.')
      return
    }
    const mountY = HVAC_EQUIPMENT_SPECS[selectedEq]?.defaultMountY ?? 0
    const outcome = hvacAgentOperations.hvac_place_equipment(
      nodes,
      { levelId, equipmentKind: selectedEq, position: [1.0, mountY, 1.0], occupancy },
      { activeLevelId: levelId },
    )
    const created = outcome.changes?.create?.[0]
    if (created) {
      createNode(created.node, created.parentId as never)
      setStatusMsg(`Placed ${String(outcome.result.name)}.`)
    }
  }

  const placeTerminal = () => {
    if (!levelId) {
      setStatusMsg('Create a building level first before placing terminals.')
      return
    }
    const mountY = HVAC_TERMINAL_SPECS[selectedTerm]?.defaultMountY ?? 2.55
    const outcome = hvacAgentOperations.hvac_place_terminal(
      nodes,
      { levelId, terminalKind: selectedTerm, position: [1.5, mountY, 1.5] },
      { activeLevelId: levelId },
    )
    const created = outcome.changes?.create?.[0]
    if (created) {
      createNode(created.node, created.parentId as never)
      setStatusMsg(`Placed ${String(outcome.result.name)}.`)
    }
  }

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong style={{ fontSize: 13 }}>HVAC ({codeEdition})</strong>
        <button
          type="button"
          onClick={() => openEditorView(HVAC_SCHEDULE_VIEW_ID, { beside: true })}
          style={primaryBtnStyle}
        >
          Open Schedule
        </button>
      </div>

      <div style={sectionStyle}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <select value={codeEdition} onChange={(e) => setCodeEdition(e.target.value as CodeEdition)} style={selectStyle}>
            <option value="IMC-2021">IMC 2021</option>
            <option value="UMC-2021">UMC 2021</option>
          </select>
          <select value={occupancy} onChange={(e) => setOccupancy(e.target.value as OccupancyType)} style={selectStyle}>
            <option value="residential">Residential</option>
            <option value="commercial">Commercial</option>
          </select>
          <select value={systemType} onChange={(e) => setSystemType(e.target.value as HvacSystemType)} style={selectStyle}>
            <option value="split-heat-pump">Split Heat Pump</option>
            <option value="split-gas-furnace">96% Gas Furnace + AC</option>
            <option value="mini-split-multizone">Multi-Zone Mini-Split</option>
            <option value="rooftop-package">Packaged Rooftop RTU</option>
          </select>
          <select
            value={plenumLocation}
            onChange={(e) => setPlenumLocation(e.target.value as DuctPlenumLocation)}
            style={selectStyle}
          >
            <option value="attic">Attic Plenum (R-8)</option>
            <option value="crawlspace">Crawlspace (Under Floor)</option>
            <option value="basement">Basement (Joist Bays)</option>
            <option value="conditioned-soffit">Conditioned Soffit</option>
          </select>
        </div>

        <select value={climateZone} onChange={(e) => setClimateZone(e.target.value as ClimateZone)} style={selectStyle}>
          {(Object.keys(CLIMATE_ZONES) as ClimateZone[]).map((z) => (
            <option key={z} value={z}>
              Zone {z}: {CLIMATE_ZONES[z].label}
            </option>
          ))}
        </select>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 11 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={includeErv} onChange={(e) => setIncludeErv(e.target.checked)} />
            ASHRAE 62.2 ERV
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={includeExhaustFans} onChange={(e) => setIncludeExhaustFans(e.target.checked)} />
            Bath / Kitchen Exhaust
          </label>
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" onClick={runAutoPopulate} style={{ ...primaryBtnStyle, flex: 1 }}>
            Auto-Populate HVAC
          </button>
          <button type="button" onClick={clearHvac} style={ghostBtnStyle}>
            Clear
          </button>
        </div>
      </div>

      <div style={sectionStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>Manual J / Design Airflow</span>
          <strong>
            {schedule.manualJ.recommendedTons} Ton · {schedule.manualJ.designTotalCfm} CFM
          </strong>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, opacity: 0.85 }}>
          <span>Cool / Heat Peak</span>
          <span>
            {Math.round(schedule.manualJ.totalCoolingBtuh / 1000)}k / {Math.round(schedule.manualJ.totalHeatingBtuh / 1000)}k BTU/h
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
          <span>IMC / IECC Audit</span>
          <button
            type="button"
            onClick={() => {
              setActiveTab('audit')
              openEditorView(HVAC_SCHEDULE_VIEW_ID, { beside: true })
            }}
            style={{
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              color: audit.errorCount > 0 ? '#ef4444' : '#22c55e',
              fontWeight: 600,
              fontSize: 11,
            }}
          >
            {audit.errorCount} Err · {audit.warningCount} Warn
          </button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
          <span>Electrical Panel Handoff</span>
          <span style={{ color: unwiredPowerCount > 0 ? '#f59e0b' : '#22c55e', fontWeight: 600 }}>
            {schedule.electricalCoordination.length - unwiredPowerCount}/{schedule.electricalCoordination.length} Wired
          </span>
        </div>
      </div>

      <div style={sectionStyle}>
        <div style={{ fontWeight: 600, fontSize: 11 }}>Duct &amp; Mechanical Layers</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {(Object.keys(HVAC_SYSTEM_COLORS) as HvacDuctSystem[]).map((sys) => {
            const meta = HVAC_SYSTEM_COLORS[sys]
            const hidden = hiddenSystems[sys]
            return (
              <button
                key={sys}
                type="button"
                onClick={() => toggleSystem(sys)}
                style={{
                  padding: '3px 7px',
                  borderRadius: 999,
                  fontSize: 10,
                  cursor: 'pointer',
                  border: `1px solid ${meta.hex}`,
                  background: hidden ? 'transparent' : `${meta.hex}26`,
                  opacity: hidden ? 0.45 : 1,
                  color: 'inherit',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: meta.hex }} />
                {meta.label}
              </button>
            )
          })}
        </div>
      </div>

      <div style={sectionStyle}>
        <div style={{ fontWeight: 600, fontSize: 11 }}>Catalog Placement</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <select
            value={selectedEq}
            onChange={(e) => setSelectedEq(e.target.value as HvacEquipmentKind)}
            style={{ ...selectStyle, flex: 1 }}
          >
            {QUICK_EQUIPMENT.map((item) => (
              <option key={item.kind} value={item.kind}>
                {item.label}
              </option>
            ))}
          </select>
          <button type="button" onClick={placeEquipment} style={ghostBtnStyle}>
            + Eq
          </button>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <select
            value={selectedTerm}
            onChange={(e) => setSelectedTerm(e.target.value as HvacTerminalKind)}
            style={{ ...selectStyle, flex: 1 }}
          >
            {QUICK_TERMINALS.map((item) => (
              <option key={item.kind} value={item.kind}>
                {item.label}
              </option>
            ))}
          </select>
          <button type="button" onClick={placeTerminal} style={ghostBtnStyle}>
            + Term
          </button>
        </div>
        <button
          type="button"
          onClick={() => {
            setActiveTab('cutaway')
            openEditorView(HVAC_SCHEDULE_VIEW_ID, { beside: true })
          }}
          style={{ ...ghostBtnStyle, width: '100%' }}
        >
          Inspect 3D Air Handler &amp; Joist-Bay Cutaway
        </button>
      </div>

      {statusMsg && <div style={{ fontSize: 11, opacity: 0.8 }}>{statusMsg}</div>}
    </div>
  )
}

const sectionStyle = {
  padding: 8,
  borderRadius: 8,
  border: '1px solid var(--border, rgba(255,255,255,0.14))',
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 6,
}

const selectStyle = {
  padding: '4px 6px',
  borderRadius: 6,
  border: '1px solid var(--border, rgba(255,255,255,0.18))',
  background: 'var(--background, rgba(15,23,42,0.75))',
  color: 'inherit',
  fontSize: 11,
}

const primaryBtnStyle = {
  padding: '5px 9px',
  borderRadius: 6,
  border: '1px solid rgba(2,132,199,0.65)',
  background: 'rgba(2,132,199,0.24)',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 11,
  fontWeight: 600,
}

const ghostBtnStyle = {
  padding: '5px 8px',
  borderRadius: 6,
  border: '1px solid var(--border, rgba(255,255,255,0.2))',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 11,
}
