import React, { useState, useEffect } from 'react';
import { Play, Ban, AlertTriangle, Clock, ShieldAlert, KeyRound, LogOut, User } from 'lucide-react';
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
  sessionUser 
}) {
  const selectedId = '1313'; // Station-locked for this machine's screen
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
  const machine = machines.find(m => m.id === selectedId) || {};
  const { name = '1313 ACE CNC SUPER JOBBER', status = 'No Signal', target = 500, production_count = 0, last_pulse, ideal_cycle_time = 12, metrics } = machine;
  const { lastCycleTime = 0, currentShift = 'Shift A' } = metrics || {};
  const achievementRate = target > 0 ? (production_count / target) * 100 : 0;

  useEffect(() => {
    setShowManualLogin(false);
  }, [loggedInOperator]);

  useEffect(() => {
    if (sessionUser?.role === 'Operator') {
      const nextName = sessionUser.displayName || sessionUser.operatorId || '';
      setLoggedInOperator(nextName);
      window.localStorage.setItem('mes-logged-operator', nextName);
    }
  }, [sessionUser]);

  // Real-time stopwatch
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
          banner: 'bg-emerald-950/80 border border-emerald-800/80 text-emerald-300',
          dot: 'bg-emerald-400 animate-pulse',
          icon: <Play className="w-6 h-6 fill-emerald-400 text-emerald-400" />
        };
      case 'Stopped':
        return {
          banner: 'bg-rose-955/80 border border-rose-800/80 text-rose-350',
          dot: 'bg-rose-500',
          icon: <Ban className="w-6 h-6 text-rose-500" />
        };
      default:
        return {
          banner: 'bg-violet-955/80 border border-violet-800/80 text-violet-300',
          dot: 'bg-violet-500 animate-ping',
          icon: <AlertTriangle className="w-6 h-6 text-violet-400" />
        };
    }
  };

  const statusStyle = getStatusStyle();

  return (
    <div className="w-screen h-screen bg-slate-950 flex flex-col justify-between p-6 text-slate-100 font-sans select-none m-0 border-none">
      
      {!loggedInOperator ? (
        // LOGIN SCREEN MODE
        (!showManualLogin && assigned_operator && assigned_operator !== 'Unassigned') ? (
          // PPC PRE-ASSIGNED LOGIN MODE
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center animate-in fade-in duration-300">
            <div className="bg-sky-955 text-sky-400 p-6 rounded-full border border-sky-900 mb-6">
              <User className="w-12 h-12" />
            </div>
            <h3 className="text-2xl font-black text-slate-200 uppercase tracking-widest">Workstation Pre-Planned</h3>
            <p className="text-sm text-slate-400 mt-1.5 uppercase font-bold tracking-wider">Shift details are pre-assigned by PPC planning</p>
            
            <div className="my-6 bg-slate-900 border border-slate-800 rounded-3xl p-6 w-96 space-y-3.5 text-sm text-left">
              <div className="flex justify-between items-center">
                <span className="font-semibold text-slate-400 uppercase">Assigned Operator:</span>
                <span className="font-extrabold text-sky-400 font-mono text-base">{assigned_operator}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="font-semibold text-slate-400 uppercase">Scheduled Part:</span>
                <span className="font-extrabold text-slate-200 font-mono text-base">{active_part_name || 'General CNC Part'}</span>
              </div>
            </div>

            <div className="flex flex-col gap-3 w-96">
              <button
                onClick={() => {
                  setLoggedInOperator(assigned_operator);
                  window.localStorage.setItem('mes-logged-operator', assigned_operator);
                }}
                className="w-full bg-sky-600 hover:bg-sky-505 text-white font-extrabold text-sm tracking-wider uppercase py-4.5 rounded-2xl border border-sky-700 shadow-md transition-all active:scale-95 cursor-pointer"
              >
                Confirm & Sign On
              </button>
              <button
                onClick={() => setShowManualLogin(true)}
                className="w-full bg-slate-900 hover:bg-slate-800 text-slate-300 font-bold text-xs tracking-wider uppercase py-3.5 rounded-2xl border border-slate-800 transition-all cursor-pointer"
              >
                Sign on as Different Operator
              </button>
            </div>
          </div>
        ) : (
          // MANUAL SELECTOR DROPDOWN LOGIN MODE
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center animate-in fade-in duration-300">
            <div className="bg-sky-955 text-sky-400 p-6 rounded-full border border-sky-900 mb-6">
              <KeyRound className="w-12 h-12" />
            </div>
            <h3 className="text-2xl font-black text-slate-200 uppercase tracking-widest">MES Terminal Sign-In</h3>
            <p className="text-sm text-slate-400 mt-1.5 max-w-sm uppercase font-bold tracking-wider">Select operator profile to unlock workstation controls</p>
            
            <form onSubmit={handleLoginSubmit} className="mt-8 flex flex-col gap-4 w-80">
              <select
                value={operatorId}
                onChange={(e) => setOperatorId(e.target.value)}
                className="w-full bg-slate-900 border border-slate-800 hover:border-slate-700 text-slate-200 rounded-2xl py-4 px-5 text-sm font-bold uppercase transition-all outline-none"
              >
                <option value="">Select operator Badge...</option>
                {SIMULATED_OPERATORS.map(op => (
                  <option key={op.id} value={op.id}>{op.id} - {op.name}</option>
                ))}
              </select>

              <button
                type="submit"
                disabled={!operatorId}
                className="w-full bg-sky-600 hover:bg-sky-505 disabled:opacity-50 text-white font-extrabold text-sm tracking-wider uppercase py-4.5 rounded-2xl border border-sky-700 shadow-md transition-all active:scale-95 cursor-pointer"
              >
                Login to Workstation
              </button>
            </form>
          </div>
        )
      ) : (
        // OPERATOR TERMINAL MODE
        <>
          {/* Header Status Bar */}
          <div className={`flex justify-between items-center px-6 py-4.5 rounded-3xl border shadow-md ${statusStyle.banner}`}>
            <div className="flex items-center gap-4">
              {statusStyle.icon}
              <span className="font-black tracking-widest uppercase text-base truncate max-w-[600px]">{name}</span>
            </div>
            <div className="flex items-center gap-5">
              <span className="flex items-center gap-2 text-xs font-black tracking-widest bg-black/40 px-4 py-1.5 rounded-xl border border-white/5 uppercase">
                <User className="w-4 h-4 text-sky-400" /> Op: {loggedInOperator || sessionUser?.displayName || 'Operator'}
              </span>
              
              <div className="flex items-center gap-2.5">
                <span className={`w-3.5 h-3.5 rounded-full ${statusStyle.dot}`}></span>
                <span className="font-black text-xs uppercase tracking-widest">{status}</span>
              </div>

              <button
                onClick={handleLogout}
                title="Sign out of terminal"
                className="p-2 rounded-xl bg-black/50 hover:bg-black/70 text-white transition-all ml-1 cursor-pointer"
              >
                <LogOut className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Core Telemetry Stats Area */}
          <div className="grid grid-cols-12 gap-6 my-6 items-stretch flex-1">
            
            {/* Achievement Radial Progress Dial */}
            <div className="col-span-5 bg-slate-900 border border-slate-800 rounded-3xl p-6 flex flex-col items-center justify-center shadow-lg">
              <div className="relative w-52 h-52 flex items-center justify-center">
                <svg className="w-full h-full transform -rotate-90">
                  <circle
                    cx="104"
                    cy="104"
                    r="80"
                    className="stroke-slate-800 fill-none"
                    strokeWidth="14"
                  />
                  <circle
                    cx="104"
                    cy="104"
                    r="80"
                    className="stroke-sky-500 fill-none transition-all duration-500 ease-out"
                    strokeWidth="14"
                    strokeDasharray={2 * Math.PI * 80}
                    strokeDashoffset={2 * Math.PI * 80 - (Math.min(100, achievementRate) / 100) * (2 * Math.PI * 80)}
                    strokeLinecap="round"
                  />
                </svg>
                <div className="absolute flex flex-col items-center justify-center">
                  <span className="text-5xl font-black text-slate-100 leading-none font-mono">{production_count}</span>
                  <span className="text-slate-400 font-bold text-xs tracking-widest uppercase mt-2.5">/ {target} units</span>
                  <span className="text-xs font-black text-sky-400 mt-1.5">{achievementRate.toFixed(0)}% Done</span>
                </div>
              </div>
            </div>

            {/* Live Cycle Timing detail rows */}
            <div className="col-span-7 grid grid-rows-3 gap-4.5 text-left">
              
              {/* Row 1: Active Cycle Timer */}
              <div className="bg-slate-900 border border-slate-800 rounded-3xl px-6 py-4.5 flex items-center justify-between shadow-lg">
                <div>
                  <span className="text-xs font-black text-slate-400 uppercase tracking-widest block">Active Cycle stopwatch</span>
                  <div className="flex items-center gap-2.5 mt-1.5">
                    <Clock className="w-6 h-6 text-sky-400 animate-pulse" />
                    <span className="text-4xl font-black font-mono text-slate-100 leading-none">
                      {status === 'Running' ? `${cycleTimer.toFixed(1)}s` : '0.0s'}
                    </span>
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-xs font-black text-slate-400 uppercase tracking-widest block">Ideal Cycle</span>
                  <span className="text-base font-black text-slate-350 font-mono mt-1.5 block">{ideal_cycle_time}s</span>
                </div>
              </div>

              {/* Row 2: Last Cycle Duration */}
              <div className="bg-slate-900 border border-slate-800 rounded-3xl px-6 py-4.5 flex items-center justify-between shadow-lg">
                <div>
                  <span className="text-xs font-black text-slate-400 uppercase tracking-widest block">Last Cycle Duration</span>
                  <span className="text-3xl font-black font-mono text-slate-100 mt-1.5 block">
                    {lastCycleTime > 0 ? `${lastCycleTime.toFixed(2)}s` : '--'}
                  </span>
                </div>
                <div className="text-right">
                  <span className="text-xs font-black text-slate-400 uppercase tracking-widest block">Performance</span>
                  <span className={`text-base font-black font-mono mt-1.5 block ${lastCycleTime > 0 && lastCycleTime <= ideal_cycle_time ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {lastCycleTime > 0 ? `${(ideal_cycle_time / lastCycleTime * 100).toFixed(0)}%` : '--'}
                  </span>
                </div>
              </div>

              {/* Row 3: Active Shift Name */}
              <div className="bg-slate-900 border border-slate-800 rounded-3xl px-6 py-4.5 flex items-center justify-between shadow-lg">
                <div>
                  <span className="text-xs font-black text-slate-400 uppercase tracking-widest block">Current Shift Duty</span>
                  <span className="text-xl font-black text-slate-200 uppercase tracking-widest mt-1.5 block">
                    {currentShift}
                  </span>
                </div>
                <div className="text-right bg-slate-950 border border-slate-850 px-4 py-1.5 rounded-2xl">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block">Workstation</span>
                  <span className="text-xs font-black text-slate-200 block uppercase font-mono">{selectedId}</span>
                </div>
              </div>

            </div>
          </div>

          {/* Touch Control Buttons */}
          <div className="flex gap-4 pt-1 w-full">
            {status === 'Running' ? (
              <button
                onClick={() => onStopMachine(selectedId)}
                className="w-full bg-rose-600 hover:bg-rose-700 text-white font-black text-sm tracking-widest uppercase py-5 rounded-3xl border border-rose-700 shadow-xl flex items-center justify-center gap-3 transition-all active:scale-98 cursor-pointer animate-in fade-in"
              >
                <ShieldAlert className="w-6 h-6" /> EMERGENCY STOP (HALT)
              </button>
            ) : (
              <button
                onClick={handleStartClick}
                disabled={status === 'No Signal'}
                className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-black text-sm tracking-widest uppercase py-5 rounded-3xl border border-emerald-700 shadow-lg flex items-center justify-center gap-3 transition-all active:scale-98 cursor-pointer animate-in fade-in"
              >
                <Play className="w-6 h-6 fill-white" /> RESUME PRODUCTION
              </button>
            )}
          </div>
        </>
      )}

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
