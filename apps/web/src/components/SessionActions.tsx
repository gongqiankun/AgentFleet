import { Ellipsis } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { t } from "../i18n";

/** Disclosure keeps infrequent controls mounted, including their confirmation dialogs. */
export function SessionActions({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || ref.current?.contains(event.target)) return;
      // A child can render a confirmation through a portal. Let that dialog handle dismissal.
      if (document.querySelector('[role="dialog"], dialog[open]')) return;
      if (ref.current) ref.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !ref.current?.open || document.querySelector('[role="dialog"], dialog[open]')) return;
      ref.current.open = false;
      ref.current.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, []);
  return <details ref={ref} className="session-actions-menu">
    <summary className="icon-button" aria-label={t("更多会话操作")} title={t("更多会话操作")}><Ellipsis size={20} /></summary>
    <div className="session-actions-popover">{children}</div>
  </details>;
}
