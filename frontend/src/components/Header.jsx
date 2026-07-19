import React, { useState, useEffect, useRef } from 'react';
import { Wifi, WifiOff, Menu, Bell } from 'lucide-react';

export default function Header({ socketConnected, sessionUser, onToggleMobileSidebar, alerts = [], onDismissAlert, onClearAlerts }) {
  const [time, setTime] = useState(new Date());
  const [alertsOpen, setAlertsOpen] = useState(false);
  const alertsRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (alertsRef.current && !alertsRef.current.contains(e.target)) {
        setAlertsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const formatDayDate = (date) => {
    return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: '2-digit', year: 'numeric' });
  };

  const getHour = (date) => {
    let hr = date.getHours() % 12;
    if (hr === 0) hr = 12;
    return hr.toString();
  };

  const getMinute = (date) => {
    return date.getMinutes().toString().padStart(2, '0');
  };

  const getAmPm = (date) => {
    return date.getHours() >= 12 ? 'PM' : 'AM';
  };

  // Determine shift (Shift C, A, B)
  const getShiftInfo = (date) => {
    const hr = date.getHours();
    const min = date.getMinutes();
    const totalMins = hr * 60 + min;
    
    if (totalMins >= 7 * 60 && totalMins < 15.5 * 60) {
      return { name: 'Shift A', hours: '07:00 AM - 03:30 PM' };
    } else if (totalMins >= 15.5 * 60 && totalMins < 24 * 60) {
      return { name: 'Shift B', hours: '03:30 PM - 12:00 AM' };
    } else {
      return { name: 'Shift C', hours: '12:00 AM - 07:00 AM' };
    }
  };

  const shift = getShiftInfo(time);
  const initials = sessionUser?.displayName
    ? sessionUser.displayName.split(' ').map(n => n[0]).join('').toUpperCase()
    : 'DJ';

  return (
    <div className="w-full flex justify-between items-center py-2.5 px-4 md:px-6 bg-[var(--white-color)] border-b border-[var(--grey-200)] flex-wrap gap-3">
      {/* Date & Time Widget (Left/Middle) */}
      <div className="flex items-center gap-3">
        {/* Hamburger Menu Toggle for Mobile */}
        <button
          onClick={onToggleMobileSidebar}
          className="lg:hidden p-2 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-500 transition active:scale-95 cursor-pointer shrink-0"
          title="Toggle Navigation Menu"
        >
          <Menu className="w-5.5 h-5.5" />
        </button>

        {/* Connection status badge */}
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-black tracking-widest border border-slate-200 bg-[var(--bg-color-page)]">
          {socketConnected ? (
            <span className="flex items-center gap-1 text-emerald-600">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping"></span>
              <Wifi className="w-3 h-3" /> LIVE
            </span>
          ) : (
            <span className="flex items-center gap-1 text-rose-500">
              <span className="w-1.5 h-1.5 rounded-full bg-rose-500"></span>
              <WifiOff className="w-3 h-3" /> OFFLINE
            </span>
          )}
        </div>

        {/* Local Clock Widget matching JBM */}
        <div className="flex items-center text-xs font-semibold text-[var(--grey-900)]">
          <div className="pt-1 mr-3 text-slate-500 text-[10.5px] uppercase tracking-wider">{formatDayDate(time)}</div>
          <div className="flex items-center gap-1 text-[11px] font-bold">
            <div className="px-2 py-1 rounded-lg bg-[var(--secondary2-trans-100)] text-[var(--primary)] border border-[var(--grey-200)] font-mono">{getHour(time)}</div>
            <div className="pt-1 font-mono text-[var(--primary)] animate-pulse">:</div>
            <div className="px-2 py-1 rounded-lg bg-[var(--secondary2-trans-100)] text-[var(--primary)] border border-[var(--grey-200)] font-mono">{getMinute(time)}</div>
            <div className="px-2 py-1 rounded-lg bg-[var(--secondary2-trans-100)] text-[var(--primary)] border border-[var(--grey-200)] font-mono">{getAmPm(time)}</div>
          </div>
        </div>
      </div>

      {/* Shift & User Badges (Right) */}
      <div className="flex items-center gap-4">
        {/* Shift detail display */}
        <div className="flex flex-col text-right leading-none gap-0.5">
          <span className="text-[10px] font-black text-[var(--primary)] uppercase tracking-wider">{shift.name}</span>
          <span className="text-[11px] font-bold text-slate-400">{shift.hours}</span>
        </div>

        {/* Alerts bell */}
        <div className="relative" ref={alertsRef}>
          <button
            onClick={() => setAlertsOpen((v) => !v)}
            className="relative p-2 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-500 transition active:scale-95"
            title="Machine alerts"
          >
            <Bell className="w-4.5 h-4.5" />
            {alerts.length > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-rose-500 text-white text-[9px] font-black flex items-center justify-center">
                {alerts.length > 9 ? '9+' : alerts.length}
              </span>
            )}
          </button>

          {alertsOpen && (
            <div className="absolute right-0 mt-2 w-80 max-h-96 overflow-y-auto bg-[var(--white-color)] border border-[var(--grey-200)] rounded-xl shadow-xl z-50 animate-in fade-in duration-150">
              <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--grey-200)]">
                <span className="text-xs font-black uppercase tracking-wider text-[var(--grey-900)]">Machine Alerts</span>
                {alerts.length > 0 && (
                  <button onClick={onClearAlerts} className="text-[10px] font-bold uppercase text-[var(--primary)] hover:underline">
                    Clear all
                  </button>
                )}
              </div>
              {alerts.length === 0 ? (
                <div className="px-4 py-8 text-center text-xs font-bold text-slate-400 uppercase tracking-wider">
                  No alerts. All machines nominal.
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {alerts.map((alert) => (
                    <li key={alert.id} className="px-4 py-3 text-xs">
                      <div className="flex items-start justify-between gap-2">
                        <span className={`font-black uppercase tracking-wider ${alert.severity === 'critical' ? 'text-rose-600' : 'text-amber-600'}`}>
                          {alert.severity === 'critical' ? 'Critical' : 'Warning'}
                        </span>
                        <button onClick={() => onDismissAlert?.(alert.id)} className="text-slate-350 hover:text-slate-600 text-[10px]">✕</button>
                      </div>
                      <p className="text-slate-600 font-semibold mt-1 leading-snug">{alert.message}</p>
                      <p className="text-[10px] text-slate-400 mt-1 font-mono">{new Date(alert.timestamp).toLocaleTimeString()}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* User Card matching JBM layout */}
        <div className="flex items-center gap-2.5 border-l border-[var(--grey-200)] pl-4">
          <div className="w-8 h-8 rounded-full bg-[var(--primary)] text-white flex items-center justify-center font-bold text-xs shadow-sm">
            {initials}
          </div>
          <div className="text-left leading-none gap-1 flex flex-col">
            <div className="text-xs font-black text-[var(--grey-900)] capitalize">{sessionUser?.displayName || 'Demo JBM-K'}</div>
            <div className="text-[9.5px] font-bold text-slate-400">Plant ID- 9011</div>
          </div>
        </div>
      </div>
    </div>
  );
}
