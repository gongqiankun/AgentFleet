import assert from "node:assert/strict";
import test from "node:test";
import { inputAnswers, inputQuestions } from "../src/user-input.js";
const question = { id: "scope", header: "范围", question: "使用哪个项目？", options: [{ label: "当前项目", description: "仅此目录" }] };
test("question relay allowlists fields, accepts free text and rejects secret or duplicate questions", () => {
  const questions = inputQuestions([{ ...question, hiddenConfig: "not forwarded" }]);
  assert.equal(Object.hasOwn(questions[0]!, "hiddenConfig"), false);
  assert.deepEqual(inputAnswers({ scope: { answers: ["一个不同的项目"] } }, questions), { scope: { answers: ["一个不同的项目"] } });
  for (const invalid of [[{ ...question, isSecret: true }], [question, question], [{ ...question, id: "__proto__" }], []]) assert.throws(() => inputQuestions(invalid));
  for (const invalid of [{}, { scope: { answers: [] } }, { scope: { answers: [" "] } }, { scope: { answers: ["ok", "extra"] } }, { scope: { answers: ["ok"] }, injected: { answers: ["x"] } }]) assert.throws(() => inputAnswers(invalid, questions));
});
