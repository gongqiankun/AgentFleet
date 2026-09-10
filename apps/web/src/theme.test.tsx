// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ThemeSettings, ThemeSwitcher } from "./components/ThemeSwitcher";
import { setTheme } from "./lib/theme";

afterEach(() => {
  cleanup();
  setTheme("cyber");
  localStorage.clear();
});

describe("theme switching", () => {
  it("uses cyber by default and persists a selected theme", () => {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.append(meta);
    setTheme("cyber");
    render(<ThemeSwitcher />);
    fireEvent.change(screen.getByRole("combobox", { name: "界面主题" }), { target: { value: "daylight" } });
    expect(document.documentElement.dataset.theme).toBe("daylight");
    expect(localStorage.getItem("agentfleet.theme")).toBe("daylight");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#f2f6fb");
    meta.remove();
  });

  it("offers a complete theme picker for settings", () => {
    setTheme("cyber");
    render(<ThemeSettings />);
    const forest = screen.getByRole("radio", { name: /森林/ });
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    fireEvent.click(forest);
    expect(forest.getAttribute("aria-checked")).toBe("true");
    expect(document.documentElement.dataset.theme).toBe("forest");
  });
});
