import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServer, sanitizeThreadItem, verifyEffectiveThreadPolicy, type AppServerCallbacks } from "../src/app-server.js";
import { permissionProfile, requestedPermissions, threadPermissionParams, turnPermissionPolicy } from "../src/permissions.js";
import type { ApprovalRecord, ManagedThread, ProjectRecord } from "../src/types.js";

test("profiles verify the exact effective policy, never infer broader access", () => {
  const root = "/work/project";
  for (const profile of ["project", "network", "full"] as const) {
    const args = threadPermissionParams(root, profile);
    const response = { cwd: root, approvalPolicy: args.approvalPolicy, sandbox: turnPermissionPolicy(root, profile) };
    assert.equal(verifyEffectiveThreadPolicy(response, root, root, profile).ok, true);
    for (const other of ["project", "network", "full"] as const) if (other !== profile) assert.equal(verifyEffectiveThreadPolicy(response, root, root, other).ok, false);
  }
  assert.equal(permissionProfile(undefined), "project");
  assert.throws(() => permissionProfile("auto"));
  const permissions = { network: { enabled: true }, fileSystem: { write: ["/work/deploy"], entries: [{ access: "read", path: { type: "path", path: "C:\\work" } }] } };
  assert.deepEqual(requestedPermissions(permissions), permissions);
  assert.throws(() => requestedPermissions({ fileSystem: { write: ["relative"] } }));
  assert.throws(() => requestedPermissions({ network: { enabled: true, secret: true } }));
  assert.throws(() => requestedPermissions({ fileSystem: { entries: [{ access: "write", path: { type: "special", value: { kind: "root" } } }] } }));
});

test("network and deployment approvals reach the panel; grants are exact and turn scoped", async () => {
  let approval: ApprovalRecord | undefined;
  const writes: Record<string, unknown>[] = [];
  const thread = { nativeThreadId: "thread", projectId: "project", appServerEpoch: "epoch", policyVerified: true, permissionProfile: "project" } as ManagedThread;
  const server = new CodexAppServer({ findManagedThread: () => thread, findProject: () => ({ id: "project", root: "/work/project", identityVersion: 1 }) as ProjectRecord,
    onApproval: async (value: ApprovalRecord) => { approval = value; }, onEvent: async () => assert.fail("Must not auto-decline a supported explicit request"),
  } as unknown as AppServerCallbacks, "epoch");
  const internal = server as unknown as { initialized: boolean; child: unknown; writeLine(value: Record<string, unknown>): Promise<void>; handleApprovalRequest(id: number, method: string, params: Record<string, unknown>): Promise<void> };
  internal.initialized = true; internal.child = {}; internal.writeLine = async value => { writes.push(value); };
  await internal.handleApprovalRequest(1, "item/commandExecution/requestApproval", { threadId: "thread", turnId: "turn", itemId: "item", command: "curl example.test", cwd: "/work/deploy", proposedExecpolicyAmendment: ["curl"], networkApprovalContext: { host: "example.test", protocol: "https" } });
  assert.ok(approval); assert.equal(writes.length, 0);
  assert.deepEqual(approval.params.networkApprovalContext, { host: "example.test", protocol: "https" });
  await server.respondApproval(approval, "accept");
  assert.deepEqual(writes.pop(), { id: 1, result: { decision: "accept" } });
  const permissions = { fileSystem: { write: ["/work/deploy"] }, network: { enabled: true } };
  await internal.handleApprovalRequest(2, "item/permissions/requestApproval", { threadId: "thread", turnId: "turn", itemId: "item2", cwd: "/work/project", permissions });
  await server.respondApproval(approval!, "accept");
  assert.deepEqual(writes.pop(), { id: 2, result: { permissions, scope: "turn" } });
  await internal.handleApprovalRequest(3, "item/permissions/requestApproval", { threadId: "thread", turnId: "turn", itemId: "item3", permissions });
  await server.respondApproval(approval!, "decline");
  assert.deepEqual(writes.pop(), { id: 3, result: { permissions: {}, scope: "turn" } });
});

test("native explicit name is distinguished from changing message previews", async () => {
  const server = new CodexAppServer({} as AppServerCallbacks);
  const internal = server as unknown as { initialized: boolean; child: unknown; request(): Promise<unknown> };
  internal.initialized = true; internal.child = {};
  internal.request = async () => ({ data: [{ id: "a", cwd: "/work", name: "My project", preview: "部署" }, { id: "b", cwd: "/work", name: "", preview: "部署" }] });
  const page = await server.listThreadPage(null);
  assert.equal(page.threads[0]?.title, "My project"); assert.equal(page.threads[0]?.titleSource, "name");
  assert.equal(page.threads[1]?.titleSource, "preview");
});

