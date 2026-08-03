import React, { useEffect, useState } from 'react';
import { UserCog, Calendar, Factory, UserPlus } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useToast } from './Toast';

const SHIFT_OPTIONS = ['Shift A', 'Shift B', 'Shift C'];

function toDateStr(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export default function OperatorAssignment({ authToken, machines = [], onAuthError }) {
  const { showToast } = useToast();

  const [machineId, setMachineId] = useState(machines[0]?.id || '');
  const [date, setDate] = useState(toDateStr(new Date()));
  const [shift, setShift] = useState('Shift A');
  const [operatorName, setOperatorName] = useState('');

  const [assignments, setAssignments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!machineId && machines.length > 0) setMachineId(machines[0].id);
  }, [machines, machineId]);

  const fetchAvailability = async () => {
    if (!date || !shift) return;
    setLoading(true);
    try {
      const data = await apiFetch(`/api/operator-availability?date=${date}&shift=${shift}`, { token: authToken });
      setAssignments(data.assignments || []);
    } catch (err) {
      if (!onAuthError?.(err)) showToast(err.message || 'Failed to load operator assignments.', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAvailability();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, shift, authToken]);

  const machineName = machines.find((m) => m.id === machineId)?.name || machineId;
  const currentAssignment = assignments.find((a) => a.machineId === machineId) || null;

  const handleAssign = async (e) => {
    e.preventDefault();
    const trimmedName = operatorName.trim();
    if (!machineId || !trimmedName) return;

    setSaving(true);
    try {
      await apiFetch('/api/part-schedules/assign-operator', {
        method: 'POST',
        token: authToken,
        body: { machine_id: machineId, plan_date: date, shift, operator: trimmedName }
      });
      showToast(`Assigned ${trimmedName} to ${machineName} (${shift}).`, 'success');
      setOperatorName('');
      fetchAvailability();
    } catch (err) {
      if (!onAuthError?.(err)) showToast(err.message || 'Failed to assign operator.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleUnassign = async () => {
    setSaving(true);
    try {
      await apiFetch('/api/part-schedules/assign-operator', {
        method: 'POST',
        token: authToken,
        body: { machine_id: machineId, plan_date: date, shift, operator: null }
      });
      showToast(`Cleared ${machineName}'s operator assignment.`, 'success');
      fetchAvailability();
    } catch (err) {
      if (!onAuthError?.(err)) showToast(err.message || 'Failed to clear assignment.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 text-left">
      <div className="jbm-card p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <UserCog className="w-6 h-6 text-[var(--primary)] shrink-0" />
          <div>
            <h4 className="text-lg font-black uppercase text-[var(--grey-900)] tracking-wide">Operator Assignment</h4>
            <p className="text-sm font-bold text-slate-400 uppercase tracking-widest font-mono">Assign an operator by name to a scheduled machine/shift</p>
          </div>
        </div>
      </div>

      {/* Filter bar */}
      <div className="jbm-card p-5 grid gap-3 md:grid-cols-3">
        <div className="flex items-center gap-1.5 bg-[var(--bg-color-page)] border border-[var(--grey-200)] rounded-xl px-3 py-2.5">
          <Factory className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          <select value={machineId} onChange={(e) => setMachineId(e.target.value)} className="w-full bg-transparent text-sm font-bold outline-none">
            {machines.map((m) => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-1.5 bg-[var(--bg-color-page)] border border-[var(--grey-200)] rounded-xl px-3 py-2.5">
          <Calendar className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full bg-transparent text-sm font-bold outline-none" />
        </div>
        <select value={shift} onChange={(e) => setShift(e.target.value)} className="bg-[var(--bg-color-page)] border border-[var(--grey-200)] rounded-xl px-3 py-2.5 text-sm font-bold outline-none">
          {SHIFT_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {/* Assign form for the selected machine */}
      <div className="jbm-card p-6">
        <h4 className="text-base font-black uppercase text-[var(--grey-900)] tracking-wide mb-4">
          {machineName} - {shift} on {date}
        </h4>

        {currentAssignment ? (
          <div className="flex items-center justify-between gap-3 bg-emerald-50 border border-emerald-100 rounded-xl px-4 py-3 mb-4">
            <span className="text-sm font-black text-emerald-700">
              Currently assigned: <span className="font-mono">{currentAssignment.operatorName}</span>
            </span>
            <button
              onClick={handleUnassign}
              disabled={saving}
              className="text-xs font-black uppercase text-rose-500 hover:underline disabled:opacity-40"
            >
              {saving ? 'Clearing...' : 'Unassign'}
            </button>
          </div>
        ) : (
          <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4">No operator assigned yet for this machine/shift.</p>
        )}

        <form onSubmit={handleAssign} className="flex items-end gap-3">
          <div className="flex-1">
            <label className="block text-[10px] font-black uppercase tracking-wider text-slate-455 mb-1">
              {currentAssignment ? 'Reassign to a different operator' : 'Operator Name'}
            </label>
            <input
              value={operatorName}
              onChange={(e) => setOperatorName(e.target.value)}
              placeholder="Type the operator's name"
              className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] focus:border-[var(--primary)] rounded-xl py-2.5 px-3 text-sm font-bold outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={saving || !operatorName.trim()}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-[var(--primary)] hover:bg-[var(--primary)]/90 disabled:opacity-40 text-white font-extrabold text-xs uppercase tracking-wider shadow-sm transition active:scale-95"
          >
            <UserPlus className="w-3.5 h-3.5" /> {saving ? 'Assigning...' : 'Assign'}
          </button>
        </form>
        <p className="text-[10px] text-slate-400 font-semibold mt-2">
          Assigning here rejects the name if it's already on a different machine this shift - see the list below.
        </p>
      </div>

      {/* All assignments this shift, for double-booking awareness */}
      <div className="jbm-card p-6">
        <h4 className="text-base font-black uppercase text-[var(--grey-900)] tracking-wide mb-4">
          All Assignments - {shift} on {date}
        </h4>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm border-collapse">
            <thead>
              <tr className="border-b border-[var(--grey-200)] text-slate-400 uppercase font-black text-[10px] tracking-wider">
                <th className="py-3 px-2">Machine</th>
                <th className="py-3 px-2">Operator</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-semibold text-slate-700">
              {assignments.map((a) => (
                <tr key={a.machineId} className={`hover:bg-slate-50 transition ${a.machineId === machineId ? 'bg-slate-50' : ''}`}>
                  <td className="py-3 px-2 text-[var(--grey-900)] font-black">{a.machineName}</td>
                  <td className="py-3 px-2 font-mono text-[var(--primary)]">{a.operatorName}</td>
                </tr>
              ))}
              {!loading && assignments.length === 0 && (
                <tr>
                  <td colSpan="2" className="text-center py-12 text-slate-400 uppercase tracking-widest font-black text-xs">No operators assigned yet this shift</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
