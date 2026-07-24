import React, { useEffect, useMemo, useState } from 'react';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { X, ClipboardList, UserCheck } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useToast } from './Toast';

function formatDuration(totalSeconds) {
  const seconds = Math.round(totalSeconds || 0);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds % 60}s`;
}

function formatTime(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
}

const STATUS_COLORS = { Running: '#057e39', Stopped: '#ff2400', 'No Signal': '#94a3b8' };

export default function OeeDetailDrawer({ isOpen, onClose, authToken, machineId, machineName, date, shift, onAuthError }) {
  const { showToast } = useToast();
  const [row, setRow] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen || !machineId || !date || !shift) return undefined;
    let cancelled = false;
    setLoading(true);
    setRow(null);

    const params = new URLSearchParams({ machineId, date, shift });
    apiFetch(`/api/reports/oee-detail?${params.toString()}`, { token: authToken })
      .then((data) => { if (!cancelled) setRow(data.row); })
      .catch((err) => {
        if (cancelled) return;
        if (!onAuthError?.(err)) showToast(err.message || 'Failed to load detail view.', 'error');
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, machineId, date, shift, authToken]);

  const hourlyData = useMemo(() => {
    if (!row) return [];
    const buckets = {};
    row.pulses.forEach((p) => {
      const hour = new Date(p.timestamp).getHours();
      const key = `${String(hour).padStart(2, '0')}:00`;
      buckets[key] = (buckets[key] || 0) + 1;
    });
    return Object.entries(buckets)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([hour, count]) => ({ hour, Parts: count }));
  }, [row]);

  const cycleTimeData = useMemo(() => {
    if (!row) return [];
    return row.pulses.map((p, i) => ({ index: i + 1, cycleTime: parseFloat(p.cycle_time) }));
  }, [row]);

  const rejectHistory = useMemo(() => (row ? row.pulses.filter((p) => !(p.is_good === 1 || p.is_good === true)) : []), [row]);
  const downtimeEvents = useMemo(() => (row ? row.statusLogs.filter((l) => l.status === 'Stopped') : []), [row]);

  const timelineTotal = useMemo(() => {
    if (!row) return 1;
    return row.statusLogs.reduce((sum, l) => {
      const start = new Date(l.start_time).getTime();
      const end = l.end_time ? new Date(l.end_time).getTime() : Date.now();
      return sum + Math.max(0, end - start);
    }, 0) || 1;
  }, [row]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-3">
      <div className="bg-white rounded-3xl border-2 border-slate-200 shadow-2xl w-full max-w-6xl max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200 font-sans">

        <div className="bg-gradient-to-r from-sky-50 to-sky-100/60 border-b-2 border-sky-100 px-6 py-5 flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-4 min-w-0">
            <div className="bg-gradient-to-br from-sky-500 to-sky-600 p-3.5 rounded-2xl text-white shrink-0 shadow-lg shadow-sky-900/30">
              <ClipboardList className="w-7 h-7" />
            </div>
            <div className="min-w-0">
              <h3 className="text-2xl font-black text-slate-800 uppercase tracking-wide leading-tight">Shift Detail — {machineName}</h3>
              <p className="text-sm font-bold text-slate-400 uppercase tracking-wider font-mono truncate">{date} &middot; {shift}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded-xl hover:bg-white/60 text-slate-500 shrink-0" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-6">
          {loading || !row ? (
            <div className="text-center py-24 text-slate-400 uppercase tracking-widest font-black text-base">
              {loading ? 'Loading detail...' : 'No data for this shift'}
            </div>
          ) : (
            <>
              {/* Production summary + Operator details */}
              <div className="grid md:grid-cols-2 gap-6">
                <div className="jbm-card p-5">
                  <h4 className="text-sm font-black uppercase text-slate-500 tracking-wide mb-3">Production Summary</h4>
                  <table className="w-full text-left text-base border-collapse">
                    <tbody className="divide-y divide-slate-100 font-semibold text-slate-700">
                      <tr><td className="py-1.5 pr-4 text-slate-400 uppercase text-[12px] font-black">Ideal Cycle Time</td><td className="py-1.5 font-mono">{row.idealCycleTime}s</td></tr>
                      <tr><td className="py-1.5 pr-4 text-slate-400 uppercase text-[12px] font-black">Planned Production Time</td><td className="py-1.5 font-mono">{formatDuration(row.plannedSeconds)}</td></tr>
                      <tr><td className="py-1.5 pr-4 text-slate-400 uppercase text-[12px] font-black">Operating Time</td><td className="py-1.5 font-mono">{formatDuration(row.operatingSeconds)}</td></tr>
                      <tr><td className="py-1.5 pr-4 text-slate-400 uppercase text-[12px] font-black">Downtime</td><td className="py-1.5 font-mono">{formatDuration(row.totalDowntimeSeconds)}</td></tr>
                      <tr><td className="py-1.5 pr-4 text-slate-400 uppercase text-[12px] font-black">Good / Reject / Total</td><td className="py-1.5 font-mono"><span className="text-emerald-600">{row.goodCount}</span> / <span className="text-rose-600">{row.rejectCount}</span> / {row.totalCount}</td></tr>
                      <tr><td className="py-1.5 pr-4 text-slate-400 uppercase text-[12px] font-black">Target</td><td className="py-1.5 font-mono">{row.target || '-'}</td></tr>
                      <tr><td className="py-1.5 pr-4 text-slate-400 uppercase text-[12px] font-black">A / P / Q / OEE</td><td className="py-1.5 font-mono">{row.availability.toFixed(1)}% / {row.performance.toFixed(1)}% / {row.quality.toFixed(1)}% / <span className="font-black text-[var(--primary)]">{row.oee.toFixed(1)}%</span></td></tr>
                    </tbody>
                  </table>
                </div>

                <div className="jbm-card p-5">
                  <h4 className="text-sm font-black uppercase text-slate-500 tracking-wide mb-3 flex items-center gap-2">
                    <UserCheck className="w-3.5 h-3.5" /> Operator Details
                  </h4>
                  <table className="w-full text-left text-base border-collapse">
                    <tbody className="divide-y divide-slate-100 font-semibold text-slate-700">
                      <tr><td className="py-1.5 pr-4 text-slate-400 uppercase text-[12px] font-black">Operator</td><td className="py-1.5">{row.operator || 'Unassigned'}</td></tr>
                      <tr><td className="py-1.5 pr-4 text-slate-400 uppercase text-[12px] font-black">Active Part</td><td className="py-1.5">{row.partName || 'Unscheduled'}</td></tr>
                    </tbody>
                  </table>

                  <h4 className="text-sm font-black uppercase text-slate-500 tracking-wide mt-5 mb-2">Status Timeline</h4>
                  <div className="w-full h-6 rounded-full overflow-hidden flex border border-slate-200">
                    {row.statusLogs.map((l, i) => {
                      const start = new Date(l.start_time).getTime();
                      const end = l.end_time ? new Date(l.end_time).getTime() : Date.now();
                      const widthPct = (Math.max(0, end - start) / timelineTotal) * 100;
                      return (
                        <div
                          key={i}
                          title={`${l.status}: ${formatTime(l.start_time)} - ${l.end_time ? formatTime(l.end_time) : 'ongoing'}`}
                          style={{ width: `${widthPct}%`, backgroundColor: STATUS_COLORS[l.status] || '#cbd5e1' }}
                        />
                      );
                    })}
                  </div>
                  <div className="flex gap-4 mt-2 text-[12px] font-bold uppercase text-slate-500">
                    {Object.entries(STATUS_COLORS).map(([status, color]) => (
                      <span key={status} className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />{status}</span>
                    ))}
                  </div>
                </div>
              </div>

              {/* Hourly Production + Cycle Time Trend */}
              <div className="grid md:grid-cols-2 gap-6">
                <div className="jbm-card p-5 h-[280px] flex flex-col">
                  <h4 className="text-sm font-black uppercase text-slate-500 tracking-wide mb-3">Hourly Production</h4>
                  <div className="flex-1 w-full text-sm">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={hourlyData} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                        <XAxis dataKey="hour" stroke="#64748b" fontSize={10} tickLine={false} axisLine={false} />
                        <YAxis stroke="#64748b" fontSize={10} tickLine={false} axisLine={false} allowDecimals={false} />
                        <Tooltip cursor={{ fill: 'rgba(148,163,184,0.03)' }} />
                        <Bar dataKey="Parts" fill="#0057ff" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="jbm-card p-5 h-[280px] flex flex-col">
                  <h4 className="text-sm font-black uppercase text-slate-500 tracking-wide mb-3">Cycle Time Trend (s)</h4>
                  <div className="flex-1 w-full text-sm">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={cycleTimeData} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                        <XAxis dataKey="index" stroke="#64748b" fontSize={10} tickLine={false} axisLine={false} />
                        <YAxis stroke="#64748b" fontSize={10} tickLine={false} axisLine={false} />
                        <Tooltip cursor={{ fill: 'rgba(148,163,184,0.03)' }} />
                        <Line type="monotone" dataKey="cycleTime" stroke="#ff8350" strokeWidth={2} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>

              {/* Downtime events */}
              <div className="jbm-card p-5">
                <h4 className="text-sm font-black uppercase text-slate-500 tracking-wide mb-3">Downtime Events</h4>
                <div className="overflow-x-auto rounded-xl border border-slate-200">
                  <table className="w-full text-left text-base border-collapse">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-550 font-bold uppercase tracking-wider text-[12px]">
                      <tr>
                        <th className="px-3 py-2.5">Start</th>
                        <th className="px-3 py-2.5">End</th>
                        <th className="px-3 py-2.5">Duration</th>
                        <th className="px-3 py-2.5">Reason</th>
                        <th className="px-3 py-2.5">Operator</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-semibold text-slate-700">
                      {downtimeEvents.length > 0 ? downtimeEvents.map((l) => (
                        <tr key={l.id}>
                          <td className="px-3 py-2 font-mono text-sm">{formatTime(l.start_time)}</td>
                          <td className="px-3 py-2 font-mono text-sm">{l.end_time ? formatTime(l.end_time) : <span className="text-emerald-600 font-bold uppercase text-[12px]">Active</span>}</td>
                          <td className="px-3 py-2 font-mono text-sm">{formatDuration(Math.max(0, (l.end_time ? new Date(l.end_time).getTime() : Date.now()) - new Date(l.start_time).getTime()) / 1000)}</td>
                          <td className="px-3 py-2 text-sm">{l.downtime_reason || 'Other'}</td>
                          <td className="px-3 py-2 font-mono text-sm">{l.operator_id || '-'}</td>
                        </tr>
                      )) : (
                        <tr><td colSpan="5" className="text-center py-8 text-slate-400 uppercase tracking-widest font-black text-sm">No downtime this shift</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Production events + Reject history */}
              <div className="grid md:grid-cols-2 gap-6">
                <div className="jbm-card p-5">
                  <h4 className="text-sm font-black uppercase text-slate-500 tracking-wide mb-3">Production Events ({row.pulses.length})</h4>
                  <div className="overflow-y-auto max-h-64 rounded-xl border border-slate-200">
                    <table className="w-full text-left text-base border-collapse">
                      <thead className="bg-slate-50 border-b border-slate-200 text-slate-550 font-bold uppercase tracking-wider text-[12px] sticky top-0">
                        <tr><th className="px-3 py-2">Time</th><th className="px-3 py-2">Cycle Time</th><th className="px-3 py-2">Result</th></tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 font-semibold text-slate-700">
                        {row.pulses.map((p, i) => (
                          <tr key={i}>
                            <td className="px-3 py-1.5 font-mono text-sm">{formatTime(p.timestamp)}</td>
                            <td className="px-3 py-1.5 font-mono text-sm">{parseFloat(p.cycle_time).toFixed(1)}s</td>
                            <td className="px-3 py-1.5 text-sm">{(p.is_good === 1 || p.is_good === true) ? <span className="text-emerald-600 font-bold uppercase text-[12px]">Good</span> : <span className="text-rose-600 font-bold uppercase text-[12px]">Reject</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="jbm-card p-5">
                  <h4 className="text-sm font-black uppercase text-slate-500 tracking-wide mb-3">Reject History ({rejectHistory.length})</h4>
                  <div className="overflow-y-auto max-h-64 rounded-xl border border-slate-200">
                    <table className="w-full text-left text-base border-collapse">
                      <thead className="bg-slate-50 border-b border-slate-200 text-slate-550 font-bold uppercase tracking-wider text-[12px] sticky top-0">
                        <tr><th className="px-3 py-2">Time</th><th className="px-3 py-2">Cycle Time</th></tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 font-semibold text-slate-700">
                        {rejectHistory.length > 0 ? rejectHistory.map((p, i) => (
                          <tr key={i}>
                            <td className="px-3 py-1.5 font-mono text-sm">{formatTime(p.timestamp)}</td>
                            <td className="px-3 py-1.5 font-mono text-sm">{parseFloat(p.cycle_time).toFixed(1)}s</td>
                          </tr>
                        )) : (
                          <tr><td colSpan="2" className="text-center py-8 text-slate-400 uppercase tracking-widest font-black text-sm">No rejects this shift</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
