// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { count, locale, setLocale, systemText, t } from "./index";
import english from "./en.json";
import { codexCommands, coverageLabels } from "../lib/codex-commands";
import { permissionNames } from "../lib/permissions";

describe("application localization", () => {
  it("persists language, updates document language, and refreshes static catalogs", () => {
    setLocale("en");
    expect(locale()).toBe("en");
    expect(localStorage.getItem("agentfleet.locale")).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(permissionNames.project).toBe("Project access");
    expect(codexCommands.find(command => command.name === "model")?.label).toBe("Model and reasoning effort");
    expect(coverageLabels.available).toBe("Available");
    setLocale("zh-CN");
    expect(codexCommands.find(command => command.name === "model")?.label).toBe("模型与推理强度");
    expect(permissionNames.project).toBe("项目内开发");
  });
  it("preserves parameters and unknown diagnostic text", () => {
    setLocale("en");
    expect(t("主机显示名称已改为 {0}", "发送 {1} <script> 主机")).toBe("Host display name changed to 发送 {1} <script> 主机");
    expect(t("__proto__")).toBe("__proto__");
    expect(systemText("constructor")).toBe("constructor");
    expect(systemText("unknown diagnostic: 用户项目 /srv/发送")).toBe("unknown diagnostic: 用户项目 /srv/发送");
    expect(systemText("官方版本检查失败 HTTP 503")).toBe("Official release check failed: HTTP 503");
    expect(systemText("主机刚刚重连，请重新点击解除冻结")).toBe("The host just reconnected. Select Unfreeze again.");
    setLocale("zh-CN");
    expect(systemText("Official release check failed: HTTP 503")).toBe("官方版本检查失败 HTTP 503");
  });
  it("formats singular counts and still switches when storage is blocked", () => {
    const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    try {
      expect(() => setLocale("en")).not.toThrow();
      expect(count(1, "天")).toBe("1 day");
      expect(count(7, "天")).toBe("7 days");
      expect(count(1, "个会话")).toBe("1 session");
    } finally { save.mockRestore(); }
  });
  it("keeps every translated template parameter intact", () => {
    for (const [source, translation] of Object.entries(english)) {
      expect(translation.trim(), source).not.toBe("");
      expect(translation.match(/\{\d+\}/g)?.sort() ?? [], source).toEqual(source.match(/\{\d+\}/g)?.sort() ?? []);
    }
  });
});
