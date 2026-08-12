import React, { useEffect, useMemo, useState } from 'react';
import { Download, FileText, RefreshCw, Search, SlidersHorizontal, User } from 'lucide-react';
import { getShiftForTimestamp as getShiftFromTimestamp } from '../lib/shiftTime';

function getDurationSeconds(start, end) {
  const startTime = new Date(start).getTime();
  const endTime = end ? new Date(end).getTime() : Date.now();
  return Math.max(0, Math.floor((endTime - startTime) / 1000));
}

function formatDurationFromSeconds(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatDateTime(dateStr) {
  if (!dateStr) return '--';

  return new Date(dateStr).toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

function formatDateOnly(dateStr) {
  if (!dateStr) return '--';

  return new Date(dateStr).toLocaleDateString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

export default function ReportsLog({ reports = [], machines = [], currentUser, onRefresh }) {
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [shiftFilter, setShiftFilter] = useState('All Shifts');
  const [operatorFilter, setOperatorFilter] = useState('All Operators');
  const [machineFilter, setMachineFilter] = useState('All Machines');
  const [statusFilter, setStatusFilter] = useState('All');
  const [reasonFilter, setReasonFilter] = useState('All Reasons');
  const [sortMode, setSortMode] = useState('Newest First');

  useEffect(() => {
    if (currentUser?.role === 'Operator' && currentUser?.operatorId) {
      setOperatorFilter(currentUser.operatorId);
    } else {
      setOperatorFilter('All Operators');
    }
  }, [currentUser?.role, currentUser?.operatorId]);

  const machineLookup = useMemo(() => new Map(machines.map((machine) => [machine.id, machine])), [machines]);

  const reportRows = useMemo(() => reports.map((report) => {
    const machine = machineLookup.get(report.machine_id);
    const shift = getShiftFromTimestamp(report.start_time);
    const reportDate = report.start_time ? new Date(report.start_time).toISOString().slice(0, 10) : '';

    return {
      ...report,
      reportDate,
      shift,
      part_name: report.part_name || machine?.active_part_name || ''
    };
  }), [machineLookup, reports]);

  const operatorOptions = useMemo(() => ['All Operators', ...new Set(reportRows.map((report) => report.operator_id).filter(Boolean))], [reportRows]);
  const machineOptions = useMemo(() => ['All Machines', ...new Set(reportRows.map((report) => report.machine_id).filter(Boolean))], [reportRows]);
  const reasonOptions = useMemo(() => ['All Reasons', ...new Set(reportRows.map((report) => report.downtime_reason).filter(Boolean))], [reportRows]);

  const filteredReports = useMemo(() => {
    const term = search.trim().toLowerCase();

    const matched = reportRows.filter((report) => {
      const searchMatches = !term || [
        report.machine_name,
        report.machine_id,
        report.operator_id,
        report.status,
        report.downtime_reason,
        report.shift,
        report.part_name,
        report.reportDate
      ].some((value) => String(value || '').toLowerCase().includes(term));

      const dateMatches = (!dateFrom || report.reportDate >= dateFrom) && (!dateTo || report.reportDate <= dateTo);
      const shiftMatches = shiftFilter === 'All Shifts' || report.shift === shiftFilter;
      const operatorMatches = operatorFilter === 'All Operators' || report.operator_id === operatorFilter;
      const machineMatches = machineFilter === 'All Machines' || report.machine_id === machineFilter;
      const statusMatches = statusFilter === 'All' || report.status === statusFilter;
      const reasonMatches = reasonFilter === 'All Reasons' || report.downtime_reason === reasonFilter;

      return searchMatches && dateMatches && shiftMatches && operatorMatches && machineMatches && statusMatches && reasonMatches;
    });

    return [...matched].sort((left, right) => {
      const leftTime = new Date(left.start_time).getTime();
      const rightTime = new Date(right.start_time).getTime();

      if (sortMode === 'Oldest First') return leftTime - rightTime;
      if (sortMode === 'Longest Duration') return getDurationSeconds(right.start_time, right.end_time) - getDurationSeconds(left.start_time, left.end_time);
      return rightTime - leftTime;
    });
  }, [dateFrom, dateTo, machineFilter, operatorFilter, reasonFilter, reportRows, search, shiftFilter, sortMode, statusFilter]);

  const totalDurationSeconds = filteredReports.reduce((sum, report) => sum + getDurationSeconds(report.start_time, report.end_time), 0);
  const openCount = filteredReports.filter((report) => report.status === 'Running').length;
  const stoppedCount = filteredReports.filter((report) => report.status === 'Stopped').length;
  const uniqueOperators = new Set(filteredReports.map((report) => report.operator_id || 'system')).size;
  const uniqueReasons = new Set(filteredReports.map((report) => report.downtime_reason).filter(Boolean)).size;

  const resetFilters = () => {
    setSearch('');
    setDateFrom('');
    setDateTo('');
    setShiftFilter('All Shifts');
    setOperatorFilter(currentUser?.role === 'Operator' && currentUser?.operatorId ? currentUser.operatorId : 'All Operators');
    setMachineFilter('All Machines');
    setStatusFilter('All');
    setReasonFilter('All Reasons');
    setSortMode('Newest First');
  };

  const handleExportCSV = () => {
    if (filteredReports.length === 0) return;

    const headers = ['Timestamp', 'Date', 'Shift', 'Machine ID', 'Machine Name', 'Operator ID', 'Part Name', 'Status Event', 'Duration', 'Downtime Reason'];
    const rows = filteredReports.map((report) => [
      formatDateTime(report.start_time),
      formatDateOnly(report.start_time),
      report.shift,
      report.machine_id,
      report.machine_name || report.machine_id,
      report.operator_id || 'system',
      report.part_name || '',
      report.status,
      report.end_time ? formatDurationFromSeconds(getDurationSeconds(report.start_time, report.end_time)) : 'Active state',
      report.downtime_reason || ''
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `Factory_CNC_Report_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="glass-card rounded-2xl p-6 border border-slate-200 bg-white shadow-sm mt-6">
      <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center gap-4 pb-4 border-b border-slate-100 mb-6">
        <div className="flex items-center gap-3">
          <FileText className="w-6 h-6 text-sky-600" />
          <div className="text-left">
            <h3 className="text-lg font-black text-slate-800 uppercase tracking-wide">Historical MES Log Reports</h3>
            <p className="text-xs font-black text-slate-400 uppercase tracking-wider font-mono">Custom reporting by date, shift, operator, machine, and downtime reason</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-3 w-full xl:w-auto select-none">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-5 py-3">
            <p className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-400">Visible rows</p>
            <p className="mt-1 text-xl font-black text-slate-800 font-mono">{filteredReports.length}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-5 py-3">
            <p className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-400">Open</p>
            <p className="mt-1 text-xl font-black text-emerald-600 font-mono">{openCount}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-5 py-3">
            <p className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-400">Stopped</p>
            <p className="mt-1 text-xl font-black text-rose-600 font-mono">{stoppedCount}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-5 py-3">
            <p className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-400">Operators</p>
            <p className="mt-1 text-xl font-black text-sky-600 font-mono">{uniqueOperators}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-5 py-3">
            <p className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-400">Reasons</p>
            <p className="mt-1 text-xl font-black text-indigo-600 font-mono">{uniqueReasons}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-5 py-3">
            <p className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-400">Total duration</p>
            <p className="mt-1 text-xl font-black text-slate-800 font-mono">{formatDurationFromSeconds(totalDurationSeconds)}</p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[2fr_1fr_1fr_1fr] items-center mb-6">
        <label className="relative block xl:col-span-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search machine, operator, shift, reason, part..."
            className="w-full rounded-xl border border-slate-200 bg-slate-50 px-11 py-3.5 text-base font-bold text-slate-800 outline-none transition focus:border-sky-500 focus:bg-white"
          />
        </label>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3.5 text-base font-bold text-slate-700 outline-none transition focus:border-sky-500 focus:bg-white"
        >
          {['All', 'Running', 'Stopped', 'Not Connected'].map((option) => <option key={option} value={option}>{option}</option>)}
        </select>

        <select
          value={shiftFilter}
          onChange={(e) => setShiftFilter(e.target.value)}
          className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3.5 text-base font-bold text-slate-700 outline-none transition focus:border-sky-500 focus:bg-white"
        >
          {['All Shifts', 'Shift A', 'Shift B', 'Shift C'].map((option) => <option key={option} value={option}>{option}</option>)}
        </select>

        <select
          value={operatorFilter}
          onChange={(e) => setOperatorFilter(e.target.value)}
          className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3.5 text-base font-bold text-slate-700 outline-none transition focus:border-sky-500 focus:bg-white"
        >
          {operatorOptions.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.5fr_1.5fr_2fr_1.5fr] items-center mb-6">
        <div className="flex gap-2">
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-700 outline-none transition focus:border-sky-500 focus:bg-white"
          />
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-700 outline-none transition focus:border-sky-500 focus:bg-white"
          />
        </div>

        <select
          value={machineFilter}
          onChange={(e) => setMachineFilter(e.target.value)}
          className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-700 outline-none transition focus:border-sky-500 focus:bg-white"
        >
          {machineOptions.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>

        <select
          value={reasonFilter}
          onChange={(e) => setReasonFilter(e.target.value)}
          className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-700 outline-none transition focus:border-sky-500 focus:bg-white"
        >
          {reasonOptions.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>

        <select
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value)}
          className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-700 outline-none transition focus:border-sky-500 focus:bg-white"
        >
          {['Newest First', 'Oldest First', 'Longest Duration'].map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </div>

      <div className="flex items-center gap-3 justify-end mb-6">
        <button
          type="button"
          onClick={resetFilters}
          className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-xs font-black uppercase tracking-widest text-slate-600 transition hover:bg-slate-100"
        >
          <SlidersHorizontal className="w-4 h-4" /> Reset
        </button>

        <button
          onClick={onRefresh}
          title="Refresh logs from database"
          className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 hover:bg-slate-150 hover:border-slate-350 text-slate-600 transition-all shadow-sm"
        >
          <RefreshCw className="w-4 h-4" />
        </button>

        <button
          onClick={handleExportCSV}
          disabled={filteredReports.length === 0}
          className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-750 disabled:opacity-50 disabled:bg-slate-300 text-white text-xs font-black uppercase tracking-wider transition-all shadow-sm"
        >
          <Download className="w-4 h-4" /> Export CSV
        </button>
      </div>

      {currentUser?.role === 'Operator' && currentUser?.operatorId && (
        <div className="mb-6 rounded-xl border border-sky-100 bg-sky-50 px-4 py-3 text-xs font-bold uppercase tracking-wider text-sky-700 text-left">
          Report scope is preloaded to {currentUser.operatorId} for the logged-in operator profile.
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-200 shadow-inner max-h-[500px] overflow-y-auto">
        <table className="w-full text-left text-sm border-collapse">
          <thead className="bg-slate-50 border-b border-slate-200 text-slate-550 font-bold uppercase tracking-wider text-[10px] sticky top-0 z-10">
            <tr>
              <th className="px-4 py-3.5">Timestamp</th>
              <th className="px-4 py-3.5">Date</th>
              <th className="px-4 py-3.5">Shift</th>
              <th className="px-4 py-3.5">Machine ID</th>
              <th className="px-4 py-3.5">Machine Name</th>
              <th className="px-4 py-3.5">Operator</th>
              <th className="px-4 py-3.5">Part</th>
              <th className="px-4 py-3.5">Status Event</th>
              <th className="px-4 py-3.5">Duration</th>
              <th className="px-4 py-3.5">Downtime Reason</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-slate-700 bg-white font-semibold">
            {filteredReports.length > 0 ? (
              filteredReports.map((report) => (
                <tr key={report.id} className="hover:bg-slate-50/55 transition-colors">
                  <td className="px-4 py-4 text-slate-500 font-mono">{formatDateTime(report.start_time)}</td>
                  <td className="px-4 py-4 text-slate-500 font-mono">{formatDateOnly(report.start_time)}</td>
                  <td className="px-4 py-4 text-slate-550 text-[10px] uppercase tracking-wider">{report.shift}</td>
                  <td className="px-4 py-4 font-mono text-xs text-slate-400">{report.machine_id}</td>
                  <td className="px-4 py-4 font-black text-slate-900 text-base">{report.machine_name || report.machine_id}</td>
                  <td className="px-4 py-4 text-slate-600 font-mono text-xs uppercase">
                    {report.operator_id ? (
                      <span className="flex items-center gap-1.5">
                        <User className="w-3.5 h-3.5 text-sky-600" />
                        {report.operator_id}
                      </span>
                    ) : (
                      <span className="text-slate-400">-</span>
                    )}
                  </td>
                  <td className="px-4 py-4 text-slate-600 text-xs">{report.part_name || <span className="text-slate-400">-</span>}</td>
                  <td className="px-4 py-4">
                    <span className={`px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider border ${
                      report.status === 'Running' ? 'text-emerald-700 bg-emerald-50 border-emerald-100' :
                      report.status === 'Stopped' ? 'text-rose-700 bg-rose-50 border-rose-100' :
                      'text-violet-700 bg-violet-50 border-violet-100'
                    }`}>
                      {report.status}
                    </span>
                  </td>
                  <td className="px-4 py-4 font-mono text-slate-655 text-xs">
                    {report.end_time ? (
                      formatDurationFromSeconds(getDurationSeconds(report.start_time, report.end_time))
                    ) : (
                      <span className="text-emerald-600 font-bold uppercase tracking-wider text-[10px] flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></span>
                        Active
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-4">
                    {report.status === 'Stopped' ? (
                      report.downtime_reason ? (
                        <span className="font-bold text-slate-700 bg-slate-100 border border-slate-200 px-2.5 py-1 rounded text-xs uppercase">{report.downtime_reason}</span>
                      ) : (
                        <span className="text-rose-550 italic font-black text-xs">Pending Operator Input</span>
                      )
                    ) : (
                      <span className="text-slate-400">-</span>
                    )}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan="10" className="text-center py-16 text-slate-400 uppercase tracking-widest font-black text-base">
                  No matching log records found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
