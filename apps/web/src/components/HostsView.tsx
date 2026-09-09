import { t, locale, localized, systemText } from "../i18n";
import { AlertTriangle, Check, Copy, Download, Info, LoaderCircle, RefreshCw, Stethoscope, Trash2, Unplug } from "lucide-react";
import { ReactNode, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { HostOperation, Machine, MaintenanceType } from "../lib/types";
import { DiscoveryStatus } from "./DiscoveryStatus";
import { CodexSettingsPanel } from "./CodexSettingsPanel";
import { PermissionPanel } from "./PermissionPanel";
import { CodexCommandGuide } from "./CodexCommandGuide";
import { HostCards } from "./HostCards";
import { HostDisclosure } from "./HostDisclosure";
import { HostCodexInventory } from "./HostCodexInventory";
import { RuntimeReleasePanel } from "./RuntimeReleasePanel";
import { HostReadiness } from "./HostReadiness";
import { HostImageStorage } from "./HostImageStorage";

const operationNames: Record<MaintenanceType, string> = localized(() => ({ "images.preview": t("预览会话图片"), "images.clean": t("清理会话图片"), "commands.reconcile": t("核验主机回执"), "session.reconcile": t("解除冻结"), "catalog.refresh": t("重新扫描"), "agent.update": t("检查并更新"), "runtime.reconnect": t("重新连接 Codex"), "diagnostics.collect": t("检查连接") }));
const operationStates: Record<HostOperation["state"], string> = localized(() => ({ accepted: t("等待主机"), running: t("正在处理"), succeeded: t("主机已完成"), failed: t("操作未完成"), unknown: t("结果待核验"), expired: t("操作已过期") }));

export function repairCommand(machine: Machine, origin: string): string {
  const installer = /windows/i.test(machine.os) ? "/install.ps1" : /darwin|macos/i.test(machine.os) ? "/install-macos" : "/install";
  return installer.endsWith("ps1") ? `$i=Join-Path $env:TEMP 'agentfleet-install.ps1'; Invoke-WebRequest '${origin}/install.ps1' -OutFile $i; & $i -Mode Update -Url '${origin}'` : `curl -fsSL '${origin}${installer}' | sh -s -- --update-only --url '${origin}'`;
}

function profileValue(profile: Record<string, unknown> | undefined, ...keys: string[]): string {
  for (const key of keys) { const value = profile?.[key]; if (typeof value === "string" && value) return value; }
  return t("尚未上报");
}

export function HostsView({ machines, selectedId, onSelect, onPair, onRemove, onChanged, renderCompatibility }: { machines: Machine[]; selectedId?: string; onSelect: (id: string) => void; onPair: () => void; onRemove: (machine: Machine) => void; onChanged: () => Promise<void>; renderCompatibility: (machine: Machine) => ReactNode }) {
  const machine = selectedId ? machines.find((item) => item.id === selectedId) : machines[0];
  const [operations, setOperations] = useState<HostOperation[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [alias, setAlias] = useState(machine?.name ?? "");
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [release, setRelease] = useState<Awaited<ReturnType<typeof api.release>>>();
  const mutationRef = useRef(new Map<string, string>());
  const generation = useRef(0);
  useEffect(() => { void api.release().then(setRelease).catch(() => undefined); }, []);
  useEffect(() => { setAlias(machine?.name ?? ""); setSaved(false); setCopied(false); setOperations([]); }, [machine?.id, machine?.name]);
  useEffect(() => {
    if (!machine) return;
    const current = ++generation.current;
    const controller = new AbortController();
    const refresh = async () => { try { const next = await api.hostOperations(machine.id, controller.signal); if (generation.current === current && !controller.signal.aborted) { setOperations(next); setError(""); } } catch (reason) { if (!controller.signal.aborted) setError((reason as Error).message); } };
    void refresh(); const timer = window.setInterval(() => void refresh(), 3_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [machine?.id]);
  const pending = operations.some((operation) => ["accepted", "running"].includes(operation.state));
  async function operate(type: MaintenanceType) {
    if (!machine) return;
    const hostId = machine.id;
    const currentGeneration = generation.current;
    const key = `${hostId}:${type}`;
    const id = mutationRef.current.get(key) ?? crypto.randomUUID();
    mutationRef.current.set(key, id);
    setBusy(true); setError("");
    try { const operation = await api.hostOperation(hostId, type, id); if (generation.current === currentGeneration) setOperations((current) => [operation, ...current.filter((item) => item.id !== operation.id)]); mutationRef.current.delete(key); await onChanged(); }
    catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  }
  if (!machine) return <section className="wide-view"><h1>{selectedId ? t("该主机不存在或已移除") : t("连接你的 Codex 主机")}</h1><p>{selectedId ? t("请选择其他主机，或添加新主机。") : t("一条命令连接，自动发现已有项目和会话。")}</p><HostCards machines={machines} onSelect={onSelect} /><button className="button button--primary" type="button" onClick={onPair}>{t("添加主机")}</button></section>;
  const repair = repairCommand(machine, location.origin);
  return <section className="wide-view hosts-view"><div className="wide-view__heading"><div><h1>{t("主机")}</h1><p>{t("选择一台主机，设置默认模型、修改名称或检查连接。")}</p></div><button className="button button--primary" type="button" onClick={onPair}>{t("添加主机")}</button></div>
    {release?.manifestStatus !== undefined && release.manifestStatus !== "ready" && <p className="catalog-error" role="alert">{t("安装文件暂不可用，添加或更新主机可能失败。")}</p>}
    <HostCards machines={machines} selectedId={machine.id} onSelect={onSelect} />
    <CodexSettingsPanel key={machine.id} machineId={machine.id} />
    <PermissionPanel key={`permissions:${machine.id}`} machineId={machine.id} />
    <HostImageStorage key={`images:${machine.id}`} machineId={machine.id} name={machine.name} />
    <div className="host-workspace"><section className="settings-block"><div className="host-heading"><div><h2>{machine.name}</h2><span>{machine.os} · {machine.arch} · {machine.reachability === "live" ? t("在线") : machine.reachability === "reconciling" ? t("正在同步") : t("离线")}</span></div><button className="button machine-remove-trigger" type="button" onClick={() => onRemove(machine)}><Trash2 size={14} />{t("移除主机")}</button></div>
      <form className="host-alias" onSubmit={async (event) => { event.preventDefault(); setBusy(true); setSaved(false); try { await api.updateMachineAlias(machine.id, alias.trim() || null); await onChanged(); setSaved(true); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); } }}><label>{t("显示名称")}<input value={alias} maxLength={80} onChange={(event) => { setAlias(event.target.value); setSaved(false); }} /></label><button type="submit" className="button button--quiet" disabled={busy}>{saved ? t("已保存") : t("保存名称")}</button></form><p className="subtle">{t("系统主机名：")}{locale() === "en" ? " " : ""}{machine.hostname}</p>
      <DiscoveryStatus discovery={machine.discovery} />
      <div className="host-operation-buttons">{(["diagnostics.collect", "catalog.refresh", "agent.update", "runtime.reconnect"] as MaintenanceType[]).map((type) => <button type="button" className="button button--quiet" key={type} disabled={busy || pending || machine.reachability !== "live" || !machine.maintenanceCapabilities?.includes(type)} title={!machine.maintenanceCapabilities?.includes(type) ? t("当前 Agent 尚未提供此操作") : undefined} onClick={() => void operate(type)}>{type === "agent.update" ? <Download size={15} /> : type === "diagnostics.collect" ? <Stethoscope size={15} /> : type === "runtime.reconnect" ? <Unplug size={15} /> : <RefreshCw size={15} />}{operationNames[type]}</button>)}</div>
      {(!machine.maintenanceCapabilities?.length || machine.reachability !== "live") && <details className="repair-command"><summary>{machine.reachability !== "live" ? t("主机离线时的修复命令") : t("旧版 Agent 升级命令")}</summary><p>{t("在这台主机安装 AgentFleets 的原账号中执行后，会保留已有连接并修复服务。")}</p><code>{repair}</code><button type="button" className="button button--quiet" onClick={async () => { try { await navigator.clipboard.writeText(repair); setCopied(true); } catch { setError(t("复制失败，请手动选中命令复制")); } }}><Copy size={14} />{copied ? t("已复制") : t("复制命令")}</button></details>}
      {error && <p className="catalog-error" role="alert">{systemText(error)}</p>}
      <section className="host-operation-list" aria-label={t("主机操作记录")}><h3>{t("操作记录")}</h3>{operations.length === 0 ? <p className="subtle">{t("还没有维护操作。")}</p> : operations.map((operation) => <article key={operation.id} className={`host-operation host-operation--${operation.state}`}>{["accepted", "running"].includes(operation.state) ? <LoaderCircle className="spin" size={16} /> : operation.state === "succeeded" ? <Check size={16} /> : <AlertTriangle size={16} />}<div><strong>{operationNames[operation.type]}<span>{operationStates[operation.state]}</span></strong>{operation.error && <p>{systemText(operation.error.message)}</p>}{operation.state === "unknown" && <p>{t("等待核验实际主机状态，请勿重复提交。")}</p>}<small>{new Date(operation.updatedAt).toLocaleString(locale())}</small>{operation.result && <details><summary>{t("主机返回详情")}</summary><pre>{JSON.stringify(operation.result, null, 2)}</pre></details>}</div></article>)}</section>
    </section><section className="settings-block host-runtime"><h2>{t("运行状态")}</h2>
      <HostReadiness discovery={machine.discovery} online={machine.reachability === "live"} onAction={type => void operate(type)} disabled={busy || pending} capabilities={machine.maintenanceCapabilities} />
      <dl><div><dt>{t("面板使用的 Codex")}</dt><dd>{!machine.codexVersion || machine.codexVersion === "unknown" ? t("等待主机报告") : machine.codexVersion}</dd></div><div><dt>{t("连接服务版本")}</dt><dd>{machine.agentVersion}</dd></div></dl>
      <HostCodexInventory machine={machine} />
      <p className="host-help">{t("Codex 版本是程序版本，不是模型名称。模型在上方「主机默认配置」中选择，单个会话仍可独立修改。")}</p>
      <details className="host-technical" key={`technical:${machine.id}`}><summary>{t("版本与兼容性详情")}</summary><dl><div><dt>{t("运行账号")}</dt><dd>{profileValue(machine.codexProfile, "account", "username", "osAccount")}</dd></div><div><dt>{t("Codex 数据目录")}</dt><dd>{profileValue(machine.codexProfile, "codexHome")}</dd></div><div><dt>{t("宿主机程序路径")}</dt><dd>{profileValue(machine.codexProfile, "hostCodexPath", "hostPath")}</dd></div><div><dt>{t("面板程序路径")}</dt><dd>{profileValue(machine.codexProfile, "runtimePath", "executablePath", "servicePath")}</dd></div></dl><p className="subtle">{t("面板和主机自装的 Codex 可以使用不同版本，以上均为主机报告的实际值。")}</p>{renderCompatibility(machine)}</details>
    </section></div>
    <RuntimeReleasePanel machine={machine} />
    <CodexCommandGuide key={`commands:${machine.id}`} spacious />
    {release && <HostDisclosure title={t("后台版本信息")} description={t("查看面板构建与已发布的连接服务版本")} icon={<Info size={21} />}><dl className="host-release-facts"><div><dt>{t("当前面板构建")}</dt><dd><code>{release.build}</code></dd></div><div><dt>{t("已发布连接服务")}</dt><dd>{release.agentVersion}</dd></div><div><dt>{t("数据库版本")}</dt><dd>{release.schema}</dd></div></dl></HostDisclosure>}
  </section>;
}
