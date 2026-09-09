import { AgentError } from "./errors.js";
import { posix, win32 } from "node:path";
import { isRecord, redact } from "./util.js";

export type PermissionProfile = "project" | "network" | "full";
/** Only exact, displayable absolute scopes. Unknown aliases never become grants. */
export function requestedPermissions(value: unknown): Record<string, unknown> {
  const fail = () => { throw new AgentError("PERMISSIONS_REQUEST_UNSUPPORTED", "Unsupported or undisplayable permission scope"); };
  if (!isRecord(value)) return fail();
  const serialized = JSON.stringify(value);
  if (serialized.length > 32_000 || redact(serialized) !== serialized || Object.keys(value).some(key => !["fileSystem", "network"].includes(key))) return fail();
  const absolute = (path: unknown) => typeof path === "string" && path.length <= 8_192 && !path.includes("\0") && (posix.isAbsolute(path) || win32.isAbsolute(path));
  if (value.network != null && (!isRecord(value.network) || Object.keys(value.network).some(key => key !== "enabled") || (value.network.enabled != null && typeof value.network.enabled !== "boolean"))) return fail();
  if (value.fileSystem != null) {
    const fs = value.fileSystem;
    if (!isRecord(fs) || Object.keys(fs).some(key => !["read", "write", "entries", "globScanMaxDepth"].includes(key))) return fail();
    for (const key of ["read", "write"]) if (fs[key] != null && (!Array.isArray(fs[key]) || fs[key].length > 128 || !fs[key].every(absolute))) return fail();
    if (fs.globScanMaxDepth != null && (!Number.isSafeInteger(fs.globScanMaxDepth) || Number(fs.globScanMaxDepth) < 1)) return fail();
    if (fs.entries != null) {
      if (!Array.isArray(fs.entries) || fs.entries.length > 128) return fail();
      for (const entry of fs.entries) {
        if (!isRecord(entry) || Object.keys(entry).some(key => !["access", "path"].includes(key)) || !["read", "write", "deny"].includes(String(entry.access)) || !isRecord(entry.path)) return fail();
        const path = entry.path;
        if (path.type !== "path" || Object.keys(path).some(key => !["type", "path"].includes(key)) || !absolute(path.path)) return fail();
      }
    }
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}
export function permissionProfile(value: unknown): PermissionProfile {
  if (value === undefined) return "project";
  if (value === "project" || value === "network" || value === "full") return value;
  throw new AgentError("PERMISSION_PROFILE_INVALID", "Unsupported permission profile");
}
export function threadPermissionParams(root: string, profile: PermissionProfile) {
  const approvalPolicy = profile === "full" ? "never" : "on-request";
  const sandbox = profile === "full" ? "danger-full-access" : "workspace-write";
  return { approvalPolicy, approvalsReviewer: "user", sandbox,
    config: { approval_policy: approvalPolicy, sandbox_mode: sandbox,
      sandbox_workspace_write: { network_access: profile !== "project", writable_roots: [root], exclude_tmpdir_env_var: true, exclude_slash_tmp: true } } };
}
export function turnPermissionPolicy(root: string, profile: PermissionProfile): Record<string, unknown> {
  return profile === "full" ? { type: "dangerFullAccess" } : {
    type: "workspaceWrite", writableRoots: [root], networkAccess: profile === "network", excludeTmpdirEnvVar: true, excludeSlashTmp: true,
  };
}
