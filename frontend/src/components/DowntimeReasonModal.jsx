import React, { useState } from 'react';
import { AlertCircle } from 'lucide-react';

export default function DowntimeReasonModal({ isOpen, onClose, onSubmit, machineId, reasonCodes = [] }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  // Reason codes are fetched from GET /api/reason-codes (single source of truth on the
  // backend) so this list can never drift from what OEE aggregation actually recognizes.
  const predefinedReasons = reasonCodes;

  if (!isOpen) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!reason) {
      setError('A downtime reason must be specified before resuming production.');
      return;
    }
    setError('');
    onSubmit(reason);
    setReason('');
  };

  return (
    <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-sm z-50 flex items-center justify-center p-3">
      <div className="bg-white rounded-2xl border-2 border-slate-200 shadow-2xl w-full max-w-lg max-h-full flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200 font-sans">

        {/* Header */}
        <div className="bg-rose-50 border-b-2 border-rose-100 px-5 py-4 flex items-center gap-3 shrink-0">
          <div className="bg-rose-100 p-2.5 rounded-xl text-rose-600 shrink-0">
            <AlertCircle className="w-6 h-6" />
          </div>
          <div className="min-w-0">
            <h3 className="text-lg font-black text-slate-800 uppercase tracking-wide leading-tight">Downtime Reason Mandatory</h3>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-wider font-mono">Machine: {machineId}</p>
          </div>
        </div>

        {/* Content Form */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4 flex-1 min-h-0 flex flex-col overflow-hidden">
          <div className="space-y-2.5 flex-1 min-h-0 flex flex-col">
            <label className="text-sm font-black text-slate-500 uppercase tracking-wide block shrink-0">
              Select reason for machine stopped:
            </label>

            <div className="grid grid-cols-2 gap-3 overflow-y-auto pr-1 flex-1 min-h-0 auto-rows-min">
              {predefinedReasons.map((r) => {
                const isSelected = reason === r;
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => {
                      setReason(r);
                      setError('');
                    }}
                    className={`min-h-16 p-4 rounded-xl border-2 text-sm font-black uppercase tracking-wide text-left transition-all flex items-center justify-between gap-2 cursor-pointer active:scale-95 ${
                      isSelected
                        ? 'bg-rose-50 border-rose-500 text-rose-700 shadow-sm'
                        : 'bg-slate-50 hover:bg-slate-100 border-slate-200 text-slate-600'
                    }`}
                  >
                    <span className="leading-tight">{r}</span>
                    {isSelected && (
                      <span className="w-3 h-3 rounded-full bg-rose-500 shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {error && (
            <p className="text-sm font-bold text-rose-600 bg-rose-50 border-2 border-rose-100 p-3 rounded-xl flex items-center gap-2 leading-snug animate-in fade-in shrink-0">
              ⚠️ {error}
            </p>
          )}

          <p className="text-xs font-bold text-slate-400 leading-normal uppercase shrink-0">
            * Note: Submitting this log will close out the active downtime duration log in the factory MES database and transition status to running.
          </p>

          {/* Action buttons */}
          <div className="flex gap-3 pt-1 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 bg-slate-100 hover:bg-slate-200 border-2 border-slate-200 text-slate-500 py-4 rounded-xl text-base font-extrabold uppercase transition-all shadow-sm active:scale-95 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white py-4 rounded-xl text-base font-black uppercase transition-all shadow-md active:scale-95 cursor-pointer"
            >
              Submit & Resume
            </button>
          </div>
        </form>

      </div>
    </div>
  );
}
