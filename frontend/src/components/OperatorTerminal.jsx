import React, { useState, useEffect } from 'react';
import { Play, Ban, AlertTriangle, Clock, LogOut, User, Calendar } from 'lucide-react';
import DowntimeReasonModal from './DowntimeReasonModal';
import jbmLogo from '../assets/jbmlogo (1).png';
import roseLogo from '../assets/rose logo (1).png';

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
  sessionUser,
  reasonCodes = []
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

  const [loginTime, setLoginTime] = useState(() => {
    const saved = window.localStorage.getItem('mes-login-time');
    return saved ? parseInt(saved, 10) : null;
  });

  const [dutyTimeStr, setDutyTimeStr] = useState('00h 00m');

  useEffect(() => {
    if (loggedInOperator) {
      if (!loginTime) {
        const now = Date.now();
        setLoginTime(now);
        window.localStorage.setItem('mes-login-time', now.toString());
      }
    } else {
      setLoginTime(null);
      window.localStorage.removeItem('mes-login-time');
    }
  }, [loggedInOperator, loginTime]);

  useEffect(() => {
    if (!loginTime) {
      setDutyTimeStr('00h 00m');
      return;
    }
    const updateDutyTime = () => {
      const diffMs = Date.now() - loginTime;
      const totalSecs = Math.floor(diffMs / 1000);
      const hours = Math.floor(totalSecs / 3600);
      const mins = Math.floor((totalSecs % 3600) / 60);
      setDutyTimeStr(`${hours.toString().padStart(2, '0')}h ${mins.toString().padStart(2, '0')}m`);
    };
    updateDutyTime();
    const interval = setInterval(updateDutyTime, 10000); // update every 10 seconds
    return () => clearInterval(interval);
  }, [loginTime]);

  // Find active selected machine
  const machine = machines.find(m => m.id === selectedId) || {};
  const { name = '1313 ACE CNC SUPER JOBBER', status = 'No Signal', target = 500, production_count = 0, last_pulse, ideal_cycle_time = 12, metrics, assigned_operator, active_part_name } = machine;
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

  const statusTheme =
    status === 'Running'
      ? { grad: 'from-emerald-950/70', border: 'border-emerald-900/50', text: 'text-emerald-300', solid: 'from-emerald-500 to-emerald-700', glow: 'shadow-emerald-900/60' }
      : status === 'Stopped'
      ? { grad: 'from-rose-950/70', border: 'border-rose-900/50', text: 'text-rose-300', solid: 'from-rose-500 to-rose-700', glow: 'shadow-rose-900/60' }
      : { grad: 'from-violet-950/70', border: 'border-violet-900/50', text: 'text-violet-300', solid: 'from-violet-500 to-violet-700', glow: 'shadow-violet-900/60' };

  return (
    <div className="w-screen h-screen bg-slate-950 flex flex-col justify-between p-4 text-slate-100 font-sans select-none m-0 border-none overflow-hidden relative">

      {/* Ambient decorative glow blobs */}
      <div className="absolute top-[-20%] left-[-10%] w-[55%] h-[55%] rounded-full bg-sky-600 opacity-[0.07] blur-3xl pointer-events-none" />
      <div className="absolute bottom-[-25%] right-[-10%] w-[55%] h-[55%] rounded-full bg-violet-600 opacity-[0.07] blur-3xl pointer-events-none" />

      {!loggedInOperator && (
        <div className="w-full flex items-center justify-between px-4 py-2 border-b-2 border-slate-800 bg-slate-950 shrink-0 mb-2 relative z-10">
          <div className="flex items-center gap-3 bg-white px-3.5 py-1.5 rounded-2xl border border-slate-200 shadow-lg shrink-0">
            <img
              src={jbmLogo}
              alt="JBM Logo"
              style={{ height: '40px', width: 'auto', display: 'block', objectFit: 'contain' }}
            />
            <img
              src={roseLogo}
              alt="Rose Logo"
              style={{ height: '40px', width: 'auto', display: 'block', objectFit: 'contain', marginLeft: '8px' }}
            />
          </div>
          <span className="text-lg font-black uppercase tracking-[0.2em] text-sky-400 font-mono">MES KIOSK</span>
        </div>
      )}

      {!loggedInOperator ? (
        // LOGIN SCREEN MODE
        (!showManualLogin && assigned_operator && assigned_operator !== 'Unassigned') ? (
          // PPC PRE-ASSIGNED LOGIN MODE
          <div className="flex-1 flex flex-col items-center justify-center p-4 text-center animate-in fade-in duration-300 relative z-10 min-h-0">
            <h3 className="text-3xl font-black text-slate-100 uppercase tracking-wide whitespace-nowrap">Workstation Pre-Planned</h3>
            <p className="text-sm text-slate-400 mt-1.5 uppercase font-bold tracking-wide">Shift details are pre-assigned by PPC planning</p>

            <div className="my-4 bg-gradient-to-b from-slate-900 to-slate-950 border-2 border-slate-800 rounded-3xl p-5 w-full max-w-xl space-y-3 text-left shadow-2xl shadow-black/40">
              <div className="flex justify-between items-center gap-4">
                <span className="font-bold text-slate-400 uppercase text-sm">Assigned Operator:</span>
                <span className="font-extrabold text-sky-400 font-mono text-lg">{assigned_operator}</span>
              </div>
              <div className="w-full h-px bg-slate-800" />
              <div className="flex justify-between items-center gap-4">
                <span className="font-bold text-slate-400 uppercase text-sm">Scheduled Part:</span>
                <span className="font-extrabold text-slate-200 font-mono text-lg">{active_part_name || 'General CNC Part'}</span>
              </div>
            </div>

            <div className="flex flex-col gap-2.5 w-full max-w-xl">
              <button
                onClick={() => {
                  setLoggedInOperator(assigned_operator);
                  window.localStorage.setItem('mes-logged-operator', assigned_operator);
                }}
                className="w-full bg-gradient-to-r from-sky-500 to-sky-600 hover:from-sky-400 hover:to-sky-500 text-white font-extrabold text-lg tracking-wide uppercase py-4 rounded-2xl border-2 border-sky-400/40 shadow-2xl shadow-sky-950/60 transition-all active:scale-95 cursor-pointer"
              >
                Confirm & Sign On
              </button>
              <button
                onClick={() => setShowManualLogin(true)}
                className="w-full bg-slate-900 hover:bg-slate-800 text-slate-300 font-bold text-sm tracking-wide uppercase py-3 rounded-2xl border-2 border-slate-800 transition-all cursor-pointer"
              >
                Sign on as Different Operator
              </button>
            </div>
          </div>
        ) : (
          // MANUAL SELECTOR DROPDOWN LOGIN MODE
          <div className="flex-1 flex flex-col items-center justify-center p-4 text-center animate-in fade-in duration-300 relative z-10">
            <h3 className="text-4xl font-black text-slate-100 uppercase tracking-wide">MES Terminal Sign-In</h3>
            <p className="text-lg text-slate-400 mt-2 max-w-2xl uppercase font-bold tracking-wide">Select operator profile to unlock workstation controls</p>

            <form onSubmit={handleLoginSubmit} className="mt-8 flex flex-col gap-4 w-full max-w-xl">
              <select
                value={operatorId}
                onChange={(e) => setOperatorId(e.target.value)}
                className="w-full bg-slate-900 border-2 border-slate-800 hover:border-slate-700 text-slate-100 rounded-2xl py-5 px-5 text-xl font-bold uppercase transition-all outline-none"
              >
                <option value="">Select operator badge...</option>
                {SIMULATED_OPERATORS.map(op => (
                  <option key={op.id} value={op.id}>{op.id} - {op.name}</option>
                ))}
              </select>

              <button
                type="submit"
                disabled={!operatorId}
                className="w-full bg-gradient-to-r from-sky-500 to-sky-600 hover:from-sky-400 hover:to-sky-500 disabled:opacity-50 text-white font-extrabold text-xl tracking-wide uppercase py-6 rounded-3xl border-2 border-sky-400/40 shadow-2xl shadow-sky-950/60 transition-all active:scale-95 cursor-pointer"
              >
                Login to Workstation
              </button>
            </form>
          </div>
        )
      ) : (
        // OPERATOR TERMINAL MODE
        <>
          {/* Header Row 1: Logos + Operator/Status/Logout */}
          <div className="flex justify-between items-center w-full gap-2 shrink-0 relative z-10">
            <div className="bg-white pl-3 pr-3.5 py-2 rounded-2xl shadow-xl flex items-center gap-2.5 shrink-0">
              <img src={jbmLogo} alt="JBM Logo" className="h-9 w-auto object-contain" />
              <div className="w-px h-7 bg-slate-200" />
              <img src={roseLogo} alt="Rose Logo" className="h-9 w-auto object-contain" />
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {/* Operator Badge */}
              <div className="border-2 border-slate-700 bg-gradient-to-br from-slate-800 to-slate-900 rounded-xl px-3 py-2 flex items-center gap-1.5 text-sm font-black uppercase text-slate-100 tracking-wide shadow-lg">
                <User className="w-5 h-5 text-sky-400 shrink-0" />
                <span className="whitespace-nowrap">{loggedInOperator || 'OP-101'}</span>
              </div>

              {/* Status Badge */}
              <div className={`border-2 rounded-xl px-3 py-2 flex items-center gap-1.5 text-sm font-black uppercase tracking-wide shrink-0 shadow-lg bg-gradient-to-br ${statusTheme.grad} to-slate-900 ${statusTheme.border} ${statusTheme.text}`}>
                <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${status === 'Running' ? 'bg-emerald-400 animate-pulse' : status === 'Stopped' ? 'bg-rose-500' : 'bg-violet-500 animate-pulse'}`}></span>
                <span>{status === 'Running' ? 'RUNNING' : status === 'Stopped' ? 'STOPPED' : 'NO SIGNAL'}</span>
              </div>

              {/* Signout Button */}
              <button
                onClick={handleLogout}
                title="Sign out of terminal"
                className="w-10 h-10 flex items-center justify-center rounded-xl bg-gradient-to-br from-slate-800 to-slate-900 border-2 border-slate-700 text-slate-300 hover:text-white transition-all active:scale-90 cursor-pointer shrink-0 shadow-lg"
              >
                <LogOut className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Header Row 2: Machine Name */}
          <div className="w-full pt-2 pb-1 shrink-0 flex items-center gap-2.5 relative z-10">
            <div className="w-1.5 h-7 bg-sky-500 rounded-full shrink-0 shadow-lg shadow-sky-900/60" />
            <h1 className="text-2xl font-black text-white font-mono uppercase tracking-normal leading-tight truncate">{name}</h1>
          </div>

          {/* Core Telemetry Stats Area */}
          <div className="grid grid-cols-12 gap-3 flex-1 my-1.5 min-h-0 overflow-hidden items-stretch relative z-10">

            {/* Left Card: Production */}
            <div className="col-span-5 bg-gradient-to-b from-slate-900 to-[#050b18] border-2 border-slate-800 rounded-3xl flex flex-col overflow-hidden shadow-2xl shadow-black/40">
              <div className="bg-gradient-to-r from-sky-950 to-slate-900 border-b-2 border-sky-900/40 py-3 text-center shrink-0">
                <span className="text-base font-black tracking-widest text-sky-300 uppercase">Production</span>
              </div>
              <div className="flex-1 flex flex-col items-center justify-center p-1 min-h-0">
                <div className="relative flex items-center justify-center shrink min-h-0 w-60 h-60">
                  <div className="absolute w-[75%] h-[75%] rounded-full bg-sky-500/10 blur-2xl" />
                  <svg className="w-full h-full transform -rotate-90" viewBox="0 0 160 160">
                    <circle
                      cx="80"
                      cy="80"
                      r="64"
                      className="stroke-slate-800 fill-none"
                      strokeWidth="14"
                    />
                    <circle
                      cx="80"
                      cy="80"
                      r="64"
                      className="stroke-sky-500 fill-none transition-all duration-500 ease-out"
                      strokeWidth="14"
                      strokeDasharray={2 * Math.PI * 64}
                      strokeDashoffset={2 * Math.PI * 64 - (Math.min(100, achievementRate) / 100) * (2 * Math.PI * 64)}
                      strokeLinecap="round"
                    />
                  </svg>
                  <div className="absolute flex flex-col items-center justify-center">
                    <span className="text-7xl font-black text-slate-100 font-mono leading-none">{production_count}</span>
                    <span className="text-slate-400 font-extrabold text-base tracking-wide uppercase mt-2">/ {target} Parts</span>
                    <span className="text-2xl font-black text-sky-400 mt-1.5 uppercase tracking-wide">{achievementRate.toFixed(0)}% Done</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Right Side: full-height row of 3 secondary stat cards */}
            <div className="col-span-7 grid grid-cols-3 gap-4 h-full min-h-0">

              {/* 1. Machine Status */}
              <div className="bg-gradient-to-b from-slate-900 to-[#050b18] border-2 border-slate-800 rounded-3xl flex flex-col overflow-hidden shadow-xl shadow-black/40">
                <div className={`bg-gradient-to-r ${statusTheme.grad} to-slate-900 border-b-2 ${statusTheme.border} py-2 text-center shrink-0`}>
                  <span className="text-xs font-black tracking-widest text-slate-200 uppercase">Status</span>
                </div>
                <div className="flex-1 flex flex-col items-center justify-center p-2 text-center gap-3 min-h-0">
                  {status === 'Running' ? (
                    <div className="w-24 h-24 rounded-full bg-gradient-to-br from-emerald-500 to-emerald-700 flex items-center justify-center text-white shadow-xl shadow-emerald-900/60 shrink-0">
                      <Play className="w-11 h-11 fill-white text-white translate-x-0.5" />
                    </div>
                  ) : status === 'Stopped' ? (
                    <div className="w-24 h-24 rounded-full bg-gradient-to-br from-rose-500 to-rose-700 flex items-center justify-center text-white shadow-xl shadow-rose-900/60 shrink-0">
                      <Ban className="w-11 h-11 text-white" />
                    </div>
                  ) : (
                    <div className="w-24 h-24 rounded-full bg-gradient-to-br from-violet-500 to-violet-700 flex items-center justify-center text-white shadow-xl shadow-violet-900/60 shrink-0">
                      <AlertTriangle className="w-11 h-11 text-white" />
                    </div>
                  )}
                  <span className={`text-2xl font-black uppercase tracking-wide leading-none ${statusTheme.text}`}>
                    {status}
                  </span>
                </div>
              </div>

              {/* 2. Active Cycle Stopwatch */}
              <div className="bg-gradient-to-b from-slate-900 to-[#050b18] border-2 border-slate-800 rounded-3xl flex flex-col overflow-hidden shadow-xl shadow-black/40">
                <div className="bg-gradient-to-r from-sky-950 to-slate-900 border-b-2 border-sky-900/40 py-2 text-center shrink-0">
                  <span className="text-xs font-black tracking-widest text-sky-300 uppercase">Active Cycle</span>
                </div>
                <div className="flex-1 flex flex-col items-center justify-center p-1 text-center gap-1.5 min-h-0">
                  <Clock className="w-10 h-10 text-sky-400 animate-pulse shrink-0" />
                  <span className="text-6xl font-black font-mono text-slate-100 leading-none">
                    {status === 'Running' ? `${cycleTimer.toFixed(1)}s` : '0.0s'}
                  </span>
                  <span className="text-base font-bold text-slate-400 uppercase leading-none">Ideal: {ideal_cycle_time}s</span>
                </div>
              </div>

              {/* 3. Last Cycle Duration */}
              <div className="bg-gradient-to-b from-slate-900 to-[#050b18] border-2 border-slate-800 rounded-3xl flex flex-col overflow-hidden shadow-xl shadow-black/40">
                <div className="bg-gradient-to-r from-sky-950 to-slate-900 border-b-2 border-sky-900/40 py-2 text-center shrink-0">
                  <span className="text-xs font-black tracking-widest text-sky-300 uppercase">Last Cycle</span>
                </div>
                <div className="flex-1 flex flex-col items-center justify-center p-1 text-center gap-1.5 min-h-0">
                  <Clock className="w-10 h-10 text-sky-400 shrink-0" />
                  <span className="text-6xl font-black font-mono text-slate-100 leading-none">
                    {lastCycleTime > 0 ? `${lastCycleTime.toFixed(2)}s` : '10.88s'}
                  </span>
                  {lastCycleTime > 0 ? (
                    <span className={`text-base font-black uppercase leading-none ${lastCycleTime <= ideal_cycle_time ? 'text-emerald-400' : 'text-amber-400'}`}>
                      Perf: {(ideal_cycle_time / lastCycleTime * 100).toFixed(0)}%
                    </span>
                  ) : (
                    <span className="text-base font-bold text-emerald-400 uppercase leading-none">Perf: 110%</span>
                  )}
                </div>
              </div>

            </div>
          </div>

          {/* Shift & Duty Strip */}
          <div className="w-full bg-gradient-to-r from-slate-900 via-violet-950/40 to-slate-900 border-2 border-slate-800 rounded-2xl px-6 py-3 flex items-center justify-around shrink-0 shadow-lg shadow-black/30 relative z-10">
            <div className="flex items-center gap-4">
              <div className="p-2.5 bg-violet-900/40 text-violet-400 rounded-xl border border-violet-800/50">
                <Calendar className="w-8 h-8" />
              </div>
              <div className="text-left leading-none">
                <span className="text-sm font-bold text-slate-400 uppercase tracking-widest block mb-1.5">Current Shift</span>
                <span className="text-3xl font-black text-white font-mono block uppercase">{currentShift}</span>
              </div>
            </div>
            <div className="w-px h-12 bg-slate-800"></div>
            <div className="flex items-center gap-4">
              <div className="p-2.5 bg-sky-900/40 text-sky-400 rounded-xl border border-sky-800/50">
                <Clock className="w-8 h-8" />
              </div>
              <div className="text-left leading-none">
                <span className="text-sm font-bold text-slate-400 uppercase tracking-widest block mb-1.5">Duty Time</span>
                <span className="text-3xl font-black text-white font-mono block uppercase">{dutyTimeStr}</span>
              </div>
            </div>
          </div>

          {/* Touch Control Buttons */}
          <div className="w-full pt-2 shrink-0 relative z-10">
            {status === 'Running' ? (
              <button
                onClick={() => onStopMachine(selectedId)}
                className="w-full bg-gradient-to-r from-rose-600 to-rose-700 hover:from-rose-500 hover:to-rose-600 text-white font-black text-4xl tracking-widest uppercase py-8 rounded-3xl border-4 border-rose-400/40 shadow-2xl shadow-rose-950/60 flex items-center justify-center gap-5 transition-all active:scale-[0.98] cursor-pointer animate-in fade-in"
              >
                <Ban className="w-12 h-12 shrink-0" /> STOP PRODUCTION
              </button>
            ) : (
              <button
                onClick={handleStartClick}
                disabled={status === 'No Signal'}
                className="w-full bg-gradient-to-r from-emerald-500 to-emerald-700 hover:from-emerald-400 hover:to-emerald-600 disabled:opacity-50 text-white font-black text-4xl tracking-widest uppercase py-8 rounded-3xl border-4 border-emerald-300/40 shadow-2xl shadow-emerald-950/60 flex items-center justify-center gap-5 transition-all active:scale-[0.98] cursor-pointer animate-in fade-in"
              >
                <Play className="w-12 h-12 fill-white text-white shrink-0" /> RESUME PRODUCTION
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
        reasonCodes={reasonCodes}
      />

    </div>
  );
}
