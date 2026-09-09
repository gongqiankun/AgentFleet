import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentMaintenance } from "../src/maintenance.js";
import type { AgentRuntime } from "../src/runtime.js";
import { StateStore } from "../src/store.js";
import { shouldRestartWorker, workerStopExitCode, writeUpdateTransaction, workerHealthDiagnostics, writeWorkerHealth, type UpdateTransaction } from "../src/supervisor.js";
import { AGENT_VERSION } from "../src/constants.js";

test("expired maintenance never touches Codex and duplicate operations replay the result", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-maintenance-"));
  const store = new StateStore(directory);
  await store.initialize();
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  let scans = 0;
  const reports: Record<string, unknown>[] = [];
  const runtime = { refreshCatalog: async () => { scans += 1; return { state: "ready" }; } } as unknown as AgentRuntime;
  const maintenance = new AgentMaintenance({ store, runtime, signal: new AbortController().signal, report: (result) => reports.push(result) });
  await assert.rejects(maintenance.handle({ operationId: "op-expired", operationType: "catalog.refresh", expiresAt: "2000-01-01T00:00:00Z" }), /expired/);
  assert.equal(scans, 0);
  const offer = { operationId: "op-refresh", operationType: "catalog.refresh", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  await maintenance.handle(offer);
  await maintenance.handle(offer);
  assert.equal(scans, 1);
  assert.equal(reports.at(-1)?.state, "succeeded");
});

test("connection diagnostics refreshes the host inventory before reporting it", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-maintenance-"));
  const store = new StateStore(directory); await store.initialize();
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const support = { codexProfile: { hostCodexVersion: "0.145.0" } };
  const runtime = { support, refreshDiagnostics: async () => { support.codexProfile.hostCodexVersion = "0.153.4"; }, getDiscoveryStatus: () => ({ state: "ready" }) } as unknown as AgentRuntime;
  const reports: Record<string, unknown>[] = [];
  const maintenance = new AgentMaintenance({ store, runtime, signal: new AbortController().signal, report: result => reports.push(result) });
  await maintenance.handle({ operationId: "refresh-host-version", operationType: "diagnostics.collect" });
  assert.equal(reports.at(-1)?.state, "succeeded");
  assert.equal(support.codexProfile.hostCodexVersion, "0.153.4");
});

test("a graceful health-timeout exit restarts after rollback rather than stopping the service", () => {
  assert.equal(shouldRestartWorker(0, true), true);
  assert.equal(shouldRestartWorker(0, false), false);
  assert.equal(shouldRestartWorker(75, false), true);
  assert.equal(shouldRestartWorker(null, false), true);
  assert.equal(workerStopExitCode(false), 0);
  assert.equal(workerStopExitCode(true), 75, "already-running old supervisors must also restart a failed supervised child");
});

test("update replay waits for the supervisor, never reports current while verification is pending", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-maintenance-health-"));
  const store = new StateStore(directory); await store.initialize();
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const reports: Record<string, unknown>[] = [];
  const maintenance = new AgentMaintenance({ store, runtime: {} as AgentRuntime, signal: new AbortController().signal, report: result => reports.push(result) });
  const transaction: UpdateTransaction = { updateId: "health-test", phase: "verifying", previousVersion: "0.21.1", targetVersion: AGENT_VERSION,
    backupDir: join(directory, "updates", "backup"), launcher: "/not-used", previousTarget: "/not-used", profilePresent: false, codexPresent: false, startedAt: "2026-09-06T00:00:01Z" };
  await store.recordMaintenance({ operationId: "update-health", operationType: "agent.update", state: "running", createdAt: "2026-09-06T00:00:00Z", updatedAt: "2026-09-06T00:00:00Z" });
  await writeUpdateTransaction(directory, transaction);
  await maintenance.replay();
  await maintenance.handle({ operationId: "update-health", operationType: "agent.update" });
  assert.equal(reports.at(-1)?.state, "running");
  assert.equal((reports.at(-1)?.result as { phase: string }).phase, "verifying");
  assert.ok((reports.at(-1)?.result as { health: unknown }).health);
  assert.equal(store.snapshot().maintenanceOperations["update-health"]?.state, "running");
  await writeUpdateTransaction(directory, { ...transaction, phase: "rolled_back", error: "health timed out" });
  await maintenance.replay();
  assert.equal(reports.at(-1)?.state, "failed");
  assert.equal((reports.at(-1)?.error as { code: string }).code, "UPDATE_ROLLED_BACK");
});


test("update health diagnostics distinguish missing and written acknowledgements without exposing tokens", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-health-diag-"));
  const token = randomUUID();
  const previousToken = process.env.AGENTFLEET_SUPERVISOR_TOKEN;
  const previousSupervised = process.env.AGENTFLEET_SUPERVISED;
  t.after(async () => {
    if (previousToken === undefined) delete process.env.AGENTFLEET_SUPERVISOR_TOKEN; else process.env.AGENTFLEET_SUPERVISOR_TOKEN = previousToken;
    if (previousSupervised === undefined) delete process.env.AGENTFLEET_SUPERVISED; else process.env.AGENTFLEET_SUPERVISED = previousSupervised;
    await rm(directory, { recursive: true, force: true });
  });
  process.env.AGENTFLEET_SUPERVISED = "1";
  process.env.AGENTFLEET_SUPERVISOR_TOKEN = token;
  assert.equal((await workerHealthDiagnostics(directory)).acknowledgement, "missing");
  await writeWorkerHealth(directory, "0.153.4");
  const status = await workerHealthDiagnostics(directory);
  assert.equal(status.acknowledgement, "written");
  assert.equal(status.version, AGENT_VERSION);
  assert.equal(status.runtimeVersion, "0.153.4");
  assert.ok(!JSON.stringify(status).includes(token));
  process.env.AGENTFLEET_SUPERVISOR_TOKEN = "../../unrelated-file";
  assert.equal((await workerHealthDiagnostics(directory)).acknowledgement, "missing_token");
});

