import React, { useEffect, useState } from 'react';
import * as XLSX from 'xlsx';
import { PackageCheck, Download, Calendar } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useToast } from './Toast';

function toDateStr(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function achievementColor(pct) {
  if (pct >= 95) return 'text-emerald-600';
  if (pct >= 70) return 'text-amber-600';
  return 'text-rose-600';
}

const GROUP_OPTIONS = [
  { value: 'part', label: 'Part-wise' },
  { value: 'shift', label: 'Shift-wise' },
  { value: 'machine', label: 'Machine-wise' }
];

export default function ProductionSummary({ authToken, onAuthError }) {
  const { showToast } = useToast();
  const [date, setDate] = useState(() => toDateStr(new Date()));
  const [groupBy, setGroupBy] = useState('part');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch(`/api/reports/production-summary?date=${date}&groupBy=${groupBy}`, { token: authToken })
      .then((data) => { if (!cancelled) setRows(data.rows); })
      .catch((err) => {
        if (cancelled) return;
        if (!onAuthError?.(err)) showToast(err.message || 'Failed to load production summary.', 'error');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, groupBy, authToken]);

  const totals = rows.reduce((acc, r) => ({
    target: acc.target + r.target,
    production_count: acc.production_count + r.production_count,
    good_count: acc.good_count + r.good_count,
    scrap_count: acc.scrap_count + r.scrap_count
  }), { target: 0, production_count: 0, good_count: 0, scrap_count: 0 });

  const handleExportExcel = () => {
    const sheetData = rows.map((r) => ({
      [GROUP_OPTIONS.find((g) => g.value === groupBy).label]: r.key,
      'Target': r.target,
      'Produced': r.production_count,
      'Good': r.good_count,
      'Scrap': r.scrap_count,
      'Achievement %': r.target ? ((r.production_count / r.target) * 100).toFixed(1) : ''
    }));
    const worksheet = XLSX.utils.json_to_sheet(sheetData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, date);
    XLSX.writeFile(workbook, `production_summary_${groupBy}_${date}.xlsx`);
  };

  return (
    <div className="jbm-card p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-[var(--grey-200)] mb-6">
        <div className="flex items-center gap-2.5">
          <PackageCheck className="w-6 h-6 text-[var(--primary)] shrink-0" />
          <div>
            <h4 className="text-base font-black uppercase text-[var(--grey-900)] tracking-wide">Production Summary</h4>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest font-mono">Part-wise, shift-wise & machine-wise production</p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 bg-[var(--bg-color-page)] border border-[var(--grey-200)] rounded-xl px-3 py-2">
            <Calendar className="w-3.5 h-3.5 text-slate-400" />
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="bg-transparent text-xs font-bold outline-none"
            />
          </div>
          <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl border border-slate-200">
            {GROUP_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setGroupBy(opt.value)}
                className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition ${
                  groupBy === opt.value ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
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
        <div className="text-center py-20 text-slate-400 uppercase tracking-widest font-black text-xs">No production recorded for this date</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm border-collapse">
            <thead>
              <tr className="border-b border-[var(--grey-200)] text-slate-400 uppercase font-black text-[10px] tracking-wider">
                <th className="py-3 px-3">{GROUP_OPTIONS.find((g) => g.value === groupBy).label}</th>
                <th className="py-3 px-3 text-right">Target</th>
                <th className="py-3 px-3 text-right">Produced</th>
                <th className="py-3 px-3 text-right">Good</th>
                <th className="py-3 px-3 text-right">Scrap</th>
                <th className="py-3 px-3 text-right">Achievement</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-semibold text-slate-700">
              {rows.map((r) => {
                const achievement = r.target ? (r.production_count / r.target) * 100 : null;
                return (
                  <tr key={r.key} className="hover:bg-slate-50 transition">
                    <td className="py-3 px-3 font-black text-[var(--grey-900)]">{r.key}</td>
                    <td className="py-3 px-3 text-right font-mono">{r.target}</td>
                    <td className="py-3 px-3 text-right font-mono">{r.production_count}</td>
                    <td className="py-3 px-3 text-right font-mono text-emerald-600">{r.good_count}</td>
                    <td className="py-3 px-3 text-right font-mono text-rose-500">{r.scrap_count}</td>
                    <td className={`py-3 px-3 text-right font-mono font-black ${achievement !== null ? achievementColor(achievement) : 'text-slate-350'}`}>
                      {achievement !== null ? `${achievement.toFixed(0)}%` : '-'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-200 font-black text-[var(--grey-900)]">
                <td className="py-3 px-3 uppercase text-xs">Total</td>
                <td className="py-3 px-3 text-right font-mono">{totals.target}</td>
                <td className="py-3 px-3 text-right font-mono">{totals.production_count}</td>
                <td className="py-3 px-3 text-right font-mono text-emerald-600">{totals.good_count}</td>
                <td className="py-3 px-3 text-right font-mono text-rose-500">{totals.scrap_count}</td>
                <td className="py-3 px-3 text-right font-mono">
                  {totals.target ? `${((totals.production_count / totals.target) * 100).toFixed(0)}%` : '-'}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
