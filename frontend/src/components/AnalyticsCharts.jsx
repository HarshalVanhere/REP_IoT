import React, { useEffect, useState } from 'react';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine, PieChart, Pie, Cell } from 'recharts';
import { BarChart3, TrendingUp, Clock, PieChart as PieIcon, Factory, Calendar, Activity } from 'lucide-react';
import { isConnected } from '../lib/connectivity';
import { apiFetch } from '../lib/api';
import { useToast } from './Toast';

const SHIFT_OPTIONS = ['Shift A', 'Shift B', 'Shift C'];

function toDateStr(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Ahead/on-target/behind dot coloring for the cumulative Target vs Actual line, per point's own
// achievementPercent (Actual/Target at that hour) - matches the spec's green/blue/red convention.
function achievementColor(pct) {
  if (pct === null || pct === undefined) return '#64748b';
  if (pct >= 100) return '#057e39';
  if (pct >= 90) return '#0057ff';
  return '#ff2400';
}

function HourlyTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  const point = payload[0]?.payload;
  if (!point) return null;
  const diff = point.actual - point.target;
  return (
    <div className="bg-white border border-slate-200 p-3 rounded-lg shadow-lg font-sans text-slate-850">
      <p className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-1.5">{label} <span className="font-mono text-slate-400 normal-case">({point.timeRange})</span></p>
      <div className="space-y-1 text-[11px]">
        <div className="flex justify-between gap-6"><span className="font-semibold text-slate-500 uppercase">Target:</span><span className="font-mono font-bold text-slate-800">{point.target}</span></div>
        <div className="flex justify-between gap-6"><span className="font-semibold text-slate-500 uppercase">Actual:</span><span className="font-mono font-bold text-slate-800">{point.actual}</span></div>
        <div className="flex justify-between gap-6"><span className="font-semibold text-slate-500 uppercase">Difference:</span><span className={`font-mono font-bold ${diff >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{diff >= 0 ? '+' : ''}{diff}</span></div>
        <div className="flex justify-between gap-6"><span className="font-semibold text-slate-500 uppercase">Achievement:</span><span className="font-mono font-bold text-slate-800">{point.achievementPercent ?? '-'}%</span></div>
      </div>
    </div>
  );
}

// Predefined downtime reasons colors for pie chart
const COLORS = [
  '#0057ff', // JBM Royal Blue
  '#ff8350', // JBM Orange
  '#057e39', // JBM Green
  '#ff2400', // JBM Red
  '#8b5cf6', // Purple
  '#f59e0b', // Amber
  '#ec4899', // Pink
  '#64748b'  // Slate
];

export default function AnalyticsCharts({ machines, reasonCodes = [], authToken, onAuthError }) {
  const { showToast } = useToast();
  // Reason codes come from GET /api/reason-codes (backend single source of truth) instead
  // of being duplicated here - keeps this chart's legend in sync with OEE aggregation.
  const PREDEFINED_REASONS = reasonCodes;

  // Not Connected machines (no IoT device wired up, or signal lost past heartbeat timeout) have
  // no real production/OEE data - excluded from every fleet-wide chart below rather than
  // dragging every average down with fabricated zeros.
  const connectedMachines = machines.filter(isConnected);

  // Hourly Production & OEE Trend - its own self-contained filter bar (Machine/Date/Shift),
  // independent of the fleet-wide charts above, same pattern as OeeReportPage.jsx's filter bar.
  const [hourlyMachineId, setHourlyMachineId] = useState(connectedMachines[0]?.id || machines[0]?.id || '');
  const [hourlyDate, setHourlyDate] = useState(toDateStr(new Date()));
  const [hourlyShift, setHourlyShift] = useState('Shift A');
  const [hourlyTrendTab, setHourlyTrendTab] = useState('downtime'); // 'downtime' | 'oee'
  const [hourlyData, setHourlyData] = useState(null);
  const [hourlyLoading, setHourlyLoading] = useState(false);

  useEffect(() => {
    if (!hourlyMachineId && machines.length > 0) setHourlyMachineId(machines[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machines]);

  useEffect(() => {
    if (!hourlyMachineId || !hourlyDate || !hourlyShift || !authToken) return undefined;
    let cancelled = false;
    setHourlyLoading(true);
    const params = new URLSearchParams({ machineId: hourlyMachineId, date: hourlyDate, shift: hourlyShift });
    apiFetch(`/api/reports/hourly-breakdown?${params.toString()}`, { token: authToken })
      .then((data) => { if (!cancelled) setHourlyData(data); })
      .catch((err) => {
        if (cancelled) return;
        setHourlyData(null);
        if (!onAuthError?.(err)) showToast(err.message || 'Failed to load hourly breakdown.', 'error');
      })
      .finally(() => { if (!cancelled) setHourlyLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hourlyMachineId, hourlyDate, hourlyShift, authToken]);

  const hourlyMachineName = machines.find((m) => m.id === hourlyMachineId)?.name || hourlyMachineId;
  const hourlyRows = hourlyData?.hours || [];
  const hourlyDowntimeData = hourlyRows.map((h) => ({ label: h.label, 'Downtime (min)': parseFloat((h.downtimeSeconds / 60).toFixed(1)) }));
  const hourlyOeeData = hourlyRows.map((h) => ({ label: h.label, Availability: h.availability, Performance: h.performance, Quality: h.quality, OEE: h.oee }));

  // 1. Prepare data for OEE breakdown chart
  const oeeData = connectedMachines.map(m => ({
    name: m.id,
    OEE: m.metrics?.oee || 0,
    Availability: m.metrics?.availability || 0,
    Performance: m.metrics?.performance || 0,
    Quality: m.metrics?.quality || 0
  }));

  // 2. Prepare data for Machine Utilization stacked bar
  const utilizationData = connectedMachines.map(m => ({
    name: m.id,
    Running: m.metrics?.utilization?.Running || 0,
    Stopped: m.metrics?.utilization?.Stopped || 0,
    Offline: m.metrics?.utilization?.NoSignal || 0
  }));

  // 3. Prepare data for Shift-wise production comparison
  const shiftData = connectedMachines.map(m => ({
    name: m.id,
    'Shift A': m.metrics?.shifts?.A || 0,
    'Shift B': m.metrics?.shifts?.B || 0,
    'Shift C': m.metrics?.shifts?.C || 0
  }));

  // 4. Consolidate downtime reasons durations across all machines
  const reasonsAgg = {};
  PREDEFINED_REASONS.forEach(r => reasonsAgg[r] = 0);
  
  connectedMachines.forEach(m => {
    const reasons = m.metrics?.downtimeReasons || {};
    Object.keys(reasons).forEach(r => {
      reasonsAgg[r] = (reasonsAgg[r] || 0) + reasons[r];
    });
  });

  const pieData = Object.keys(reasonsAgg)
    .map(key => ({
      name: key,
      value: reasonsAgg[key]
    }))
    .filter(item => item.value > 0); // Only render reasons with recorded seconds

  const formatDowntimeDuration = (seconds) => {
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins < 60) return `${mins}m ${secs}s`;
    const hrs = Math.floor(mins / 60);
    const remainingMins = mins % 60;
    return `${hrs}h ${remainingMins}m`;
  };

  const CustomTooltip = ({ active, payload, label }) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-white border border-slate-200 p-3 rounded-lg shadow-lg font-sans text-slate-850">
          <p className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-1.5">{label}</p>
          <div className="space-y-1">
            {payload.map((item, index) => (
              <div key={index} className="flex justify-between items-center gap-6 text-[11px]">
                <span className="font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: item.color }}></span>
                  {item.name}:
                </span>
                <span className="font-mono font-bold text-slate-800">{item.value}%</span>
              </div>
            ))}
          </div>
        </div>
      );
    }
    return null;
  };

  const CustomPieTooltip = ({ active, payload }) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-white border border-slate-200 p-3 rounded-lg shadow-lg font-sans text-slate-850">
          <p className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-1">{data.name}</p>
          <p className="text-xs font-bold text-sky-700 font-mono">
            Downtime: {formatDowntimeDuration(data.value)}
          </p>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="space-y-6">

      {/* Hourly Production & OEE Trend - self-contained filter bar + charts */}
      <div className="glass-card rounded-xl p-4 sm:p-5 border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center gap-2 pb-3 border-b border-slate-100 mb-4">
          <Activity className="w-4 h-4 text-sky-600 shrink-0" />
          <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider">Hourly Production &amp; OEE Trend</h3>
        </div>

        {/* Filter bar - mobile-first: stacks to 1 column on small screens, 3 across from sm+ */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
          <div className="flex items-center gap-1.5 bg-[var(--bg-color-page)] border border-[var(--grey-200)] rounded-xl px-3 py-2.5">
            <Factory className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <select value={hourlyMachineId} onChange={(e) => setHourlyMachineId(e.target.value)} className="w-full bg-transparent text-sm font-bold outline-none min-w-0">
              {machines.map((m) => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-1.5 bg-[var(--bg-color-page)] border border-[var(--grey-200)] rounded-xl px-3 py-2.5">
            <Calendar className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <input type="date" value={hourlyDate} onChange={(e) => setHourlyDate(e.target.value)} className="w-full bg-transparent text-sm font-bold outline-none min-w-0" />
          </div>
          <select value={hourlyShift} onChange={(e) => setHourlyShift(e.target.value)} className="bg-[var(--bg-color-page)] border border-[var(--grey-200)] rounded-xl px-3 py-2.5 text-sm font-bold outline-none">
            {SHIFT_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        {hourlyLoading ? (
          <div className="text-center py-16 text-slate-400 uppercase tracking-widest font-black text-xs">Loading hourly breakdown...</div>
        ) : hourlyData?.connected === false ? (
          <div className="text-center py-16 text-slate-400 uppercase tracking-widest font-black text-xs">Machine is Not Connected - no data available</div>
        ) : hourlyRows.length === 0 ? (
          <div className="text-center py-16 text-slate-400 uppercase tracking-widest font-black text-xs">No production data yet for {hourlyMachineName} - {hourlyShift} on {hourlyDate}</div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            {/* Target vs Actual (cumulative), dot color-coded ahead/on-target/behind */}
            <div className="flex flex-col h-[320px] min-w-0">
              <h4 className="text-[11px] font-black uppercase tracking-wider text-slate-500 mb-2">Target vs Actual (Cumulative)</h4>
              <div className="flex-1 w-full text-xs min-w-0">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={hourlyRows} margin={{ top: 10, right: 10, left: -20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                    <XAxis dataKey="label" stroke="#64748b" fontSize={10} tickLine={false} axisLine={false} />
                    <YAxis stroke="#64748b" fontSize={10} tickLine={false} axisLine={false} allowDecimals={false} />
                    <Tooltip content={<HourlyTooltip />} />
                    <Legend verticalAlign="top" height={32} iconSize={8} iconType="circle" wrapperStyle={{ fontSize: '10px', textTransform: 'uppercase', fontWeight: 'bold' }} />
                    <Line type="monotone" dataKey="target" name="Target" stroke="#94a3b8" strokeWidth={2} dot={false} strokeDasharray="4 3" />
                    <Line
                      type="monotone" dataKey="actual" name="Actual" stroke="#0057ff" strokeWidth={2}
                      dot={(props) => {
                        const { cx, cy, payload, index } = props;
                        return <circle key={`dot-${index}`} cx={cx} cy={cy} r={4} fill={achievementColor(payload.achievementPercent)} stroke="#fff" strokeWidth={1.5} />;
                      }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Toggleable second trend: Downtime or A/P/Q/OEE */}
            <div className="flex flex-col h-[320px] min-w-0">
              <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                <h4 className="text-[11px] font-black uppercase tracking-wider text-slate-500">
                  {hourlyTrendTab === 'downtime' ? 'Hourly Downtime' : 'Hourly Availability / Performance / Quality / OEE'}
                </h4>
                <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg border border-slate-200 shrink-0">
                  <button
                    onClick={() => setHourlyTrendTab('downtime')}
                    className={`px-2.5 py-1 rounded-md text-[10px] font-black uppercase tracking-wider transition ${hourlyTrendTab === 'downtime' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500'}`}
                  >
                    Downtime
                  </button>
                  <button
                    onClick={() => setHourlyTrendTab('oee')}
                    className={`px-2.5 py-1 rounded-md text-[10px] font-black uppercase tracking-wider transition ${hourlyTrendTab === 'oee' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500'}`}
                  >
                    A/P/Q/OEE
                  </button>
                </div>
              </div>
              <div className="flex-1 w-full text-xs min-w-0">
                <ResponsiveContainer width="100%" height="100%">
                  {hourlyTrendTab === 'downtime' ? (
                    <BarChart data={hourlyDowntimeData} margin={{ top: 10, right: 10, left: -20, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                      <XAxis dataKey="label" stroke="#64748b" fontSize={10} tickLine={false} axisLine={false} />
                      <YAxis stroke="#64748b" fontSize={10} tickLine={false} axisLine={false} />
                      <Tooltip cursor={{ fill: 'rgba(148,163,184,0.03)' }} />
                      <Bar dataKey="Downtime (min)" fill="#ff2400" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  ) : (
                    <LineChart data={hourlyOeeData} margin={{ top: 10, right: 10, left: -20, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                      <XAxis dataKey="label" stroke="#64748b" fontSize={10} tickLine={false} axisLine={false} />
                      <YAxis stroke="#64748b" fontSize={10} domain={[0, 100]} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}%`} />
                      <Tooltip content={<CustomTooltip />} />
                      <Legend verticalAlign="top" height={32} iconSize={8} iconType="circle" wrapperStyle={{ fontSize: '10px', textTransform: 'uppercase', fontWeight: 'bold' }} />
                      <Line type="monotone" dataKey="OEE" stroke="#0057ff" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="Availability" stroke="#3b82f6" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="Performance" stroke="#ff8350" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="Quality" stroke="#057e39" strokeWidth={2} dot={false} />
                    </LineChart>
                  )}
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Top Row: OEE Component Grouped Chart & Machine Utilization Stacked Chart */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Chart 1: OEE Grouped Comparison */}
        <div className="glass-card rounded-xl p-5 border border-slate-200 bg-white shadow-sm flex flex-col h-[360px]">
          <div className="flex items-center gap-2 pb-3 border-b border-slate-100 mb-4">
            <BarChart3 className="w-4 h-4 text-sky-600" />
            <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider">OEE Metric Analysis</h3>
          </div>
          <div className="flex-1 w-full text-xs">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={oeeData} margin={{ top: 10, right: 10, left: -20, bottom: 5 }} barGap={3}>
                <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                <XAxis dataKey="name" stroke="#64748b" fontSize={10} tickLine={false} axisLine={false} />
                <YAxis stroke="#64748b" fontSize={10} domain={[0, 100]} tickLine={false} axisLine={false} tickFormatter={(val) => `${val}%`} />
                <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(148,163,184,0.03)' }} />
                <Legend verticalAlign="top" height={36} iconSize={8} iconType="circle" wrapperStyle={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 'bold', color: '#475569' }} />
                <ReferenceLine y={85} stroke="rgba(5, 150, 105, 0.4)" strokeDasharray="5 5" strokeWidth={1} label={{ value: 'World Class (85%)', fill: '#059669', fontSize: 8, position: 'top' }} />
                <Bar dataKey="OEE" fill="#0057ff" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Availability" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Performance" fill="#ff8350" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Quality" fill="#057e39" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Chart 2: Machine Utilization Stacked horizontal bar */}
        <div className="glass-card rounded-xl p-5 border border-slate-200 bg-white shadow-sm flex flex-col h-[360px]">
          <div className="flex items-center gap-2 pb-3 border-b border-slate-100 mb-4">
            <Clock className="w-4 h-4 text-sky-600" />
            <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider">Machine Utilization Timeline</h3>
          </div>
          <div className="flex-1 w-full text-xs">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={utilizationData}
                layout="vertical"
                margin={{ top: 10, right: 10, left: -15, bottom: 5 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" horizontal={false} />
                <XAxis type="number" domain={[0, 100]} stroke="#64748b" fontSize={10} tickLine={false} axisLine={false} tickFormatter={(val) => `${val}%`} />
                <YAxis type="category" dataKey="name" stroke="#64748b" fontSize={10} tickLine={false} axisLine={false} />
                <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(148,163,184,0.03)' }} />
                <Legend verticalAlign="top" height={36} iconSize={8} iconType="circle" wrapperStyle={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 'bold' }} />
                <Bar dataKey="Running" stackId="u" fill="#057e39" name="Running %" radius={[0, 0, 0, 0]} />
                <Bar dataKey="Stopped" stackId="u" fill="#ff2400" name="Stopped %" radius={[0, 0, 0, 0]} />
                <Bar dataKey="Offline" stackId="u" fill="#94a3b8" name="Not Connected %" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Bottom Row: Shift Production & Downtime Reasons Breakdown */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Chart 3: Shift-wise production comparison */}
        <div className="glass-card rounded-xl p-5 border border-slate-200 bg-white shadow-sm flex flex-col h-[360px]">
          <div className="flex items-center gap-2 pb-3 border-b border-slate-100 mb-4">
            <TrendingUp className="w-4 h-4 text-sky-600" />
            <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider">Shift-Wise Production Tally</h3>
          </div>
          <div className="flex-1 w-full text-xs">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={shiftData} margin={{ top: 10, right: 10, left: -25, bottom: 5 }} barGap={4}>
                <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                <XAxis dataKey="name" stroke="#64748b" fontSize={10} tickLine={false} axisLine={false} />
                <YAxis stroke="#64748b" fontSize={10} tickLine={false} axisLine={false} />
                <Tooltip cursor={{ fill: 'rgba(148,163,184,0.03)' }} />
                <Legend verticalAlign="top" height={36} iconSize={8} iconType="circle" wrapperStyle={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 'bold' }} />
                <Bar dataKey="Shift A" fill="#0057ff" name="Shift A (07:00 AM - 03:00 PM)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Shift B" fill="#ff8350" name="Shift B (03:00 PM - 11:00 PM)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Shift C" fill="#057e39" name="Shift C (11:00 PM - 07:00 AM)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Chart 4: Downtime reasons pie chart */}
        <div className="glass-card rounded-xl p-5 border border-slate-200 bg-white shadow-sm flex flex-col h-[360px]">
          <div className="flex items-center gap-2 pb-3 border-b border-slate-100 mb-4">
            <PieIcon className="w-4 h-4 text-sky-600" />
            <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider">Downtime Reasons Breakdown</h3>
          </div>
          <div className="flex-1 flex flex-col md:flex-row items-center justify-center gap-4 text-xs">
            {pieData.length > 0 ? (
              <>
                {/* Pie Chart container */}
                <div className="w-[180px] h-[180px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Tooltip content={<CustomPieTooltip />} />
                      <Pie
                        data={pieData}
                        cx="50%"
                        cy="50%"
                        innerRadius={50}
                        outerRadius={75}
                        paddingAngle={3}
                        dataKey="value"
                      >
                        {pieData.map((entry, index) => (
                          <Cell 
                            key={`cell-${index}`} 
                            fill={COLORS[PREDEFINED_REASONS.indexOf(entry.name) % COLORS.length]} 
                          />
                        ))}
                      </Pie>
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                {/* Legend list grid */}
                <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 max-h-[220px] overflow-y-auto pr-1">
                  {pieData.map((entry) => {
                    const colorIndex = PREDEFINED_REASONS.indexOf(entry.name) % COLORS.length;
                    return (
                      <div key={entry.name} className="flex items-start gap-1.5 text-[10px]">
                        <span 
                          className="w-2.5 h-2.5 rounded-full shrink-0 mt-0.5" 
                          style={{ backgroundColor: COLORS[colorIndex] }}
                        ></span>
                        <div className="leading-tight">
                          <p className="font-bold text-slate-700 uppercase tracking-wide">{entry.name}</p>
                          <p className="font-mono text-slate-450 font-semibold">{formatDowntimeDuration(entry.value)}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="text-center py-10 uppercase tracking-widest font-semibold text-slate-400">
                No machine downtime recorded today
              </div>
            )}
          </div>
        </div>
      </div>

    </div>
  );
}
