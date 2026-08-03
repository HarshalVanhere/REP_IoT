import React from 'react';
import { Cpu, Layers, Percent } from 'lucide-react';

export default function SummaryBar({ machines }) {
  const totalMachines = machines.length;
  
  // Calculate average capacity
  const capacityHours = totalMachines * 24;
  
  // Calculate connected percentage
  const connectedCount = machines.filter(m => m.status !== 'Not Connected').length;
  const connectedPercent = totalMachines > 0 ? (connectedCount / totalMachines) * 100 : 0;
  
  // Machine Utilization = Running Time / Shift Elapsed Time (raw, includes breaks) - distinct
  // from Availability, which excludes planned breaks from its denominator.
  const averageUtilization = totalMachines > 0
    ? machines.reduce((sum, m) => sum + (m.metrics?.machineUtilization || 0), 0) / totalMachines
    : 0;

  // Calculate total production pieces
  const totalProduction = machines.reduce((sum, m) => sum + (m.production_count || 0), 0);
  
  // Calculate average pieces/hour (total production over total capacity)
  const piecesPerHour = totalMachines > 0
    ? Math.round(totalProduction / totalMachines)
    : 0;

  // Calculate average plant OEE, Availability, Performance, Quality
  const avgOee = totalMachines > 0 
    ? machines.reduce((sum, m) => sum + (m.metrics?.oee || 0), 0) / totalMachines
    : 0;
  const avgAvailability = totalMachines > 0
    ? machines.reduce((sum, m) => sum + (m.metrics?.availability || 0), 0) / totalMachines
    : 0;
  const avgPerformance = totalMachines > 0
    ? machines.reduce((sum, m) => sum + (m.metrics?.performance || 0), 0) / totalMachines
    : 0;
  const avgQuality = totalMachines > 0
    ? machines.reduce((sum, m) => sum + (m.metrics?.quality || 0), 0) / totalMachines
    : 0;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-8 md:grid-cols-2 gap-6 w-full select-none">
      
      {/* Card 1: Machines And Capacity (col-span-3) */}
      <div className="lg:col-span-3 jbm-card p-6 flex flex-col justify-between jbm-card-hover min-h-[175px]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Cpu className="w-5 h-5 text-[var(--primary)]" />
            <span className="text-sm font-black uppercase tracking-wider text-[var(--primary)]">Machines And Capacity</span>
          </div>
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Realtime</span>
        </div>

        <div className="flex justify-between my-3">
          <div className="text-left">
            <div className="text-4xl font-black text-[var(--grey-900)] leading-none">{totalMachines}</div>
            <div className="text-xs font-black text-slate-400 uppercase mt-2">Active Machines</div>
          </div>
          <div className="text-right">
            <div className="text-4xl font-black text-[var(--grey-900)] leading-none">{capacityHours}h:0m</div>
            <div className="text-xs font-black text-slate-400 uppercase mt-2">Operating Hours</div>
          </div>
        </div>

        <div className="flex justify-between items-center pt-3 border-t border-[var(--grey-200)] text-xs font-bold">
          <span className="text-[var(--success)] flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-[var(--success)] animate-pulse"></span>
            {connectedPercent.toFixed(2)}% Connected
          </span>
          <span className="text-slate-500">
            {averageUtilization.toFixed(2)}% Utilization
          </span>
        </div>
      </div>

      {/* Card 2: Production (col-span-3) */}
      <div className="lg:col-span-3 jbm-card p-6 flex flex-col justify-between jbm-card-hover min-h-[175px]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Layers className="w-5 h-5 text-[var(--primary)]" />
            <span className="text-sm font-black uppercase tracking-wider text-[var(--primary)]">Production Summary</span>
          </div>
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Shift Total</span>
        </div>

        <div className="flex justify-between my-3">
          <div className="text-left">
            <div className="text-4xl font-black text-[var(--grey-900)] leading-none">{totalProduction}.00</div>
            <div className="text-xs font-black text-slate-400 uppercase mt-2">Total pieces produced</div>
          </div>
          <div className="text-right">
            <div className="text-4xl font-black text-[var(--grey-900)] leading-none">{piecesPerHour}</div>
            <div className="text-xs font-black text-slate-400 uppercase mt-2">avg pieces / hour</div>
          </div>
        </div>

        <div className="flex justify-between items-center pt-3 border-t border-[var(--grey-200)] text-xs font-bold">
          <span className="text-slate-500">Target Shift: {totalMachines * 100} pieces</span>
          <span className="text-[var(--primary)]">
            Progress: {totalMachines > 0 ? ((totalProduction / (totalMachines * 100)) * 100).toFixed(1) : 0}%
          </span>
        </div>
      </div>

      {/* Card 3: OEE (col-span-2) */}
      <div className="lg:col-span-2 jbm-card p-6 flex flex-col justify-between jbm-card-hover min-h-[175px]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Percent className="w-5 h-5 text-[var(--primary)]" />
            <span className="text-sm font-black uppercase tracking-wider text-[var(--primary)]">Plant OEE</span>
          </div>
        </div>

        <div className="flex items-center justify-between my-2">
          <div className="text-left">
            <span className="text-4xl font-black text-[var(--grey-900)] leading-none">{avgOee.toFixed(1)}</span>
            <span className="text-lg font-black text-slate-400 ml-0.5">%</span>
          </div>

          <div className="flex flex-col text-[10px] font-black gap-1">
            <div className="flex gap-4 bg-[var(--chart-blue)] text-white rounded px-2.5 py-1 justify-between w-24">
              <span>A</span>
              <span>{avgAvailability.toFixed(0)}%</span>
            </div>
            <div className="flex gap-4 bg-[var(--chart-orange)] text-white rounded px-2.5 py-1 justify-between w-24">
              <span>P</span>
              <span>{avgPerformance.toFixed(0)}%</span>
            </div>
            <div className="flex gap-4 bg-[var(--chart-green)] text-white rounded px-2.5 py-1 justify-between w-24">
              <span>Q</span>
              <span>{avgQuality.toFixed(0)}%</span>
            </div>
          </div>
        </div>

        <div className="pt-3 border-t border-[var(--grey-200)] text-[11px] font-bold text-slate-400 uppercase tracking-wider">
          OEE Status: <span className={avgOee >= 85 ? 'text-emerald-650' : avgOee >= 60 ? 'text-amber-550' : 'text-rose-550'}>
            {avgOee >= 85 ? 'World Class' : avgOee >= 60 ? 'Satisfactory' : 'Needs Improvement'}
          </span>
        </div>
      </div>

    </div>
  );
}
