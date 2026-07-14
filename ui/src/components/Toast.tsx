import { useEffect, useRef } from "react";

export interface ToastData {
  /** Stable numeric identity — auto-dismiss timer keys on this, not object reference */
  id: number;
  kind: "success" | "error";
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function Toast({ toast, onDismiss }: { toast: ToastData; onDismiss: () => void }) {
  // Always hold the latest onDismiss in a ref so the timer callback calls the
  // current version even when the parent re-renders and passes a new closure.
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  });

  useEffect(() => {
    if (toast.kind !== "success") return;
    const t = setTimeout(() => onDismissRef.current(), 6000);
    return () => clearTimeout(t);
  // Intentionally omit onDismiss: timer must not reset on parent re-renders
  // that recreate the callback. Only toast.id or kind changes restart it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast.id, toast.kind]);

  return (
    <div className={`toast toast--${toast.kind}`} role="status">
      <span className="toast__msg">{toast.message}</span>
      {toast.actionLabel && toast.onAction && (
        <button className="toast__action" onClick={toast.onAction}>
          {toast.actionLabel}
        </button>
      )}
      <button className="toast__close" aria-label="Dismiss" onClick={onDismiss}>✕</button>
    </div>
  );
}
