// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompatibilityProfileCard, MachineSummaryHeader, RemoveMachineDialog, SessionInspector, SessionList } from "./App";
import type { CodexCompatibilityProfile, FleetSession, Machine, Project, SessionDetail } from "./lib/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function session(id: string, projectId: string, title: string, updatedAt: string): FleetSession {
  return {
    id,
    title,
    machineId: "machine-1",
    machineName: "linux-host",
    projectId,
    projectAlias: projectId,
    nativeThreadId: `native-${id}`,
    historyMode: "legacy",
    state: {
      ownership: "external_owned",
      threadRuntime: "idle",
      currentTurn: "none",
      waitReason: "none",
      reachability: "live",
      history: "metadata_only",
      unknownFreeze: false,
    },
    lastActivityAt: updatedAt,
    sessionSeq: 0,
    projectionEpoch: 1,
    contentEpoch: 1,
    executionSegmentId: `segment-${id}`,
    threadControlVersion: 1,
    turnControlVersion: 1,
    projectLeaseVersion: 1,
    controlLeaseVersion: 0,
    queueVersion: 0,
  };
}

describe("SessionList", () => {
  it("renders Codex sessions beneath their inferred projects", () => {
    const projects: Project[] = [
      { id: "alpha", machineId: "machine-1", alias: "alpha-repo", pathHint: "/srv/alpha", syncContent: true, retentionDays: 7 },
      { id: "beta", machineId: "machine-1", alias: "beta-repo", pathHint: "/srv/beta", syncContent: true, retentionDays: 7 },
    ];
    const select = vi.fn();
    render(<SessionList
      sessions={[
        session("a1", "alpha", "Alpha setup", "2026-09-05T00:00:00.000Z"),
        session("b1", "beta", "Beta fix", "2026-09-05T00:02:00.000Z"),
        session("a2", "alpha", "Alpha release", "2026-09-05T00:01:00.000Z"),
      ]}
      projects={projects}
      machineId="machine-1"
      onSelect={select}
      onCreate={() => undefined}
    />);

    const alpha = screen.getByText("alpha-repo").closest("section");
    const beta = screen.getByText("beta-repo").closest("section");
    expect(alpha).not.toBeNull();
    expect(beta).not.toBeNull();
    expect(within(alpha!).getByText("2 个会话")).toBeTruthy();
    expect(within(alpha!).queryByText("Alpha setup")).toBeNull();
    expect(within(alpha!).queryByText("Alpha release")).toBeNull();
    expect(within(beta!).getByText("1 个会话")).toBeTruthy();

    const alphaToggle = within(alpha!).getByRole("button", { name: /alpha-repo/ });
    expect(alphaToggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(alphaToggle);
    expect(alphaToggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(alpha!).getByText("Alpha setup")).toBeTruthy();

    fireEvent.click(within(beta!).getByRole("button", { name: /beta-repo/ }));
    fireEvent.click(screen.getByText("Beta fix"));
    expect(select).toHaveBeenCalledWith("b1");
  });

  it("paginates projects and jumps to the selected session project", async () => {
    const projects: Project[] = Array.from({ length: 9 }, (_, index) => ({
      id: `project-${index + 1}`,
      machineId: "machine-1",
      alias: `Project ${index + 1}`,
      pathHint: `/srv/project-${index + 1}`,
      syncContent: true,
      retentionDays: 7 as const,
    }));
    const sessions = projects.map((project, index) => session(
      `session-${index + 1}`,
      project.id,
      `Session ${index + 1}`,
      `2026-09-05T00:${String(index).padStart(2, "0")}:00.000Z`,
    ));
    const { rerender } = render(<SessionList
      sessions={sessions}
      projects={projects}
      machineId="machine-1"
      onSelect={() => undefined}
      onCreate={() => undefined}
    />);

    expect(screen.getByText("1–8 / 9 个项目")).toBeTruthy();
    expect(screen.queryByText("Project 1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getByText("Project 1")).toBeTruthy();
    expect(screen.queryByText("Session 1")).toBeNull();
    expect(screen.getByText("9–9 / 9 个项目")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    rerender(<SessionList
      sessions={sessions}
      projects={projects}
      machineId="machine-1"
      selectedId="session-1"
      onSelect={() => undefined}
      onCreate={() => undefined}
    />);
    expect(await screen.findByText("Session 1")).toBeTruthy();
  });

  it("revokes a machine and then exposes the local purge command", async () => {
    const machine: Machine = {
      id: "machine-remove",
      name: "build-host",
      hostname: "build-host",
      os: "Linux 6.8",
      arch: "x64",
      identity: "paired",
      reachability: "live",
      compatibility: "compatible",
      capacity: "idle",
      credentialProtectionLevel: "software_protected",
      agentVersion: "0.5.0",
      codexVersion: "0.153.2",
      projects: [],
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const removed = vi.fn(async () => undefined);
    render(<RemoveMachineDialog machine={machine} onClose={() => undefined} onRemoved={removed} onToast={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "确认移除主机" }));
    await screen.findByText("build-host 已断开并隐藏");
    expect(fetchMock).toHaveBeenCalledWith("/api/machines/machine-remove", expect.objectContaining({ method: "DELETE" }));
    await waitFor(() => expect(removed).toHaveBeenCalledOnce());
    expect(screen.getByText(/--uninstall --purge/)).toBeTruthy();
    expect(screen.getByText(/Codex 会话与项目文件不会被删除/)).toBeTruthy();
  });
});

describe("CompatibilityProfileCard", () => {
  it("shows the promoted profile and exact schema evidence", () => {
    const schemaHash = "d3eace08be5dca386bfd1f1e8df650058b4113f1e10870a284d775d75517576a";
    const machine: Machine = {
      id: "machine-compatible",
      name: "build-host",
      hostname: "build-host",
      os: "ubuntu 24.04",
      arch: "x64",
      identity: "paired",
      reachability: "live",
      compatibility: "compatible",
      capacity: "idle",
      credentialProtectionLevel: "software_protected",
      agentVersion: "0.13.0",
      codexVersion: "0.153.2",
      schemaHash: `sha256:${schemaHash}`,
      lastSeenAt: new Date().toISOString(),
      projects: [],
    };
    const profile: CodexCompatibilityProfile = {
      profileVersion: "codex-v2-2026.09.05",
      validationStatus: "verified",
      protocol: "codex-app-server-v2",
      minimumCodexVersion: "0.153.2",
      managedCodexVersion: "0.153.2",
      schemaHash,
      lastValidatedAt: "2026-09-05T02:30:00.000Z",
      upgradePolicy: "when-promoted",
    };

    render(<CompatibilityProfileCard machine={machine} profile={profile} />);
    expect(screen.getByText("兼容档案已验证")).toBeTruthy();
    expect(screen.getByText("SHA-256 一致")).toBeTruthy();
    expect(screen.getByText("codex-v2-2026.09.05")).toBeTruthy();
    expect(screen.getAllByText(new RegExp(schemaHash)).length).toBe(2);
    expect(screen.getByText(/晋升为托管目标后自动切换/)).toBeTruthy();
    expect(screen.getByText(/来源为宿主机时会直接使用本机程序/)).toBeTruthy();
  });
});

describe("MachineSummaryHeader", () => {
  it("edits a display alias while retaining the real hostname", async () => {
    const machine: Machine = {
      id: "machine-alias",
      name: "生产节点",
      hostname: "build-host-01",
      displayAlias: "生产节点",
      os: "ubuntu 24.04",
      arch: "x64",
      identity: "paired",
      reachability: "live",
      compatibility: "compatible",
      capacity: "idle",
      credentialProtectionLevel: "software_protected",
      agentVersion: "0.15.0",
      codexVersion: "0.153.2",
      projects: [],
    };
    const updateAlias = vi.fn(async () => undefined);
    render(<MachineSummaryHeader machine={machine} onAliasChange={updateAlias} />);
    expect(screen.queryByRole("button", { name: "移除主机" })).toBeNull();

    expect(screen.getByText("hostname · build-host-01")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "修改主机显示名称" }));
    const input = screen.getByRole("textbox", { name: "主机显示名称" });
    fireEvent.change(input, { target: { value: "北京构建机" } });
    fireEvent.click(screen.getByRole("button", { name: "保存主机名称" }));
    await waitFor(() => expect(updateAlias).toHaveBeenCalledWith("北京构建机"));
  });
});

describe("SessionInspector host sharing", () => {
  it("offers explicit claim and history sync for an idle legacy host thread", async () => {
    const shared = session("shared", "project-1", "宿主机会话", new Date().toISOString());
    shared.state.ownership = "claimable";
    shared.state.history = "partial";
    const detail: SessionDetail = {
      session: shared,
      events: [],
      approval: null,
      writable: false,
      writeBlockedReason: "先接管并同步这个宿主机会话",
      queue: [],
    };
    const onClaim = vi.fn(async () => undefined);
    render(<SessionInspector detail={detail} loading={false} onRefresh={() => undefined} onClaim={onClaim} onContinueManaged={async () => undefined} onReleaseManagement={async () => undefined} onSend={async () => undefined} onQueue={async () => undefined} onSteer={async () => undefined} onCancelQueued={async () => undefined} onCancel={async () => undefined} onApproval={async () => undefined} />);

    expect(screen.getByText("宿主机共享会话")).toBeTruthy();
    expect(screen.getByText(/继续原来的 Codex 会话/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /接管并同步/ }));
    await waitFor(() => expect(onClaim).toHaveBeenCalledOnce());
  });

  it("resumes the same paginated session instead of replacing it with an empty conversation", async () => {
    const paginated = session("paginated", "project-1", "旧会话", new Date().toISOString());
    paginated.historyMode = "paginated";
    paginated.state.ownership = "claimable";
    const detail: SessionDetail = {
      session: paginated,
      events: [],
      approval: null,
      writable: false,
      writeBlockedReason: "分页历史暂不支持安全接管",
      queue: [],
    };
    const onContinueManaged = vi.fn(async () => undefined);
    const onClaim = vi.fn(async () => undefined);
    render(<SessionInspector detail={detail} loading={false} onRefresh={() => undefined} onClaim={onClaim} onContinueManaged={onContinueManaged} onReleaseManagement={async () => undefined} onSend={async () => undefined} onQueue={async () => undefined} onSteer={async () => undefined} onCancelQueued={async () => undefined} onCancel={async () => undefined} onApproval={async () => undefined} />);

    expect(screen.getByText("宿主机共享会话")).toBeTruthy();
    expect(screen.getByText(/继续原来的 Codex 会话/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /同项目新建会话/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /接管并同步/ }));
    await waitFor(() => expect(onClaim).toHaveBeenCalledOnce());
    expect(onContinueManaged).not.toHaveBeenCalled();
  });

  it("offers management release only for an idle managed thread", async () => {
    const managed = session("managed", "project-1", "已接管会话", new Date().toISOString());
    managed.state.ownership = "agentfleet_owned";
    managed.state.history = "partial";
    const detail: SessionDetail = {
      session: managed,
      events: [],
      approval: null,
      writable: true,
      writeBlockedReason: null,
      releaseManagementSupported: true,
      releaseManagementBlockedReason: null,
      queue: [],
    };
    const onReleaseManagement = vi.fn(async () => undefined);
    render(<SessionInspector detail={detail} loading={false} onRefresh={() => undefined} onClaim={async () => undefined} onContinueManaged={async () => undefined} onReleaseManagement={onReleaseManagement} onSend={async () => undefined} onQueue={async () => undefined} onSteer={async () => undefined} onCancelQueued={async () => undefined} onCancel={async () => undefined} onApproval={async () => undefined} />);

    expect(screen.queryByRole("button", { name: /取得控制权|释放控制权/ })).toBeNull();
    expect(screen.getByText(/可在其他设备继续/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /取消接管/ }));
    expect(onReleaseManagement).not.toHaveBeenCalled();
    expect(screen.getByText(/主机会话、本地和云端历史都会保留/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /确认取消/ }));
    await waitFor(() => expect(onReleaseManagement).toHaveBeenCalledOnce());
  });

  it("explains the required automatic update instead of dispatching to an old agent", () => {
    const managed = session("old-agent", "project-1", "旧 Agent 会话", new Date().toISOString());
    managed.state.ownership = "agentfleet_owned";
    const detail: SessionDetail = {
      session: managed,
      events: [],
      approval: null,
      writable: true,
      writeBlockedReason: null,
      releaseManagementSupported: false,
      releaseManagementBlockedReason: "Agent 0.16.1 正在等待自动更新到 0.16.2 或更高版本",
      queue: [],
    };
    render(<SessionInspector detail={detail} loading={false} onRefresh={() => undefined} onClaim={async () => undefined} onContinueManaged={async () => undefined} onReleaseManagement={async () => undefined} onSend={async () => undefined} onQueue={async () => undefined} onSteer={async () => undefined} onCancelQueued={async () => undefined} onCancel={async () => undefined} onApproval={async () => undefined} />);

    expect(screen.getByText(/Agent 0\.16\.1 正在等待自动更新/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /取消接管/ })).toBeNull();
  });
});
