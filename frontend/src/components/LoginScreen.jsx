import React, { useMemo, useState } from 'react';
import { ArrowRight, Factory, Lock, LogIn, MoonStar, SunMedium, ShieldAlert } from 'lucide-react';

export default function LoginScreen({ accounts, themeMode, onToggleTheme, onLogin }) {
  const [loginId, setLoginId] = useState(accounts[0]?.loginId || '');
  const [password, setPassword] = useState('1234');
  const [errorMessage, setErrorMessage] = useState('');

  const selectedAccount = useMemo(
    () => accounts.find((account) => account.loginId === loginId),
    [accounts, loginId]
  );

  const handleSubmit = (event) => {
    event.preventDefault();

    if (!selectedAccount || password !== '1234') {
      setErrorMessage('Invalid credentials. Use a valid login ID with password 1234.');
      return;
    }

    setErrorMessage('');
    onLogin({
      loginId: selectedAccount.loginId,
      role: selectedAccount.role,
      displayName: selectedAccount.displayName,
      operatorId: selectedAccount.operatorId || '',
      terminalId: selectedAccount.terminalId || selectedAccount.loginId
    });
  };

  return (
    <div className="min-h-screen flex flex-col justify-center items-center p-4 font-sans select-none bg-[var(--bg-color-page)] relative overflow-hidden transition-all duration-300">
      {/* Background Decorative Blobs */}
      <div className="absolute top-[-20%] left-[-20%] w-[60%] h-[60%] rounded-full bg-[var(--primary)] opacity-[0.03] blur-3xl pointer-events-none"></div>
      <div className="absolute bottom-[-20%] right-[-20%] w-[60%] h-[60%] rounded-full bg-[var(--primary)] opacity-[0.04] blur-3xl pointer-events-none"></div>

      {/* Theme Toggler (Top Right) */}
      <div className="absolute top-6 right-6">
        <button
          type="button"
          onClick={onToggleTheme}
          className="flex items-center gap-2 px-3 py-2 rounded-xl border border-[var(--grey-200)] bg-[var(--white-color)] text-xs font-bold text-[var(--grey-900)] transition hover:border-[var(--primary)] hover:text-[var(--primary)] shadow-sm"
        >
          {themeMode === 'light' ? <MoonStar className="w-3.5 h-3.5" /> : <SunMedium className="w-3.5 h-3.5" />}
          {themeMode === 'light' ? 'Dark Mode' : 'Light Mode'}
        </button>
      </div>

      <div className="w-full max-w-[900px] grid lg:grid-cols-[1.1fr_0.9fr] jbm-card overflow-hidden shadow-xl animate-in fade-in duration-300">
        
        {/* Left Side: Brand Promo / Info Panel */}
        <div className="bg-[var(--secondary2-trans-100)] p-8 flex flex-col justify-between border-r-[1.5px] border-[var(--grey-200)]">
          <div className="space-y-6">
            {/* JBM Branded Logo Symbol */}
            <div className="flex items-center gap-3">
              <div className="bg-[var(--primary)] text-white p-3 rounded-2xl shadow-md">
                <Factory className="w-6 h-6" />
              </div>
              <div>
                <span className="text-[10px] font-black uppercase tracking-[0.45em] text-[var(--primary)] block leading-none">Smart Factory</span>
                <span className="text-lg font-black tracking-wider text-[var(--grey-900)] uppercase font-mono">Factory-Sync MM</span>
              </div>
            </div>

            <div className="space-y-4 pt-4">
              <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-[var(--primary)]">Production Operations</p>
              <h2 className="text-3xl font-black text-[var(--grey-900)] leading-tight">
                Real-Time CNC Machine Telemetry
              </h2>
              <p className="text-sm text-[var(--grey-900)] opacity-70 leading-relaxed">
                Connect and sync factory-floor PLC signals directly to the control room. Log in with your personnel ID to access command dashboards, resource allocations, and live OEE metrics.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 pt-6 border-t border-[var(--grey-200)]">
            <div className="p-3 bg-[var(--white-color)] border border-[var(--grey-200)] rounded-xl">
              <p className="text-[9px] font-extrabold uppercase tracking-wider text-slate-400">Security</p>
              <p className="mt-1 text-xs font-bold text-[var(--grey-900)]">Role-based Access</p>
            </div>
            <div className="p-3 bg-[var(--white-color)] border border-[var(--grey-200)] rounded-xl">
              <p className="text-[9px] font-extrabold uppercase tracking-wider text-slate-400">Default Pass</p>
              <p className="mt-1 text-xs font-bold text-[var(--grey-900)]">Use: 1234</p>
            </div>
          </div>
        </div>

        {/* Right Side: Form Panel */}
        <div className="bg-[var(--white-color)] p-8 flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-3 pb-5 border-b border-[var(--grey-200)]">
              <div className="bg-[var(--secondary2-trans-100)] text-[var(--primary)] p-2.5 rounded-xl border border-[var(--primary)]/10">
                <LogIn className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-lg font-black text-[var(--grey-900)] uppercase tracking-wide">Operator Sign In</h3>
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Authorized Personnel Only</p>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="mt-6 space-y-4">
              <div>
                <label className="mb-1.5 block text-[9.5px] font-extrabold uppercase tracking-widest text-slate-450">Login ID</label>
                <select
                  value={loginId}
                  onChange={(e) => setLoginId(e.target.value)}
                  className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] hover:border-[var(--primary)] focus:border-[var(--primary)] focus:bg-[var(--white-color)] text-[var(--grey-900)] rounded-xl py-2.5 px-3 text-xs font-bold uppercase transition-all outline-none"
                >
                  <option value="">Select profile Badge...</option>
                  {accounts.map(acc => (
                    <option key={acc.loginId} value={acc.loginId}>
                      {acc.loginId} - {acc.role} ({acc.displayName})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1.5 block text-[9.5px] font-extrabold uppercase tracking-widest text-slate-450">PIN / Password</label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-455" />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter PIN code"
                    className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] hover:border-[var(--primary)] focus:border-[var(--primary)] focus:bg-[var(--white-color)] text-[var(--grey-900)] rounded-xl py-2.5 pl-9 pr-3 text-xs font-bold transition-all outline-none"
                  />
                </div>
              </div>

              {errorMessage && (
                <div className="rounded-xl border border-rose-100 bg-rose-50/80 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-rose-700 flex items-center gap-1.5 leading-normal">
                  <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
                  {errorMessage}
                </div>
              )}

              <button
                type="submit"
                disabled={!loginId}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--primary)] hover:bg-[var(--primary)]/90 disabled:opacity-50 text-white font-extrabold text-xs uppercase tracking-widest py-3 border border-[var(--primary)]/10 shadow-md transition-all active:scale-95 mt-2"
              >
                Access Command Center
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>
          </div>

          <div className="text-[9px] font-semibold text-slate-400 leading-normal uppercase pt-6 border-t border-[var(--grey-200)] mt-6 text-center">
            JBM Industrial IoT Security Platform
          </div>
        </div>

      </div>
    </div>
  );
}