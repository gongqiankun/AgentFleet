import { invariant } from "./errors.js";

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export function validateInputAnswers(value: unknown, questions: unknown): void {
  invariant(Array.isArray(questions) && questions.length > 0 && questions.length <= 8 && record(value), 400, "INPUT_ANSWERS_INVALID", "Question answers are required");
  invariant(Object.keys(value).length === questions.length, 400, "INPUT_ANSWERS_INVALID", "Answer every question exactly once");
  const ids = new Set<string>();
  for (const question of questions) {
    invariant(record(question) && typeof question.id === "string" && !["__proto__", "constructor", "prototype"].includes(question.id) && !ids.has(question.id), 400, "INPUT_QUESTIONS_INVALID", "Invalid question identity");
    ids.add(question.id);
    const entry = Object.hasOwn(value, question.id) ? value[question.id] : undefined;
    invariant(record(entry) && Object.keys(entry).length === 1 && Array.isArray(entry.answers) && entry.answers.length === 1 && typeof entry.answers[0] === "string" && entry.answers[0].trim().length > 0 && entry.answers[0].length <= 8000, 400, "INPUT_ANSWERS_INVALID", "Each question needs one non-empty answer of at most 8000 characters");
  }
}
