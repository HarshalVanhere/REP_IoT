import React from 'react';
import { History, RefreshCw } from 'lucide-react';

export default function AuditLogView({ entries = [], onRefresh }) {
  return (
    <div className="jbm-card p-6 text-left">
      <div className="flex items-center justify-between pb-4 border-b border-[var(--grey-200)] mb-6">
        <div className="flex items-center gap-2.5">
          <History className="w-6 h-6 text-[var(--primary)] shrink-0" />
          <div>
            <h4 className="text-base font-black uppercase text-[var(--grey-900)] tracking-wide">Audit Log</h4>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest font-mono">Traceability for logins and sensitive plant actions</p>
          </div>
        </div>
        <button
          onClick={onRefresh}
          className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 hover:border-slate-350 text-slate-600 transition-all shadow-sm"
          title="Refresh"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      <div className="overflow-x-auto max-h-[600px] overflow-y-auto rounded-xl border border-slate-200">
        <table className="w-full text-left text-sm border-collapse">
          <thead className="bg-slate-50 border-b border-slate-200 text-slate-550 font-bold uppercase tracking-wider text-[10px] sticky top-0">
            <tr>
              <th className="px-4 py-3">Timestamp</th>
              <th className="px-4 py-3">Actor</th>
              <th className="px-4 py-3">Action</th>
              <th className="px-4 py-3">Target</th>
              <th className="px-4 py-3">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-slate-700 font-semibold">
            {entries.length > 0 ? entries.map((entry) => (
              <tr key={entry.id} className="hover:bg-slate-50/60 transition">
                <td className="px-4 py-3 font-mono text-xs text-slate-500">{new Date(entry.timestamp).toLocaleString()}</td>
                <td className="px-4 py-3 font-mono text-xs text-[var(--primary)]">{entry.actor_login_id}</td>
                <td className="px-4 py-3 text-xs font-black uppercase tracking-wider">{entry.action}</td>
                <td className="px-4 py-3 text-xs font-mono text-slate-500">{entry.target || '-'}</td>
                <td className="px-4 py-3 text-xs text-slate-500">{entry.details || '-'}</td>
              </tr>
            )) : (
              <tr>
                <td colSpan="5" className="text-center py-16 text-slate-400 uppercase tracking-widest font-black text-sm">No audit entries yet</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
