import React, { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { Calendar, ChevronLeft, ChevronRight, Copy, Download, X, Pencil, Lock, Trash2, Plus, Zap, GripVertical } from 'lucide-react';
import {
  DndContext, closestCenter, PointerSensor, TouchSensor, useSensor, useSensors
} from '@dnd-kit/core';
import {
  SortableContext, verticalListSortingStrategy, useSortable, arrayMove
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { apiFetch } from '../lib/api';
import { useToast } from './Toast';

const SHIFT_NAMES = ['Shift A', 'Shift B', 'Shift C'];

// Default planned_start/planned_end offered when adding a part to a shift - matches the plant's
// actual shift boundaries (backend/src/config/shifts.js SHIFT_DEFINITIONS), not just Shift A's
// window for every shift. Shift B's end is stored as "00:00" (midnight) - calculateAutoTarget on
// the backend already knows to treat that as the following day's midnight, not plan_date's own.
const SHIFT_DEFAULT_WINDOW = {
  'Shift A': { start: '07:00', end: '15:30' },
  'Shift B': { start: '15:30', end: '00:00' },
  'Shift C': { start: '00:00', end: '07:00' }
};

function toDateStr(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d + delta);
  return toDateStr(date);
}

function buildMonthGrid(viewMonth) {
  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const startOffset = firstOfMonth.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push(toDateStr(new Date(year, month, day)));
  return cells;
}

function achievementColor(pct) {
  if (pct >= 95) return 'text-emerald-600';
  if (pct >= 70) return 'text-amber-600';
  return 'text-rose-600';
}

function statusBadge(status) {
  switch (status) {
    case 'Running':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    case 'Completed':
      return 'bg-slate-100 text-slate-500 border-slate-200';
    default:
      return 'bg-amber-50 text-amber-700 border-amber-200';
  }
}

function timeHHMM(value) {
  // MySQL TIME columns come back as 'HH:MM:SS' - trim to 'HH:MM' for display/inputs
  return typeof value === 'string' ? value.slice(0, 5) : value;
}

function SortableEntryRow({ entry, canEdit, editableDate, onEdit, onDelete, onActivate }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.id,
    disabled: entry.status !== 'Pending'
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1
  };

  const achievement = entry.target ? (entry.actual.count / entry.target) * 100 : null;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-3 bg-white border rounded-xl px-3 py-2.5 ${entry.isActive ? 'border-emerald-300 ring-1 ring-emerald-200' : 'border-slate-200'}`}
    >
      {entry.status === 'Pending' ? (
        <button {...attributes} {...listeners} className="text-slate-300 hover:text-slate-500 cursor-grab active:cursor-grabbing shrink-0">
          <GripVertical className="w-4 h-4" />
        </button>
      ) : (
        <span className="w-4 h-4 shrink-0" />
      )}

      <span className="text-[10px] font-mono text-slate-400 w-6 shrink-0">#{entry.sequence}</span>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-extrabold text-slate-700 text-sm truncate">{entry.part_name}</span>
          <span className={`text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border ${statusBadge(entry.status)}`}>
            {entry.isActive ? 'Running' : entry.status}
          </span>
        </div>
        <div className="text-[10px] text-slate-400 font-mono">
          {timeHHMM(entry.planned_start)}–{timeHHMM(entry.planned_end)} · Op: {entry.operator || 'Unassigned'} · Cycle {entry.ideal_cycle_time}s
        </div>
      </div>

      <div className="text-right shrink-0 font-mono text-xs">
        <div className="text-slate-700 font-bold">{entry.actual.count}/{entry.target}</div>
        {achievement !== null && (
          <div className={`text-[10px] font-black ${achievementColor(achievement)}`}>{achievement.toFixed(0)}%</div>
        )}
      </div>

      {canEdit && editableDate && (
        <div className="flex items-center gap-1.5 shrink-0">
          {!entry.isActive && entry.status !== 'Completed' && (
            <button onClick={() => onActivate(entry)} title="Activate now (mid-shift override)" className="p-1.5 rounded-lg border border-slate-200 hover:border-sky-300 hover:bg-sky-50 text-slate-400 hover:text-sky-600 transition-colors">
              <Zap className="w-3.5 h-3.5" />
            </button>
          )}
          <button onClick={() => onEdit(entry)} title="Edit" className="p-1.5 rounded-lg border border-slate-200 hover:border-sky-300 hover:bg-sky-50 text-slate-400 hover:text-sky-600 transition-colors">
            <Pencil className="w-3.5 h-3.5" />
          </button>
          {entry.status === 'Pending' && (
            <button onClick={() => onDelete(entry)} title="Delete" className="p-1.5 rounded-lg border border-slate-200 hover:border-rose-300 hover:bg-rose-50 text-slate-400 hover:text-rose-600 transition-colors">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ShiftScheduleList({ machineId, machineName, shift, entries, canEdit, editableDate, onReorder, onEdit, onDelete, onActivate, onAdd }) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } })
  );

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = entries.findIndex((e) => e.id === active.id);
    const newIndex = entries.findIndex((e) => e.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(entries, oldIndex, newIndex);
    onReorder(machineId, shift, reordered.map((e) => e.id));
  };

  return (
    <div className="space-y-2">
      {entries.length === 0 ? (
        <div className="text-center py-6 text-slate-350 italic text-xs">No parts scheduled for {shift}</div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={entries.map((e) => e.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-2">
              {entries.map((entry) => (
                <SortableEntryRow
                  key={entry.id}
                  entry={entry}
                  canEdit={canEdit}
                  editableDate={editableDate}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onActivate={onActivate}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
      {canEdit && editableDate && (
        <button
          onClick={() => onAdd(machineId, machineName, shift)}
          className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl border border-dashed border-slate-300 hover:border-[var(--primary)] hover:bg-slate-50 text-[11px] font-black uppercase tracking-wider text-slate-400 hover:text-[var(--primary)] transition"
        >
          <Plus className="w-3.5 h-3.5" /> Add Part
        </button>
      )}
    </div>
  );
}

export default function PartScheduleBoard({ authToken, machines, sessionUser, onAuthError }) {
  const { showToast } = useToast();
  const today = toDateStr(new Date());
  const canEditPlans = sessionUser?.role === 'PPC Engineer' || sessionUser?.role === 'Admin';

  const [viewMonth, setViewMonth] = useState(() => new Date());
  const [selectedDate, setSelectedDate] = useState(today);
  const [rows, setRows] = useState([]);
  const [editableDate, setEditableDate] = useState(true);
  const [loading, setLoading] = useState(false);
  const [activeShiftTab, setActiveShiftTab] = useState({}); // machineId -> shift name
  // Backend-computed (plant-timezone-aware) - which shift is actually live right now, so the
  // board defaults to showing that instead of always opening on "Shift A" regardless of the
  // real time of day, which is what made a just-created current-shift entry look like it
  // belonged to the wrong shift when activation was attempted.
  const liveCurrentShift = machines.find((m) => m.metrics?.currentShift)?.metrics?.currentShift || 'Shift A';

  const [entryModal, setEntryModal] = useState(null); // { mode, machineId, machineName, shift, entry }
  const [entryForm, setEntryForm] = useState({
    part_number: '', part_name: '', part_operation: '',
    ideal_cycle_time: '', load_unload_allowance_seconds: '',
    planned_start: '', planned_end: ''
  });
  const [copyConfirmOpen, setCopyConfirmOpen] = useState(false);
  const [activatingEntry, setActivatingEntry] = useState(null);
  const [activateReason, setActivateReason] = useState('');

  // Live "Auto Target: N parts" preview, recomputed server-side (same calculateAutoTarget the
  // save actually uses) whenever ideal_cycle_time/allowance/planned_start/planned_end change -
  // never computed client-side, so the preview can never drift from what gets saved. There is no
  // Part Master catalog and no default allowance - Part Number/Name/Operation, Ideal Cycle Time,
  // and the Loading/Unloading Allowance are all typed directly into this form every time.
  const [targetPreview, setTargetPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const monthCells = useMemo(() => buildMonthGrid(viewMonth), [viewMonth]);

  const fetchSchedules = async (date) => {
    setLoading(true);
    try {
      const data = await apiFetch(`/api/part-schedules?date=${date}`, { token: authToken });
      setRows(data.rows);
      setEditableDate(data.editable);
    } catch (err) {
      if (!onAuthError?.(err)) showToast(err.message || 'Failed to load part schedules.', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSchedules(selectedDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate, authToken]);

  // Live target preview - server-computed (calculateAutoTarget), debounced against
  // ideal_cycle_time/allowance/planned_start/planned_end changes so it doesn't fire on every keystroke.
  useEffect(() => {
    const cycle = parseInt(entryForm.ideal_cycle_time);
    const allowance = parseInt(entryForm.load_unload_allowance_seconds);
    if (!entryModal || isNaN(cycle) || cycle <= 0 || isNaN(allowance) || allowance < 0 || !entryForm.planned_start || !entryForm.planned_end) {
      setTargetPreview(null);
      return undefined;
    }
    setPreviewLoading(true);
    const timer = setTimeout(() => {
      const params = new URLSearchParams({
        planDate: selectedDate,
        plannedStart: entryForm.planned_start,
        plannedEnd: entryForm.planned_end,
        idealCycleTime: String(cycle),
        loadUnloadAllowanceSeconds: String(allowance)
      });
      apiFetch(`/api/part-schedules/preview-target?${params.toString()}`, { token: authToken })
        .then((data) => setTargetPreview(data))
        .catch((err) => {
          setTargetPreview(null);
          if (!onAuthError?.(err)) showToast(err.message || 'Failed to compute target preview.', 'error');
        })
        .finally(() => setPreviewLoading(false));
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryModal, entryForm.ideal_cycle_time, entryForm.load_unload_allowance_seconds, entryForm.planned_start, entryForm.planned_end, selectedDate, authToken]);

  const openAddModal = (machineId, machineName, shift) => {
    const defaultWindow = SHIFT_DEFAULT_WINDOW[shift] || SHIFT_DEFAULT_WINDOW['Shift A'];
    setEntryModal({ mode: 'create', machineId, machineName, shift, entry: null });
    setEntryForm({ part_number: '', part_name: '', part_operation: '', ideal_cycle_time: '', load_unload_allowance_seconds: '', planned_start: defaultWindow.start, planned_end: defaultWindow.end });
    setTargetPreview(null);
  };

  const openEditModal = (entry) => {
    const row = rows.find((r) => r.entries.some((e) => e.id === entry.id));
    setEntryModal({ mode: 'edit', machineId: row.machineId, machineName: row.machineName, shift: row.shift, entry });
    setEntryForm({
      part_number: entry.part_number || '',
      part_name: entry.part_name || '',
      part_operation: entry.part_operation || '',
      ideal_cycle_time: entry.ideal_cycle_time,
      load_unload_allowance_seconds: entry.load_unload_allowance_seconds ?? '',
      planned_start: timeHHMM(entry.planned_start),
      planned_end: timeHHMM(entry.planned_end)
    });
    setTargetPreview(null);
  };

  const handleSaveEntry = async (e) => {
    e.preventDefault();
    if (!entryModal) return;
    const selectedPartName = entryForm.part_name || 'part';

    try {
      if (entryModal.mode === 'edit') {
        await apiFetch(`/api/part-schedules/${entryModal.entry.id}`, {
          method: 'PUT',
          token: authToken,
          body: entryForm
        });
        showToast(`Updated "${selectedPartName}"`, 'success');
      } else {
        await apiFetch('/api/part-schedules', {
          method: 'POST',
          token: authToken,
          body: { machine_id: entryModal.machineId, plan_date: selectedDate, shift: entryModal.shift, ...entryForm }
        });
        showToast(`Added "${selectedPartName}" to ${entryModal.shift}`, 'success');
      }
      setEntryModal(null);
      fetchSchedules(selectedDate);
    } catch (err) {
      if (!onAuthError?.(err)) showToast(err.message || 'Failed to save part schedule entry.', 'error');
    }
  };

  const handleDeleteEntry = async (entry) => {
    if (!window.confirm(`Delete scheduled part "${entry.part_name}"?`)) return;
    try {
      await apiFetch(`/api/part-schedules/${entry.id}`, { method: 'DELETE', token: authToken });
      showToast('Part schedule entry deleted', 'success');
      fetchSchedules(selectedDate);
    } catch (err) {
      if (!onAuthError?.(err)) showToast(err.message || 'Failed to delete entry.', 'error');
    }
  };

  const handleReorder = async (machineId, shift, orderedIds) => {
    // Optimistic local update so the drag doesn't visually snap back while the request is in flight.
    setRows((prev) => prev.map((row) => {
      if (row.machineId !== machineId || row.shift !== shift) return row;
      const byId = Object.fromEntries(row.entries.map((e) => [e.id, e]));
      return { ...row, entries: orderedIds.map((id) => byId[id]).filter(Boolean) };
    }));

    try {
      await apiFetch('/api/part-schedules/reorder', {
        method: 'POST',
        token: authToken,
        body: { machine_id: machineId, plan_date: selectedDate, shift, orderedIds }
      });
      fetchSchedules(selectedDate);
    } catch (err) {
      if (!onAuthError?.(err)) showToast(err.message || 'Failed to reorder schedule.', 'error');
      fetchSchedules(selectedDate);
    }
  };

  const handleActivate = async () => {
    if (!activatingEntry) return;
    try {
      await apiFetch(`/api/part-schedules/${activatingEntry.row.machineId}/activate`, {
        method: 'POST',
        token: authToken,
        body: { scheduleId: activatingEntry.entry.id, reason: activateReason || undefined }
      });
      showToast(`Activated "${activatingEntry.entry.part_name}"`, 'success');
      setActivatingEntry(null);
      setActivateReason('');
      fetchSchedules(selectedDate);
    } catch (err) {
      if (!onAuthError?.(err)) showToast(err.message || 'Failed to activate part.', 'error');
    }
  };

  const handleCopyPreviousDay = async () => {
    setCopyConfirmOpen(false);
    try {
      await apiFetch('/api/part-schedules/copy-day', {
        method: 'POST',
        token: authToken,
        body: { sourceDate: addDays(selectedDate, -1), targetDate: selectedDate }
      });
      showToast("Previous day's schedule copied.", 'success');
      fetchSchedules(selectedDate);
    } catch (err) {
      if (!onAuthError?.(err)) showToast(err.message || 'Failed to copy previous day.', 'error');
    }
  };

  const handleExportExcel = () => {
    const sheetData = [];
    rows.forEach((row) => {
      row.entries.forEach((entry) => {
        sheetData.push({
          'Machine ID': row.machineId,
          'Machine Name': row.machineName,
          'Shift': row.shift,
          'Seq': entry.sequence,
          'Part': entry.part_name,
          'Status': entry.isActive ? 'Running' : entry.status,
          'Planned Start': timeHHMM(entry.planned_start),
          'Planned End': timeHHMM(entry.planned_end),
          'Operator': entry.operator || '',
          'Target': entry.target,
          'Actual': entry.actual.count,
          'Good': entry.actual.good,
          'Scrap': entry.actual.scrap,
          'Achievement %': entry.target ? ((entry.actual.count / entry.target) * 100).toFixed(1) : ''
        });
      });
    });

    const worksheet = XLSX.utils.json_to_sheet(sheetData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, selectedDate);
    XLSX.writeFile(workbook, `part_schedule_${selectedDate}.xlsx`);
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[340px_1fr] gap-6 items-start">

      {/* Calendar picker */}
      <div className="jbm-card p-5">
        <div className="flex items-center justify-between mb-4">
          <button
            onClick={() => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
            className="p-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-500"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-sm font-black uppercase tracking-wider text-[var(--grey-900)]">
            {viewMonth.toLocaleDateString([], { month: 'long', year: 'numeric' })}
          </span>
          <button
            onClick={() => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
            className="p-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-500"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-7 gap-1 text-center mb-1.5">
          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
            <span key={i} className="text-[10px] font-black text-slate-400 uppercase">{d}</span>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-1">
          {monthCells.map((dateStr, i) => {
            if (!dateStr) return <div key={i} />;
            const isToday = dateStr === today;
            const isSelected = dateStr === selectedDate;
            const isPast = dateStr < today;
            return (
              <button
                key={dateStr}
                onClick={() => setSelectedDate(dateStr)}
                className={`aspect-square rounded-lg text-xs font-bold transition flex items-center justify-center ${
                  isSelected ? 'bg-[var(--primary)] text-white' :
                  isToday ? 'border border-[var(--primary)] text-[var(--primary)]' :
                  isPast ? 'text-slate-350 hover:bg-slate-50' : 'text-slate-700 hover:bg-slate-100'
                }`}
              >
                {Number(dateStr.slice(-2))}
              </button>
            );
          })}
        </div>

        <div className="mt-4 pt-4 border-t border-[var(--grey-200)] space-y-2 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
          <div className="flex items-center gap-2"><span className="w-3 h-3 rounded bg-[var(--primary)]"></span> Selected date</div>
          <div className="flex items-center gap-2"><span className="w-3 h-3 rounded border border-[var(--primary)]"></span> Today</div>
          <div className="flex items-center gap-2"><Lock className="w-3 h-3" /> Past dates are read-only</div>
        </div>
      </div>

      {/* Selected date schedule board */}
      <div className="jbm-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-[var(--grey-200)] mb-6">
          <div className="flex items-center gap-2.5">
            <Calendar className="w-6 h-6 text-[var(--primary)] shrink-0" />
            <div>
              <h4 className="text-base font-black uppercase text-[var(--grey-900)] tracking-wide">
                {new Date(selectedDate).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
              </h4>
              <p className="text-xs font-bold text-slate-400 uppercase tracking-widest font-mono">
                {editableDate ? (canEditPlans ? 'Editable part schedule' : 'View only (PPC/Admin can edit)') : 'Historical record - read only'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {canEditPlans && editableDate && (
              <button
                onClick={() => setCopyConfirmOpen(true)}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 bg-[var(--bg-color-page)] hover:border-[var(--primary)] text-[10px] font-black uppercase tracking-wider text-slate-600 transition"
              >
                <Copy className="w-3.5 h-3.5" /> Copy Previous Day
              </button>
            )}
            <button
              onClick={handleExportExcel}
              disabled={rows.length === 0}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[var(--primary)] hover:bg-[var(--primary)]/90 disabled:opacity-50 text-white text-[10px] font-black uppercase tracking-wider shadow-sm transition"
            >
              <Download className="w-3.5 h-3.5" /> Export Excel
            </button>
          </div>
        </div>

        {loading ? (
          <div className="text-center py-20 text-slate-400 uppercase tracking-widest font-black text-xs">Loading...</div>
        ) : rows.length === 0 ? (
          <div className="text-center py-20 text-slate-400 uppercase tracking-widest font-black text-xs">No machines configured</div>
        ) : (
          <div className="space-y-5">
            {Object.values(
              rows.reduce((acc, row) => {
                if (!acc[row.machineId]) acc[row.machineId] = { machineId: row.machineId, machineName: row.machineName, byShift: {} };
                acc[row.machineId].byShift[row.shift] = row;
                return acc;
              }, {})
            ).map((machine) => {
              const currentTab = activeShiftTab[machine.machineId] || liveCurrentShift;
              const activeRow = machine.byShift[currentTab];
              return (
                <div key={machine.machineId} className="border border-[var(--grey-200)] rounded-2xl p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                    <div>
                      <h5 className="text-sm font-black text-[var(--grey-900)] uppercase tracking-wide">{machine.machineName}</h5>
                      <span className="text-[10px] font-mono text-[var(--primary)] font-bold">{machine.machineId}</span>
                    </div>
                    <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl border border-slate-200">
                      {SHIFT_NAMES.map((shift) => (
                        <button
                          key={shift}
                          onClick={() => setActiveShiftTab((prev) => ({ ...prev, [machine.machineId]: shift }))}
                          className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition flex items-center gap-1 ${
                            currentTab === shift ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                          }`}
                        >
                          {shift === liveCurrentShift && (
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" title="Live shift right now" />
                          )}
                          {shift}
                        </button>
                      ))}
                    </div>
                  </div>

                  {activeRow && (
                    <ShiftScheduleList
                      machineId={machine.machineId}
                      machineName={machine.machineName}
                      shift={currentTab}
                      entries={activeRow.entries}
                      canEdit={canEditPlans}
                      editableDate={editableDate}
                      onReorder={handleReorder}
                      onEdit={openEditModal}
                      onDelete={handleDeleteEntry}
                      onActivate={(entry) => setActivatingEntry({ entry, row: activeRow })}
                      onAdd={openAddModal}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Add/Edit entry modal */}
      {entryModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[60] flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="bg-[var(--white-color)] rounded-2xl border border-[var(--grey-200)] shadow-2xl w-full max-w-md p-6 text-left">
            <div className="flex items-center justify-between mb-4">
              <h4 className="text-sm font-black uppercase tracking-wider text-[var(--grey-900)]">
                {entryModal.machineName} - {entryModal.shift} {entryModal.mode === 'edit' ? '(Edit)' : '(Add Part)'}
              </h4>
              <button onClick={() => setEntryModal(null)} className="text-slate-400 hover:text-slate-700"><X className="w-4 h-4" /></button>
            </div>
            <form onSubmit={handleSaveEntry} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-black uppercase tracking-wider text-slate-455 mb-1">Part Number</label>
                  <input
                    value={entryForm.part_number}
                    onChange={(e) => setEntryForm({ ...entryForm, part_number: e.target.value })}
                    disabled={entryModal.mode === 'edit'}
                    required
                    placeholder="e.g. DK68"
                    className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] focus:border-[var(--primary)] rounded-xl py-2.5 px-3 text-xs font-bold outline-none disabled:opacity-60"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-black uppercase tracking-wider text-slate-455 mb-1">Part Name</label>
                  <input
                    value={entryForm.part_name}
                    onChange={(e) => setEntryForm({ ...entryForm, part_name: e.target.value })}
                    disabled={entryModal.mode === 'edit'}
                    required
                    placeholder="e.g. Pulley Assembly"
                    className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] focus:border-[var(--primary)] rounded-xl py-2.5 px-3 text-xs font-bold outline-none disabled:opacity-60"
                  />
                </div>
              </div>
              {entryModal.mode === 'edit' && (
                <p className="text-[9px] text-slate-400 -mt-2">Part Number/Name can't be changed here - delete and re-add instead.</p>
              )}
              <div>
                <label className="block text-[10px] font-black uppercase tracking-wider text-slate-455 mb-1">Part Operation</label>
                <input
                  value={entryForm.part_operation}
                  onChange={(e) => setEntryForm({ ...entryForm, part_operation: e.target.value })}
                  placeholder="e.g. Turning, Facing, Drilling"
                  className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] focus:border-[var(--primary)] rounded-xl py-2.5 px-3 text-xs font-bold outline-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-black uppercase tracking-wider text-slate-455 mb-1">Ideal Cycle Time (s)</label>
                  <input
                    type="number"
                    min="1"
                    value={entryForm.ideal_cycle_time}
                    onChange={(e) => setEntryForm({ ...entryForm, ideal_cycle_time: e.target.value })}
                    required
                    className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] focus:border-[var(--primary)] rounded-xl py-2.5 px-3 text-xs font-bold outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-black uppercase tracking-wider text-slate-455 mb-1">Loading/Unloading (s)</label>
                  <input
                    type="number"
                    min="0"
                    value={entryForm.load_unload_allowance_seconds}
                    onChange={(e) => setEntryForm({ ...entryForm, load_unload_allowance_seconds: e.target.value })}
                    required
                    placeholder="e.g. 15"
                    className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] focus:border-[var(--primary)] rounded-xl py-2.5 px-3 text-xs font-bold outline-none"
                  />
                </div>
              </div>
              <div className="bg-[var(--bg-color-page)] border border-[var(--grey-200)] rounded-xl py-2.5 px-3">
                <label className="block text-[10px] font-black uppercase tracking-wider text-slate-455 mb-1">Automatic Target</label>
                {previewLoading ? (
                  <p className="text-xs font-bold text-slate-400">Calculating...</p>
                ) : targetPreview ? (
                  <p className="text-sm font-black text-[var(--grey-900)]">
                    {targetPreview.target} parts
                    <span className="block text-[10px] font-semibold text-slate-400 mt-0.5 normal-case">
                      Effective Cycle {targetPreview.effectiveCycleTime}s over {Math.round(targetPreview.availableSeconds / 60)}m available
                    </span>
                  </p>
                ) : (
                  <p className="text-xs font-bold text-slate-400">Enter Ideal Cycle Time, Allowance, and the planned window to calculate.</p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-black uppercase tracking-wider text-slate-455 mb-1">Planned Start</label>
                  <input
                    type="time"
                    value={entryForm.planned_start}
                    onChange={(e) => setEntryForm({ ...entryForm, planned_start: e.target.value })}
                    required
                    className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] focus:border-[var(--primary)] rounded-xl py-2.5 px-3 text-xs font-bold outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-black uppercase tracking-wider text-slate-455 mb-1">Planned End</label>
                  <input
                    type="time"
                    value={entryForm.planned_end}
                    onChange={(e) => setEntryForm({ ...entryForm, planned_end: e.target.value })}
                    required
                    className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] focus:border-[var(--primary)] rounded-xl py-2.5 px-3 text-xs font-bold outline-none"
                  />
                </div>
              </div>
              <p className="text-[10px] text-slate-400 font-semibold px-0.5">
                Operator assignment is handled separately by the Supervisor once this part is scheduled.
              </p>
              <button
                type="submit"
                disabled={!entryForm.part_number || !entryForm.part_name}
                className="w-full bg-[var(--primary)] disabled:opacity-40 text-white text-xs font-black uppercase tracking-wider py-3 rounded-xl transition active:scale-95 mt-2"
              >
                {entryModal.mode === 'edit' ? 'Save Changes' : 'Add Part'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Manual override / activate confirm */}
      {activatingEntry && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[60] flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="bg-[var(--white-color)] rounded-2xl border border-[var(--grey-200)] shadow-2xl w-full max-w-sm p-6 text-left">
            <h4 className="text-sm font-black uppercase tracking-wider text-[var(--grey-900)]">Activate "{activatingEntry.entry.part_name}" now?</h4>
            <p className="text-sm text-slate-500 mt-2">
              This immediately closes out the current running part's tally and switches production to this part, out of sequence if needed.
            </p>
            <div className="mt-3">
              <label className="block text-[10px] font-black uppercase tracking-wider text-slate-455 mb-1">Reason (optional)</label>
              <input
                value={activateReason}
                onChange={(e) => setActivateReason(e.target.value)}
                placeholder="e.g. urgent order, tooling issue"
                className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] focus:border-[var(--primary)] rounded-xl py-2.5 px-3 text-xs font-bold outline-none"
              />
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={() => { setActivatingEntry(null); setActivateReason(''); }} className="flex-1 py-2.5 rounded-xl border border-slate-200 text-slate-500 font-extrabold text-xs uppercase tracking-wider hover:bg-slate-50">Cancel</button>
              <button onClick={handleActivate} className="flex-1 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-700 text-white font-extrabold text-xs uppercase tracking-wider shadow-sm transition active:scale-95">Activate</button>
            </div>
          </div>
        </div>
      )}

      {/* Copy previous day confirm */}
      {copyConfirmOpen && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[60] flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="bg-[var(--white-color)] rounded-2xl border border-[var(--grey-200)] shadow-2xl w-full max-w-sm p-6 text-left">
            <h4 className="text-sm font-black uppercase tracking-wider text-[var(--grey-900)]">Copy Previous Day's Schedule?</h4>
            <p className="text-sm text-slate-500 mt-2">
              This copies every machine/shift's scheduled parts from <strong className="text-[var(--grey-900)]">{addDays(selectedDate, -1)}</strong> onto <strong className="text-[var(--grey-900)]">{selectedDate}</strong>.
            </p>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setCopyConfirmOpen(false)} className="flex-1 py-2.5 rounded-xl border border-slate-200 text-slate-500 font-extrabold text-xs uppercase tracking-wider hover:bg-slate-50">Cancel</button>
              <button onClick={handleCopyPreviousDay} className="flex-1 py-2.5 rounded-xl bg-[var(--primary)] hover:bg-[var(--primary)]/90 text-white font-extrabold text-xs uppercase tracking-wider shadow-sm transition active:scale-95">Copy</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
