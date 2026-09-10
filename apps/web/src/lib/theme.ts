import { useSyncExternalStore } from "react";

export type Theme = "cyber" | "daylight" | "midnight" | "forest";

const STORAGE_KEY = "agentfleet.theme";
const themes: Theme[] = ["cyber", "daylight", "midnight", "forest"];
const listeners = new Set<() => void>();

function isTheme(value: string | null): value is Theme {
  return themes.includes(value as Theme);
}

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isTheme(saved)) return saved;
  } catch { /* The default theme remains available when storage is blocked. */ }
  return "cyber";
}

let current = initialTheme();

function updateDocument() {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = current;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", {
    cyber: "#070c17",
    daylight: "#f2f6fb",
    midnight: "#111018",
    forest: "#0d1813",
  }[current]);
}

export const theme = () => current;

export function setTheme(value: Theme) {
  if (!isTheme(value) || value === current) return;
  current = value;
  try { localStorage.setItem(STORAGE_KEY, value); } catch { /* Switching still works for this page. */ }
  updateDocument();
  listeners.forEach(listener => listener());
}

export function useTheme() {
  return useSyncExternalStore(listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, theme, () => "cyber" as Theme);
}

updateDocument();
