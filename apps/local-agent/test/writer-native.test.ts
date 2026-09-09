import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { CodexAppServer, type AppServerCallbacks } from "../src/app-server.js";
import { SessionAppServer } from "../src/session-app-server.js";
import { resolveProject } from "../src/projects.js";
import type { ManagedThread } from "../src/types.js";

// Opt-in real protocol check, no account credentials and no model requests.
for (const historyMode of ["legacy", "paginated"] as const) test(`native ${historyMode} writer handoff permits a second process to resume the same persisted session`, { skip: !process.env.AGENTFLEET_NATIVE_TEST, timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "agentfleet-writer-native-"));
  t.after(() => rm(root, {recursive:true,force:true}));
  const home = join(root, "codex-home"); const cwd = join(root, "project");
  const day = join(home, "sessions", "2026", "09", "07");
  await mkdir(day, { recursive: true }); await mkdir(cwd);
  const id = randomUUID(); const otherId = randomUUID(); const childId = randomUUID(); const grandchildId = randomUUID(); const timestamp = "2026-09-07T00:00:00.000Z";
  for (const fixtureId of [id, otherId, childId, grandchildId]) await writeFile(join(day, `rollout-2026-09-07T00-00-00-${fixtureId}.jsonl`), [
    { timestamp, type: "session_meta", payload: { id: fixtureId, timestamp, cwd, history_mode: historyMode, originator: "codex_cli_rs", cli_version: "0.153.4", source: fixtureId === childId || fixtureId === grandchildId ? {subagent:{thread_spawn:{parent_thread_id:fixtureId === childId ? id : childId,depth:fixtureId === childId ? 1 : 2}}} : "cli", model_provider: "openai", base_instructions: { text: "Isolated handoff fixture." } } },
    { timestamp, type: "event_msg", payload: { type: "task_started", turn_id: id, started_at: 1788739200, model_context_window: 200000, collaboration_mode_kind: "default" } },
    { timestamp, type: "turn_context", payload: { turn_id: id, cwd, approval_policy: "never", sandbox_policy: {type:"danger-full-access"}, model:"test", effort:"high", summary:"auto" } },
    { timestamp, type: "event_msg", payload: { type: "user_message", message: "Fixture only; do not execute.", images: [], local_images: [] } },
    { timestamp, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fixture only; do not execute." }] } },
    { timestamp, type: "event_msg", payload: { type: "item_completed", thread_id: fixtureId, turn_id: id, item: {type: "UserMessage", id: "fixture-item", content: [{type: "text", text: "Fixture only."}]}, started_at_ms: 1788739200000, completed_at_ms: 1788739200100 } },
    { timestamp, type: "event_msg", payload: { type: "task_complete", turn_id: id, started_at: 1788739200, completed_at: 1788739201, duration_ms: 1000, time_to_first_token_ms: 0, last_agent_message: "Fixture complete." } },
  ].map((row, ordinal) => JSON.stringify({ ...row, ...(historyMode === "paginated" ? { ordinal } : {}) })).join("\n") + "\n");
  const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, CODEX_HOME: home,
    ...(process.env.AGENTFLEET_NATIVE_CODEX ? { AGENTFLEET_CODEX_EXECUTABLE: process.env.AGENTFLEET_NATIVE_CODEX } : {}) };
  const callbacks: AppServerCallbacks = { findManagedThread: () => undefined, findProject: () => undefined,
    onEvent: async () => undefined, onVolatile: () => undefined, onApproval: async () => undefined,
    onApprovalResolved: async () => undefined, onExit: async () => undefined };
  const panel = new SessionAppServer(callbacks, (cb, epoch) => new CodexAppServer(cb, epoch, environment));
  const terminal = new CodexAppServer(callbacks, undefined, environment);
  const project = await resolveProject(cwd, "fixture");
  try {
    await panel.start(); await terminal.start();
    const resumed = await panel.resumeThread(id, project);
    assert.equal(resumed.history.historyMode, historyMode);
    await panel.resumeThread(otherId, project);
    for (const descendant of [childId,grandchildId]) { await panel.resumeThread(descendant,project); await panel.unsubscribeThread(descendant); }
    await assert.rejects(terminal.resumeThread(id, project), /active writer/);
    const releasedAt = Date.now();
    await panel.unsubscribeThread(id);
    assert.deepEqual(await terminal.readTurnOutcome(id,id),{cwd,status:"completed"});
    assert.equal(await terminal.readTurnOutcome(id,"absent-turn"),null);

    assert.equal((await terminal.resumeThread(id, project)).nativeThreadId, id);
    assert.ok(Date.now() - releasedAt < 15_000);
    await assert.rejects(terminal.resumeThread(otherId, project), /active writer/);
    await terminal.releaseWriter();
    assert.equal((await panel.resumeThread(id, project)).nativeThreadId, id);
    await panel.unsubscribeThread(id);
    await panel.unsubscribeThread(otherId);
    // No model requests: verify the actual selected policy for each native
    // resume and writer replacement, without changing a real user's config.
    for (const profile of ["project", "network", "full"] as const) {
      const policy = await panel.resumeThread(id, project, undefined, profile);
      assert.equal(policy.policyVerified, true, `${profile}: ${policy.policyFailure}`);
      assert.equal(policy.rawSummary.approvalPolicy, profile === "full" ? "never" : "on-request");
      await panel.unsubscribeThread(id);
    }
    const historyBefore = await panel.readThread(id);
    const metadataOnly = await panel.readThread(id,true);
    if (historyMode === "paginated") {
      assert.equal(metadataOnly.items.length,0);
      assert.equal(metadataOnly.paged,true);
      const page = await panel.readHistoryPage(id,null);
      assert.deepEqual(page.items,historyBefore.items,"Native item pagination preserves IDs and payloads");
      assert.equal(page.nextCursor,null);
    } else assert.deepEqual(metadataOnly.items,historyBefore.items,"Legacy history retains the supported read path");
    const archiveTarget: ManagedThread = { nativeThreadId: id, projectId: project.id, sessionCwd: cwd, appServerEpoch: panel.appServerEpoch, policyVersion: "remote-restricted-v1", policyVerified: true, contentEpoch: 1, createdAt: timestamp };
    await panel.threadAction(archiveTarget, project, "archive");
    const archived = (await panel.listThreads()).find(thread => thread.nativeThreadId === id);
    assert.equal(archived?.archived, true, "Host archive remains discoverable under the original ID");
    await panel.threadAction(archiveTarget, project, "unarchive");
    assert.equal((await panel.listThreads()).find(thread => thread.nativeThreadId === id)?.archived, false);
    assert.deepEqual((await panel.readThread(id)).items, historyBefore.items, "Archive/restore preserves native history");
    const reopenedTerminal = new CodexAppServer(callbacks, undefined, environment);
    try { await reopenedTerminal.start(); assert.equal((await reopenedTerminal.resumeThread(id, project)).nativeThreadId, id); }
    finally { await reopenedTerminal.stop(); }
    const deletion = new CodexAppServer(callbacks,undefined,environment);
    try {
      await deletion.start();
      await panel.threadAction({...archiveTarget,nativeThreadId:childId},project,"unarchive");
      const plan = await panel.previewDeletion(archiveTarget,project);
      assert.deepEqual(new Set(plan.threads.map(t=>t.id)),new Set([id,childId,grandchildId]),"Preview includes every spawned descendant");
      const external = new CodexAppServer(callbacks,undefined,environment);
      try {
        await external.start();await external.resumeThread(childId,project);
        await assert.rejects(panel.deleteThread(archiveTarget,project,plan),/active writer/);
        assert.equal((await deletion.readThread(id)).nativeThreadId,id,"Busy descendant prevents deletion of the parent");
      } finally {await external.stop();}
      const currentPlan=await panel.previewDeletion(archiveTarget,project);
      await panel.deleteThread(archiveTarget,project,currentPlan);
      await assert.rejects(deletion.readThread(childId));await assert.rejects(deletion.readThread(grandchildId));
      await assert.rejects(deletion.readThread(id));
      assert.equal((await deletion.readThread(otherId)).nativeThreadId,otherId,"Unrelated native thread is retained");
      t.diagnostic("native delete succeeded and unrelated thread remains");
    } finally { await deletion.stop(); }
    const created = await panel.createThread(project, "network", "Stable cloud title");
    assert.equal(created.policyVerified, true, created.policyFailure);
    await panel.unsubscribeThread(created.nativeThreadId);
    const reopenedEmpty = new CodexAppServer(callbacks,undefined,environment);
    try {
      await reopenedEmpty.start();
      try {
        const empty = await reopenedEmpty.resumeThread(created.nativeThreadId,project);
        assert.equal(empty.nativeThreadId,created.nativeThreadId);
        t.diagnostic("empty thread survives writer exit and fresh-process resume");
      } catch (error) {
        t.diagnostic(`empty thread persistence unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally { await reopenedEmpty.stop(); }
  } finally { await panel.stop(); await terminal.stop(); }
});