test("writer handoff fails closed for active children, unknown state, or background terminals", async () => {
  for (const scenario of ["active", "unknown", "background", "incomplete"]) {
    const server = new CodexAppServer({} as AppServerCallbacks);
    const internal = server as unknown as { initialized: boolean; child: unknown; request(method: string): Promise<unknown> };
    internal.initialized = true;
    internal.child = { stdin: { end: () => assert.fail("Must not close a busy writer") } };
    internal.request = async method => {
      if (method === "thread/loaded/list") return scenario === "incomplete" ? { data: [123] } : { data: ["child"] };
      if (method === "thread/read") return { thread: { id: "child", status: { type: scenario === "background" ? "idle" : scenario } } };
      return { data: [{ processId: "fixture" }] };
    };
    await assert.rejects(server.releaseWriter(), (error: unknown) => (error as { code: string }).code === "THREAD_RELEASE_PENDING");
  }
});

test("catalog lifecycle hints include unmanaged threads, while content remains managed-only", async () => {
  let invalidations = 0; let contentEvents = 0;
  const server = new CodexAppServer({ findManagedThread: () => undefined,
    onCatalogChanged: () => { invalidations++; }, onEvent: async () => { contentEvents++; },
  } as unknown as AppServerCallbacks);
  const notify = (server as unknown as { handleNotification(method: string, params: Record<string, unknown>): Promise<void> });
  await notify.handleNotification("thread/started", { thread: { id: "external" } });
  await notify.handleNotification("turn/completed", { threadId: "external" });
  await notify.handleNotification("item/agentMessage/delta", { threadId: "external", delta: "fixture" });
  assert.equal(invalidations, 2);
  assert.equal(contentEvents, 0);
});

test("effective remote-restricted policy must be observable and confined", () => {
  const root = "/work/project";
  assert.deepEqual(
    verifyEffectiveThreadPolicy(
      {
        cwd: root,
        approvalPolicy: "on-request",
        sandbox: {
          type: "workspaceWrite",
          writableRoots: [root, `${root}/generated`],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      },
      root,
    ),
    { ok: true },
  );
  assert.equal(
    verifyEffectiveThreadPolicy(
      {
        cwd: root,
        approvalPolicy: "on-request",
        sandbox: {
          type: "workspaceWrite",
          writableRoots: ["/tmp"],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      },
      root,
    ).ok,
    false,
  );
  assert.equal(
    verifyEffectiveThreadPolicy(
      {
        cwd: root,
        approvalPolicy: "on-request",
        sandbox: {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: true,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      },
      root,
    ).ok,
    false,
  );
  assert.equal(
    verifyEffectiveThreadPolicy(
      {
        cwd: root,
        approvalPolicy: "on-request",
        sandbox: { type: "workspaceWrite", writableRoots: [root], networkAccess: false },
      },
      root,
    ).ok,
    false,
  );
});

test("notification sanitizer drops unknown payloads and raw reasoning", () => {
  assert.equal(sanitizeThreadItem({ type: "futureDangerousItem", id: "x", raw: { secret: "value" } }), null);
  assert.deepEqual(
    sanitizeThreadItem({ type: "reasoning", id: "reason-1", summary: ["safe summary"], content: ["private chain of thought"] }),
    { type: "reasoning", id: "reason-1", summary: ["safe summary"] },
  );
  const command = sanitizeThreadItem({
    type: "commandExecution",
    id: "item-1",
    command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz' example.test",
    cwd: "/work/project",
    status: "completed",
    aggregatedOutput: "api_key=supersecretvalue",
    exitCode: 0,
  });
  assert.ok(command);
  assert.doesNotMatch(JSON.stringify(command), /supersecretvalue|abcdefghijklmnopqrstuvwxyz/);
});

test("session cwd may be a project subdirectory while writable roots stay confined", () => {
  const root = "/work/project";
  const cwd = `${root}/packages/web`;
  const response = {
    cwd, approvalPolicy: "on-request",
    sandbox: { type: "workspaceWrite", writableRoots: [root], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
  };
  assert.equal(verifyEffectiveThreadPolicy(response, root, cwd).ok, true);
  assert.equal(verifyEffectiveThreadPolicy({ ...response, cwd: "/work/other" }, root, "/work/other").ok, false);
});
