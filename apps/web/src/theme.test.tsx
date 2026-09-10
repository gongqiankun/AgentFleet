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
    fireEvent.change(screen.getByRole("combobox", { name: "界面主题" }), { target: { value: "eyecare" } });
    expect(document.documentElement.dataset.theme).toBe("eyecare");
    expect(localStorage.getItem("agentfleet.theme")).toBe("eyecare");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#e8e5cf");
    meta.remove();
  });

  it("offers a complete theme picker for settings", () => {
    setTheme("cyber");
    render(<ThemeSettings />);
    const eyecare = screen.getByRole("radio", { name: /护眼/ });
    expect(screen.getAllByRole("radio")).toHaveLength(5);
    fireEvent.click(eyecare);
    expect(eyecare.getAttribute("aria-checked")).toBe("true");
    expect(document.documentElement.dataset.theme).toBe("eyecare");
  });
});
