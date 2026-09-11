import { describe, expect, it } from "vitest";
import { enrollmentTicket, onboardCommand, uninstallCommand } from "./enrollment";

describe("browser initiated enrollment", () => {
  it("keeps the opaque secret out of the control plane URL", () => {
    const ticket = enrollmentTicket("enr_123", "secret-value");
    const command = onboardCommand("https://fleet.example.com/pair?ignored=yes", ticket);

    expect(ticket).toBe("enr_123.secret-value");
    expect(command).toContain("curl -fsSL 'https://fleet.example.com/install' | sh -s --");
    expect(command).toContain("--url 'https://fleet.example.com'");
    expect(command).toContain("--ticket 'enr_123.secret-value'");
    expect(command).toContain('--name "$(hostname)"');
    expect(command).not.toContain('--project');
    expect(command).not.toContain("?ignored=yes");
  });

  it("refuses to create a partial ticket", () => {
    expect(() => enrollmentTicket("enr_123", "")).toThrow("incomplete");
  });

  it("renders native macOS and Windows installation commands", () => {
    const ticket = enrollmentTicket("enr_123", "secret-value");
    expect(onboardCommand("https://fleet.example.com", ticket, "macos"))
      .toContain("https://fleet.example.com/install-macos");
    const windows = onboardCommand("https://fleet.example.com", ticket, "windows");
    expect(windows).toContain("https://fleet.example.com/install.ps1");
    expect(windows).toContain("-Name $env:COMPUTERNAME");
    expect(windows).not.toContain("-Project");
  });
});

it("generates platform-specific uninstall commands without enrollment secrets and makes purge opt-in", () => {
  for (const [platform, path] of [["linux", "/install"], ["macos", "/install-macos"], ["windows", "/install.ps1"]] as const) {
    const command = uninstallCommand("https://fleet.example.com/pair?secret=hidden", platform);
    expect(command).toContain(`https://fleet.example.com${path}'`);
    expect(command).not.toMatch(/hidden|ticket|purge/i);
    expect(command).toContain(platform === "windows" ? "-Mode Uninstall" : "--uninstall");
    expect(uninstallCommand("https://fleet.example.com", platform, true)).toContain(platform === "windows" ? "-Purge" : "--purge");
  }
});
