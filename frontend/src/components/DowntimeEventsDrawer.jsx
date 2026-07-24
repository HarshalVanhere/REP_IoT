import React, { useRef } from 'react';
import { X, Clock, FileDown, FileSpreadsheet, Printer } from 'lucide-react';
import { exportPdf, exportExcel, printElement, formatDurationHm, formatTimeRange } from '../lib/reportExport';

export default function DowntimeEventsDrawer({ isOpen, onClose, groupLabel, events = [], machineName = '', generatedBy = 'Unknown' }) {
  const cardRef = useRef(null);
  if (!isOpen) return null;

  const totalDowntimeSeconds = events.reduce((s, e) => s + e.durationSeconds, 0);
  const totalEvents = events.length;
  const avgDowntimeSeconds = totalEvents > 0 ? totalDowntimeSeconds / totalEvents : 0;
  const longestDowntimeSeconds = totalEvents > 0 ? Math.max(...events.map((e) => e.durationSeconds)) : 0;

  const eventsTableRows = events.map((e) => [
    e.id, e.date, e.shift, formatTimeRange(e.startTime, e.endTime),
    formatDurationHm(e.durationSeconds), e.reason, e.category, e.operator || '-', e.partNumber || '-',
    e.statusBefore || '-', e.statusAfter || '-', e.remarks || '-'
  ]);

  async function handleDownloadPdf() {
    await exportPdf({
      title: 'Downtime Events Report',
      machineName,
      filtersText: `Group: ${groupLabel}`,
      generatedBy,
      kpiRows: [
        ['Total Events', totalEvents, 'Total Downtime', formatDurationHm(totalDowntimeSeconds)],
        ['Average Downtime', formatDurationHm(avgDowntimeSeconds), 'Longest Event', formatDurationHm(longestDowntimeSeconds)]
      ],
      tables: [{
        title: 'Downtime Events',
        head: ['ID', 'Date', 'Shift', 'Time Range', 'Duration', 'Reason', 'Category', 'Operator', 'Part', 'Before', 'After', 'Remarks'],
        body: eventsTableRows
      }],
      fileName: `Downtime_Events_${groupLabel.replace(/[^\w-]+/g, '_')}.pdf`
    });
  }

  function handleDownloadExcel() {
    exportExcel({
      sheets: [{
        name: 'Downtime Events',
        rows: events.map((e) => ({
          ID: e.id, Date: e.date, Shift: e.shift, 'Time Range': formatTimeRange(e.startTime, e.endTime),
          Duration: formatDurationHm(e.durationSeconds), Reason: e.reason, Category: e.category,
          Operator: e.operator || '', Part: e.partNumber || '', StatusBefore: e.statusBefore || '',
          StatusAfter: e.statusAfter || '', Remarks: e.remarks || ''
        }))
      }],
      fileName: `Downtime_Events_${groupLabel.replace(/[^\w-]+/g, '_')}.xlsx`
    });
  }

  function handlePrint() {
    printElement(cardRef.current, `Downtime Events - ${groupLabel}`);
  }

  return (
    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-3">
      <div ref={cardRef} className="bg-white rounded-3xl border-2 border-slate-200 shadow-2xl w-full max-w-6xl max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200 font-sans">

        <div className="bg-gradient-to-r from-rose-50 to-rose-100/60 border-b-2 border-rose-100 px-6 py-5 flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-4 min-w-0">
            <div className="bg-gradient-to-br from-rose-500 to-rose-600 p-3.5 rounded-2xl text-white shrink-0 shadow-lg shadow-rose-900/30">
              <Clock className="w-7 h-7" />
            </div>
            <div className="min-w-0">
              <h3 className="text-2xl font-black text-slate-800 uppercase tracking-wide leading-tight">Downtime Events</h3>
              <p className="text-sm font-bold text-slate-400 uppercase tracking-wider font-mono truncate">{groupLabel}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0 no-print">
            <button onClick={handleDownloadPdf} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-rose-200 bg-white/70 hover:border-[var(--primary)] text-[12px] font-black uppercase tracking-wider text-slate-600 hover:text-[var(--primary)] transition">
              <FileDown className="w-3.5 h-3.5" /> PDF
            </button>
            <button onClick={handleDownloadExcel} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-rose-200 bg-white/70 hover:border-emerald-600 text-[12px] font-black uppercase tracking-wider text-slate-600 hover:text-emerald-600 transition">
              <FileSpreadsheet className="w-3.5 h-3.5" /> Excel
            </button>
            <button onClick={handlePrint} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-rose-200 bg-white/70 hover:border-slate-500 text-[12px] font-black uppercase tracking-wider text-slate-600 hover:text-slate-800 transition">
              <Printer className="w-3.5 h-3.5" /> Print
            </button>
            <button onClick={onClose} className="p-2 rounded-xl hover:bg-white/60 text-slate-500 shrink-0" aria-label="Close">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-5">
          <div className="overflow-x-auto rounded-xl border border-slate-200 shadow-inner">
            <table className="w-full text-left text-base border-collapse">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-550 font-bold uppercase tracking-wider text-[12px] sticky top-0 z-10">
                <tr>
                  <th className="px-3 py-3">ID</th>
                  <th className="px-3 py-3">Date</th>
                  <th className="px-3 py-3">Shift</th>
                  <th className="px-3 py-3">Time Range</th>
                  <th className="px-3 py-3">Duration</th>
                  <th className="px-3 py-3">Reason</th>
                  <th className="px-3 py-3">Category</th>
                  <th className="px-3 py-3">Operator</th>
                  <th className="px-3 py-3">Part Number</th>
                  <th className="px-3 py-3">Status Before</th>
                  <th className="px-3 py-3">Status After</th>
                  <th className="px-3 py-3">Remarks</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700 bg-white font-semibold">
                {events.length > 0 ? events.map((e) => (
                  <tr key={e.id} className="hover:bg-slate-50/55 transition-colors">
                    <td className="px-3 py-2.5 font-mono text-sm text-slate-400">#{e.id}</td>
                    <td className="px-3 py-2.5 font-mono text-sm">{e.date}</td>
                    <td className="px-3 py-2.5 text-[12px] uppercase tracking-wider">{e.shift}</td>
                    <td className="px-3 py-2.5 font-mono text-sm">
                      {formatTimeRange(e.startTime, e.endTime)}
                      {!e.endTime && <span className="ml-1.5 text-emerald-600 font-bold uppercase text-[12px]">(Active)</span>}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-sm">{formatDurationHm(e.durationSeconds)}</td>
                    <td className="px-3 py-2.5">
                      <span className="font-bold text-slate-700 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded text-[12px] uppercase">{e.reason}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`px-2 py-0.5 rounded-full text-[12px] font-black uppercase tracking-wider border ${
                        e.category === 'Planned' ? 'text-sky-700 bg-sky-50 border-sky-100' : 'text-rose-700 bg-rose-50 border-rose-100'
                      }`}>{e.category}</span>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-sm">{e.operator || '-'}</td>
                    <td className="px-3 py-2.5 text-sm">{e.partNumber || '-'}</td>
                    <td className="px-3 py-2.5 text-[12px] uppercase text-slate-500">{e.statusBefore || '-'}</td>
                    <td className="px-3 py-2.5 text-[12px] uppercase text-slate-500">{e.statusAfter || '-'}</td>
                    <td className="px-3 py-2.5 text-sm text-slate-400">{e.remarks || '-'}</td>
                  </tr>
                )) : (
                  <tr><td colSpan="12" className="text-center py-16 text-slate-400 uppercase tracking-widest font-black text-base">No downtime events in this group</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="shrink-0 border-t border-slate-200 bg-slate-50 px-6 py-4 grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <p className="text-[12px] font-black uppercase tracking-[0.2em] text-slate-400">Total Events</p>
            <p className="text-xl font-black font-mono text-slate-800">{totalEvents}</p>
          </div>
          <div>
            <p className="text-[12px] font-black uppercase tracking-[0.2em] text-slate-400">Total Downtime</p>
            <p className="text-xl font-black font-mono text-rose-600">{formatDurationHm(totalDowntimeSeconds)}</p>
          </div>
          <div>
            <p className="text-[12px] font-black uppercase tracking-[0.2em] text-slate-400">Average Downtime</p>
            <p className="text-xl font-black font-mono text-slate-800">{formatDurationHm(avgDowntimeSeconds)}</p>
          </div>
          <div>
            <p className="text-[12px] font-black uppercase tracking-[0.2em] text-slate-400">Longest Event</p>
            <p className="text-xl font-black font-mono text-slate-800">{formatDurationHm(longestDowntimeSeconds)}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
