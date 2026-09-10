import { t } from "../i18n";
import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export type ConfigurationRequest = { section: "all" | "settings" | "permissions" | "tools" | "help"; nonce: number };

/** Keep controls mounted when closed: unsaved next-turn choices must survive dismissal. */
export function SessionConfiguration({ request, title, onClose, children }: {
  request?: ConfigurationRequest; title: string; onClose: () => void; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!request) { if (element.open) element.close(); return; }
    if (!element.open) element.showModal();
    const selector = { all: "", settings: ".codex-settings-panel", permissions: ".permission-panel", tools: ".composer-tools", help: ".composer-tools" }[request.section];
    const panel = selector ? element.querySelector<HTMLDetailsElement>(selector) : null;
    if (panel) { panel.open = true; panel.scrollIntoView({ block: "nearest" }); }
    if (request.section === "settings") {
      const model = element.querySelector<HTMLSelectElement>(".codex-settings-fields select");
      model?.scrollIntoView({ block: "center" }); model?.focus({ preventScroll: true });
    }
    if (request.section === "help") {
      const guide = element.querySelector<HTMLDetailsElement>(".codex-command-guide");
      if (guide) { guide.open = true; guide.scrollIntoView({ block: "nearest" }); }
    }
  }, [request]);
  return <dialog ref={dialog} className="modal session-config-dialog" aria-label={t("会话配置")} onCancel={onClose} onClose={event => { if (!event.currentTarget.open) onClose(); }} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
  }}>
    <header className="modal-head"><div><h2>{t("会话配置")}</h2><p>{title}</p></div><button type="button" className="icon-button" aria-label={t("关闭会话配置")} onClick={onClose} autoFocus><X size={18} /></button></header>
    <div className="session-config-body">{children}</div>
  </dialog>;
}
