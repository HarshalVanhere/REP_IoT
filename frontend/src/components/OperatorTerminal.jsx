import React, { useState, useEffect } from 'react';
import { Play, Ban, AlertTriangle, Layers, Clock, ShieldAlert, KeyRound, LogOut, User } from 'lucide-react';
import DowntimeReasonModal from './DowntimeReasonModal';

const SIMULATED_OPERATORS = [
  { id: 'OP-101', name: 'Harsh (Operator 101)' },
  { id: 'OP-102', name: 'Suresh (Operator 102)' },
  { id: 'OP-103', name: 'Rahul (Operator 103)' },
  { id: 'OP-104', name: 'Amit (Operator 104)' }
];

export default function OperatorTerminal({ 
  machines, 
  onStopMachine, 
  onResumeMachine, 
  onTriggerPulse,
  sessionUser 
}) {
  const [selectedId, setSelectedId] = useState('1302');
  const [isReasonOpen, setIsReasonOpen] = useState(false);
  const [cycleTimer, setCycleTimer] = useState(0);
  const [operatorId, setOperatorId] = useState('');
  const [showManualLogin, setShowManualLogin] = useState(false);
  const [loggedInOperator, setLoggedInOperator] = useState(() => {
    if (sessionUser?.role === 'Operator') {
      return sessionUser.displayName || sessionUser.operatorId || '';
    }
    return window.localStorage.getItem('mes-logged-operator') || '';
  });
  
  // Find active selected machine
  const machine = machines.find(m => m.id === selectedId) || machines[0] || {};
  const { id, name, status, target, production_count, last_pulse, ideal_cycle_time, metrics, active_part_name, assigned_operator } = machine;
  const { achievement = 0, lastCycleTime = 0, currentShift = 'Shift A' } = metrics || {};
  const achievementRate = target > 0 ? (production_count / target) * 100 : 0;

  useEffect(() => {
    setShowManualLogin(false);
  }, [selectedId, loggedInOperator]);

  useEffect(() => {
    if (sessionUser?.role === 'Operator') {
      const nextName = sessionUser.displayName || sessionUser.operatorId || '';
      setLoggedInOperator(nextName);
      window.localStorage.setItem('mes-logged-operator', nextName);
    }
  }, [sessionUser]);

  // Real-time stopwatch inside operator touchscreen
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
      setCycleTimer(0);
    }
    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [status, last_pulse]);

  const handleLoginSubmit = (e) => {
    e.preventDefault();
    if (!operatorId) return;
    setLoggedInOperator(operatorId);
    window.localStorage.setItem('mes-logged-operator', operatorId);
  };

  const handleLogout = () => {
    setLoggedInOperator('');
    window.localStorage.removeItem('mes-logged-operator');
  };

  const handleStartClick = () => {
    setIsReasonOpen(true);
  };

  const handleReasonSubmit = (reason) => {
    setIsReasonOpen(false);
    onResumeMachine(selectedId, reason, loggedInOperator);
  };

  const getStatusStyle = () => {
    switch (status) {
      case 'Running':
        return {
          banner: 'bg-emerald-600 border-emerald-700 text-white',
          dot: 'bg-white pulse-green',
          icon: <Play className="w-4 h-4 fill-white" />
        };
      case 'Stopped':
        return {
          banner: 'bg-rose-600 border-rose-700 text-white',
          dot: 'bg-white',
          icon: <Ban className="w-4 h-4" />
        };
      default:
        return {
          banner: 'bg-violet-600 border-violet-700 text-white',
          dot: 'bg-white pulse-purple',
          icon: <AlertTriangle className="w-4 h-4" />
        };
    }
  };

  const statusStyle = getStatusStyle();

  return (
    <div className="flex flex-col items-center py-6 font-sans select-none w-full">
      
      {/* 1. Flex Wrap Machine Selector (Renders Full Names, Never Overlaps) */}
      {loggedInOperator && (
        <div className="flex flex-wrap gap-2.5 justify-center max-w-[800px] mb-6 animate-in fade-in duration-200">
          {machines.map(m => (
            <button
              key={m.id}
              onClick={() => setSelectedId(m.id)}
              className={`px-4 py-2.5 rounded-xl text-[11px] font-black uppercase tracking-wider transition-all border shadow-sm ${
                selectedId === m.id 
                  ? 'bg-[var(--primary)] border-[var(--primary)] text-white shadow-md scale-[1.02]' 
                  : 'bg-white border-slate-200 text-slate-655 hover:bg-slate-50'
              }`}
            >
              {m.name}
            </button>
          ))}
        </div>
      )}

      {/* 2. Touchscreen 5" Box Frame Wrapper (800x480) */}
      <div className="relative border-[12px] border-slate-800 bg-slate-900 rounded-3xl shadow-2xl p-0.5 overflow-hidden w-[800px] h-[480px]">
        <div className="absolute top-1 left-1/2 -translate-x-1/2 text-[7px] text-slate-500 font-extrabold tracking-widest uppercase">
          MES Touch Screen Terminal • 5.0 INCH
        </div>

        {/* Screen container */}
        <div className="w-full h-full bg-slate-50 text-slate-800 p-4 rounded-[10px] flex flex-col justify-between overflow-hidden relative">
          
          {!loggedInOperator ? (
            // LOGIN SCREEN MODE
            (!showManualLogin && assigned_operator && assigned_operator !== 'Unassigned') ? (
              // PPC PRE-ASSIGNED LOGIN MODE
              <div className="flex-1 flex flex-col items-center justify-center p-6 text-center animate-in fade-in duration-200">
                <div className="bg-sky-50 text-sky-600 p-4 rounded-full border border-sky-100 mb-3 animate-bounce">
                  <User className="w-8 h-8" />
                </div>
                <h3 className="text-base font-black text-slate-800 uppercase tracking-wider">Workstation Pre-Planned</h3>
                
                <div className="my-3 bg-slate-100 border border-slate-200 rounded-xl p-4 w-72 space-y-1.5 text-xs text-left">
                  <div className="flex justify-between">
                    <span className="font-semibold text-slate-500 uppercase">Assigned Operator:</span>
                    <span className="font-extrabold text-slate-800 font-mono">{assigned_operator}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="font-semibold text-slate-500 uppercase">Scheduled Part:</span>
                    <span className="font-extrabold text-slate-800 font-mono">{active_part_name || 'General CNC Part'}</span>
                  </div>
                </div>

                <div className="flex flex-col gap-2 w-72">
                  <button
                    onClick={() => {
                      setLoggedInOperator(assigned_operator);
                      window.localStorage.setItem('mes-logged-operator', assigned_operator);
                    }}
                    className="w-full bg-sky-600 hover:bg-sky-750 text-white font-extrabold text-xs tracking-wider uppercase py-3.5 rounded-xl border border-sky-700 shadow-md transition-all active:scale-95"
                  >
                    Confirm & Sign On
                  </button>
                  <button
                    onClick={() => setShowManualLogin(true)}
                    className="w-full bg-slate-100 hover:bg-slate-200 text-slate-655 font-bold text-[9px] tracking-wider uppercase py-2.5 rounded-xl border border-slate-200 transition-all"
                  >
                    Sign on as Different Operator
                  </button>
                </div>
              </div>
            ) : (
              // MANUAL SELECTOR DROPDOWN LOGIN MODE
              <div className="flex-1 flex flex-col items-center justify-center p-6 text-center animate-in fade-in duration-200">
                <div className="bg-sky-50 text-sky-600 p-4 rounded-full border border-sky-100 mb-4 animate-bounce">
                  <KeyRound className="w-8 h-8" />
                </div>
                <h3 className="text-lg font-black text-slate-800 uppercase tracking-wider">MES Terminal Sign-In</h3>
                <p className="text-xs text-slate-400 mt-1 max-w-sm uppercase font-bold tracking-wider">Scan badge or select operator profile to access controls</p>
                
                <form onSubmit={handleLoginSubmit} className="mt-6 flex flex-col gap-3 w-64">
                  <select
                    value={operatorId}
                    onChange={(e) => setOperatorId(e.target.value)}
                    className="w-full bg-white border border-slate-250 hover:border-slate-350 text-slate-800 rounded-xl py-3 px-4 text-xs font-bold uppercase transition-all outline-none"
                  >
                    <option value="">Select operator Badge...</option>
                    {SIMULATED_OPERATORS.map(op => (
                      <option key={op.id} value={op.id}>{op.id} - {op.name}</option>
                    ))}
                  </select>

                  <button
                    type="submit"
                    disabled={!operatorId}
                    className="w-full bg-sky-600 hover:bg-sky-750 disabled:opacity-50 text-white font-extrabold text-xs tracking-wider uppercase py-3.5 rounded-xl border border-sky-700 shadow-md transition-all active:scale-95"
                  >
                    Login to Workstation
                  </button>
                </form>
              </div>
            )
          ) : (
            // OPERATOR TERMINAL MODE
            <>
              {/* Header Status Bar (no department) */}
              <div className={`flex justify-between items-center px-4 py-2.5 rounded-lg border shadow-sm ${statusStyle.banner}`}>
                <div className="flex items-center gap-2">
                  {statusStyle.icon}
                  <span className="font-extrabold tracking-wider uppercase text-xs truncate max-w-[400px]">{name}</span>
                </div>
                <div className="flex items-center gap-4">
                  {/* Operator badge display */}
                  <span className="flex items-center gap-1.5 text-[9px] font-bold tracking-wider bg-black/15 px-2 py-0.5 rounded border border-white/10 uppercase">
                    <User className="w-3 h-3" /> Op: {loggedInOperator || sessionUser?.displayName || 'Operator'}
                  </span>
                  
                  <div className="flex items-center gap-1.5">
                    <span className={`w-2.5 h-2.5 rounded-full ${statusStyle.dot}`}></span>
                    <span className="font-bold text-[9px] uppercase tracking-wider">{status}</span>
                  </div>

                  <button
                    onClick={handleLogout}
                    title="Sign out of terminal"
                    className="p-1 rounded bg-black/20 hover:bg-black/40 text-white transition-all ml-1.5"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Core Telemetry Stats Area */}
              <div className="grid grid-cols-12 gap-4 my-2.5 items-stretch flex-1">
                {/* Achievement Radial Progress Dial */}
                <div className="col-span-5 bg-white border border-slate-200 rounded-xl p-3 flex flex-col items-center justify-center shadow-sm">
                  <div className="relative w-36 h-36 flex items-center justify-center">
                    <svg className="w-full h-full transform -rotate-90">
                      <circle
                        cx="72"
                        cy="72"
                        r="55"
                        className="stroke-slate-100 fill-none"
                        strokeWidth="10"
                      />
                      <circle
                        cx="72"
                        cy="72"
                        r="55"
                        className="stroke-sky-600 fill-none transition-all duration-500 ease-out"
                        strokeWidth="10"
                        strokeDasharray={2 * Math.PI * 55}
                        strokeDashoffset={2 * Math.PI * 55 - (Math.min(100, achievementRate) / 100) * (2 * Math.PI * 55)}
                        strokeLinecap="round"
                      />
                    </svg>
                    <div className="absolute flex flex-col items-center justify-center">
                      <span className="text-3xl font-black text-slate-800 leading-none">{production_count}</span>
                      <span className="text-slate-400 font-bold text-[10px] tracking-wider uppercase mt-1">/ {target} units</span>
                      <span className="text-[10px] font-black text-sky-600 mt-0.5">{achievementRate.toFixed(0)}% Done</span>
                    </div>
                  </div>
                </div>

                {/* Live Cycle Timing detail rows */}
                <div className="col-span-7 grid grid-rows-3 gap-3 text-left">
                  
                  {/* Row 1: Active Cycle Timer */}
                  <div className="bg-white border border-slate-200 rounded-xl px-4 py-2.5 flex items-center justify-between shadow-sm">
                    <div>
                      <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block">Active Cycle stopwatch</span>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <Clock className="w-4 h-4 text-sky-600 animate-pulse" />
                        <span className="text-2xl font-black font-mono text-slate-800 leading-none">
                          {status === 'Running' ? `${cycleTimer.toFixed(1)}s` : '0.0s'}
                        </span>
                      </div>
                    </div>
                    <div className="text-right">
                      <span className="text-[8px] font-bold text-slate-400 uppercase tracking-widest block">Ideal Cycle</span>
                      <span className="text-xs font-extrabold text-slate-700 font-mono mt-0.5 block">{ideal_cycle_time}s</span>
                    </div>
                  </div>

                  {/* Row 2: Last Cycle Duration */}
                  <div className="bg-white border border-slate-200 rounded-xl px-4 py-2.5 flex items-center justify-between shadow-sm">
                    <div>
                      <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block">Last Cycle Duration</span>
                      <span className="text-xl font-bold font-mono text-slate-800 mt-0.5 block">
                        {lastCycleTime > 0 ? `${lastCycleTime.toFixed(2)}s` : '--'}
                      </span>
                    </div>
                    <div className="text-right">
                      <span className="text-[8px] font-bold text-slate-400 uppercase tracking-widest block">Performance</span>
                      <span className={`text-xs font-bold font-mono mt-0.5 block ${lastCycleTime > 0 && lastCycleTime <= ideal_cycle_time ? 'text-emerald-600' : 'text-amber-500'}`}>
                        {lastCycleTime > 0 ? `${(ideal_cycle_time / lastCycleTime * 100).toFixed(0)}%` : '--'}
                      </span>
                    </div>
                  </div>

                  {/* Row 3: Active Shift Name */}
                  <div className="bg-white border border-slate-200 rounded-xl px-4 py-2.5 flex items-center justify-between shadow-sm">
                    <div>
                      <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block">Current Shift Duty</span>
                      <span className="text-base font-extrabold text-slate-800 uppercase tracking-wider mt-0.5 block">
                        {currentShift}
                      </span>
                    </div>
                    <div className="text-right bg-slate-50 border border-slate-200 px-2.5 py-0.5 rounded-lg">
                      <span className="text-[8px] font-bold text-slate-450 uppercase tracking-widest block">Active Ops</span>
                      <span className="text-[10px] font-black text-slate-700 block uppercase font-mono">Terminal {id}</span>
                    </div>
                  </div>

                </div>
              </div>

              {/* Touch Control Buttons */}
              <div className="flex gap-4 pt-1 pb-1">
                {status === 'Running' ? (
                  <button
                    onClick={() => onStopMachine(selectedId)}
                    className="flex-1 bg-rose-600 hover:bg-rose-700 text-white font-extrabold text-xs tracking-wider uppercase py-3.5 rounded-xl border border-rose-700 shadow-md flex items-center justify-center gap-2 transition-all active:scale-95"
                  >
                    <ShieldAlert className="w-5 h-5" /> EMERGENCY STOP (HALT)
                  </button>
                ) : (
                  <button
                    onClick={handleStartClick}
                    disabled={status === 'No Signal'}
                    className="flex-1 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-extrabold text-xs tracking-wider uppercase py-3.5 rounded-xl border border-emerald-700 shadow-md flex items-center justify-center gap-2 transition-all active:scale-95"
                  >
                    <Play className="w-5 h-5 fill-white" /> RESUME PRODUCTION
                  </button>
                )}

                <button
                  onClick={() => onTriggerPulse(selectedId)}
                  disabled={status !== 'Running'}
                  className="flex-1 bg-sky-600 hover:bg-sky-750 disabled:opacity-40 disabled:bg-slate-300 disabled:border-slate-200 disabled:text-slate-400 text-white font-extrabold text-xs tracking-wider uppercase py-3.5 rounded-xl border border-sky-700 shadow-md flex items-center justify-center gap-2 transition-all active:scale-95"
                >
                  <Layers className="w-5 h-5" /> Cycle Complete Pulse
                </button>
              </div>
            </>
          )}

        </div>
      </div>

      {/* Mandatory Downtime Reason Input Popup */}
      <DowntimeReasonModal
        isOpen={isReasonOpen}
        onClose={() => setIsReasonOpen(false)}
        onSubmit={handleReasonSubmit}
        machineId={selectedId}
      />

    </div>
  );
}
