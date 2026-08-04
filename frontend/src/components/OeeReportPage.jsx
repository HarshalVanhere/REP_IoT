import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, PieChart, Pie, Cell
} from 'recharts';
import { Gauge, Calendar, Factory, TrendingUp, Clock, PieChart as PieIcon, Target, Sigma, Eye, LayoutList, FileDown, FileSpreadsheet, Printer } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useToast } from './Toast';
import DowntimeEventsDrawer from './DowntimeEventsDrawer';
import OeeDetailDrawer from './OeeDetailDrawer';
import { exportPdf, exportExcel, printReport, formatDurationHm, formatTimeRange } from '../lib/reportExport';

const COLORS = [
  '#0057ff', '#ff8350', '#057e39', '#ff2400', '#8b5cf6', '#f59e0b', '#ec4899', '#64748b'
];

const DATE_PRESETS = ['Today', 'Yesterday', 'Last 7 Days', 'Last 30 Days', 'This Month', 'Last Month', 'Custom Date Range'];
const SHIFT_OPTIONS = ['All Shifts', 'Shift A', 'Shift B', 'Shift C'];

function toDateStr(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return toDateStr(d);
}

function resolvePresetRange(preset, customStart, customEnd) {
  const today = toDateStr(new Date());
  switch (preset) {
    case 'Today':
      return { startDate: today, endDate: today };
    case 'Yesterday': {
      const y = addDays(today, -1);
      return { startDate: y, endDate: y };
    }
    case 'Last 7 Days':
      return { startDate: addDays(today, -6), endDate: today };
    case 'Last 30 Days':
      return { startDate: addDays(today, -29), endDate: today };
    case 'This Month': {
      const d = new Date();
      return { startDate: toDateStr(new Date(d.getFullYear(), d.getMonth(), 1)), endDate: today };
    }
    case 'Last Month': {
      const d = new Date();
      const firstOfThisMonth = new Date(d.getFullYear(), d.getMonth(), 1);
      const lastOfPrevMonth = new Date(firstOfThisMonth.getTime() - 86400000);
      const firstOfPrevMonth = new Date(lastOfPrevMonth.getFullYear(), lastOfPrevMonth.getMonth(), 1);
      return { startDate: toDateStr(firstOfPrevMonth), endDate: toDateStr(lastOfPrevMonth) };
    }
    case 'Custom Date Range':
      return { startDate: customStart || today, endDate: customEnd || today };
    default:
      return { startDate: today, endDate: today };
  }
}

function fmtPct(v) {
  return typeof v === 'number' ? v.toFixed(1) : v;
}

function formatDuration(totalSeconds) {
  const seconds = Math.round(totalSeconds || 0);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds % 60}s`;
}

// Mirrors backend/src/services/reportingService.js's isoWeekKey() exactly, so a clicked
// week-group row filters the same flat `events` array to the same set of events.
function isoWeekKey(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const target = new Date(d.valueOf());
  const dayNr = (d.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const weekNumber = 1 + Math.round(((target - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${target.getUTCFullYear()}-W${String(weekNumber).padStart(2, '0')}`;
}

function downtimeGroupKey(event, groupBy) {
  if (groupBy === 'shift') return `${event.date}|${event.shift}`;
  if (groupBy === 'week') return isoWeekKey(event.date);
  if (groupBy === 'month') return event.date.slice(0, 7);
  return event.date;
}

const DOWNTIME_GROUP_OPTIONS = [
  { value: 'day', label: 'Day Wise' },
  { value: 'shift', label: 'Shift Wise' },
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' }
];

function StatTile({ label, value, accent }) {
  return (
    <div className="jbm-card p-4 flex flex-col justify-between min-h-[92px]">
      <p className="text-[12px] font-black uppercase tracking-[0.15em] text-slate-400">{label}</p>
      <p className={`mt-2 text-2xl font-black font-mono ${accent || 'text-[var(--grey-900)]'}`}>{value}</p>
    </div>
  );
}

