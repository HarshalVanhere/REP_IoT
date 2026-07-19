import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from 'lucide-react';

const ToastContext = createContext(null);

const VARIANTS = {
  success: { icon: CheckCircle2, classes: 'bg-emerald-50 border-emerald-200 text-emerald-800' },
  error: { icon: XCircle, classes: 'bg-rose-50 border-rose-200 text-rose-800' },
  warning: { icon: AlertTriangle, classes: 'bg-amber-50 border-amber-200 text-amber-800' },
  info: { icon: Info, classes: 'bg-sky-50 border-sky-200 text-sky-800' }
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(1);

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback((message, variant = 'info', durationMs = 5000) => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, message, variant: VARIANTS[variant] ? variant : 'info' }]);
    if (durationMs > 0) {
      setTimeout(() => dismissToast(id), durationMs);
    }
    return id;
  }, [dismissToast]);

  return (
    <ToastContext.Provider value={{ showToast, dismissToast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2.5 w-[min(360px,calc(100vw-2rem))] pointer-events-none">
        {toasts.map((toast) => {
          const { icon: Icon, classes } = VARIANTS[toast.variant];
          return (
            <div
              key={toast.id}
              role="status"
              className={`pointer-events-auto flex items-start gap-2.5 border rounded-xl shadow-lg px-4 py-3 text-sm font-semibold animate-in fade-in slide-in-from-bottom-2 duration-200 ${classes}`}
            >
              <Icon className="w-5 h-5 shrink-0 mt-0.5" />
              <span className="flex-1 leading-snug">{toast.message}</span>
              <button
                onClick={() => dismissToast(toast.id)}
                className="shrink-0 opacity-60 hover:opacity-100 transition"
                aria-label="Dismiss notification"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}
