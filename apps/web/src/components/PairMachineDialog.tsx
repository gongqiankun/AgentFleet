import { t, locale, localized } from "../i18n";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CircleCheck,
  Copy,
  LoaderCircle,
  RefreshCw,
  Server,
  ShieldCheck,
  TerminalSquare,
  X,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { enrollmentTicket, onboardCommand, type InstallPlatform } from "../lib/enrollment";
import type { Enrollment, PairingPreview } from "../lib/types";
import { ApiError } from "../lib/types";
import { DiscoveryStatus } from "./DiscoveryStatus";

type ToastTone = "info" | "success" | "danger";
type FlowMode = "guided" | "legacy";
const runInstructions: Record<InstallPlatform, string> = localized(() => ({
  linux: t("在要连接的 Linux 主机上打开终端（远程服务器先通过 SSH 登录），粘贴命令并按回车。"),
  macos: t("在要连接的 Mac 上打开「终端」（应用程序 → 实用工具），粘贴命令并按回车。"),
  windows: t("在要连接的 Windows 主机上打开 PowerShell（或 Windows 终端的 PowerShell 标签页），粘贴命令并按回车，不要在 CMD 中运行。"),
}));

interface PairMachineDialogProps {
  open: boolean;
  initialCode?: string;
  onClose: () => void;
  onPaired: (machineId?: string) => void;
  onToast: (tone: ToastTone, message: string) => void;
}

function errorMessage(error: unknown) {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return t("操作未完成，请重试");
}

function mergeEnrollment(previous: Enrollment, next: Enrollment): Enrollment {
  return {
    ...previous,
    ...next,
    bootstrapSecret: previous.bootstrapSecret,
    claimUrl: next.claimUrl ?? previous.claimUrl,
  };
}

export function shouldPollEnrollment(enrollment: Enrollment | undefined, now = Date.now()): boolean {
  void now;
  return Boolean(
    enrollment &&
    (["pending", "claimed", "confirmed"].includes(enrollment.status) ||
      (enrollment.status === "redeemed" && (!enrollment.machineReady || enrollment.discovery?.state === "scanning"))),
  );
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const temporary = document.createElement("textarea");
  temporary.value = value;
  temporary.setAttribute("readonly", "");
  temporary.style.position = "fixed";
  temporary.style.opacity = "0";
  document.body.appendChild(temporary);
  temporary.select();
  const copied = document.execCommand("copy");
  temporary.remove();
  if (!copied) throw new Error(t("浏览器未允许复制，请手动选中命令"));
}

function remainingLabel(expiresAt: string, now: number) {
  const remaining = Math.max(0, Date.parse(expiresAt) - now);
  if (!Number.isFinite(remaining) || remaining <= 0) return t("即将过期");
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1_000);
  return t("{0}:{1} 后失效", String(minutes).padStart(2, "0"), String(seconds).padStart(2, "0"));
}

function FlowSteps({ copied, claimed, confirmed, ready }: { copied: boolean; claimed: boolean; confirmed: boolean; ready: boolean }) {
  const states = [
    copied || claimed ? "done" : "active",
    claimed ? "done" : copied ? "active" : "idle",
    confirmed ? "done" : claimed ? "active" : "idle",
    ready ? "done" : confirmed ? "active" : "idle",
  ];
  const steps = [
    [t("安装"), t("复制一次命令")],
    [t("验证身份"), t("自动识别主机")],
    [t("连接"), t("启动后台服务")],
    [t("发现项目"), t("同步已有会话")],
  ];
  return (
    <ol className="pair-steps" aria-label={t("配对进度")}>
      {steps.map(([title, detail], index) => (
        <li className={`pair-step pair-step--${states[index]}`} key={title} aria-current={states[index] === "active" ? "step" : undefined}>
          <span className="pair-step__number">{states[index] === "done" ? <Check size={13} /> : index + 1}</span>
          <span><strong>{title}</strong><small>{detail}</small></span>
        </li>
      ))}
    </ol>
  );
}

