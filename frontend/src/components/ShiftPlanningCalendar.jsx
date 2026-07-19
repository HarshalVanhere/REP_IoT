import React, { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { Calendar, ChevronLeft, ChevronRight, Copy, Download, X, Pencil, Lock } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useToast } from './Toast';

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
  const startOffset = firstOfMonth.getDay(); // 0 = Sunday
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

export default function ShiftPlanningCalendar({ authToken, machines, sessionUser, onAuthError }) {
  const { showToast } = useToast();
  const today = toDateStr(new Date());
  const canEditPlans = sessionUser?.role === 'PPC Engineer' || sessionUser?.role === 'Admin';

  const [viewMonth, setViewMonth] = useState(() => new Date());
  const [selectedDate, setSelectedDate] = useState(today);
  const [rows, setRows] = useState([]);
  const [editableDate, setEditableDate] = useState(true);
  const [loading, setLoading] = useState(false);
  const [editingRow, setEditingRow] = useState(null);
  const [editForm, setEditForm] = useState({ target: 0, ideal_cycle_time: 0, part_name: '', operator: '' });
  const [copyConfirmOpen, setCopyConfirmOpen] = useState(false);
  const [viewMode, setViewMode] = useState('table');

  const monthCells = useMemo(() => buildMonthGrid(viewMonth), [viewMonth]);

  const groupedRows = useMemo(() => {
    const groups = {};
    rows.forEach((row) => {
      if (!groups[row.machineId]) {
        groups[row.machineId] = {
          machineId: row.machineId,
          machineName: row.machineName,
          shifts: []
        };
      }
      groups[row.machineId].shifts.push(row);
    });
    return Object.values(groups);
  }, [rows]);

  const fetchPlans = async (date) => {
    setLoading(true);
    try {
      const data = await apiFetch(`/api/shift-plans?date=${date}`, { token: authToken });
      setRows(data.rows);
      setEditableDate(data.editable);
    } catch (err) {
      if (!onAuthError?.(err)) showToast(err.message || 'Failed to load shift plans.', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPlans(selectedDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate, authToken]);

  const openEditModal = (row) => {
    const machine = machines.find((m) => m.id === row.machineId);
    setEditingRow(row);
    setEditForm({
      target: row.plan?.target ?? machine?.target ?? 0,
      ideal_cycle_time: row.plan?.ideal_cycle_time ?? machine?.ideal_cycle_time ?? 0,
      part_name: row.plan?.part_name ?? machine?.active_part_name ?? '',
      operator: row.plan?.operator ?? machine?.assigned_operator ?? ''
    });
  };

  const handleSavePlan = async (e) => {
    e.preventDefault();
    if (!editingRow) return;

    try {
      if (editingRow.plan?.id) {
        await apiFetch(`/api/shift-plans/${editingRow.plan.id}`, {
          method: 'PUT',
          token: authToken,
          body: editForm
        });
      } else {
        await apiFetch('/api/shift-plans', {
          method: 'POST',
          token: authToken,
          body: { machine_id: editingRow.machineId, plan_date: selectedDate, shift: editingRow.shift, ...editForm }
        });
      }
      showToast(`Plan saved for ${editingRow.machineId} - ${editingRow.shift}`, 'success');
      setEditingRow(null);
      fetchPlans(selectedDate);
    } catch (err) {
      if (!onAuthError?.(err)) showToast(err.message || 'Failed to save plan.', 'error');
    }
  };

  const handleCopyPreviousDay = async () => {
    setCopyConfirmOpen(false);
    try {
      await apiFetch('/api/shift-plans/copy-day', {
        method: 'POST',
        token: authToken,
        body: { sourceDate: addDays(selectedDate, -1), targetDate: selectedDate }
      });
      showToast('Previous day\'s plan copied.', 'success');
      fetchPlans(selectedDate);
    } catch (err) {
      if (!onAuthError?.(err)) showToast(err.message || 'Failed to copy previous day.', 'error');
    }
  };

  const handleExportExcel = () => {
    const sheetData = rows.map((row) => ({
      'Machine ID': row.machineId,
      'Machine Name': row.machineName,
      'Shift': row.shift,
      'Target': row.plan?.target ?? '',
      'Ideal Cycle (s)': row.plan?.ideal_cycle_time ?? '',
      'Part': row.plan?.part_name ?? '',
      'Operator': row.plan?.operator ?? '',
      'Actual': row.actual.count,
      'Good': row.actual.good,
      'Scrap': row.actual.scrap,
      'Achievement %': row.plan?.target ? ((row.actual.count / row.plan.target) * 100).toFixed(1) : ''
    }));

    const worksheet = XLSX.utils.json_to_sheet(sheetData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, selectedDate);
    XLSX.writeFile(workbook, `shift_plan_${selectedDate}.xlsx`);
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

      {/* Selected date plan table */}
      <div className="jbm-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-[var(--grey-200)] mb-6">
          <div className="flex items-center gap-2.5">
            <Calendar className="w-6 h-6 text-[var(--primary)] shrink-0" />
            <div>
              <h4 className="text-base font-black uppercase text-[var(--grey-900)] tracking-wide">
                {new Date(selectedDate).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
              </h4>
              <p className="text-xs font-bold text-slate-400 uppercase tracking-widest font-mono">
                {editableDate ? (canEditPlans ? 'Editable shift plan' : 'View only (PPC/Admin can edit)') : 'Historical record - read only'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* View Switcher Toggle */}
            {rows.length > 0 && !loading && (
              <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-xl border border-slate-200 dark:border-slate-700 mr-2">
                <button
                  type="button"
                  onClick={() => setViewMode('table')}
                  className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition ${
                    viewMode === 'table'
                      ? 'bg-white dark:bg-slate-700 text-slate-800 dark:text-white shadow-sm'
                      : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
                  }`}
                >
                  Table View
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('card')}
                  className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition ${
                    viewMode === 'card'
                      ? 'bg-white dark:bg-slate-700 text-slate-800 dark:text-white shadow-sm'
                      : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
                  }`}
                >
                  Card View
                </button>
              </div>
            )}
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
          <>
            {viewMode === 'table' ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm border-collapse">
                  <thead>
                    <tr className="border-b border-[var(--grey-200)] text-slate-400 uppercase font-black text-[10px] tracking-wider">
                      <th className="py-3 px-3">Machine</th>
                      <th className="py-3 px-3">Shift</th>
                      <th className="py-3 px-3">Part / Operator</th>
                      <th className="py-3 px-3 text-right">Target</th>
                      <th className="py-3 px-3 text-right">Actual</th>
                      <th className="py-3 px-3 text-right">Achievement</th>
                      <th className="py-3 px-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-semibold text-slate-700">
                    {groupedRows.flatMap((group, groupIdx) => {
                      return group.shifts.map((row, shiftIdx) => {
                        const achievement = row.plan?.target ? (row.actual.count / row.plan.target) * 100 : null;
                        const isFirstShift = shiftIdx === 0;
                        return (
                          <tr 
                            key={`${row.machineId}-${row.shift}`} 
                            className={`hover:bg-slate-50 transition ${isFirstShift && groupIdx > 0 ? 'border-t-2 border-slate-200' : ''}`}
                          >
                            {isFirstShift && (
                              <td className="py-4 px-3 border-r border-slate-100 bg-slate-50/50" rowSpan={group.shifts.length}>
                                <div className="text-[var(--grey-900)] font-black">{group.machineName}</div>
                                <div className="text-[10px] font-mono text-[var(--primary)]">{group.machineId}</div>
                              </td>
                            )}
                            <td className="py-3 px-3 text-xs font-black uppercase text-slate-500">{row.shift}</td>
                            <td className="py-3 px-3 text-xs">
                              {row.plan ? (
                                <>
                                  <div className="text-slate-700">{row.plan.part_name || 'Unassigned'}</div>
                                  <div className="text-slate-400 font-mono">{row.plan.operator || 'Unassigned'}</div>
                                </>
                              ) : (
                                <span className="text-slate-350 italic">Not planned</span>
                              )}
                            </td>
                            <td className="py-3 px-3 text-right font-mono">{row.plan?.target ?? '-'}</td>
                            <td className="py-3 px-3 text-right font-mono">
                              {row.actual.count} <span className="text-[10px] text-slate-400">({row.actual.scrap} scrap)</span>
                            </td>
                            <td className={`py-3 px-3 text-right font-mono font-black ${achievement !== null ? achievementColor(achievement) : 'text-slate-350'}`}>
                              {achievement !== null ? `${achievement.toFixed(0)}%` : '-'}
                            </td>
                            <td className="py-3 px-3 text-right">
                              {canEditPlans && editableDate ? (
                                <button
                                  onClick={() => openEditModal(row)}
                                  className="text-xs font-black uppercase text-[var(--primary)] hover:underline inline-flex items-center gap-1"
                                >
                                  <Pencil className="w-3.5 h-3.5" /> {row.plan ? 'Edit' : 'Plan'}
                                </button>
                              ) : (
                                <span className="text-slate-300 text-xs inline-flex items-center gap-1"><Lock className="w-3 h-3" /> Locked</span>
                              )}
                            </td>
                          </tr>
                        );
                      });
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {groupedRows.map((group) => (
                  <div key={group.machineId} className="jbm-card p-5 border border-[var(--grey-200)] bg-[var(--white-color)] shadow-sm hover:shadow-md transition flex flex-col justify-between">
                    <div className="flex justify-between items-center pb-2.5 border-b border-slate-100 dark:border-slate-700/50 mb-4">
                      <div>
                        <h4 className="text-sm font-black text-[var(--grey-900)] tracking-wide uppercase">{group.machineName}</h4>
                        <span className="text-[10px] font-mono text-[var(--primary)] font-bold">{group.machineId}</span>
                      </div>
                    </div>
                    
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      {group.shifts.map((row) => {
                        const achievement = row.plan?.target ? (row.actual.count / row.plan.target) * 100 : null;
                        return (
                          <div key={row.shift} className="bg-slate-50 dark:bg-slate-800/40 border border-slate-100 dark:border-slate-700/40 rounded-xl p-3 flex flex-col justify-between min-h-[170px]">
                            <div>
                              <div className="flex justify-between items-center mb-2">
                                <span className="px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 text-[9px] font-black uppercase tracking-wider">{row.shift}</span>
                                {achievement !== null && (
                                  <span className={`text-[10px] font-black font-mono ${achievementColor(achievement)}`}>
                                    {achievement.toFixed(0)}%
                                  </span>
                                )}
                              </div>
                              
                              <div className="space-y-0.5 text-xs text-left">
                                {row.plan ? (
                                  <>
                                    <div className="text-slate-750 dark:text-slate-300 font-extrabold truncate" title={row.plan.part_name}>
                                      {row.plan.part_name || 'Unassigned'}
                                    </div>
                                    <div className="text-slate-400 dark:text-slate-500 font-mono text-[9px] truncate" title={row.plan.operator}>
                                      Op: {row.plan.operator || 'Unassigned'}
                                    </div>
                                  </>
                                ) : (
                                  <div className="text-slate-350 dark:text-slate-600 italic text-[10px] py-1">Not planned</div>
                                )}
                              </div>
                            </div>

                            <div className="mt-3 pt-2 border-t border-slate-200/50 dark:border-slate-700/50 space-y-1">
                              <div className="flex justify-between text-[9px] font-mono">
                                <span className="text-slate-400 dark:text-slate-550">TGT:</span>
                                <span className="font-extrabold text-slate-700 dark:text-slate-300">{row.plan?.target ?? '-'}</span>
                              </div>
                              <div className="flex justify-between text-[9px] font-mono">
                                <span className="text-slate-400 dark:text-slate-550">ACT:</span>
                                <span className="font-extrabold text-slate-700 dark:text-slate-300">
                                  {row.actual.count} <span className="text-[8px] text-slate-400">({row.actual.scrap}s)</span>
                                </span>
                              </div>
                              
                              <div className="pt-2 flex justify-end">
                                {canEditPlans && editableDate ? (
                                  <button
                                    onClick={() => openEditModal(row)}
                                    className="text-[10px] font-black uppercase text-[var(--primary)] hover:underline inline-flex items-center gap-0.5"
                                  >
                                    <Pencil className="w-3 h-3" /> {row.plan ? 'Edit' : 'Plan'}
                                  </button>
                                ) : (
                                  <span className="text-slate-300 dark:text-slate-650 text-[10px] inline-flex items-center gap-0.5">
                                    <Lock className="w-2.5 h-2.5" /> Locked
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Edit plan modal */}
      {editingRow && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[60] flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="bg-[var(--white-color)] rounded-2xl border border-[var(--grey-200)] shadow-2xl w-full max-w-md p-6 text-left">
            <div className="flex items-center justify-between mb-4">
              <h4 className="text-sm font-black uppercase tracking-wider text-[var(--grey-900)]">
                {editingRow.machineName} - {editingRow.shift}
              </h4>
              <button onClick={() => setEditingRow(null)} className="text-slate-400 hover:text-slate-700"><X className="w-4 h-4" /></button>
            </div>
            <form onSubmit={handleSavePlan} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-black uppercase tracking-wider text-slate-455 mb-1">Target</label>
                  <input
                    type="number"
                    value={editForm.target}
                    onChange={(e) => setEditForm({ ...editForm, target: parseInt(e.target.value) || 0 })}
                    className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] focus:border-[var(--primary)] rounded-xl py-2.5 px-3 text-xs font-bold outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-black uppercase tracking-wider text-slate-455 mb-1">Ideal Cycle (s)</label>
                  <input
                    type="number"
                    value={editForm.ideal_cycle_time}
                    onChange={(e) => setEditForm({ ...editForm, ideal_cycle_time: parseInt(e.target.value) || 0 })}
                    className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] focus:border-[var(--primary)] rounded-xl py-2.5 px-3 text-xs font-bold outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[10px] font-black uppercase tracking-wider text-slate-455 mb-1">Part Name</label>
                <input
                  value={editForm.part_name}
                  onChange={(e) => setEditForm({ ...editForm, part_name: e.target.value })}
                  className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] focus:border-[var(--primary)] rounded-xl py-2.5 px-3 text-xs font-bold outline-none"
                />
              </div>
              <div>
                <label className="block text-[10px] font-black uppercase tracking-wider text-slate-455 mb-1">Operator</label>
                <input
                  value={editForm.operator}
                  onChange={(e) => setEditForm({ ...editForm, operator: e.target.value })}
                  className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] focus:border-[var(--primary)] rounded-xl py-2.5 px-3 text-xs font-bold outline-none"
                />
              </div>
              <button
                type="submit"
                className="w-full bg-[var(--primary)] text-white text-xs font-black uppercase tracking-wider py-3 rounded-xl transition active:scale-95 mt-2"
              >
                Save Plan
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Copy previous day confirm */}
      {copyConfirmOpen && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[60] flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="bg-[var(--white-color)] rounded-2xl border border-[var(--grey-200)] shadow-2xl w-full max-w-sm p-6 text-left">
            <h4 className="text-sm font-black uppercase tracking-wider text-[var(--grey-900)]">Copy Previous Day's Plan?</h4>
            <p className="text-sm text-slate-500 mt-2">
              This copies every machine/shift plan from <strong className="text-[var(--grey-900)]">{addDays(selectedDate, -1)}</strong> onto <strong className="text-[var(--grey-900)]">{selectedDate}</strong>, overwriting any existing plans on this date.
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
