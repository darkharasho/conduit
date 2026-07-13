import { useEffect } from "react";

export interface ToastData {
  kind: "success" | "error";
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function Toast({ toast, onDismiss }: { toast: ToastData; onDismiss: () => void }) {
  useEffect(() => {
    if (toast.kind !== "success") return;
    const t = setTimeout(onDismiss, 6000);
    return () => clearTimeout(t);
  }, [toast, onDismiss]);

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
