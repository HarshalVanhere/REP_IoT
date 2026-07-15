import React, { useState, useEffect } from 'react';
import { AreaChart, Area, ResponsiveContainer } from 'recharts';
import { Play, Ban, AlertTriangle, Clock, Target } from 'lucide-react';

export default function MachineCard({ machine, history = [] }) {
  const { id, name, status, target, production_count, good_count, scrap_count, ideal_cycle_time, last_pulse, metrics, active_part_name, assigned_operator } = machine;
  const { availability = 100, performance = 0, quality = 100, oee = 0, downtimeSeconds = 0 } = metrics || {};

  const [cycleTimer, setCycleTimer] = useState(0);

  // Real-time cycle stopwatch
  useEffect(() => {
    let intervalId;
    
    if (status === 'Running') {
      const baseTime = last_pulse ? new Date(last_pulse).getTime() : Date.now();
      
      const updateTimer = () => {
        const elapsed = (Date.now() - baseTime) / 1000;
        setCycleTimer(Math.max(0, elapsed));
      };

      updateTimer();
      intervalId = setInterval(updateTimer, 100);
    } else {
      if (intervalId) clearInterval(intervalId);
    }

    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [status, last_pulse]);

  useEffect(() => {
    if (status !== 'Running') {
      setCycleTimer(0);
    }
  }, [status]);

  const formatDuration = (totalSeconds) => {
    const hrs = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = Math.floor(totalSeconds % 60);
    
    if (hrs > 0) {
      return `${hrs}h ${mins}m ${secs}s`;
    }
    if (mins > 0) {
      return `${mins}m ${secs}s`;
    }
    return `${secs}s`;
  };

  const getStatusConfig = () => {
    switch (status) {
      case 'Running':
        return {
          border: 'border-emerald-250 hover:border-emerald-450',
          badge: 'bg-emerald-50 text-emerald-700 border-emerald-100',
          dot: 'bg-emerald-500 pulse-green',
          icon: <Play className="w-4 h-4 fill-emerald-600 animate-pulse" />,
          color: 'text-emerald-600'
        };
      case 'Stopped':
        return {
          border: 'border-rose-250 hover:border-rose-450',
          badge: 'bg-rose-50 text-rose-700 border-rose-100',
          dot: 'bg-rose-500',
          icon: <Ban className="w-4 h-4" />,
          color: 'text-rose-600'
        };
      default:
        return {
          border: 'border-violet-250 hover:border-violet-450',
          badge: 'bg-violet-50 text-violet-700 border-violet-100',
          dot: 'bg-violet-500 pulse-purple',
          icon: <AlertTriangle className="w-4 h-4" />,
          color: 'text-violet-650'
        };
    }
  };

  const statusConfig = getStatusConfig();
  const achievementRate = target > 0 ? (production_count / target) * 100 : 0;
  
  const formatLastPulse = () => {
    if (!last_pulse) return 'NO PULSE TODAY';
    return new Date(last_pulse).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  };

  const radius = 35;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (oee / 100) * circumference;

  const getOeeColor = () => {
    if (oee >= 85) return 'stroke-emerald-600';  
    if (oee >= 65) return 'stroke-sky-600';      
    return 'stroke-amber-500';                   
  };

  return (
    <div className={`glass-card rounded-2xl p-6 border ${statusConfig.border} bg-white shadow-sm hover:shadow-md transition-all duration-300 flex flex-col justify-between min-h-[480px]`}>
      
      {/* 1. Header: Machine Name & Status */}
      <div className="flex justify-between items-start mb-3">
        <div className="text-left">
          <h3 className="text-lg font-black text-slate-800 tracking-wide font-sans leading-snug">{name}</h3>
          <span className="text-xs font-black text-slate-400 tracking-wider font-mono">ID: {id}</span>
        </div>
        <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-black uppercase tracking-wider shrink-0 ${statusConfig.badge}`}>
          <span className={`w-2.5 h-2.5 rounded-full ${statusConfig.dot}`}></span>
          {status}
        </div>
      </div>

      {/* 1.5 Active Part & Operator Info */}
      <div className="flex justify-between text-xs bg-slate-50 border border-slate-200/50 rounded-xl px-3 py-2.5 mb-4 text-slate-600 font-extrabold uppercase tracking-wider text-left">
        <span className="truncate max-w-[170px]">Part: {active_part_name || 'Unassigned'}</span>
        <span className="shrink-0 font-mono text-slate-400">Op: {assigned_operator || 'None'}</span>
      </div>

      {/* 2. Top Half: Gauges and Cycle stopwatch */}
      <div className="grid grid-cols-12 gap-3 items-center mb-4">
        {/* Left Side: Radial OEE Gauge */}
        <div className="col-span-5 flex flex-col items-center justify-center">
          <div className="relative w-24 h-24 flex items-center justify-center">
            <svg className="w-full h-full transform -rotate-90">
              <circle
                cx="48"
                cy="48"
                r={radius}
                className="stroke-slate-100 fill-none"
                strokeWidth="7.5"
              />
              <circle
                cx="48"
                cy="48"
                r={radius}
                className={`${getOeeColor()} fill-none transition-all duration-500 ease-out`}
                strokeWidth="7.5"
                strokeDasharray={circumference}
                strokeDashoffset={strokeDashoffset}
                strokeLinecap="round"
              />
            </svg>
            <div className="absolute flex flex-col items-center justify-center">
              <span className="text-2xl font-black text-slate-800 font-sans">{oee.toFixed(0)}%</span>
              <span className="text-[10px] font-black tracking-widest text-slate-400 uppercase">OEE</span>
            </div>
          </div>
        </div>

        {/* Right Side: Stopwatch and production counts */}
        <div className="col-span-7 pl-3 flex flex-col justify-center space-y-3 text-left">
          {/* Cycle Time Timer */}
          <div>
            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Active Cycle Time</span>
            <div className="flex items-center gap-1.5 mt-0.5">
              <Clock className="w-5 h-5 text-sky-600" />
              <span className="text-3xl font-black font-mono text-slate-800 leading-none">
                {status === 'Running' ? `${cycleTimer.toFixed(1)}s` : '--'}
              </span>
              <span className="text-[11px] font-bold text-slate-400 self-end mb-0.5 font-mono">
                (ideal: {ideal_cycle_time}s)
              </span>
            </div>
          </div>

          {/* Today's Stats summary */}
          <div className="grid grid-cols-2 gap-2.5 pt-1.5 border-t border-slate-100">
            <div>
              <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest block">Downtime</span>
              <span className="text-sm font-black text-rose-600 font-mono mt-0.5 block">
                {formatDuration(downtimeSeconds)}
              </span>
            </div>
            <div>
              <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest block">Last Pulse</span>
              <span className="text-sm font-black text-slate-600 font-mono mt-0.5 block">
                {formatLastPulse()}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* 3. Middle Section: Production Count & Target Progress */}
      <div className="space-y-2 mb-4 bg-slate-50 p-3 rounded-xl border border-slate-200/60">
        <div className="flex justify-between items-center text-sm">
          <div className="flex items-center gap-1 text-slate-700">
            <Target className="w-4 h-4 text-sky-600 animate-pulse" />
            <span className="font-extrabold text-[11px] uppercase tracking-wider">Prod. Count</span>
          </div>
          <div className="text-right">
            <span className="font-black text-slate-800 font-mono text-[13px]">{production_count}</span>
            <span className="text-slate-400 font-mono text-xs"> / {target}</span>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="w-full bg-slate-200 h-3 rounded-full overflow-hidden relative">
          <div 
            className={`h-full rounded-full transition-all duration-500 ${achievementRate >= 100 ? 'bg-emerald-600' : 'bg-sky-500'}`}
            style={{ width: `${Math.min(100, achievementRate)}%` }}
          ></div>
        </div>

        <div className="flex justify-between items-center text-xs font-bold">
          <span className="text-slate-400 tracking-wider">ACHIEVEMENT RATE</span>
          <span className={`${achievementRate >= 100 ? 'text-emerald-600' : 'text-sky-600'} font-black font-mono`}>
            {achievementRate.toFixed(1)}%
          </span>
        </div>
      </div>

      {/* 4. Telemetry meters: A | P | Q breakdown */}
      <div className="grid grid-cols-3 gap-3 mb-4 text-center">
        {/* Availability */}
        <div className="bg-slate-50 p-2 rounded-lg border border-slate-200/50">
          <span className="text-[10px] font-black text-slate-400 tracking-wider block">AVAILABILITY</span>
          <span className="text-sm font-black text-slate-750 mt-1 block">{availability.toFixed(1)}%</span>
          <div className="w-full bg-slate-200 h-2 rounded-full mt-2 overflow-hidden">
            <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${availability}%` }}></div>
          </div>
        </div>

        {/* Performance */}
        <div className="bg-slate-50 p-2 rounded-lg border border-slate-200/50">
          <span className="text-[10px] font-black text-slate-400 tracking-wider block">PERFORMANCE</span>
          <span className="text-sm font-black text-slate-750 mt-1 block">{performance.toFixed(1)}%</span>
          <div className="w-full bg-slate-200 h-2 rounded-full mt-2 overflow-hidden">
            <div className="h-full bg-sky-500 rounded-full" style={{ width: `${performance}%` }}></div>
          </div>
        </div>

        {/* Quality */}
        <div className="bg-slate-50 p-2 rounded-lg border border-slate-200/50">
          <span className="text-[10px] font-black text-slate-400 tracking-wider block">QUALITY</span>
          <span className="text-sm font-black text-slate-750 mt-1 block">{quality.toFixed(1)}%</span>
          <div className="w-full bg-slate-200 h-2 rounded-full mt-2 overflow-hidden">
            <div className="h-full bg-emerald-600 rounded-full" style={{ width: `${quality}%` }}></div>
          </div>
        </div>
      </div>

      {/* 5. Bottom Section: Mini Pulse History Sparkline */}
      <div className="h-10 mt-auto border-t border-slate-100 pt-2.5 flex flex-col justify-end">
        {history.length > 0 ? (
          <div className="w-full h-8 relative">
            <div className="absolute top-0 left-0 text-[10px] font-black text-slate-400 tracking-wider">CYCLE SPARKLINE</div>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={history} margin={{ top: 5, bottom: 0, left: 0, right: 0 }}>
                <defs>
                  <linearGradient id={`grad-${id}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={status === 'Running' ? '#0ea5e9' : '#94a3b8'} stopOpacity={0.15}/>
                    <stop offset="95%" stopColor={status === 'Running' ? '#0ea5e9' : '#94a3b8'} stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <Area 
                  type="monotone" 
                  dataKey="cycle_time" 
                  stroke={status === 'Running' ? '#0284c7' : '#94a3b8'} 
                  strokeWidth={1.5}
                  fillOpacity={1} 
                  fill={`url(#grad-${id})`}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="text-center text-[10px] font-bold text-slate-400 tracking-wider uppercase mb-1">
            Waiting for machine cycles...
          </div>
        )}
      </div>

    </div>
  );
}
