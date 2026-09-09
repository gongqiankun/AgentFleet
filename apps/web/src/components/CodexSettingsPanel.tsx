import { t, locale, systemText } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { CodexPreferences, CodexSettings, RuntimeSettings } from "../lib/codex-settings";

export type RuntimeChoice = { sessionId: string; settings?: CodexSettings };
const ignoreChoice = (_choice: RuntimeChoice) => {};
export function CodexSettingsPanel({ sessionId = "", machineId, observed, onChange = ignoreChoice }: { sessionId?: string; machineId?: string; observed?: RuntimeSettings | null; onChange?: (choice: RuntimeChoice) => void }) {
  const [data, setData] = useState<CodexPreferences>();
  const [choice, setChoice] = useState<CodexSettings>();
  const [scope, setScope] = useState<"machine" | "project" | "session">(machineId ? "machine" : "session");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const controller = new AbortController(); const current = ++generation.current;
    setData(undefined); setChoice(undefined); setMessage(""); setBusy(false); setScope(machineId ? "machine" : "session");
    onChange({ sessionId });
    void Promise.resolve().then(() => machineId ? api.machineCodexPreferences(machineId, controller.signal) : api.codexPreferences(sessionId, controller.signal)).then((next) => {
      if (controller.signal.aborted || current !== generation.current) return;
      setData(next); setChoice(next.desired ?? undefined); onChange({ sessionId, settings: next.desired ?? undefined });
    }).catch((error) => { if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : t("读取配置失败")); });
    return () => { controller.abort(); generation.current += 1; };
  }, [sessionId, machineId, onChange, retry]);
  const select = (next?: CodexSettings) => { setChoice(next); onChange({ sessionId, settings: next }); };
  const model = data?.catalog?.models.find((item) => item.model === choice?.model);
  const valid = Boolean(model && !data?.catalog?.error && (!choice?.effort || model.efforts.includes(choice.effort)) && (!choice?.mode || data?.catalog?.modes.includes(choice.mode))
    && (choice?.serviceTier == null || model.serviceTiers?.some((tier) => tier.id === choice.serviceTier))
    && (!choice?.personality || (model.supportsPersonality && ["none", "friendly", "pragmatic"].includes(choice.personality))));
  async function save(inherit = false) {
    if (!data || busy || (!inherit && !valid)) return;
    const current = generation.current; setBusy(true); setMessage("");
    try {
      const input = { settings: inherit ? null : choice!, revision: data.preferences[scope].revision };
      const next = machineId ? await api.saveMachineCodexPreferences(machineId, input) : await api.saveCodexPreferences(sessionId, { scope, ...input });
      if (current !== generation.current) return;
      setData(next); select(next.desired ?? undefined); setMessage(t("面板配置已保存；下次发送时应用，不修改正在运行的任务。"));
    } catch (error) { if (current === generation.current) setMessage(error instanceof Error ? error.message : t("保存失败")); }
    finally { if (current === generation.current) setBusy(false); }
  }
  const labels = { machine: t("主机默认"), project: t("项目默认"), session: t("会话覆盖"), codex: t("Codex 自身配置") };
  const changed = data && JSON.stringify(choice ?? null) !== JSON.stringify(data.desired);
  const summary = data ? `${changed ? t("未保存的选择") : labels[data.source]} · ${choice?.model ?? t("继承 Codex")} · ${choice?.effort ?? t("继承强度")} · ${choice?.mode === "plan" ? t("计划") : choice?.mode === "default" ? t("执行") : t("继承模式")}` : t("读取中");
  const content = <>
    {!machineId && <p>{t("Codex 程序版本不是模型名称。以下设置仅用于新一轮，不改变历史消息。")}</p>}
    {machineId ? <p>{t("新会话和未单独覆盖的会话继承这里；会话覆盖优先，其次是已有项目配置。不修改宿主机 config.toml 或正在运行的任务。")}</p> : <p>{t("下次发送：")}{locale() === "en" ? " " : ""}{choice ? `${choice.model} · ${choice.effort ?? t("继承强度")} · ${choice.mode === "plan" ? t("计划") : choice.mode === "default" ? t("执行") : t("继承模式")}` : t("不附加覆盖，沿用 Codex 当前配置")}{locale() === "en" ? " " : ""}{t("。更改主机统一默认值请到主机页。")}</p>}
    {observed?.observed && <p>{t("最近读取：")}{locale() === "en" ? " " : ""}{observed.observed.model} · {observed.observed.effort ?? t("强度未上报")} · {new Date(observed.observed.observedAt).toLocaleString(locale())}</p>}
    {observed?.accepted && <p>{t("主机上次接受：")}{locale() === "en" ? " " : ""}{observed.accepted.model} · {observed.accepted.effort ?? t("继承强度")} · {observed.accepted.mode === "plan" ? t("计划模式") : observed.accepted.mode === "default" ? t("执行模式") : t("继承模式")}{locale() === "en" ? " " : ""}{t("（不代表提供方绝无模型回退）")}</p>}
    {observed?.accepted && (observed.accepted.serviceTier !== undefined || observed.accepted.personality) && <p>{t("上次接受的服务档位：")}{locale() === "en" ? " " : ""}{observed.accepted.serviceTier === null ? t("默认") : observed.accepted.serviceTier ?? t("继承")} {locale() === "en" ? " " : ""}{t("· 沟通风格：")}{locale() === "en" ? " " : ""}{observed.accepted.personality ?? t("继承")}{locale() === "en" ? " " : ""}{t("。这不是用量或计费确认。")}</p>}
    {!data ? <p>{t("配置尚未读取。")}</p> : !data.catalog || data.catalog.error ? <p>{t("此主机暂未提供可用模型列表。请升级 Agent 或在主机页重连运行时。")}{locale() === "en" ? " " : ""}{data.catalog?.error}</p> : <>
      {!machineId && <p>{t("已保存的来源：")}{locale() === "en" ? " " : ""}{labels[data.source]}{locale() === "en" ? " " : ""}{t("。展开后可直接修改下方选项，用于下次发送；保存后作为此会话的独立配置。")}</p>}
      {changed && <p role="status">{machineId ? t("修改尚未保存，不影响会话默认值。") : t("当前选择尚未保存：仅用于下次发送，刷新后恢复已保存配置。")}</p>}
      {!machineId && <p>{t("模型目录读取于")}{locale() === "en" ? " " : ""}{new Date(data.catalog.fetchedAt).toLocaleString(locale())}{locale() === "en" ? " " : ""}{t("。账号或模型权限变化后，请在主机页重连运行时。取消已保存的默认配置需清除对应范围的覆盖。")}</p>}
      <div className="codex-settings-fields">
      <label>{t("模型")}<select aria-label={machineId ? t("主机默认模型") : t("会话模型")} value={choice?.model ?? ""} onChange={(event) => {
        const next = data.catalog!.models.find((item) => item.model === event.target.value);
        select(next ? { model: next.model, ...(next.defaultEffort ? { effort: next.defaultEffort } : {}) } : undefined);
      }}><option value="">{t("不覆盖，继承 Codex 当前配置")}</option>{choice && !model && <option value={choice.model}>{choice.model}{locale() === "en" ? " " : ""}{t("（主机当前未提供）")}</option>}{data.catalog.models.map((item) => <option key={item.model} value={item.model}>{item.displayName}</option>)}</select></label>
      <label>{t("推理强度")}<select aria-label={t("推理强度")} disabled={!model} value={choice?.effort ?? ""} onChange={(event) => select({ ...choice!, effort: event.target.value || undefined })}><option value="">{t("继承")}</option>{model?.efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}</select></label>
      <label>{t("协作模式")}<select aria-label={t("协作模式")} disabled={!model || !data.catalog.modes.length} value={choice?.mode ?? ""} onChange={(event) => select({ ...choice!, mode: event.target.value as CodexSettings["mode"] || undefined })}><option value="">{t("继承")}</option>{data.catalog.modes.filter((mode) => mode === "default" || mode === "plan").map((mode) => <option key={mode} value={mode}>{mode === "plan" ? t("计划") : t("执行")}</option>)}</select></label>
      <label>{t("服务档位")}<select aria-label={t("服务档位")} disabled={!model} value={choice?.serviceTier === null ? "__default" : choice?.serviceTier ?? ""} onChange={(event) => select({ ...choice!, serviceTier: event.target.value === "__default" ? null : event.target.value || undefined })}><option value="">{t("继承当前档位")}</option><option value="__default">{t("恢复默认档位")}</option>{model?.serviceTiers?.map((tier) => <option key={tier.id} value={tier.id}>{tier.name}</option>)}</select></label>
      <label>{t("沟通风格")}<select aria-label={t("沟通风格")} disabled={!model?.supportsPersonality} value={choice?.personality ?? ""} onChange={(event) => select({ ...choice!, personality: event.target.value as CodexSettings["personality"] || undefined })}><option value="">{t("继承")}</option><option value="none">{t("不指定风格")}</option><option value="friendly">{t("友好")}</option><option value="pragmatic">{t("务实")}</option></select></label>
      </div>
      {!data.catalog.modes.length && <p>{t("当前运行时未提供模式切换能力。")}</p>}
      <p>{t("服务档位仅列出主机支持项，可能影响额度或费用；未提供快速档位时不能强制开启。")}</p>
      {model && !model.supportsPersonality && <p>{t("当前模型未声明支持沟通风格配置。")}</p>}
      {data.catalog.modeNotice && <p>{data.catalog.modeNotice} {locale() === "en" ? " " : ""}{t("请更新这台主机的 AgentFleets 连接服务后重新读取；仅刷新网页不会升级主机。")}</p>}
      {choice && !valid && <p role="alert">{t("所选配置在当前主机不可用，请重新选择。主机会拒绝不支持的配置。")}</p>}
      {!machineId && <label>{t("保存范围")}<select aria-label={t("配置保存范围")} value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="session">{t("仅此会话")}</option><option value="project">{t("此项目中未单独覆盖的会话")}</option></select></label>}
      <div className="codex-settings-save"><button type="button" className={`button ${machineId ? "button--primary" : "button--quiet"}`} disabled={busy || !valid} onClick={() => void save()}>{machineId ? t("保存主机默认配置") : scope === "session" ? t("保存为此会话配置") : t("保存为项目默认配置")}</button><button type="button" className="button button--quiet" disabled={busy} onClick={() => void save(true)}>{machineId ? t("清除主机默认配置") : t("恢复继承（清除此范围覆盖）")}</button></div>
      {!machineId && data.preferences.project.settings && <p>{t("此项目已有独立配置；清除会话覆盖后先继承项目。若要继承主机，请同时清除项目范围覆盖。")}</p>}
    </>}
    {message && <p role="status">{systemText(message)}</p>}
    <button type="button" className="catalog-more" disabled={busy} onClick={() => setRetry((value) => value + 1)}>{t("重新读取配置")}</button>
  </>;
  return machineId ? <section className="codex-settings-panel host-default-settings" aria-label={t("主机默认配置")}>
    <header className="host-default-settings__heading"><div><div className="eyebrow">Codex defaults</div><h2>{t("主机默认配置")}</h2></div><span>{t("统一配置 · 会话可单独覆盖")}</span></header>
    <div className="host-default-settings__current">{summary}</div>{content}
  </section> : <details className="codex-settings-panel session-config-section"><summary><span>{t("运行配置")}<small>{summary}</small></span></summary>{content}</details>;
}
