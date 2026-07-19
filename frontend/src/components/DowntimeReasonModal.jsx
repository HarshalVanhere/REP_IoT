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
          <div className="space-y-1.5">
            <label className="text-xs font-bold text-slate-550 uppercase tracking-wider block">
              Select reason for Machine stopped?
            </label>
            <select
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setError('');
              }}
              className="w-full bg-slate-50 border border-slate-250 hover:border-slate-350 focus:border-sky-600 focus:bg-white text-slate-800 rounded-lg py-2.5 px-3 text-sm font-semibold transition-all outline-none"
            >
              <option value="">Select Predefined Reason...</option>
              {predefinedReasons.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>

          {error && (
            <p className="text-xs font-bold text-rose-600 bg-rose-50 border border-rose-150 p-2.5 rounded-lg flex items-center gap-1.5 leading-snug">
              ⚠️ {error}
            </p>
          )}

          <p className="text-[10px] font-bold text-slate-400 leading-normal uppercase">
            * Note: Submitting this log will close out the active downtime duration log in the factory MES database and transition status to running.
          </p>

          {/* Action buttons */}
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 bg-slate-100 hover:bg-slate-200 border border-slate-200 text-slate-600 py-2.5 rounded-lg text-xs font-bold uppercase transition-all shadow-sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white py-2.5 rounded-lg text-xs font-bold uppercase transition-all shadow-md"
            >
              Submit & Resume
            </button>
          </div>
        </form>

      </div>
    </div>
  );
}
