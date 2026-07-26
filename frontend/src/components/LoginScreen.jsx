import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Factory, Lock, LogIn, MoonStar, SunMedium, ShieldAlert, User } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useVirtualKeyboard } from './keyboard/useVirtualKeyboard';
import jbmLogo from '../assets/jbmlogo (1).png';
import roseLogo from '../assets/rose logo (1).png';

// Lazy-loaded so the on-screen keyboard (and react-simple-keyboard) is only ever fetched/parsed
// while the Login screen is mounted - it never ships as part of the dashboard bundle, and it
// unmounts along with LoginScreen the moment login succeeds.
const VirtualKeyboard = lazy(() => import('./keyboard/VirtualKeyboard.jsx'));

export default function LoginScreen({ themeMode, onToggleTheme, onLoginSuccess }) {
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { activeInput, isOpen: isKeyboardOpen, open: openKeyboard, close: closeKeyboard } = useVirtualKeyboard();
  const formRef = useRef(null);
  const cardRef = useRef(null);

  // Warm the keyboard chunk as soon as the Login screen mounts (not on first focus), so the very
  // first tap into a field opens it without a visible load delay - the import is still only ever
  // triggered from this screen.
  useEffect(() => {
    import('./keyboard/VirtualKeyboard.jsx');
  }, []);

  // Tapping anywhere outside the login card (background, theme toggle) hides the keyboard.
  // Taps inside the card - including switching between fields, which re-opens via onFocus -
  // are left alone.
  useEffect(() => {
    if (!isKeyboardOpen) return undefined;
    const handlePointerDown = (event) => {
      const insideCard = cardRef.current?.contains(event.target);
      const insideKeyboard = event.target.closest?.('.virtual-keyboard-dock');
      if (!insideCard && !insideKeyboard) {
        closeKeyboard();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [isKeyboardOpen, closeKeyboard]);

  const handleFieldChange = useCallback((name, value) => {
    if (name === 'loginId') setLoginId(value.toUpperCase());
    else if (name === 'password') setPassword(value);
  }, []);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!loginId || !password) {
      setErrorMessage('Enter both your Login ID and password.');
      return;
    }

    setIsSubmitting(true);
    setErrorMessage('');

    try {
      const data = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: { loginId: loginId.trim(), password }
      });
      closeKeyboard();
      onLoginSuccess(data.user, data.token);
    } catch (err) {
      setErrorMessage(err.message || 'Login failed. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const requestSubmit = useCallback(() => {
    formRef.current?.requestSubmit();
  }, []);

  const keyboardShiftClass = isKeyboardOpen
    ? (activeInput === 'password' ? '-translate-y-[110px]' : '-translate-y-[60px]')
    : 'translate-y-0';

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

      <div
        ref={cardRef}
        className={`w-full max-w-[900px] grid lg:grid-cols-[1.1fr_0.9fr] jbm-card overflow-hidden shadow-xl animate-in fade-in duration-300 transition-transform duration-300 ease-out ${keyboardShiftClass}`}
      >

        {/* Left Side: Brand Promo / Info Panel */}
        <div className="bg-[var(--secondary2-trans-100)] p-8 flex flex-col justify-between border-r-[1.5px] border-[var(--grey-200)]">
          <div className="space-y-6">
            {/* JBM Branded Logo Symbol */}
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2.5 w-fit bg-white p-3 rounded-2xl shadow-sm border border-slate-100">
                <img src={jbmLogo} alt="JBM Logo" className="h-10 w-auto object-contain" />
                <div className="h-[1px] w-full bg-slate-150"></div>
                <img src={roseLogo} alt="Rose Logo" className="h-10 w-auto object-contain" />
              </div>
              <div className="text-left">
                <span className="text-[10px] font-black uppercase tracking-[0.45em] text-[var(--primary)] block leading-none">Smart Factory</span>
                <span className="text-sm font-black tracking-wider text-[var(--grey-900)] uppercase font-mono">JBM Factory-Sync MM</span>
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
              <p className="text-[9px] font-extrabold uppercase tracking-wider text-slate-400">First Login</p>
              <p className="mt-1 text-xs font-bold text-[var(--grey-900)]">Ask your Admin for credentials</p>
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

            <form ref={formRef} onSubmit={handleSubmit} className="mt-6 space-y-4">
              <div>
                <label className="mb-1.5 block text-[9.5px] font-extrabold uppercase tracking-widest text-slate-450">Login ID</label>
                <div className="relative">
                  <User className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-455" />
                  <input
                    type="text"
                    value={loginId}
                    onChange={(e) => handleFieldChange('loginId', e.target.value)}
                    onFocus={() => openKeyboard('loginId')}
                    placeholder="e.g. ADMIN, SUP-201"
                    autoComplete="username"
                    inputMode="text"
                    className="w-full bg-[var(--bg-color-page)] border border-[var(--grey-200)] hover:border-[var(--primary)] focus:border-[var(--primary)] focus:bg-[var(--white-color)] text-[var(--grey-900)] rounded-xl py-2.5 pl-9 pr-3 text-xs font-bold uppercase transition-all outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-[9.5px] font-extrabold uppercase tracking-widest text-slate-450">Password</label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-455" />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => handleFieldChange('password', e.target.value)}
                    onFocus={() => openKeyboard('password')}
                    placeholder="Enter your password"
                    autoComplete="current-password"
                    inputMode="text"
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
                disabled={!loginId || !password || isSubmitting}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--primary)] hover:bg-[var(--primary)]/90 disabled:opacity-50 text-white font-extrabold text-xs uppercase tracking-widest py-3 border border-[var(--primary)]/10 shadow-md transition-all active:scale-95 mt-2"
              >
                {isSubmitting ? 'Signing In...' : 'Access Command Center'}
                {!isSubmitting && <ArrowRight className="w-4 h-4" />}
              </button>
            </form>
          </div>

          <div className="text-[9px] font-semibold text-slate-400 leading-normal uppercase pt-6 border-t border-[var(--grey-200)] mt-6 text-center">
            JBM Industrial IoT Security Platform
          </div>
        </div>

      </div>

      <Suspense fallback={null}>
        <VirtualKeyboard
          visible={isKeyboardOpen}
          activeInput={activeInput}
          values={{ loginId, password }}
          onChange={handleFieldChange}
          onEnter={requestSubmit}
          onHide={closeKeyboard}
        />
      </Suspense>
    </div>
  );
}