test("manual session recovery is scoped and duplicate delivery never re-executes it", async t => {
 const directory=await mkdtemp(join(tmpdir(),"manual-recovery-"));const store=new StateStore(directory);await store.initialize();t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
 const target={logicalSessionId:"session",nativeThreadId:"native",executionSegmentId:"segment",contentEpoch:1,appServerEpoch:"epoch"};let calls=0;
 const runtime={recoverFrozenSession:async(actual:Record<string,unknown>)=>{assert.deepEqual(actual,target);calls++;return {recovered:true,status:"interrupted"};}} as unknown as AgentRuntime;
 const maintenance=new AgentMaintenance({store,runtime,signal:new AbortController().signal,report:()=>{}});
 await maintenance.replay();assert.equal(calls,0,"Startup without an explicit operation never recovers");
 const offer={operationId:"manual-click",operationType:"session.reconcile",recoveryTarget:target,expiresAt:new Date(Date.now()+60000).toISOString()};
 await maintenance.handle(offer);await maintenance.handle(offer);await maintenance.replay();assert.equal(calls,1);
 assert.deepEqual(store.snapshot().maintenanceOperations["manual-click"]?.recoveryTarget,target);
});

test("journal recovery only reads persisted evidence and never invokes or replays commands", async t => {
  const directory=await mkdtemp(join(tmpdir(),"agentfleet-journal-probe-"));
  const store=new StateStore(directory);await store.initialize();
  t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  const command={commandId:"cmd-proof",attemptId:"attempt-proof",type:"thread.rename"} as import("../src/types.js").FleetCommand;
  await store.claimCommand(command,"immutable-proof");
  await store.transitionCommand(command.attemptId,"claimed","invoking");
  await store.transitionCommand(command.attemptId,"invoking","responded",{response:{nativeThreadId:"original-thread",title:"new title",secret:"must-not-leak"}});
  await store.transitionCommand(command.attemptId,"responded","applied");
  const before=store.snapshot();
  const reports:Record<string,unknown>[]=[];
  const maintenance=new AgentMaintenance({store,runtime:new Proxy({} as AgentRuntime,{get(){throw Error("recovery must never call runtime");}}),signal:new AbortController().signal,report:result=>reports.push(result)});
  const offer={operationId:"probe-journal",operationType:"commands.reconcile",commands:["cmd-proof","cmd-missing"]};
  await maintenance.handle(offer);
  const result=reports.at(-1)?.result as {readOnly:boolean;commands:Array<Record<string,unknown>>};
  assert.equal(reports.at(-1)?.state,"succeeded");assert.equal(result.readOnly,true);
  assert.equal(result.commands[0]?.state,"applied");assert.equal(result.commands[0]?.attemptId,"attempt-proof");
  assert.equal(result.commands[1]?.state,"missing");assert.ok(!JSON.stringify(result).includes("must-not-leak"));
  await maintenance.handle(offer);
  assert.deepEqual(store.snapshot().commandJournal,before.commandJournal);
  assert.deepEqual(store.snapshot().inbox,before.inbox);
  assert.deepEqual(store.snapshot().outbox,before.outbox);
});

test("image cleanup crash replay never invokes deletion again, successful proof replays", async t => {
  const directory = await mkdtemp(join(tmpdir(), "image-maintenance-"));
  const store = new StateStore(directory); await store.initialize();
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  let calls=0; const reports: Record<string,unknown>[]=[];
  const maintenance=new AgentMaintenance({store,runtime:{manageSessionImages:async()=>{calls++;return {cleaned:true};}} as unknown as AgentRuntime,signal:new AbortController().signal,report:r=>reports.push(r)});
  const timestamp=new Date().toISOString();
  await store.recordMaintenance({operationId:"interrupted",operationType:"images.clean",state:"running",createdAt:timestamp,updatedAt:timestamp,recoveryTarget:{logicalSessionId:"one"}});
  assert.equal(store.canSafelyRestart(),false,"a running cleanup blocks automatic updates");
  await maintenance.handle({operationId:"interrupted",operationType:"images.clean"});
  assert.equal(store.canSafelyRestart(),true,"an unconfirmed receipt does not keep host maintenance permanently blocked");
  assert.equal(calls,0);assert.equal(store.snapshot().maintenanceOperations.interrupted?.error?.code,"IMAGE_CLEANUP_UNCONFIRMED");
  const offer={operationId:"new-clean",operationType:"images.clean",recoveryTarget:{logicalSessionId:"two"}};
  await maintenance.handle(offer);await maintenance.handle(offer);
  assert.equal(calls,1);assert.equal(reports.at(-1)?.state,"succeeded");
  await store.recordMaintenance({operationId:"expired-preview",operationType:"images.preview",state:"running",createdAt:timestamp,updatedAt:timestamp,expiresAt:"2000-01-01T00:00:00Z"});
  assert.equal(store.canSafelyRestart(),false);
  await maintenance.replay();
  assert.equal(store.canSafelyRestart(),true,"expired preview cannot permanently block host updates");
  assert.equal(calls,1);
});