const CustomTooltip = ({ active, payload, label }) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white border border-slate-200 p-3 rounded-lg shadow-lg font-sans text-slate-850">
        <p className="text-sm font-bold text-slate-800 uppercase tracking-wider mb-1.5">{label}</p>
        <div className="space-y-1">
          {payload.map((item, index) => (
            <div key={index} className="flex justify-between items-center gap-6 text-[13px]">
              <span className="font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: item.color }}></span>
                {item.name}:
              </span>
              <span className="font-mono font-bold text-slate-800">{item.value}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  return null;
};

export default function OeeReportPage({ authToken, machines = [], reasonCodes = [], onAuthError, currentUser }) {
  const { showToast } = useToast();
  const [tab, setTab] = useState('oee');
  const chartsRef = useRef(null);
  const dtChartsRef = useRef(null);

  const [machineId, setMachineId] = useState(machines[0]?.id || '');
  const [preset, setPreset] = useState('Today');
  const [customStart, setCustomStart] = useState(toDateStr(new Date()));
  const [customEnd, setCustomEnd] = useState(toDateStr(new Date()));
  const [shift, setShift] = useState('All Shifts');
  const [operator, setOperator] = useState('All Operators');
  const [partName, setPartName] = useState('All Parts');

  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selectedDetail, setSelectedDetail] = useState(null);

  const [downtimeGroupBy, setDowntimeGroupBy] = useState('day');
  const [downtimeReport, setDowntimeReport] = useState(null);
  const [downtimeLoading, setDowntimeLoading] = useState(false);
  const [selectedDowntimeGroup, setSelectedDowntimeGroup] = useState(null);

  useEffect(() => {
    if (!machineId && machines.length > 0) setMachineId(machines[0].id);
  }, [machines, machineId]);

  const { startDate, endDate } = useMemo(
    () => resolvePresetRange(preset, customStart, customEnd),
    [preset, customStart, customEnd]
  );

  useEffect(() => {
    if (!machineId || !startDate || !endDate) return undefined;
    let cancelled = false;
    setLoading(true);

    const params = new URLSearchParams({ machineId, startDate, endDate });
    if (shift !== 'All Shifts') params.set('shift', shift);
    if (operator !== 'All Operators') params.set('operator', operator);
    if (partName !== 'All Parts') params.set('partName', partName);

    apiFetch(`/api/reports/oee-summary?${params.toString()}`, { token: authToken })
      .then((data) => { if (!cancelled) setReport(data); })
      .catch((err) => {
        if (cancelled) return;
        if (!onAuthError?.(err)) showToast(err.message || 'Failed to load OEE report.', 'error');
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineId, startDate, endDate, shift, operator, partName, authToken]);

  useEffect(() => {
    if (!machineId || !startDate || !endDate || tab !== 'downtime') return undefined;
    let cancelled = false;
    setDowntimeLoading(true);

    const params = new URLSearchParams({ machineId, startDate, endDate, groupBy: downtimeGroupBy });
    if (shift !== 'All Shifts') params.set('shift', shift);
    if (operator !== 'All Operators') params.set('operator', operator);
    if (partName !== 'All Parts') params.set('partName', partName);

    apiFetch(`/api/reports/downtime-summary?${params.toString()}`, { token: authToken })
      .then((data) => { if (!cancelled) setDowntimeReport(data); })
      .catch((err) => {
        if (cancelled) return;
        if (!onAuthError?.(err)) showToast(err.message || 'Failed to load downtime report.', 'error');
      })
      .finally(() => { if (!cancelled) setDowntimeLoading(false); });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineId, startDate, endDate, shift, operator, partName, downtimeGroupBy, tab, authToken]);

  const rows = report?.rows || [];
  const kpis = report?.kpis || null;

  const operatorOptions = useMemo(
    () => ['All Operators', ...new Set(rows.map((r) => r.operator).filter(Boolean))],
    [rows]
  );
  const partOptions = useMemo(
    () => ['All Parts', ...new Set(rows.map((r) => r.partName).filter(Boolean))],
    [rows]
  );

  const trendData = rows.map((r) => ({
    name: report.groupBy === 'day' ? r.date : `${r.date.slice(5)} ${r.shift.replace('Shift ', '')}`,
    OEE: r.oee, Availability: r.availability, Performance: r.performance, Quality: r.quality
  }));

  const downtimeTrendData = rows.map((r) => ({
    name: report.groupBy === 'day' ? r.date : `${r.date.slice(5)} ${r.shift.replace('Shift ', '')}`,
    'Downtime (min)': parseFloat((r.totalDowntimeSeconds / 60).toFixed(1))
  }));

  const targetVsActualData = rows.map((r) => ({
    name: report.groupBy === 'day' ? r.date : `${r.date.slice(5)} ${r.shift.replace('Shift ', '')}`,
    Target: r.target, Actual: r.totalCount
  }));

  const reasonsAgg = {};
  reasonCodes.forEach((r) => { reasonsAgg[r] = 0; });
  rows.forEach((r) => {
    Object.entries(r.downtimeReasons || {}).forEach(([reason, seconds]) => {
      reasonsAgg[reason] = (reasonsAgg[reason] || 0) + seconds;
    });
  });
  const pieData = Object.entries(reasonsAgg).map(([name, value]) => ({ name, value })).filter((d) => d.value > 0);

  const machineName = report?.machineName || machines.find((m) => m.id === machineId)?.name || machineId;

  const dtEvents = downtimeReport?.events || [];
  const dtGroups = downtimeReport?.groups || [];
  const dtKpis = downtimeReport?.kpis || null;

  const dtReasonsAgg = {};
  reasonCodes.forEach((r) => { dtReasonsAgg[r] = 0; });
  dtEvents.forEach((e) => { dtReasonsAgg[e.reason] = (dtReasonsAgg[e.reason] || 0) + e.durationSeconds; });
  const dtPieData = Object.entries(dtReasonsAgg).map(([name, value]) => ({ name, value })).filter((d) => d.value > 0);

  // Use the server-confirmed groupBy (downtimeReport.groupBy), not the local downtimeGroupBy
  // state, to derive chart/table data from dtGroups - the local state flips the instant a
  // grouping button is clicked, one render before the matching re-fetch resolves. Reading
  // dtGroups (still holding the *previous* grouping's shape, e.g. shift: null for day-wise)
  // against the new local state crashed the whole page (g.shift.replace on null, no error
  // boundary to catch it).
  const effectiveDowntimeGroupBy = downtimeReport?.groupBy || downtimeGroupBy;

  const dtTrendData = dtGroups.map((g) => ({
    name: effectiveDowntimeGroupBy === 'shift' && g.shift ? `${g.date.slice(5)} ${g.shift.replace('Shift ', '')}` : g.key,
    'Downtime (min)': parseFloat((g.totalDowntimeSeconds / 60).toFixed(1))
  }));

  const selectedGroupEvents = selectedDowntimeGroup
    ? dtEvents.filter((e) => downtimeGroupKey(e, effectiveDowntimeGroupBy) === selectedDowntimeGroup.key)
    : [];

  const filtersText = `Date Range: ${startDate} → ${endDate}  |  Shift: ${shift}  |  Operator: ${operator}  |  Part: ${partName}`;
  const generatedBy = currentUser ? `${currentUser.displayName || currentUser.loginId}${currentUser.role ? ` (${currentUser.role})` : ''}` : 'Unknown';

  async function handleDownloadPdf() {
    if (tab === 'oee') {
      if (!kpis) return;
      await exportPdf({
        title: 'Machine-Wise OEE Report',
        machineName,
        filtersText,
        generatedBy,
        kpiRows: [
          ['Availability', `${kpis.availability}%`, 'Performance', `${kpis.performance}%`],
          ['Quality', `${kpis.quality}%`, 'Overall OEE', `${kpis.oee}%`],
          ['Machine Utilization', `${kpis.machineUtilization}%`, 'Production Achievement', kpis.productionAchievement != null ? `${kpis.productionAchievement}%` : '-'],
          ['Planned Production Time', formatDurationHm(kpis.plannedProductionSeconds), 'Operating Time', formatDurationHm(kpis.operatingSeconds)],
          ['Downtime', formatDurationHm(kpis.totalDowntimeSeconds), 'Total Running Time', formatDurationHm(kpis.runningSeconds)],
          ['Total Stop Time', formatDurationHm(kpis.stoppedSeconds), 'Total Break Time', formatDurationHm(kpis.breakSeconds)],
          ['Good Parts', kpis.goodCount, 'Reject Parts', kpis.rejectCount],
          ['Total Count', kpis.totalCount, 'Production Target', kpis.target || '-'],
          ['Rejection %', `${kpis.rejectionPercent}%`, 'Yield %', `${kpis.yieldPercent}%`],
          ['Reject PPM', kpis.rejectPpm, 'Avg Hourly Production', kpis.avgHourlyProduction],
          ['Avg Cycle Time', `${kpis.avgCycleTime.toFixed(1)}s`, 'Ideal Cycle Time', `${kpis.idealCycleTime}s`]
        ],
        chartsEl: chartsRef.current,
        tables: [{
          title: 'Detailed Report',
          head: ['Date', 'Shift', 'Good', 'Reject', 'Downtime', 'Availability', 'Performance', 'Quality', 'OEE'],
          body: rows.map((r) => [
            r.date, r.shift, r.goodCount, r.rejectCount, formatDurationHm(r.totalDowntimeSeconds),
            `${fmtPct(r.availability)}%`, `${fmtPct(r.performance)}%`, `${fmtPct(r.quality)}%`, `${fmtPct(r.oee)}%`
          ])
        }],
        fileName: `OEE_Report_${machineId}_${startDate}_to_${endDate}.pdf`
      });
    } else {
      if (!dtKpis) return;
      await exportPdf({
        title: 'Downtime Analysis Report',
        machineName,
        filtersText,
        generatedBy,
        kpiRows: [
          ['Total Downtime', formatDurationHm(dtKpis.totalDowntimeSeconds), 'Planned Downtime', formatDurationHm(dtKpis.plannedDowntimeSeconds)],
          ['Unplanned Downtime', formatDurationHm(dtKpis.unplannedDowntimeSeconds), 'Downtime %', `${dtKpis.downtimePercent}%`],
          ['Total Events', dtKpis.totalEvents, 'Avg Downtime / Event', formatDurationHm(dtKpis.avgDowntimeSeconds)],
          ['Longest Downtime', formatDurationHm(dtKpis.longestDowntimeSeconds), '', '']
        ],
        chartsEl: dtChartsRef.current,
        tables: [
          {
            title: `Downtime by ${DOWNTIME_GROUP_OPTIONS.find((o) => o.value === effectiveDowntimeGroupBy)?.label || 'Group'}`,
            head: effectiveDowntimeGroupBy === 'shift' ? ['Date', 'Shift', 'Total Downtime', 'Events'] : ['Date', 'Total Downtime', 'Events'],
            body: dtGroups.map((g) => (
              effectiveDowntimeGroupBy === 'shift'
                ? [g.date, g.shift, formatDurationHm(g.totalDowntimeSeconds), g.events]
                : [g.key, formatDurationHm(g.totalDowntimeSeconds), g.events]
            ))
          },
          {
            title: 'Downtime Events',
            head: ['ID', 'Date', 'Shift', 'Time Range', 'Duration', 'Reason', 'Category', 'Operator', 'Part', 'Before', 'After'],
            body: dtEvents.map((e) => [
              e.id, e.date, e.shift, formatTimeRange(e.startTime, e.endTime),
              formatDurationHm(e.durationSeconds), e.reason, e.category, e.operator || '-', e.partNumber || '-',
              e.statusBefore || '-', e.statusAfter || '-'
            ])
          }
        ],
        fileName: `Downtime_Report_${machineId}_${startDate}_to_${endDate}.pdf`
      });
    }
  }

  function handleDownloadExcel() {
    if (tab === 'oee') {
      if (!kpis) return;
      exportExcel({
        sheets: [
          {
            name: 'KPI Summary',
            rows: [{
              Machine: machineName,
              Availability: `${kpis.availability}%`,
              Performance: `${kpis.performance}%`,
              Quality: `${kpis.quality}%`,
              'Overall OEE': `${kpis.oee}%`,
              'Machine Utilization': `${kpis.machineUtilization}%`,
              'Production Achievement': kpis.productionAchievement != null ? `${kpis.productionAchievement}%` : '-',
              'Planned Production Time': formatDurationHm(kpis.plannedProductionSeconds),
              'Operating Time': formatDurationHm(kpis.operatingSeconds),
              'Total Running Time': formatDurationHm(kpis.runningSeconds),
              'Total Stop Time': formatDurationHm(kpis.stoppedSeconds),
              'Total Break Time': formatDurationHm(kpis.breakSeconds),
              'Total Downtime': formatDurationHm(kpis.totalDowntimeSeconds),
              'Good Parts': kpis.goodCount,
              'Reject Parts': kpis.rejectCount,
              'Total Count': kpis.totalCount,
              'Production Target': kpis.target || '-',
              'Rejection %': `${kpis.rejectionPercent}%`,
              'Yield %': `${kpis.yieldPercent}%`,
              'Reject PPM': kpis.rejectPpm,
              'Avg Hourly Production': kpis.avgHourlyProduction,
              'Avg Cycle Time (s)': kpis.avgCycleTime.toFixed(1),
              'Ideal Cycle Time (s)': kpis.idealCycleTime
            }]
          },
          {
            name: 'Detailed Report',
            rows: rows.map((r) => ({
              Date: r.date, Shift: r.shift, Operator: r.operator || '', Part: r.partName || '',
              Good: r.goodCount, Reject: r.rejectCount, Downtime: formatDurationHm(r.totalDowntimeSeconds),
              Availability: r.availability, Performance: r.performance, Quality: r.quality, OEE: r.oee
            }))
          }
        ],
        fileName: `OEE_Report_${machineId}_${startDate}_to_${endDate}.xlsx`
      });
    } else {
      if (!dtKpis) return;
      exportExcel({
        sheets: [
          {
            name: 'KPI Summary',
            rows: [{
              Machine: machineName,
              'Total Downtime': formatDurationHm(dtKpis.totalDowntimeSeconds),
              'Planned Downtime': formatDurationHm(dtKpis.plannedDowntimeSeconds),
              'Unplanned Downtime': formatDurationHm(dtKpis.unplannedDowntimeSeconds),
              'Downtime %': `${dtKpis.downtimePercent}%`,
              'Total Events': dtKpis.totalEvents,
              'Avg Downtime / Event': formatDurationHm(dtKpis.avgDowntimeSeconds),
              'Longest Downtime': formatDurationHm(dtKpis.longestDowntimeSeconds)
            }]
          },
          {
            name: 'Grouped',
            rows: dtGroups.map((g) => ({ Group: g.key, Date: g.date, Shift: g.shift || '', 'Total Downtime': formatDurationHm(g.totalDowntimeSeconds), Events: g.events }))
          },
          {
            name: 'Events',
            rows: dtEvents.map((e) => ({
              ID: e.id, Date: e.date, Shift: e.shift, 'Time Range': formatTimeRange(e.startTime, e.endTime),
              Duration: formatDurationHm(e.durationSeconds), Reason: e.reason, Category: e.category,
              Operator: e.operator || '', Part: e.partNumber || '', StatusBefore: e.statusBefore || '',
              StatusAfter: e.statusAfter || '', Remarks: e.remarks || ''
            }))
          }
        ],
        fileName: `Downtime_Report_${machineId}_${startDate}_to_${endDate}.xlsx`
      });
    }
  }

  return (
    <div className="space-y-6 w-full animate-in fade-in duration-200 text-left print-area">
      {/* Header + tabs */}
      <div className="jbm-card p-5 flex flex-wrap items-center justify-between gap-4 no-print">
        <div className="flex items-center gap-2.5">
          <Gauge className="w-6 h-6 text-[var(--primary)] shrink-0" />
          <div>
            <h4 className="text-lg font-black uppercase text-[var(--grey-900)] tracking-wide">Machine-Wise OEE &amp; Downtime Reports</h4>
            <p className="text-sm font-bold text-slate-400 uppercase tracking-widest font-mono">Historical Availability / Performance / Quality / OEE and downtime analysis</p>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl border border-slate-200">
            <button
              onClick={() => setTab('oee')}
              className={`px-4 py-2 rounded-lg text-[13px] font-black uppercase tracking-wider transition ${tab === 'oee' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            >
              OEE Report
            </button>
            <button
              onClick={() => setTab('downtime')}
              className={`px-4 py-2 rounded-lg text-[13px] font-black uppercase tracking-wider transition ${tab === 'downtime' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            >
              Downtime Analysis
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleDownloadPdf}
              disabled={!kpis}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 hover:border-[var(--primary)] text-[12px] font-black uppercase tracking-wider text-slate-600 hover:text-[var(--primary)] transition disabled:opacity-40 disabled:pointer-events-none"
            >
              <FileDown className="w-3.5 h-3.5" /> Download PDF
            </button>
            <button
              onClick={handleDownloadExcel}
              disabled={!kpis}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 hover:border-emerald-600 text-[12px] font-black uppercase tracking-wider text-slate-600 hover:text-emerald-600 transition disabled:opacity-40 disabled:pointer-events-none"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" /> Download Excel
            </button>
            <button
              onClick={printReport}
              disabled={!kpis}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 hover:border-slate-500 text-[12px] font-black uppercase tracking-wider text-slate-600 hover:text-slate-800 transition disabled:opacity-40 disabled:pointer-events-none"
            >
              <Printer className="w-3.5 h-3.5" /> Print Report
            </button>
          </div>
        </div>
      </div>

      {/* Filter bar */}
      <div className="jbm-card p-5 grid gap-3 md:grid-cols-2 xl:grid-cols-5 items-center no-print">
        <div className="flex items-center gap-1.5 bg-[var(--bg-color-page)] border border-[var(--grey-200)] rounded-xl px-3 py-2.5">
          <Factory className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          <select value={machineId} onChange={(e) => setMachineId(e.target.value)} className="w-full bg-transparent text-sm font-bold outline-none">
            {machines.map((m) => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
          </select>
        </div>

        <div className="flex items-center gap-1.5 bg-[var(--bg-color-page)] border border-[var(--grey-200)] rounded-xl px-3 py-2.5">
          <Calendar className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          <select value={preset} onChange={(e) => setPreset(e.target.value)} className="w-full bg-transparent text-sm font-bold outline-none">
            {DATE_PRESETS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>

        {preset === 'Custom Date Range' ? (
          <div className="flex items-center gap-2 xl:col-span-1">
            <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] rounded-xl px-3 py-2.5 text-sm font-bold outline-none" />
            <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] rounded-xl px-3 py-2.5 text-sm font-bold outline-none" />
          </div>
        ) : (
          <div className="hidden xl:flex items-center px-3 py-2.5 text-[13px] font-bold text-slate-400 font-mono">
            {startDate} &rarr; {endDate}
          </div>
        )}

        <select value={shift} onChange={(e) => setShift(e.target.value)} className="bg-[var(--bg-color-page)] border border-[var(--grey-200)] rounded-xl px-3 py-2.5 text-sm font-bold outline-none">
          {SHIFT_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>

        <div className="flex gap-2">
          <select value={operator} onChange={(e) => setOperator(e.target.value)} className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] rounded-xl px-3 py-2.5 text-sm font-bold outline-none">
            {operatorOptions.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          <select value={partName} onChange={(e) => setPartName(e.target.value)} className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] rounded-xl px-3 py-2.5 text-sm font-bold outline-none">
            {partOptions.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
      </div>

      {loading ? (
        <div className="jbm-card text-center py-24 text-slate-400 uppercase tracking-widest font-black text-base">Loading report...</div>
      ) : !kpis || rows.length === 0 ? (
        <div className="jbm-card text-center py-24 text-slate-400 uppercase tracking-widest font-black text-base">
          No production data for the selected filters
        </div>
      ) : tab === 'oee' ? (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-4">
            <StatTile label="Availability" value={`${kpis.availability}%`} accent="text-sky-600" />
            <StatTile label="Performance" value={`${kpis.performance}%`} accent="text-orange-600" />
            <StatTile label="Quality" value={`${kpis.quality}%`} accent="text-emerald-600" />
            <StatTile label="Overall OEE" value={`${kpis.oee}%`} accent="text-[var(--primary)]" />
            <StatTile label="Machine Utilization" value={`${kpis.machineUtilization}%`} />
            <StatTile label="Production Achievement" value={kpis.productionAchievement !== null ? `${kpis.productionAchievement}%` : '-'} />

            <StatTile label="Planned Production Time" value={formatDuration(kpis.plannedProductionSeconds)} />
            <StatTile label="Operating Time" value={formatDuration(kpis.operatingSeconds)} />
            <StatTile label="Downtime" value={formatDuration(kpis.totalDowntimeSeconds)} accent="text-rose-600" />

            <StatTile label="Good Parts" value={kpis.goodCount} accent="text-emerald-600" />
            <StatTile label="Reject Parts" value={kpis.rejectCount} accent="text-rose-600" />
            <StatTile label="Total Count" value={kpis.totalCount} />
            <StatTile label="Production Target" value={kpis.target || '-'} />
            <StatTile label="Rejection %" value={`${kpis.rejectionPercent}%`} />
            <StatTile label="Yield %" value={`${kpis.yieldPercent}%`} />

            <StatTile label="Reject PPM" value={kpis.rejectPpm} />
            <StatTile label="Avg Hourly Production" value={kpis.avgHourlyProduction} />
            <StatTile label="Avg Cycle Time" value={`${kpis.avgCycleTime.toFixed(1)}s`} />
            <StatTile label="Actual Cycle Time" value={`${kpis.actualCycleTime.toFixed(1)}s`} />
            <StatTile label="Ideal Cycle Time" value={`${kpis.idealCycleTime}s`} />
          </div>

          {/* Production Summary table */}
          <div className="jbm-card p-6">
            <h4 className="text-base font-black uppercase text-[var(--grey-900)] tracking-wide mb-4 flex items-center gap-2">
              <Sigma className="w-4 h-4 text-[var(--primary)]" /> Production Summary
            </h4>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-base border-collapse">
                <tbody className="divide-y divide-slate-100 font-semibold text-slate-700">
                  <tr><td className="py-2 pr-4 text-slate-400 uppercase text-[12px] font-black">Machine</td><td className="py-2 font-black text-[var(--grey-900)]">{machineName}</td></tr>
                  <tr><td className="py-2 pr-4 text-slate-400 uppercase text-[12px] font-black">Date Range</td><td className="py-2 font-mono">{startDate} &rarr; {endDate}</td></tr>
                  <tr><td className="py-2 pr-4 text-slate-400 uppercase text-[12px] font-black">Shift</td><td className="py-2">{shift}</td></tr>
                  <tr><td className="py-2 pr-4 text-slate-400 uppercase text-[12px] font-black">Operator</td><td className="py-2">{operator}</td></tr>
                  <tr><td className="py-2 pr-4 text-slate-400 uppercase text-[12px] font-black">Ideal Cycle Time</td><td className="py-2 font-mono">{kpis.idealCycleTime}s</td></tr>
                  <tr><td className="py-2 pr-4 text-slate-400 uppercase text-[12px] font-black">Planned Production Time</td><td className="py-2 font-mono">{formatDuration(kpis.plannedProductionSeconds)}</td></tr>
                  <tr><td className="py-2 pr-4 text-slate-400 uppercase text-[12px] font-black">Operating Time</td><td className="py-2 font-mono">{formatDuration(kpis.operatingSeconds)}</td></tr>
                  <tr><td className="py-2 pr-4 text-slate-400 uppercase text-[12px] font-black">Downtime</td><td className="py-2 font-mono">{formatDuration(kpis.totalDowntimeSeconds)}</td></tr>
                  <tr><td className="py-2 pr-4 text-slate-400 uppercase text-[12px] font-black">Good Parts</td><td className="py-2 font-mono text-emerald-600">{kpis.goodCount}</td></tr>
                  <tr><td className="py-2 pr-4 text-slate-400 uppercase text-[12px] font-black">Reject Parts</td><td className="py-2 font-mono text-rose-600">{kpis.rejectCount}</td></tr>
                  <tr><td className="py-2 pr-4 text-slate-400 uppercase text-[12px] font-black">Total Production</td><td className="py-2 font-mono">{kpis.totalCount}</td></tr>
                  <tr><td className="py-2 pr-4 text-slate-400 uppercase text-[12px] font-black">Production Target</td><td className="py-2 font-mono">{kpis.target || '-'}</td></tr>
                  <tr><td className="py-2 pr-4 text-slate-400 uppercase text-[12px] font-black">Achievement %</td><td className="py-2 font-mono">{kpis.productionAchievement !== null ? `${kpis.productionAchievement}%` : '-'}</td></tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* OEE Calculation breakdown */}
          <div className="jbm-card p-6">
            <h4 className="text-base font-black uppercase text-[var(--grey-900)] tracking-wide mb-4 flex items-center gap-2">
              <Target className="w-4 h-4 text-[var(--primary)]" /> OEE Calculation
            </h4>
            <div className="grid gap-3 md:grid-cols-2 font-mono text-sm text-slate-600">
              <p><span className="font-black text-slate-800">Availability</span> = Operating Time / Planned Production Time &times; 100 = {formatDuration(kpis.operatingSeconds)} / {formatDuration(kpis.plannedProductionSeconds)} &times; 100 = <span className="font-black text-sky-600">{kpis.availability}%</span></p>
              <p><span className="font-black text-slate-800">Performance</span> = (Ideal Cycle Time &times; Total Count) / Operating Time &times; 100 = ({kpis.idealCycleTime}s &times; {kpis.totalCount}) / {Math.round(kpis.operatingSeconds)}s &times; 100 = <span className="font-black text-orange-600">{kpis.performance}%</span></p>
              <p><span className="font-black text-slate-800">Quality</span> = Good Parts / Total Count &times; 100 = {kpis.goodCount} / {kpis.totalCount} &times; 100 = <span className="font-black text-emerald-600">{kpis.quality}%</span></p>
              <p><span className="font-black text-slate-800">OEE</span> = Availability &times; Performance &times; Quality = {kpis.availability}% &times; {kpis.performance}% &times; {kpis.quality}% = <span className="font-black text-[var(--primary)]">{kpis.oee}%</span></p>
            </div>
          </div>

          {/* Charts */}
          <div ref={chartsRef} className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <div className="jbm-card p-5 flex flex-col h-[360px]">
              <div className="flex items-center gap-2 pb-3 border-b border-slate-100 mb-4">
                <TrendingUp className="w-4 h-4 text-sky-600" />
                <h3 className="text-base font-bold text-slate-800 uppercase tracking-wider">OEE / Availability / Performance / Quality Trend</h3>
              </div>
              <div className="flex-1 w-full text-sm">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={trendData} margin={{ top: 10, right: 10, left: -20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                    <XAxis dataKey="name" stroke="#64748b" fontSize={10} tickLine={false} axisLine={false} />
                    <YAxis stroke="#64748b" fontSize={10} domain={[0, 100]} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}%`} />
                    <Tooltip content={<CustomTooltip />} />
                    <Legend verticalAlign="top" height={32} iconSize={8} iconType="circle" wrapperStyle={{ fontSize: '10px', textTransform: 'uppercase', fontWeight: 'bold' }} />
                    <Line type="monotone" dataKey="OEE" stroke="#0057ff" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="Availability" stroke="#3b82f6" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="Performance" stroke="#ff8350" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="Quality" stroke="#057e39" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="jbm-card p-5 flex flex-col h-[360px]">
              <div className="flex items-center gap-2 pb-3 border-b border-slate-100 mb-4">
                <Clock className="w-4 h-4 text-sky-600" />
                <h3 className="text-base font-bold text-slate-800 uppercase tracking-wider">Downtime Trend (minutes)</h3>
              </div>
              <div className="flex-1 w-full text-sm">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={downtimeTrendData} margin={{ top: 10, right: 10, left: -20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                    <XAxis dataKey="name" stroke="#64748b" fontSize={10} tickLine={false} axisLine={false} />
                    <YAxis stroke="#64748b" fontSize={10} tickLine={false} axisLine={false} />
                    <Tooltip cursor={{ fill: 'rgba(148,163,184,0.03)' }} />
                    <Bar dataKey="Downtime (min)" fill="#ff2400" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="jbm-card p-5 flex flex-col h-[360px]">
              <div className="flex items-center gap-2 pb-3 border-b border-slate-100 mb-4">
                <Target className="w-4 h-4 text-sky-600" />
                <h3 className="text-base font-bold text-slate-800 uppercase tracking-wider">Target vs Actual Production</h3>
              </div>
              <div className="flex-1 w-full text-sm">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={targetVsActualData} margin={{ top: 10, right: 10, left: -20, bottom: 5 }} barGap={3}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                    <XAxis dataKey="name" stroke="#64748b" fontSize={10} tickLine={false} axisLine={false} />
                    <YAxis stroke="#64748b" fontSize={10} tickLine={false} axisLine={false} />
                    <Tooltip cursor={{ fill: 'rgba(148,163,184,0.03)' }} />
                    <Legend verticalAlign="top" height={32} iconSize={8} iconType="circle" wrapperStyle={{ fontSize: '10px', textTransform: 'uppercase', fontWeight: 'bold' }} />
                    <Bar dataKey="Target" fill="#94a3b8" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="Actual" fill="#0057ff" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="jbm-card p-5 flex flex-col h-[360px]">
              <div className="flex items-center gap-2 pb-3 border-b border-slate-100 mb-4">
                <PieIcon className="w-4 h-4 text-sky-600" />
                <h3 className="text-base font-bold text-slate-800 uppercase tracking-wider">Downtime Reasons Breakdown</h3>
              </div>
              <div className="flex-1 flex flex-col md:flex-row items-center justify-center gap-4 text-sm">
                {pieData.length > 0 ? (
                  <>
                    <div className="w-[160px] h-[160px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Tooltip />
                          <Pie data={pieData} cx="50%" cy="50%" innerRadius={45} outerRadius={70} paddingAngle={3} dataKey="value">
                            {pieData.map((entry, index) => (
                              <Cell key={entry.name} fill={COLORS[reasonCodes.indexOf(entry.name) % COLORS.length] || COLORS[index % COLORS.length]} />
                            ))}
                          </Pie>
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 max-h-[200px] overflow-y-auto pr-1">
                      {pieData.map((entry, index) => (
                        <div key={entry.name} className="flex items-start gap-1.5 text-[12px]">
                          <span className="w-2.5 h-2.5 rounded-full shrink-0 mt-0.5" style={{ backgroundColor: COLORS[reasonCodes.indexOf(entry.name) % COLORS.length] || COLORS[index % COLORS.length] }}></span>
                          <div className="leading-tight">
                            <p className="font-bold text-slate-700 uppercase tracking-wide">{entry.name}</p>
                            <p className="font-mono text-slate-450 font-semibold">{formatDuration(entry.value)}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="text-center py-10 uppercase tracking-widest font-semibold text-slate-400">No downtime recorded for the selected filters</div>
                )}
              </div>
            </div>
          </div>

          {/* Detailed report table */}
          <div className="jbm-card p-6">
            <h4 className="text-base font-black uppercase text-[var(--grey-900)] tracking-wide mb-4">Detailed Report</h4>
            <div className="overflow-x-auto rounded-xl border border-slate-200 shadow-inner max-h-[480px] overflow-y-auto">
              <table className="w-full text-left text-base border-collapse">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-550 font-bold uppercase tracking-wider text-[12px] sticky top-0 z-10">
                  <tr>
                    <th className="px-4 py-3.5">Date</th>
                    <th className="px-4 py-3.5">Shift</th>
                    <th className="px-4 py-3.5 text-right">Good Parts</th>
                    <th className="px-4 py-3.5 text-right">Reject Parts</th>
                    <th className="px-4 py-3.5 text-right">Downtime</th>
                    <th className="px-4 py-3.5 text-right">Availability</th>
                    <th className="px-4 py-3.5 text-right">Performance</th>
                    <th className="px-4 py-3.5 text-right">Quality</th>
                    <th className="px-4 py-3.5 text-right">OEE</th>
                    <th className="px-4 py-3.5"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700 bg-white font-semibold">
                  {rows.map((r) => (
                    <tr key={`${r.date}-${r.shift}`} className="hover:bg-slate-50/55 transition-colors">
                      <td className="px-4 py-3 font-mono text-slate-500">{r.date}</td>
                      <td className="px-4 py-3 text-[12px] uppercase tracking-wider text-slate-550">{r.shift}</td>
                      <td className="px-4 py-3 text-right font-mono text-emerald-600">{r.goodCount}</td>
                      <td className="px-4 py-3 text-right font-mono text-rose-600">{r.rejectCount}</td>
                      <td className="px-4 py-3 text-right font-mono">{formatDuration(r.totalDowntimeSeconds)}</td>
                      <td className="px-4 py-3 text-right font-mono">{r.availability.toFixed ? r.availability.toFixed(1) : r.availability}%</td>
                      <td className="px-4 py-3 text-right font-mono">{r.performance.toFixed ? r.performance.toFixed(1) : r.performance}%</td>
                      <td className="px-4 py-3 text-right font-mono">{r.quality.toFixed ? r.quality.toFixed(1) : r.quality}%</td>
                      <td className="px-4 py-3 text-right font-mono font-black text-[var(--primary)]">{r.oee.toFixed ? r.oee.toFixed(1) : r.oee}%</td>
                      <td className="px-4 py-3 text-right">
                        {report.groupBy === 'shift' && r.shift !== 'All Shifts' ? (
                          <button
                            onClick={() => setSelectedDetail({ date: r.date, shift: r.shift })}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 hover:border-[var(--primary)] text-[12px] font-black uppercase tracking-wider text-slate-600 hover:text-[var(--primary)] transition"
                          >
                            <Eye className="w-3 h-3" /> View
                          </button>
                        ) : (
                          <span className="text-slate-300 text-[12px]">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        <>
          {/* Downtime KPI cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatTile label="Total Downtime" value={formatDuration(dtKpis?.totalDowntimeSeconds)} accent="text-rose-600" />
            <StatTile label="Planned Downtime" value={formatDuration(dtKpis?.plannedDowntimeSeconds)} />
            <StatTile label="Unplanned Downtime" value={formatDuration(dtKpis?.unplannedDowntimeSeconds)} />
            <StatTile label="Downtime %" value={`${dtKpis?.downtimePercent ?? 0}%`} />
            <StatTile label="Total Downtime Events" value={dtKpis?.totalEvents ?? 0} />
            <StatTile label="Avg Downtime / Event" value={formatDuration(dtKpis?.avgDowntimeSeconds)} />
            <StatTile label="Longest Downtime" value={formatDuration(dtKpis?.longestDowntimeSeconds)} />
          </div>

          {/* Grouping selector */}
          <div className="jbm-card p-4 flex items-center gap-2 no-print">
            <LayoutList className="w-4 h-4 text-slate-400 shrink-0" />
            <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl border border-slate-200">
              {DOWNTIME_GROUP_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setDowntimeGroupBy(opt.value)}
                  className={`px-3 py-1.5 rounded-lg text-[12px] font-black uppercase tracking-wider transition ${
                    downtimeGroupBy === opt.value ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {downtimeLoading ? (
            <div className="jbm-card text-center py-24 text-slate-400 uppercase tracking-widest font-black text-base">Loading downtime report...</div>
          ) : dtGroups.length === 0 ? (
            <div className="jbm-card text-center py-24 text-slate-400 uppercase tracking-widest font-black text-base">No downtime recorded for the selected filters</div>
          ) : (
            <>
              {/* Charts */}
              <div ref={dtChartsRef} className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                <div className="jbm-card p-5 flex flex-col h-[340px]">
                  <div className="flex items-center gap-2 pb-3 border-b border-slate-100 mb-4">
                    <Clock className="w-4 h-4 text-sky-600" />
                    <h3 className="text-base font-bold text-slate-800 uppercase tracking-wider">Downtime Trend (minutes)</h3>
                  </div>
                  <div className="flex-1 w-full text-sm">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={dtTrendData} margin={{ top: 10, right: 10, left: -20, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                        <XAxis dataKey="name" stroke="#64748b" fontSize={10} tickLine={false} axisLine={false} />
                        <YAxis stroke="#64748b" fontSize={10} tickLine={false} axisLine={false} />
                        <Tooltip cursor={{ fill: 'rgba(148,163,184,0.03)' }} />
                        <Bar dataKey="Downtime (min)" fill="#ff2400" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="jbm-card p-5 flex flex-col h-[340px]">
                  <div className="flex items-center gap-2 pb-3 border-b border-slate-100 mb-4">
                    <PieIcon className="w-4 h-4 text-sky-600" />
                    <h3 className="text-base font-bold text-slate-800 uppercase tracking-wider">Downtime Reasons Breakdown</h3>
                  </div>
                  <div className="flex-1 flex flex-col md:flex-row items-center justify-center gap-4 text-sm">
                    {dtPieData.length > 0 ? (
                      <>
                        <div className="w-[150px] h-[150px]">
                          <ResponsiveContainer width="100%" height="100%">
                            <PieChart>
                              <Tooltip />
                              <Pie data={dtPieData} cx="50%" cy="50%" innerRadius={40} outerRadius={65} paddingAngle={3} dataKey="value">
                                {dtPieData.map((entry, index) => (
                                  <Cell key={entry.name} fill={COLORS[reasonCodes.indexOf(entry.name) % COLORS.length] || COLORS[index % COLORS.length]} />
                                ))}
                              </Pie>
                            </PieChart>
                          </ResponsiveContainer>
                        </div>
                        <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 max-h-[180px] overflow-y-auto pr-1">
                          {dtPieData.map((entry, index) => (
                            <div key={entry.name} className="flex items-start gap-1.5 text-[12px]">
                              <span className="w-2.5 h-2.5 rounded-full shrink-0 mt-0.5" style={{ backgroundColor: COLORS[reasonCodes.indexOf(entry.name) % COLORS.length] || COLORS[index % COLORS.length] }}></span>
                              <div className="leading-tight">
                                <p className="font-bold text-slate-700 uppercase tracking-wide">{entry.name}</p>
                                <p className="font-mono text-slate-450 font-semibold">{formatDuration(entry.value)}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      </>
                    ) : (
                      <div className="text-center py-10 uppercase tracking-widest font-semibold text-slate-400">No downtime recorded</div>
                    )}
                  </div>
                </div>
              </div>

              {/* Grouped downtime table */}
              <div className="jbm-card p-6">
                <h4 className="text-base font-black uppercase text-[var(--grey-900)] tracking-wide mb-4">Downtime by {DOWNTIME_GROUP_OPTIONS.find((o) => o.value === downtimeGroupBy).label}</h4>
                <div className="overflow-x-auto rounded-xl border border-slate-200 shadow-inner max-h-[420px] overflow-y-auto">
                  <table className="w-full text-left text-base border-collapse">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-550 font-bold uppercase tracking-wider text-[12px] sticky top-0 z-10">
                      <tr>
                        <th className="px-4 py-3.5">Date</th>
                        {effectiveDowntimeGroupBy === 'shift' && <th className="px-4 py-3.5">Shift</th>}
                        <th className="px-4 py-3.5 text-right">Total Downtime</th>
                        <th className="px-4 py-3.5 text-right">Events</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-slate-700 bg-white font-semibold">
                      {dtGroups.map((g) => (
                        <tr key={g.key} className="hover:bg-slate-50/55 transition-colors">
                          <td className="px-4 py-3 font-mono text-slate-500">{g.key}</td>
                          {effectiveDowntimeGroupBy === 'shift' && <td className="px-4 py-3 text-[12px] uppercase tracking-wider text-slate-550">{g.shift}</td>}
                          <td className="px-4 py-3 text-right">
                            <button
                              onClick={() => setSelectedDowntimeGroup(g)}
                              className="font-mono font-black text-[var(--primary)] hover:underline"
                            >
                              {formatDuration(g.totalDowntimeSeconds)}
                            </button>
                          </td>
                          <td className="px-4 py-3 text-right font-mono">{g.events}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      )}

      <OeeDetailDrawer
        isOpen={!!selectedDetail}
        onClose={() => setSelectedDetail(null)}
        authToken={authToken}
        machineId={machineId}
        machineName={machineName}
        date={selectedDetail?.date}
        shift={selectedDetail?.shift}
        onAuthError={onAuthError}
      />

      <DowntimeEventsDrawer
        isOpen={!!selectedDowntimeGroup}
        onClose={() => setSelectedDowntimeGroup(null)}
        groupLabel={selectedDowntimeGroup ? `${selectedDowntimeGroup.key}${selectedDowntimeGroup.shift ? ` — ${selectedDowntimeGroup.shift}` : ''}` : ''}
        events={selectedGroupEvents}
        machineName={machineName}
        generatedBy={generatedBy}
      />
    </div>
  );
}
