import { t, systemText } from "../i18n";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Approval } from "../lib/types";

export function CodexInputCard({ request, onChanged }: { request: Approval; onChanged: () => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const expired = Date.parse(request.expiresAt) <= now;
  const questions = request.questions ?? [];
  const valid = questions.length > 0 && questions.every((q) => answers[q.id]?.trim());
  async function submit() {
    if (!valid || expired || busy || sent) return;
    setBusy(true); setError("");
    try {
      await api.command(request.logicalSessionId, { type: "input.respond", clientMutationId: `input-${request.id}-${request.approvalVersion}`,
        precondition: { approvalId: request.id, approvalVersion: request.approvalVersion, actionHash: request.actionHash, appServerEpoch: request.appServerEpoch },
        payload: { answers: Object.fromEntries(questions.map((q) => [q.id, { answers: [answers[q.id]] }])) } });
      setSent(true); onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : t("回答发送失败")); }
    finally { setBusy(false); }
  }
  return <section className="codex-input-card" aria-label={t("Codex 问答")}>
    <strong>{sent ? t("回答已提交，等待主机处理") : expired ? t("这个问题已过期") : t("Codex 等待你的回答")}</strong>
    <p>{t("回答会传给当前会话的原问题，不会启动新任务。请勿填写密码或密钥。")}</p>
    {questions.map((q) => <fieldset key={q.id} disabled={busy || sent || expired}>
      <legend>{q.header} · {q.question}</legend>
      {q.options.map((option, i) => <label key={i} className="codex-input-option">
        <input type="radio" name={`${request.id}-${q.id}`} checked={answers[q.id] === option.label} onChange={() => setAnswers((old) => ({ ...old, [q.id]: option.label }))} />
        <span>{option.label}<small>{option.description}</small></span>
      </label>)}
      <label>{t("回答或补充")}<textarea aria-label={t("{0} 的回答", q.header)} value={answers[q.id] ?? ""} maxLength={8000} rows={2} onChange={(e) => setAnswers((old) => ({ ...old, [q.id]: e.target.value }))} /></label>
    </fieldset>)}
    {error && <p role="alert">{systemText(error)}</p>}
    <button className="button button--primary" type="button" disabled={!valid || expired || busy || sent} onClick={() => void submit()}>{busy ? t("正在提交…") : t("提交回答")}</button>
  </section>;
}
