import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

export function HostDisclosure({ title, description, icon, className = "", children }: { title: string; description: string; icon: ReactNode; className?: string; children: ReactNode }) {
  return <details className={`host-disclosure ${className}`}>
    <summary><span className="host-disclosure__icon" aria-hidden="true">{icon}</span><span className="host-disclosure__heading"><strong>{title}</strong><span>{description}</span></span><ChevronDown className="host-disclosure__chevron" size={19} aria-hidden="true" /></summary>
    <div className="host-disclosure__body">{children}</div>
  </details>;
}
