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
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-200 font-sans">
        
        {/* Header */}
        <div className="bg-rose-50 border-b border-rose-100 px-5 py-4 flex items-center gap-3">
          <div className="bg-rose-150 p-2 rounded-lg text-rose-600">
            <AlertCircle className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-bold text-slate-800 uppercase tracking-wide">Downtime Reason Mandatory</h3>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider font-mono">Machine: {machineId}</p>
          </div>
        </div>

        {/* Content Form */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="space-y-2.5">
            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block">
              Select reason for machine stopped:
            </label>
            
            <div className="grid grid-cols-2 gap-3 max-h-[250px] overflow-y-auto pr-1">
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
                    className={`p-3 rounded-xl border text-[10px] font-black uppercase tracking-wider text-left transition-all flex items-center justify-between cursor-pointer active:scale-95 ${
                      isSelected
                        ? 'bg-rose-50 border-rose-550 text-rose-700 shadow-sm'
                        : 'bg-slate-50 hover:bg-slate-100 border-slate-200 text-slate-600'
                    }`}
                  >
                    <span className="truncate pr-1">{r}</span>
                    {isSelected && (
                      <span className="w-2.5 h-2.5 rounded-full bg-rose-550 shrink-0 ml-1.5" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {error && (
            <p className="text-xs font-bold text-rose-650 bg-rose-50 border border-rose-100 p-2.5 rounded-xl flex items-center gap-1.5 leading-snug animate-in fade-in">
              ⚠️ {error}
            </p>
          )}

          <p className="text-[9px] font-bold text-slate-400 leading-normal uppercase">
            * Note: Submitting this log will close out the active downtime duration log in the factory MES database and transition status to running.
          </p>

          {/* Action buttons */}
          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 bg-slate-100 hover:bg-slate-150 border border-slate-200 text-slate-500 py-3 rounded-xl text-xs font-extrabold uppercase transition-all shadow-sm active:scale-95 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white py-3 rounded-xl text-xs font-black uppercase transition-all shadow-md active:scale-95 cursor-pointer"
            >
              Submit & Resume
            </button>
          </div>
        </form>

      </div>
    </div>
  );
}
