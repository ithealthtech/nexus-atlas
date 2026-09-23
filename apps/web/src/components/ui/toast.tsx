import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertCircle, X } from 'lucide-react';

type Toast = { id: number; message: string; tone: 'success' | 'error' };
const ToastContext = createContext<(message: string, tone?: Toast['tone']) => void>(() => undefined);
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (message: string, tone: Toast['tone'] = 'success') => {
      const id = Date.now() + Math.random();
      setToasts((all) => [...all.slice(-3), { id, message, tone }]);
      setTimeout(() => dismiss(id), 5000);
    },
    [dismiss],
  );
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        role="status"
        className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className="animate-toast pointer-events-auto flex max-w-md items-center gap-3 rounded-xl bg-[#17322a] px-4 py-3 text-sm text-white shadow-xl"
          >
            {t.tone === 'success' ? (
              <CheckCircle2 className="size-4 text-accent" aria-hidden />
            ) : (
              <AlertCircle className="size-4 text-[#ffb4a8]" aria-hidden />
            )}
            <span>{t.message}</span>
            <button
              onClick={() => dismiss(t.id)}
              className="ml-1 rounded p-0.5 text-white/60 hover:text-white"
              aria-label="Dismiss"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
