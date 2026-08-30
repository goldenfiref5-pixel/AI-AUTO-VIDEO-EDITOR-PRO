'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { cn } from './utils';

type ToastKind = 'info' | 'success' | 'error' | 'warn';

interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
}

interface ToastContextValue {
  push: (toast: Omit<Toast, 'id'>) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const STYLES: Record<ToastKind, string> = {
  info: 'border-line-strong',
  success: 'border-ok/60',
  error: 'border-danger/60',
  warn: 'border-warn/60',
};

const DOTS: Record<ToastKind, string> = {
  info: 'bg-brand',
  success: 'bg-ok',
  error: 'bg-danger',
  warn: 'bg-warn',
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { ...toast, id }]);
    // Errors stay longer: they usually carry something the user must read.
    const ttl = toast.kind === 'error' ? 8000 : 4500;
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), ttl);
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({
      push,
      success: (title, description) => push({ kind: 'success', title, description }),
      error: (title, description) => push({ kind: 'error', title, description }),
      info: (title, description) => push({ kind: 'info', title, description }),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2"
        role="status"
        aria-live="polite"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              'pointer-events-auto animate-fade-in rounded-lg border bg-surface-raised p-3 shadow-xl shadow-black/40',
              STYLES[toast.kind],
            )}
          >
            <div className="flex gap-2.5">
              <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', DOTS[toast.kind])} />
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">{toast.title}</p>
                {toast.description ? (
                  <p className="mt-0.5 break-words text-xs text-ink-muted">{toast.description}</p>
                ) : null}
              </div>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside a ToastProvider');
  return context;
}
