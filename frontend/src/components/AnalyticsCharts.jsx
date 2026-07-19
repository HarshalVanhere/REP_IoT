import React from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine, PieChart, Pie, Cell } from 'recharts';
import { BarChart3, TrendingUp, Clock, PieChart as PieIcon } from 'lucide-react';

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

export default function AnalyticsCharts({ machines, reasonCodes = [] }) {
  // Reason codes come from GET /api/reason-codes (backend single source of truth) instead
  // of being duplicated here - keeps this chart's legend in sync with OEE aggregation.
  const PREDEFINED_REASONS = reasonCodes;
  // 1. Prepare data for OEE breakdown chart
  const oeeData = machines.map(m => ({
    name: m.id,
    OEE: m.metrics?.oee || 0,
    Availability: m.metrics?.availability || 0,
    Performance: m.metrics?.performance || 0,
    Quality: m.metrics?.quality || 0
  }));

  // 2. Prepare data for Machine Utilization stacked bar
  const utilizationData = machines.map(m => ({
    name: m.id,
    Running: m.metrics?.utilization?.Running || 0,
    Stopped: m.metrics?.utilization?.Stopped || 0,
    Offline: m.metrics?.utilization?.NoSignal || 0
  }));

  // 3. Prepare data for Shift-wise production comparison
  const shiftData = machines.map(m => ({
    name: m.id,
    'Shift A': m.metrics?.shifts?.A || 0,
    'Shift B': m.metrics?.shifts?.B || 0,
    'Shift C': m.metrics?.shifts?.C || 0
  }));

  // 4. Consolidate downtime reasons durations across all machines
  const reasonsAgg = {};
  PREDEFINED_REASONS.forEach(r => reasonsAgg[r] = 0);
  
  machines.forEach(m => {
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
                <Bar dataKey="Offline" stackId="u" fill="#94a3b8" name="No Signal %" radius={[0, 4, 4, 0]} />
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
