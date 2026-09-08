import { useCallback, useRef, useState } from "react";

export interface Toast {
  id: number;
  msg: string;
  kind: "ok" | "err";
}

export function useToasts(): { toasts: Toast[]; pushToast: (msg: string, kind?: "ok" | "err") => void } {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);
  const pushToast = useCallback((msg: string, kind: Toast["kind"] = "err") => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev, { id, msg, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);
  return { toasts, pushToast };
}

export function ToastStack({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`}>
          <span className="toast__word">{t.kind === "ok" ? "OK" : "ERR"}</span>
          <span className="toast__msg">{t.msg}</span>
        </div>
      ))}
    </div>
  );
}
