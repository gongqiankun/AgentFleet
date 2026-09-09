import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { AgentError } from "./errors.js";
import type { ProjectRecord } from "./types.js";
import type { StateStore } from "./store.js";
import { identifier, isPathInside, nowIso, sha256 } from "./util.js";

const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export async function resolveProject(path: string, alias: string): Promise<ProjectRecord> {
  if (!ALIAS_PATTERN.test(alias)) {
    throw new AgentError(
      "PROJECT_ALIAS_INVALID",
      "alias must be 1-64 characters using letters, numbers, dot, underscore, or dash",
    );
  }
  const requested = resolve(path);
  const requestedStat = await lstat(requested);
  if (requestedStat.isSymbolicLink()) {
    throw new AgentError("PROJECT_SYMLINK_REJECTED", "the selected project path must not itself be a symlink");
  }
  const root = await realpath(requested);
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new AgentError("PROJECT_NOT_DIRECTORY", "project path must be a directory");
  return {
    id: identifier("proj"),
    alias,
    root,
    device: rootStat.dev.toString(),
    inode: rootStat.ino.toString(),
    identityVersion: 1,
    addedAt: nowIso(),
    source: "explicit",
  };
}

async function gitRootFor(cwd: string): Promise<string> {
  let current = cwd;
  while (true) {
    try {
      const marker = await lstat(join(current, ".git"));
      if (marker.isDirectory() || marker.isFile()) return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return cwd;
    current = parent;
  }
}

/** Resolve the project represented by a Codex thread cwd, preferring its nearest Git root. */
export async function discoverProjectFromCwd(
  cwd: string,
  existingProjects: readonly ProjectRecord[],
): Promise<ProjectRecord> {
  if (!isAbsolute(cwd)) throw new AgentError("PROJECT_PATH_INVALID", "thread cwd must be an absolute path");
  const canonicalCwd = await realpath(cwd);
  const cwdStat = await stat(canonicalCwd);
  if (!cwdStat.isDirectory()) throw new AgentError("PROJECT_NOT_DIRECTORY", "thread cwd must be a directory");
  // Grouping is independent from installation cwd and command authorization.
  // A nested repository/worktree must never be swallowed by its parent project.
  const gitRoot = await gitRootFor(canonicalCwd);
  const authorized = existingProjects
    .filter((project) => (project.source ?? "explicit") === "explicit" &&
      isPathInside(project.root, canonicalCwd) && isPathInside(gitRoot, project.root))
    .sort((left, right) => right.root.length - left.root.length)[0];
  if (authorized) {
    const rootStat = authorized.root === canonicalCwd ? cwdStat : await stat(authorized.root);
    return { ...authorized, device: rootStat.dev.toString(), inode: rootStat.ino.toString() };
  }
  const root = gitRoot;
  const rootStat = root === canonicalCwd ? cwdStat : await stat(root);
  const existing = existingProjects.find((project) => project.root === root);
  if (existing) {
    return { ...existing, device: rootStat.dev.toString(), inode: rootStat.ino.toString() };
  }
  const identity = sha256(`${root}\0${rootStat.dev.toString()}\0${rootStat.ino.toString()}`).slice("sha256:".length);
  return {
    id: `proj_auto_${identity.slice(0, 32)}`,
    alias: basename(root) || "root",
    root,
    device: rootStat.dev.toString(),
    inode: rootStat.ino.toString(),
    identityVersion: 1,
    addedAt: nowIso(),
    source: "session_discovery",
  };
}

export async function addProject(store: StateStore, path: string, alias: string, source: ProjectRecord["source"] = "explicit"): Promise<ProjectRecord> {
  const project = await resolveProject(path, alias);
  project.source = source;
  await store.addProject(project);
  return store.snapshot().projects.find((entry) => entry.root === project.root) ?? project;
}

export async function verifySessionCwd(project: ProjectRecord, cwd = project.root): Promise<string> {
  const canonical = await realpath(cwd).catch(() => {
    throw new AgentError("THREAD_CWD_UNAVAILABLE", "the session directory is no longer available");
  });
  if (canonical !== cwd || !isPathInside(project.root, canonical) || !(await stat(canonical)).isDirectory()) {
    throw new AgentError("THREAD_PROJECT_MISMATCH", "session cwd is outside its registered project or has changed");
  }
  return canonical;
}

export async function verifyProjectIdentity(project: ProjectRecord): Promise<void> {
  let currentRoot: string;
  try {
    currentRoot = await realpath(project.root);
  } catch {
    throw new AgentError("PROJECT_UNAVAILABLE", "project root is no longer available");
  }
  if (currentRoot !== project.root) {
    throw new AgentError("PROJECT_IDENTITY_CHANGED", "project canonical path changed; re-add it locally");
  }
  const current = await stat(project.root);
  if (!current.isDirectory() || current.dev.toString() !== project.device || current.ino.toString() !== project.inode) {
    throw new AgentError("PROJECT_IDENTITY_CHANGED", "project directory identity changed; re-add it locally");
  }
}

export function projectById(store: StateStore, projectId: string): ProjectRecord {
  const project = store.snapshot().projects.find((entry) => entry.id === projectId);
  if (!project) throw new AgentError("PROJECT_NOT_AUTHORIZED", "project is not in the local allowlist");
  return project;
}