export function PairMachineDialog({ open, initialCode, onClose, onPaired, onToast }: PairMachineDialogProps) {
  const [mode, setMode] = useState<FlowMode>(initialCode ? "legacy" : "guided");
  const [platform, setPlatform] = useState<InstallPlatform>("linux");
  const [enrollment, setEnrollment] = useState<Enrollment>();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [pollError, setPollError] = useState("");
  const [pollRevision, setPollRevision] = useState(0);
  const [copied, setCopied] = useState(false);
  const [alias, setAlias] = useState("");
  const [verificationChecked, setVerificationChecked] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<PairingPreview>();
  const [busy, setBusy] = useState(false);
  const openRef = useRef(open);
  const creationRef = useRef<ReturnType<typeof api.createEnrollment> | undefined>(undefined);
  const creationGenerationRef = useRef(0);
  const dialogRef = useRef<HTMLElement>(null);
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(busy);
  const onCloseRef = useRef(onClose);
  const onPairedRef = useRef(onPaired);
  const onToastRef = useRef(onToast);
  const enrollmentRef = useRef(enrollment);
  const wasOpenRef = useRef(open);
  const completionRef = useRef(false);

  openRef.current = open;
  busyRef.current = busy;
  onCloseRef.current = onClose;
  onPairedRef.current = onPaired;
  onToastRef.current = onToast;
  enrollmentRef.current = enrollment;

  useEffect(() => {
    if (wasOpenRef.current && !open) {
      creationGenerationRef.current += 1;
      const current = enrollmentRef.current;
      if (current?.id && ["pending", "claimed", "confirmed"].includes(current.status)) {
        void api.cancelEnrollment(current.id).catch(() => undefined);
      }
      completionRef.current = false;
    }
    wasOpenRef.current = open;
  }, [open]);

  async function beginEnrollment(force = false) {
    setMode("guided");
    setCopied(false);
    setAlias("");
    setVerificationChecked(false);
    setCreateError("");
    setPollError("");
    setCreating(true);
    if (force) {
      creationGenerationRef.current += 1;
      creationRef.current = undefined;
      const current = enrollmentRef.current;
      if (current?.id && ["pending", "claimed", "confirmed"].includes(current.status)) {
        try {
          await api.cancelEnrollment(current.id);
        } catch (error) {
          if (openRef.current) {
            setCreateError(t("旧票据未能注销：{0}", errorMessage(error)));
            setCreating(false);
          }
          return;
        }
      }
    }
    setEnrollment(undefined);
    const generation = creationGenerationRef.current;
    const request = creationRef.current ?? api.createEnrollment();
    creationRef.current = request;
    try {
      const result = await request;
      if (!openRef.current || generation !== creationGenerationRef.current) {
        if (result.enrollment.id) void api.cancelEnrollment(result.enrollment.id).catch(() => undefined);
        return;
      }
      if (!result.enrollment.id || !result.enrollment.bootstrapSecret) {
        throw new Error(t("控制面没有返回完整的一次性安装票据"));
      }
      setEnrollment(result.enrollment);
    } catch (error) {
      if (openRef.current && generation === creationGenerationRef.current) setCreateError(errorMessage(error));
    } finally {
      if (openRef.current && generation === creationGenerationRef.current) setCreating(false);
    }
  }

  useEffect(() => {
    if (!open) {
      creationRef.current = undefined;
      setEnrollment(undefined);
      setPreview(undefined);
      setCode("");
      return;
    }
    setCode(initialCode ?? "");
    setPreview(undefined);
    setVerificationChecked(false);
    if (initialCode) {
      setMode("legacy");
      return;
    }
    void beginEnrollment();
  }, [open, initialCode]);

  useEffect(() => {
    if (!open) return;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => dialogRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) onCloseRef.current();
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []).filter((element) => element.offsetParent !== null);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialogRef.current?.focus();
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", handleKeyDown);
      returnFocus?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open || !enrollment?.id || !["pending", "claimed", "confirmed"].includes(enrollment.status)) return;
    const expiresAt = Date.parse(enrollment.expiresAt);
    if (!Number.isFinite(expiresAt)) return;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      setPollRevision((value) => value + 1);
      return;
    }
    const timer = window.setTimeout(() => setPollRevision((value) => value + 1), remaining);
    return () => window.clearTimeout(timer);
  }, [open, enrollment?.id, enrollment?.status, enrollment?.expiresAt]);

  useEffect(() => {
    if (!open || mode !== "guided" || !enrollment?.id || !shouldPollEnrollment(enrollment)) return;
    let cancelled = false;
    let timer: number | undefined;
    let failures = 0;
    let activeController: AbortController | undefined;

    const poll = async () => {
      if (cancelled) return;
      const controller = new AbortController();
      activeController = controller;
      try {
        const result = await api.enrollment(enrollment.id, controller.signal);
        if (cancelled) return;
        failures = 0;
        setPollError("");
        setEnrollment((current) => current ? mergeEnrollment(current, result.enrollment) : current);
        if (shouldPollEnrollment(result.enrollment)) timer = window.setTimeout(poll, 1_500);
      } catch (error) {
        if (cancelled) return;
        failures += 1;
        if (failures >= 3) {
          setPollError(errorMessage(error));
          return;
        }
        timer = window.setTimeout(poll, 2_500);
      }
    };

    timer = window.setTimeout(poll, 900);
    return () => {
      cancelled = true;
      activeController?.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [open, mode, enrollment?.id, enrollment?.status, enrollment?.expiresAt, enrollment?.machineReady, pollRevision]);

  const ticket = useMemo(() => {
    if (!enrollment?.id || !enrollment.bootstrapSecret) return "";
    return enrollmentTicket(enrollment.id, enrollment.bootstrapSecret);
  }, [enrollment?.id, enrollment?.bootstrapSecret]);
  const command = useMemo(() => ticket ? onboardCommand(location.origin, ticket, platform) : "", [ticket, platform]);
  const claimed = enrollment?.status === "claimed" || enrollment?.status === "confirmed" || enrollment?.status === "redeemed";
  const browserConfirmed = enrollment?.status === "confirmed" || enrollment?.status === "redeemed";
  const ticketTimeElapsed = Boolean(
    enrollment &&
    ["pending", "claimed", "confirmed"].includes(enrollment.status) &&
    Number.isFinite(Date.parse(enrollment.expiresAt)) &&
    now >= Date.parse(enrollment.expiresAt),
  );
  const credentialRecoveryElapsed = Boolean(
    enrollment?.status === "redeemed" &&
    !enrollment.machineReady &&
    enrollment.recoveryExpiresAt &&
    Number.isFinite(Date.parse(enrollment.recoveryExpiresAt)) &&
    now >= Date.parse(enrollment.recoveryExpiresAt),
  );

  useEffect(() => {
    if (!open || enrollment?.status !== "redeemed" || !enrollment.machineReady || completionRef.current) return;
    completionRef.current = true;
    creationRef.current = undefined;
    onToastRef.current("success", t("{0} 已安全连接", enrollment.machineName ?? t("目标主机")));
    setAlias(enrollment.machineName ?? "");
    onPairedRef.current(enrollment.machineId);
  }, [open, enrollment?.status, enrollment?.machineReady, enrollment?.machineName]);

  useEffect(() => {
    if (command && !claimed) copyButtonRef.current?.focus();
  }, [ticket, claimed]);

  if (!open) return null;

  async function lookup(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.pairingPreview(code.replace(/\s/g, "").toUpperCase());
      setPreview(result.pairing);
    } catch (error) {
      onToast("danger", errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function confirmLegacy() {
    if (!preview) return;
    setBusy(true);
    try {
      await api.confirmPairing(preview.id, preview.verificationPhrase);
      onToast("success", t("{0} 已安全配对", preview.machineName));
      onPaired();
      onClose();
    } catch (error) {
      onToast("danger", errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const guidedExpired = enrollment?.status === "expired" || enrollment?.status === "cancelled";
  const verificationReady = (enrollment?.status === "claimed" || enrollment?.status === "confirmed") && Boolean(enrollment.verificationPhrase && enrollment.fingerprint);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !busy) onClose(); }}>
      <section ref={dialogRef} className="modal modal--pair" role="dialog" aria-modal="true" aria-labelledby="pair-title" aria-describedby="pair-description" tabIndex={-1}>
        <div className="modal-head">
          <div>
            <div className="eyebrow">Secure host enrollment</div>
            <h2 id="pair-title">{t("连接 Codex 主机")}</h2>
            <p id="pair-description">{t("选择要连接的主机系统，在装有 Codex 的那台主机运行命令；连接后自动发现已有项目和会话。")}</p>
          </div>
          <button className="icon-button" aria-label={t("关闭")} title={t("关闭")} onClick={onClose} disabled={busy} type="button"><X size={18} /></button>
        </div>

        {mode === "guided" ? (
          <>
            <FlowSteps copied={copied} claimed={claimed} confirmed={browserConfirmed} ready={enrollment?.discovery?.state === "ready"} />
            <div className="platform-tabs" role="tablist" aria-label={t("目标主机系统")}>
              {([['linux', 'Linux'], ['macos', 'macOS'], ['windows', 'Windows']] as const).map(([value, label]) => (
                <button type="button" role="tab" aria-label={label} aria-selected={platform === value} tabIndex={platform === value ? 0 : -1} className={platform === value ? "platform-tab platform-tab--active" : "platform-tab"} key={value} disabled={claimed} onClick={() => { setPlatform(value); setCopied(false); }} onKeyDown={(event) => {
                  const choices: InstallPlatform[] = ["linux", "macos", "windows"];
                  const index = choices.indexOf(value);
                  const next = event.key === "ArrowRight" ? (index + 1) % 3 : event.key === "ArrowLeft" ? (index + 2) % 3 : event.key === "Home" ? 0 : event.key === "End" ? 2 : undefined;
                  if (next === undefined) return;
                  event.preventDefault(); setPlatform(choices[next]); setCopied(false);
                  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
                }}><span>{label}</span><small>{platform === value ? <><Check size={13} aria-hidden="true" />{t("已选择")}</> : t("点击选择")}</small></button>
              ))}
            </div>
            {enrollment?.machineReady ? (
              <section className="pair-complete"><CircleCheck size={28} /><h3>{enrollment.machineName} {locale() === "en" ? " " : ""}{t("已连接")}</h3><DiscoveryStatus discovery={enrollment.discovery} /><form className="stack-form" onSubmit={async (event) => { event.preventDefault(); if (!enrollment.machineId) return; setBusy(true); try { if (alias.trim() !== enrollment.machineName) await api.updateMachineAlias(enrollment.machineId, alias.trim() || null); onPaired(enrollment.machineId); onClose(); } catch (error) { onToast("danger", errorMessage(error)); } finally { setBusy(false); } }}><label><span>{t("主机显示名称")}</span><input aria-label={t("新主机显示名称")} value={alias} maxLength={80} onChange={(event) => setAlias(event.target.value)} /></label><button type="submit" className="button button--primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />}{locale() === "en" ? " " : ""}{t("查看项目")}</button></form></section>
            ) : creating ? (
              <div className="pair-loading" aria-live="polite"><LoaderCircle className="spin" size={19} /><div><strong>{t("正在签发一次性票据")}</strong><span>{t("票据只保存在当前窗口，有效期很短。")}</span></div></div>
            ) : createError ? (
              <div className="pair-create-error" role="alert">
                <AlertTriangle size={18} />
                <div><strong>{t("暂时无法生成连接命令")}</strong><span>{createError}</span></div>
                <button className="button button--quiet" type="button" onClick={() => void beginEnrollment(true)}><RefreshCw size={15} />{t("重试")}</button>
              </div>
            ) : command && enrollment ? (
              <>
                <p className="pair-run-location" id="install-run-location" role="status"><strong>{t("在哪里运行：")}</strong>{runInstructions[platform]}</p>
                <section className={`connection-receipt${claimed ? " connection-receipt--claimed" : ""}`} aria-label={t("主机连接回执")}>
                  <header>
                    <span className="terminal-lights" aria-hidden="true"><i /><i /><i /></span>
                    <code>agentfleet / secure enrollment</code>
                    <span className="receipt-expiry">{remainingLabel(enrollment.expiresAt, now)}</span>
                  </header>
                  <div className="receipt-command">
                    <span aria-hidden="true">$</span>
                    <code>{command}</code>
                    <button ref={copyButtonRef} type="button" className="receipt-copy" disabled={ticketTimeElapsed} onClick={async () => {
                      try {
                        await copyText(command);
                        setCopied(true);
                        onToast("success", t("命令已复制，在目标 {0} 主机粘贴运行", platform === "macos" ? "macOS" : platform === "windows" ? "Windows PowerShell" : "Linux"));
                      } catch (error) {
                        onToast("danger", errorMessage(error));
                      }
                    }} aria-label={copied ? t("命令已复制") : t("复制安装命令")} aria-describedby="install-run-location">
                      {copied ? <Check size={15} /> : <Copy size={15} />}{copied ? t("已复制") : t("复制")}
                    </button>
                  </div>
                  <div className="receipt-trace" aria-live="polite">
                    <div className={`receipt-line ${copied || claimed ? "receipt-line--done" : "receipt-line--active"}`}>
                      {copied || claimed ? <Check size={13} /> : <TerminalSquare size={13} />}
                      <span>{t("安装命令")}</span><strong>{copied || claimed ? t("已复制") : t("等待复制")}</strong>
                    </div>
                    <div className={`receipt-line ${claimed ? "receipt-line--done" : copied ? "receipt-line--waiting" : "receipt-line--idle"}`}>
                      {claimed ? <Check size={13} /> : copied ? <LoaderCircle className="spin" size={13} /> : <span className="receipt-node" />}
                      <span>{t("加密 Relay")}</span><strong>{claimed ? t("身份声明已收到") : copied ? t("等待出站 HTTPS") : t("尚未连接")}</strong>
                    </div>
                    <div className={`receipt-line ${claimed ? "receipt-line--done" : "receipt-line--idle"}`}>
                      {claimed ? <Check size={13} /> : <span className="receipt-node" />}
                      <span>{t("Codex 主机")}</span><strong>{claimed ? enrollment.machineName ?? t("已识别主机") : t("自动识别运行账号与 Codex 环境")}</strong>
                    </div>
                  </div>
                </section>

                <div className="pair-download-note">
                  <ShieldCheck size={15} />
                  <span>{t("安装器会校验发布文件；也可")}<a href="/downloads/manifest.json" target="_blank" rel="noreferrer">{t("手动下载并核对 SHA-256")}</a>。</span>
                </div>

                {pollError && (
                  <div className="pair-inline-error" role="alert"><AlertTriangle size={15} /><span>{t("连接状态读取中断：")}{locale() === "en" ? " " : ""}{pollError}</span><button type="button" onClick={() => { setPollError(""); setPollRevision((value) => value + 1); }}>{t("继续检测")}</button></div>
                )}

                {guidedExpired ? (
                  <div className="pair-expired" role="alert"><AlertTriangle size={18} /><div><strong>{t("这条命令已失效")}</strong><span>{t("重新生成后，请复制新命令；旧票据不能再次使用。")}</span></div><button className="button button--primary" type="button" onClick={() => void beginEnrollment(true)}><RefreshCw size={15} />{t("生成新命令")}</button></div>
                ) : enrollment.status === "redeemed" && (enrollment.machineReachability === "online" || enrollment.discovery?.state === "error") ? (
                  <section className="pair-loading" role="status"><div><strong>{enrollment.discovery?.readiness === "action_required" || enrollment.discovery?.state === "error" ? t("主机已连接，自检发现需要处理的问题") : t("主机已连接，正在检查运行环境并扫描会话")}</strong><span>{t("连接凭据已保存，不需要删除主机或重新生成安装命令。")}</span><DiscoveryStatus discovery={enrollment.discovery} /><button type="button" className="button button--primary" onClick={() => { onPaired(enrollment.machineId); onClose(); }}>{t("查看主机与自检结果")}</button></div></section>
                ) : credentialRecoveryElapsed ? (
                  <div className="pair-loading" role="status"><LoaderCircle className="spin" size={19} /><div><strong>{t("仍在等待目标主机上线")}</strong><span>{t("若终端已显示配对完成，请重跑上方原命令以继续服务安装；只有终端明确报告恢复期已结束时，才关闭窗口后生成新票据。")}</span></div></div>
                ) : enrollment.status === "redeemed" && !enrollment.machineReady ? (
                  <div className="pair-loading" role="status"><LoaderCircle className="spin" size={19} /><div><strong>{t("凭据已签发，正在等待目标主机上线")}</strong><span>{t("终端正在启动后台服务；上线后 Agent 会立即发现 Codex 项目和会话。")}</span></div></div>
                ) : ticketTimeElapsed ? (
                  <div className="pair-expired" role="status"><LoaderCircle className="spin" size={18} /><div><strong>{t("有效期已到，正在核对最终状态")}</strong><span>{t("暂不生成新票据，避免覆盖可能已经完成的连接。")}</span></div>{pollError && <button className="button button--quiet" type="button" onClick={() => { setPollError(""); setPollRevision((value) => value + 1); }}><RefreshCw size={15} />{t("继续核对")}</button>}</div>
                ) : verificationReady ? (
                  <section className="pair-verification" aria-labelledby="verify-title">
                    <div className="pair-machine">
                      <span className="pair-machine__icon"><Server size={21} /></span>
                      <div><span>{t("已识别 Codex 主机")}</span><strong>{enrollment.machineName}</strong><small>{enrollment.os} · {enrollment.arch}</small></div>
                    </div>
                    <div className="verify-block">
                      <span id="verify-title">{t("主机身份已验证，正在自动完成连接")}</span>
                      <strong>{enrollment.verificationPhrase}</strong>
                      <code title={enrollment.fingerprint}>{enrollment.fingerprint}</code>
                    </div>
                    <p className="modal-note">{t("正在启动主机服务，无需再次确认。")}</p>
                  </section>
                ) : (
                  <p className="modal-note">{t("命令将自动安装并连接主机；上线后会立即发现 Codex 项目和会话，无需安装 npm 或开放入站端口。")}</p>
                )}
              </>
            ) : null}
            <button className="pair-legacy-link" type="button" onClick={() => {
              const current = enrollmentRef.current;
              if (current?.id && ["pending", "claimed", "confirmed"].includes(current.status)) {
                void api.cancelEnrollment(current.id).catch(() => undefined);
              }
              setMode("legacy");
              setEnrollment(undefined);
              creationRef.current = undefined;
            }}>{t("已经从旧版终端获得配对码？")}</button>
          </>
        ) : (
          <section className="legacy-pairing">
            <button className="pair-back-link" type="button" onClick={() => void beginEnrollment(true)}><ArrowRight size={14} />{t("使用一条命令自动连接")}</button>
            {!preview ? (
              <>
                <div className="terminal-instruction"><TerminalSquare size={19} /><div><span>{t("旧版 Local Agent")}</span><code>agentfleet pair --url {location.origin} --name "$(hostname)"</code></div></div>
                <form className="pair-code-form" onSubmit={lookup}>
                  <label><span>{t("终端显示的用户码")}</span><input value={code} onChange={(event) => setCode(event.target.value)} placeholder="ABCD-EFGH" autoComplete="one-time-code" maxLength={9} spellCheck={false} autoFocus required /></label>
                  <button className="button button--primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />}{locale() === "en" ? " " : ""}{t("核对主机")}</button>
                </form>
                <p className="modal-note">{t("用户码只用于兼容旧版连接流程，不能单独成为机器凭证。")}</p>
              </>
            ) : (
              <>
                <div className="pair-machine"><span className="pair-machine__icon"><Server size={21} /></span><div><span>{t("待配对主机")}</span><strong>{preview.machineName}</strong><small>{preview.os} · {preview.arch}</small></div></div>
                <div className="verify-block"><span>{t("两端必须显示完全相同的校验短语")}</span><strong>{preview.verificationPhrase}</strong><code>{preview.fingerprint}</code></div>
                <label className="confirm-check"><input type="checkbox" checked={verificationChecked} onChange={(event) => setVerificationChecked(event.target.checked)} /><span>{t("我已在主机终端逐字核对校验短语和公钥指纹")}</span></label>
                <div className="modal-actions"><button className="button button--quiet" type="button" onClick={() => { setPreview(undefined); setVerificationChecked(false); }}>{t("返回")}</button><button className="button button--primary" type="button" disabled={busy || !verificationChecked} onClick={() => void confirmLegacy()}><ShieldCheck size={16} />{t("确认配对")}</button></div>
              </>
            )}
          </section>
        )}
      </section>
    </div>
  );
}
