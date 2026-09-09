import { AgentError } from "./errors.js";
import { isRecord } from "./util.js";

export interface InputQuestion {
  id: string; header: string; question: string; isOther: boolean;
  options: { label: string; description: string }[];
}
export type InputAnswers = Record<string, { answers: string[] }>;

/** Only the documented question fields cross the relay. Secret prompts stay local. */
export function inputQuestions(value: unknown): InputQuestion[] {
  const fail = (): never => { throw new AgentError("INPUT_QUESTIONS_INVALID", "Unsupported or secret user-input request"); };
  if (!Array.isArray(value) || !value.length || value.length > 8) return fail();
  const ids = new Set<string>();
  return value.map((entry) => {
    if (!isRecord(entry) || entry.isSecret === true) return fail();
    const string = (v: unknown, max: number): string => typeof v === "string" && v.length > 0 && v.length <= max ? v : fail();
    const id = string(entry.id, 128);
    if (ids.has(id) || ["__proto__", "constructor", "prototype"].includes(id)) return fail();
    ids.add(id);
    if (entry.options != null && (!Array.isArray(entry.options) || entry.options.length > 20)) return fail();
    const options = (entry.options as unknown[] | null | undefined ?? []).map((option) => {
      if (!isRecord(option)) return fail();
      return { label: string(option.label, 512), description: typeof option.description === "string" ? option.description.slice(0, 4000) : "" };
    });
    return { id, header: string(entry.header, 512), question: string(entry.question, 8000), isOther: entry.isOther === true, options };
  });
}

export function inputAnswers(value: unknown, questions: InputQuestion[]): InputAnswers {
  const fail = (): never => { throw new AgentError("INPUT_ANSWERS_INVALID", "Answer every question using one non-empty answer (maximum 8000 characters)"); };
  if (!isRecord(value) || Object.keys(value).length !== questions.length) return fail();
  const result: InputAnswers = {};
  for (const question of questions) {
    const entry = Object.hasOwn(value, question.id) ? value[question.id] : undefined;
    if (!isRecord(entry) || Object.keys(entry).length !== 1 || !Array.isArray(entry.answers) || entry.answers.length !== 1) return fail();
    const answer = entry.answers[0];
    if (typeof answer !== "string" || !answer.trim() || answer.length > 8000) return fail();
    result[question.id] = { answers: [answer] };
  }
  return result;
}
