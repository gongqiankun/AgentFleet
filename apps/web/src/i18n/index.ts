import { useSyncExternalStore } from "react";
import english from "./en.json";

export type Locale = "zh-CN" | "en";
const key = "agentfleet.locale";
const listeners = new Set<() => void>();
function initialLocale(): Locale {
  try { const saved = localStorage.getItem(key); if (saved === "en" || saved === "zh-CN") return saved; } catch { /* Storage may be unavailable. */ }
  return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("en") ? "en" : "zh-CN";
}
let current = initialLocale();
export const locale = () => current;
export function setLocale(value: Locale) {
  if (value === current) return;
  current = value;
  try { localStorage.setItem(key, value); } catch { /* The current page can still switch. */ }
  updateDocument();
  listeners.forEach(listener => listener());
}
export function useLocale() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, locale, () => "zh-CN" as Locale);
}
function updateDocument() {
  if (typeof document === "undefined") return;
  document.documentElement.lang = current;
  document.querySelector('meta[name="description"]')?.setAttribute("content", current === "en" ? "AgentFleets for Codex — Manage Codex across your hosts" : "AgentFleets for Codex — 你的 Codex 主机控制面");
  document.querySelector('link[rel="manifest"]')?.setAttribute("href", current === "en" ? "/manifest.en.webmanifest" : "/manifest.webmanifest");
}
updateDocument();
const messages: Record<string, string> = english;
/** Only call for application-owned text, never user content or native output. */
export function t(source: string, ...values: unknown[]): string {
  const template = current === "en" && Object.hasOwn(messages, source) ? messages[source] : source;
  return template.replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < values.length ? String(values[Number(index)] ?? "") : match);
}
/** Lazily rebuild module-level label maps and command catalogs when locale changes. */
export function localized<T extends object>(factory: () => T): T {
  let language = current;
  let value = factory();
  const read = () => { if (language !== current) { language = current; value = factory(); } return value; };
  return new Proxy(value, {
    get: (_target, property) => Reflect.get(read(), property),
    ownKeys: () => Reflect.ownKeys(read()),
    getOwnPropertyDescriptor: (_target, property) => Reflect.getOwnPropertyDescriptor(read(), property),
    has: (_target, property) => Reflect.has(read(), property),
  });
}

const originals = new Map(Object.entries(messages).map(([source, translated]) => [translated, source]));
/** Translate system notices received from the API or already held in component state. */
export function systemText(value: string | null | undefined): string {
  if (!value) return value ?? "";
  const original = originals.get(value) ?? value;
  if (Object.hasOwn(messages, original)) return t(original);
  for (const entry of patterns) {
    const match = entry.pattern.exec(value);
    if (!match) continue;
    const values: string[] = [];
    entry.slots.forEach((slot, index) => { values[slot] = match[index + 1]; });
    return t(entry.source, ...values);
  }
  return value;
}

function pattern(template: string) {
  const slots: number[] = [];
  const parts = template.split(/(\{\d+\})/g).map(part => {
    if (/^\{\d+\}$/.test(part)) { slots.push(Number(part.slice(1, -1))); return "([\\s\\S]*?)"; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return { pattern: new RegExp("^" + parts.join("") + "$"), slots };
}
const patterns = Object.entries(messages).filter(([source]) => /\{\d+\}/.test(source)).flatMap(([source, translated]) => [
  { source, ...pattern(source) }, { source, ...pattern(translated) },
]);

/** Localized counts, including English singular nouns. */
export function count(value: number, unit: "个项目" | "个会话" | "台主机" | "个文件" | "天"): string {
  const names = { "个项目": "project", "个会话": "session", "台主机": "host", "个文件": "file", "天": "day" };
  const number = new Intl.NumberFormat(current).format(value);
  return current === "en" ? `${number} ${names[unit]}${value === 1 ? "" : "s"}` : `${number} ${unit}`;
}
