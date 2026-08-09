import React, { useState, useEffect } from 'react';
import { Play, Ban, AlertTriangle, Clock, LogOut, User, Calendar, Package, Wifi, WifiOff } from 'lucide-react';
import DowntimeReasonModal from './DowntimeReasonModal';
import jbmLogo from '../assets/jbmlogo (1).png';
import roseLogo from '../assets/rose logo (1).png';

// How long machine data can go without refreshing (a WS push or a successful reconciliation
// poll) before the kiosk treats what's on screen as stale rather than live. The reconciliation
// poll normally succeeds every 1.5s in kiosk mode (see App.jsx) - this threshold gives several
// missed polls of slack for ordinary network jitter before warning the operator.
const STALE_DATA_THRESHOLD_MS = 10000;

export default function OperatorTerminal({
  machines,
  onStopMachine,
  onResumeMachine,
  sessionUser,
  reasonCodes = [],
  socketConnected = true,
  lastDataUpdateAt = Date.now()
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

  const [shiftRemainingStr, setShiftRemainingStr] = useState('');

  // Find active selected machine
  const machine = machines.find(m => m.id === selectedId) || {};
  const { name = '1313 ACE CNC SUPER JOBBER', status = 'Not Connected', target = 500, production_count = 0, last_pulse, ideal_cycle_time = 12, metrics, assigned_operator, active_part_name, active_schedule_id } = machine;
  const { lastCycleTime = 0, currentShift = 'Shift A' } = metrics || {};
  const achievementRate = target > 0 ? (production_count / target) * 100 : 0;
  // No part scheduled for this machine right now - production must never start (or continue
  // showing a stale previous part) without PPC creating and activating a real schedule entry.
  const hasSchedule = Boolean(active_schedule_id);

  // Shift & Duty card: counts down to the end of the CURRENT shift (from the plant's fixed
  // shift schedule - same 07:00/15:30/24:00 boundaries used elsewhere in this dashboard), not
  // how long the operator has been logged in. `currentShift` comes from the backend's
  // getShiftForTimestamp(now) (see calculateOEE), so once real time crosses into the next
  // shift the next machines poll flips currentShift forward on its own and this countdown
  // restarts for the new shift - no separate "next shift" lookup needed here.
  useEffect(() => {
    const SHIFT_END_MINUTES = { 'Shift A': 15.5 * 60, 'Shift B': 24 * 60, 'Shift C': 7 * 60 };

    const update = () => {
      const endMinutes = SHIFT_END_MINUTES[currentShift] ?? SHIFT_END_MINUTES['Shift A'];
      const now = new Date();
      const startOfDay = new Date(now);
      startOfDay.setHours(0, 0, 0, 0);
      let shiftEnd = new Date(startOfDay.getTime() + endMinutes * 60000);
      if (shiftEnd.getTime() <= now.getTime()) {
        shiftEnd = new Date(shiftEnd.getTime() + 24 * 3600000);
      }

      const remainingMs = shiftEnd.getTime() - now.getTime();
      if (remainingMs <= 0) {
        setShiftRemainingStr('SHIFT COMPLETED');
        return;
      }
      const totalSecs = Math.floor(remainingMs / 1000);
      const hh = Math.floor(totalSecs / 3600);
      const mm = Math.floor((totalSecs % 3600) / 60);
      const ss = totalSecs % 60;
      setShiftRemainingStr(`${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`);
    };

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [currentShift]);

  // Ticks once a second purely to re-evaluate data staleness below - lastDataUpdateAt itself
  // only changes when fresh data actually arrives, so without this the "is it stale yet" check
  // would never re-run once no new data comes in (the very case it needs to detect).
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);
  const isDataStale = (nowTick - lastDataUpdateAt) > STALE_DATA_THRESHOLD_MS;
  // Connection lost takes priority over "just stale" - it's the more actionable/severe state,
  // and once the socket is down the data is inevitably about to go stale anyway.
  const connectivityBanner = !socketConnected
    ? { tone: 'offline', message: 'Connection Lost — Reconnecting…' }
    : isDataStale
    ? { tone: 'stale', message: 'Data May Be Out Of Date' }
    : null;

  // Same three states as the banner above, but as a small always-visible header badge (like a
  // phone's signal icon) rather than something that only appears when there's a problem - so an
  // operator can glance at connectivity status at any time, not just during an active incident.
  const connectivityTheme = connectivityBanner === null
    ? { Icon: Wifi, label: 'ONLINE', grad: 'from-emerald-950/70', border: 'border-emerald-900/50', text: 'text-emerald-300', pulse: false }
    : connectivityBanner.tone === 'stale'
    ? { Icon: Wifi, label: 'STALE', grad: 'from-amber-950/70', border: 'border-amber-900/50', text: 'text-amber-300', pulse: true }
    : { Icon: WifiOff, label: 'OFFLINE', grad: 'from-rose-950/70', border: 'border-rose-900/50', text: 'text-rose-300', pulse: true };

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

  // Tracks when this Running period actually started, so a stale last_pulse from
  // before a stop/resume can't make the stopwatch open by counting the downtime gap.
  const [runningSince, setRunningSince] = useState(null);
  const prevStatusRef = React.useRef(status);

  useEffect(() => {
    if (status === 'Running' && prevStatusRef.current !== 'Running') {
      setRunningSince(Date.now());
    }
    prevStatusRef.current = status;
  }, [status]);

  // Real-time stopwatch
  useEffect(() => {
    let intervalId;
    if (status === 'Running') {
      const lastPulseTime = last_pulse ? new Date(last_pulse).getTime() : 0;
      const baseTime = Math.max(lastPulseTime, runningSince ?? Date.now());
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
  }, [status, last_pulse, runningSince]);

  const handleLoginSubmit = (e) => {
    e.preventDefault();
    const trimmedId = operatorId.trim();
    if (!trimmedId) return;
    setLoggedInOperator(trimmedId);
    window.localStorage.setItem('mes-logged-operator', trimmedId);
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

      {/* Connectivity/staleness banner - shown whenever the socket is down or the machine data
          on screen hasn't refreshed recently, so an operator can never unknowingly act on stale
          data. Renders nothing (zero layout impact) once connected and fresh again - no manual
          dismiss needed, it clears itself the moment real data resumes flowing. */}
      {connectivityBanner && (
        <div
          className={`w-full shrink-0 mb-2 rounded-2xl px-4 py-2 flex items-center justify-center gap-2.5 relative z-20 animate-in fade-in border-2 ${
            connectivityBanner.tone === 'offline'
              ? 'bg-gradient-to-r from-rose-950/80 to-slate-900 border-rose-800/60'
              : 'bg-gradient-to-r from-amber-950/80 to-slate-900 border-amber-800/60'
          }`}
        >
          <WifiOff className={`w-5 h-5 shrink-0 animate-pulse ${connectivityBanner.tone === 'offline' ? 'text-rose-400' : 'text-amber-400'}`} />
          <span className={`text-sm font-black uppercase tracking-wide ${connectivityBanner.tone === 'offline' ? 'text-rose-300' : 'text-amber-300'}`}>
            {connectivityBanner.message}
          </span>
        </div>
      )}

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
                Confirm and Sign In
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
          // MANUAL OPERATOR ID ENTRY LOGIN MODE - no hardcoded operator roster; the operator
          // types their own badge ID, matching how PPC-assigned IDs (e.g. OP-105, SUP-205) are
          // free-form elsewhere in this system (see User Management), not a fixed local list.
          <div className="flex-1 flex flex-col items-center justify-center p-4 text-center animate-in fade-in duration-300 relative z-10">
            <h3 className="text-4xl font-black text-slate-100 uppercase tracking-wide">MES Terminal Sign-In</h3>
            <p className="text-lg text-slate-400 mt-2 max-w-2xl uppercase font-bold tracking-wide">Enter your operator ID to unlock workstation controls</p>

            <form onSubmit={handleLoginSubmit} className="mt-8 flex flex-col gap-4 w-full max-w-xl">
              <input
                type="text"
                value={operatorId}
                onChange={(e) => setOperatorId(e.target.value.toUpperCase())}
                placeholder="e.g. OP-105"
                autoFocus
                className="w-full bg-slate-900 border-2 border-slate-800 hover:border-slate-700 text-slate-100 rounded-2xl py-5 px-5 text-xl font-bold uppercase text-center tracking-widest transition-all outline-none placeholder:text-slate-600"
              />

              <button
                type="submit"
                disabled={!operatorId.trim()}
                className="w-full bg-gradient-to-r from-sky-500 to-sky-600 hover:from-sky-400 hover:to-sky-500 disabled:opacity-50 text-white font-extrabold text-xl tracking-wide uppercase py-6 rounded-3xl border-2 border-sky-400/40 shadow-2xl shadow-sky-950/60 transition-all active:scale-95 cursor-pointer"
              >
                Confirm and Sign In
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
              {/* Connectivity Badge */}
              <div
                title={connectivityBanner?.message || 'Live connection to server is healthy'}
                className={`border-2 rounded-xl px-3 py-2 flex items-center gap-1.5 text-sm font-black uppercase tracking-wide shrink-0 shadow-lg bg-gradient-to-br ${connectivityTheme.grad} to-slate-900 ${connectivityTheme.border} ${connectivityTheme.text}`}
              >
                <connectivityTheme.Icon className={`w-5 h-5 shrink-0 ${connectivityTheme.pulse ? 'animate-pulse' : ''}`} />
                <span className="whitespace-nowrap">{connectivityTheme.label}</span>
              </div>

              {/* Operator Badge */}
              <div className="border-2 border-slate-700 bg-gradient-to-br from-slate-800 to-slate-900 rounded-xl px-3 py-2 flex items-center gap-1.5 text-sm font-black uppercase text-slate-100 tracking-wide shadow-lg">
                <User className="w-5 h-5 text-sky-400 shrink-0" />
                <span className="whitespace-nowrap">{loggedInOperator || 'OP-101'}</span>
              </div>

              {/* Status Badge */}
              <div className={`border-2 rounded-xl px-3 py-2 flex items-center gap-1.5 text-sm font-black uppercase tracking-wide shrink-0 shadow-lg bg-gradient-to-br ${statusTheme.grad} to-slate-900 ${statusTheme.border} ${statusTheme.text}`}>
                <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${status === 'Running' ? 'bg-emerald-400 animate-pulse' : status === 'Stopped' ? 'bg-rose-500' : 'bg-violet-500 animate-pulse'}`}></span>
                <span>{status === 'Running' ? 'RUNNING' : status === 'Stopped' ? 'STOPPED' : 'NOT CONNECTED'}</span>
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
            <div className="col-span-6 bg-gradient-to-b from-slate-900 to-[#050b18] border-2 border-slate-800 rounded-3xl flex flex-col overflow-hidden shadow-2xl shadow-black/40">
              <div className="bg-gradient-to-r from-sky-950 to-slate-900 border-b-2 border-sky-900/40 py-3 text-center shrink-0">
                <span className="text-base font-black tracking-widest text-sky-300 uppercase">Production</span>
              </div>
              <div className="flex-1 flex items-center justify-center p-8 min-h-0">
                <div className="relative flex items-center justify-center aspect-square h-full max-w-full max-h-full">
                  <div className="absolute w-[75%] h-[75%] rounded-full bg-sky-500/10 blur-2xl" />
                  <svg className="w-full h-full transform -rotate-90" viewBox="0 0 160 160">
                    <circle
                      cx="80"
                      cy="80"
                      r="64"
                      className="stroke-slate-800 fill-none"
                      strokeWidth="10"
                    />
                    <circle
                      cx="80"
                      cy="80"
                      r="64"
                      className="stroke-sky-500 fill-none transition-all duration-500 ease-out"
                      strokeWidth="10"
                      strokeDasharray={2 * Math.PI * 64}
                      strokeDashoffset={2 * Math.PI * 64 - (Math.min(100, achievementRate) / 100) * (2 * Math.PI * 64)}
                      strokeLinecap="round"
                    />
                  </svg>
                  <div className="absolute flex flex-col items-center justify-center">
                    <span className="text-9xl font-black text-slate-100 font-mono leading-none">{production_count}</span>
                    <span className="text-slate-400 font-extrabold text-xl tracking-wide uppercase mt-3">/ {target} Parts</span>
                    <span className="text-4xl font-black text-sky-400 mt-2.5 uppercase tracking-wide">{achievementRate.toFixed(0)}% Done</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Right Side: 2x2 grid of secondary stat cards */}
            <div className="col-span-6 grid grid-cols-2 grid-rows-2 gap-3 h-full min-h-0">

              {/* 1. Machine Status */}
              <div className="bg-gradient-to-b from-slate-900 to-[#050b18] border-2 border-slate-800 rounded-3xl flex flex-col overflow-hidden shadow-xl shadow-black/40">
                <div className={`bg-gradient-to-r ${statusTheme.grad} to-slate-900 border-b-2 ${statusTheme.border} py-2 text-center shrink-0`}>
                  <span className="text-xs font-black tracking-widest text-slate-200 uppercase">Machine Status</span>
                </div>
                <div className="flex-1 flex flex-col items-center justify-center p-2 text-center gap-2 min-h-0">
                  {status === 'Running' ? (
                    <div className="w-14 h-14 rounded-full bg-gradient-to-br from-emerald-500 to-emerald-700 flex items-center justify-center text-white shadow-xl shadow-emerald-900/60 shrink-0">
                      <Play className="w-7 h-7 fill-white text-white translate-x-0.5" />
                    </div>
                  ) : status === 'Stopped' ? (
                    <div className="w-14 h-14 rounded-full bg-gradient-to-br from-rose-500 to-rose-700 flex items-center justify-center text-white shadow-xl shadow-rose-900/60 shrink-0">
                      <Ban className="w-7 h-7 text-white" />
                    </div>
                  ) : (
                    <div className="w-14 h-14 rounded-full bg-gradient-to-br from-violet-500 to-violet-700 flex items-center justify-center text-white shadow-xl shadow-violet-900/60 shrink-0">
                      <AlertTriangle className="w-7 h-7 text-white" />
                    </div>
                  )}
                  <span className={`text-lg font-black uppercase tracking-wide leading-none ${statusTheme.text}`}>
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
                  <Clock className="w-7 h-7 text-sky-400 animate-pulse shrink-0" />
                  <span className="text-4xl font-black font-mono text-slate-100 leading-none">
                    {status === 'Running' ? `${cycleTimer.toFixed(1)}s` : '0.0s'}
                  </span>
                  <span className="text-xs font-bold text-slate-400 uppercase leading-none">Ideal: {ideal_cycle_time}s</span>
                </div>
              </div>

              {/* 3. Last Cycle Duration */}
              <div className="bg-gradient-to-b from-slate-900 to-[#050b18] border-2 border-slate-800 rounded-3xl flex flex-col overflow-hidden shadow-xl shadow-black/40">
                <div className="bg-gradient-to-r from-sky-950 to-slate-900 border-b-2 border-sky-900/40 py-2 text-center shrink-0">
                  <span className="text-xs font-black tracking-widest text-sky-300 uppercase">Last Cycle</span>
                </div>
                <div className="flex-1 flex flex-col items-center justify-center p-1 text-center gap-1.5 min-h-0">
                  <Clock className="w-7 h-7 text-sky-400 shrink-0" />
                  <span className="text-4xl font-black font-mono text-slate-100 leading-none">
                    {lastCycleTime > 0 ? `${lastCycleTime.toFixed(2)}s` : '10.88s'}
                  </span>
                  {lastCycleTime > 0 ? (
                    <span className={`text-xs font-black uppercase leading-none ${lastCycleTime <= ideal_cycle_time ? 'text-emerald-400' : 'text-amber-400'}`}>
                      Perf: {(ideal_cycle_time / lastCycleTime * 100).toFixed(0)}%
                    </span>
                  ) : (
                    <span className="text-xs font-bold text-emerald-400 uppercase leading-none">Perf: 110%</span>
                  )}
                </div>
              </div>

              {/* 4. Shift & Duty */}
              <div className="bg-gradient-to-b from-slate-900 to-[#050b18] border-2 border-slate-800 rounded-3xl flex flex-col overflow-hidden shadow-xl shadow-black/40">
                <div className="bg-gradient-to-r from-violet-950 to-slate-900 border-b-2 border-violet-900/40 py-2 text-center shrink-0">
                  <span className="text-xs font-black tracking-widest text-violet-300 uppercase">Shift &amp; Duty</span>
                </div>
                <div className="flex-1 flex flex-col items-center justify-center gap-2 min-h-0 divide-y divide-slate-800 px-3">
                  <div className="w-full flex items-center justify-center gap-2.5 py-1.5">
                    <Calendar className="w-5 h-5 text-violet-400 shrink-0" />
                    <span className="text-lg font-black text-white font-mono uppercase leading-none">{currentShift}</span>
                  </div>
                  <div className="w-full flex flex-col items-center justify-center gap-1 py-1.5">
                    <div className="flex items-center gap-2.5">
                      <Clock className="w-5 h-5 text-sky-400 shrink-0" />
                      <span className={`text-lg font-black font-mono uppercase leading-none ${shiftRemainingStr === 'SHIFT COMPLETED' ? 'text-amber-400' : 'text-white'}`}>
                        {shiftRemainingStr}
                      </span>
                    </div>
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest leading-none">
                      {shiftRemainingStr === 'SHIFT COMPLETED' ? 'Awaiting Next Shift' : 'Shift Ends In'}
                    </span>
                  </div>
                  <div className="w-full flex items-center justify-center gap-2.5 py-1.5">
                    <Package className="w-5 h-5 text-emerald-400 shrink-0" />
                    <span className="text-lg font-black text-white font-mono uppercase leading-none truncate max-w-[220px]">{active_part_name || 'General CNC Part'}</span>
                  </div>
                  <div className="w-full flex items-center justify-center gap-2.5 py-1.5">
                    <User className="w-5 h-5 text-amber-400 shrink-0" />
                    <span className="text-lg font-black text-white font-mono uppercase leading-none truncate max-w-[220px]">{assigned_operator && assigned_operator !== 'Unassigned' ? assigned_operator : (loggedInOperator || 'Unassigned')}</span>
                  </div>
                </div>
              </div>

            </div>
          </div>

          {/* No-schedule block: production must never start (or silently keep a stale
              previous part) without PPC creating and activating a real schedule entry. */}
          {!hasSchedule && status !== 'Running' && (
            <div className="w-full mb-2 shrink-0 bg-gradient-to-r from-amber-950/70 to-slate-900 border-2 border-amber-800/60 rounded-2xl px-5 py-3.5 flex items-center gap-3 relative z-10 animate-in fade-in">
              <AlertTriangle className="w-7 h-7 text-amber-400 shrink-0" />
              <span className="text-sm font-black uppercase tracking-wide text-amber-300 leading-snug">
                No part is scheduled. Please schedule the part first from the PPC Engineer login.
              </span>
            </div>
          )}

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
                disabled={status === 'Not Connected' || !hasSchedule}
                title={!hasSchedule ? 'No part is scheduled. Please schedule the part first from the PPC Engineer login.' : undefined}
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
