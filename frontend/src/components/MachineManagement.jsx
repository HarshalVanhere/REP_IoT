import React, { useState } from 'react';
import { Cpu, Plus, Trash2, Pencil, X } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useToast } from './Toast';

const emptyForm = { id: '', name: '', department: '', target: 500, ideal_cycle_time: 15, iot_enabled: false };

export default function MachineManagement({ machines, authToken, onRefresh, onAuthError }) {
  const { showToast } = useToast();
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [pendingDeleteId, setPendingDeleteId] = useState(null);

  const openCreateForm = () => {
    setForm(emptyForm);
    setEditingId(null);
    setFormOpen(true);
  };

  const openEditForm = (machine) => {
    setForm({ id: machine.id, name: machine.name, department: machine.department, target: machine.target, ideal_cycle_time: machine.ideal_cycle_time, iot_enabled: Boolean(machine.iot_enabled) });
    setEditingId(machine.id);
    setFormOpen(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.id || !form.name || !form.department) {
      showToast('Machine ID, name, and department are required.', 'error');
      return;
    }
    try {
      if (editingId) {
        await apiFetch(`/api/machines/${editingId}`, {
          method: 'PUT',
          token: authToken,
          body: { name: form.name, department: form.department, target: form.target, ideal_cycle_time: form.ideal_cycle_time, iot_enabled: form.iot_enabled }
        });
        showToast(`Machine ${editingId} updated.`, 'success');
      } else {
        await apiFetch('/api/machines', {
          method: 'POST',
          token: authToken,
          body: form
        });
        showToast(`Machine ${form.id} created.`, 'success');
      }
      setFormOpen(false);
      onRefresh();
    } catch (err) {
      if (!onAuthError?.(err)) showToast(err.message || 'Failed to save machine.', 'error');
    }
  };

  const confirmDelete = async () => {
    const id = pendingDeleteId;
    setPendingDeleteId(null);
    try {
      await apiFetch(`/api/machines/${id}`, { method: 'DELETE', token: authToken });
      showToast(`Machine ${id} deleted.`, 'success');
      onRefresh();
    } catch (err) {
      if (!onAuthError?.(err)) showToast(err.message || 'Failed to delete machine.', 'error');
    }
  };

  return (
    <div className="jbm-card p-6 text-left">
      <div className="flex items-center justify-between pb-4 border-b border-[var(--grey-200)] mb-6">
        <div className="flex items-center gap-2.5">
          <Cpu className="w-6 h-6 text-[var(--primary)] shrink-0" />
          <div>
            <h4 className="text-base font-black uppercase text-[var(--grey-900)] tracking-wide">Machine Management</h4>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest font-mono">Add, edit, or decommission plant CNC machines</p>
          </div>
        </div>
        <button
          onClick={openCreateForm}
          className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-[var(--primary)] hover:bg-[var(--primary)]/90 text-white font-extrabold text-xs uppercase tracking-wider shadow-sm transition active:scale-95"
        >
          <Plus className="w-4 h-4" /> Add Machine
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm border-collapse">
          <thead>
            <tr className="border-b border-[var(--grey-200)] text-slate-400 uppercase font-black text-[10px] tracking-wider">
              <th className="py-3 px-2">ID</th>
              <th className="py-3 px-2">Name</th>
              <th className="py-3 px-2">Department</th>
              <th className="py-3 px-2 text-right">Target</th>
              <th className="py-3 px-2 text-right">Ideal Cycle</th>
              <th className="py-3 px-2 text-center">Connectivity</th>
              <th className="py-3 px-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 font-semibold text-slate-700">
            {machines.map((m) => (
              <tr key={m.id} className="hover:bg-slate-50 transition">
                <td className="py-3 px-2 font-mono text-[var(--primary)]">{m.id}</td>
                <td className="py-3 px-2 text-[var(--grey-900)] font-black">{m.name}</td>
                <td className="py-3 px-2 text-xs">{m.department}</td>
                <td className="py-3 px-2 text-right font-mono">{m.target}</td>
                <td className="py-3 px-2 text-right font-mono">{m.ideal_cycle_time}s</td>
                <td className="py-3 px-2 text-center">
                  <span className={`px-2 py-1 rounded-full text-[10px] font-black uppercase ${m.iot_enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                    {m.iot_enabled ? 'IoT Wired' : 'Not Wired'}
                  </span>
                </td>
                <td className="py-3 px-2 text-right space-x-2">
                  <button onClick={() => openEditForm(m)} className="text-xs font-black uppercase text-[var(--primary)] hover:underline inline-flex items-center gap-1">
                    <Pencil className="w-3.5 h-3.5" /> Edit
                  </button>
                  <button onClick={() => setPendingDeleteId(m.id)} className="text-xs font-black uppercase text-rose-500 hover:underline inline-flex items-center gap-1">
                    <Trash2 className="w-3.5 h-3.5" /> Delete
                  </button>
                </td>
              </tr>
            ))}
            {machines.length === 0 && (
              <tr>
                <td colSpan="7" className="text-center py-12 text-slate-400 uppercase tracking-widest font-black text-xs">No machines configured</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {formOpen && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[60] flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="bg-[var(--white-color)] rounded-2xl border border-[var(--grey-200)] shadow-2xl w-full max-w-md p-6 text-left">
            <div className="flex items-center justify-between mb-4">
              <h4 className="text-sm font-black uppercase tracking-wider text-[var(--grey-900)]">
                {editingId ? `Edit Machine ${editingId}` : 'Add Machine'}
              </h4>
              <button onClick={() => setFormOpen(false)} className="text-slate-400 hover:text-slate-700"><X className="w-4 h-4" /></button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-3">
              {!editingId && (
                <div>
                  <label className="block text-[10px] font-black uppercase tracking-wider text-slate-455 mb-1">Machine ID</label>
                  <input
                    value={form.id}
                    onChange={(e) => setForm({ ...form, id: e.target.value.trim() })}
                    placeholder="e.g. 1314"
                    className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] focus:border-[var(--primary)] rounded-xl py-2.5 px-3 text-xs font-bold outline-none"
                  />
                </div>
              )}
              <div>
                <label className="block text-[10px] font-black uppercase tracking-wider text-slate-455 mb-1">Name</label>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. 1314 ACE CNC SUPER JOBBER"
                  className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] focus:border-[var(--primary)] rounded-xl py-2.5 px-3 text-xs font-bold outline-none"
                />
              </div>
              <div>
                <label className="block text-[10px] font-black uppercase tracking-wider text-slate-455 mb-1">Department</label>
                <input
                  value={form.department}
                  onChange={(e) => setForm({ ...form, department: e.target.value })}
                  placeholder="e.g. Turning"
                  className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] focus:border-[var(--primary)] rounded-xl py-2.5 px-3 text-xs font-bold outline-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-black uppercase tracking-wider text-slate-455 mb-1">Target / Shift</label>
                  <input
                    type="number"
                    value={form.target}
                    onChange={(e) => setForm({ ...form, target: parseInt(e.target.value) || 0 })}
                    className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] focus:border-[var(--primary)] rounded-xl py-2.5 px-3 text-xs font-bold outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-black uppercase tracking-wider text-slate-455 mb-1">Ideal Cycle (s)</label>
                  <input
                    type="number"
                    value={form.ideal_cycle_time}
                    onChange={(e) => setForm({ ...form, ideal_cycle_time: parseInt(e.target.value) || 0 })}
                    className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] focus:border-[var(--primary)] rounded-xl py-2.5 px-3 text-xs font-bold outline-none"
                  />
                </div>
              </div>
              <label className="flex items-center gap-2.5 bg-[var(--bg-color-page)] border border-[var(--grey-200)] rounded-xl py-2.5 px-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.iot_enabled}
                  onChange={(e) => setForm({ ...form, iot_enabled: e.target.checked })}
                  className="w-4 h-4 accent-[var(--primary)]"
                />
                <span className="text-[11px] font-black uppercase tracking-wider text-slate-600">
                  Physically connected to ESP32 / Raspberry Pi
                </span>
              </label>
              <p className="text-[10px] text-slate-400 font-semibold leading-snug px-0.5">
                Leave unchecked until this machine's IoT hardware is actually wired up - it will show "Not Connected" everywhere and be excluded from all OEE/production KPIs until this is checked.
              </p>
              <button
                type="submit"
                className="w-full bg-[var(--primary)] text-white text-xs font-black uppercase tracking-wider py-3 rounded-xl transition active:scale-95 mt-2"
              >
                {editingId ? 'Save Changes' : 'Create Machine'}
              </button>
            </form>
          </div>
        </div>
      )}

      {pendingDeleteId && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[60] flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="bg-[var(--white-color)] rounded-2xl border border-[var(--grey-200)] shadow-2xl w-full max-w-sm p-6 text-left">
            <h4 className="text-sm font-black uppercase tracking-wider text-[var(--grey-900)]">Delete Machine?</h4>
            <p className="text-sm text-slate-500 mt-2">
              This permanently removes <strong className="text-[var(--grey-900)]">{pendingDeleteId}</strong> and its production history. This cannot be undone.
            </p>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setPendingDeleteId(null)} className="flex-1 py-2.5 rounded-xl border border-slate-200 text-slate-500 font-extrabold text-xs uppercase tracking-wider hover:bg-slate-50">Cancel</button>
              <button onClick={confirmDelete} className="flex-1 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-extrabold text-xs uppercase tracking-wider shadow-sm transition active:scale-95">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
