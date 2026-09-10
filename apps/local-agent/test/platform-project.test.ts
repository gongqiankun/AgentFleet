import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultMachineName, defaultProjectAlias } from "../src/cli.js";
import { REQUIRED_CODEX_SCHEMA_HASH } from "../src/constants.js";
import { evaluateSupport } from "../src/platform.js";
import { discoverProjectFromCwd, resolveProject, verifyProjectIdentity } from "../src/projects.js";

test("default project aliases support Windows drive roots and directory names", () => {
  for (const drive of ["C", "D"]) {
    assert.equal(defaultProjectAlias(`${drive}:\\`, "win32"), `drive-${drive.toLowerCase()}`);
    assert.equal(defaultProjectAlias(`${drive}:/`, "win32"), `drive-${drive.toLowerCase()}`);
    assert.equal(defaultProjectAlias(`${drive}:\\work\\example-repo\\`, "win32"), "example-repo");
  }
  assert.equal(defaultProjectAlias("\\\\server\\share\\", "win32"), "share");
  assert.equal(defaultProjectAlias("/", "linux"), "root");
  for (const name of ["My Project", "中文项目", ".hidden", "a".repeat(100)]) {
    assert.match(defaultProjectAlias(`D:\\${name}`, "win32"), /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
  }
});

test("the published P0b Linux, macOS, and Windows profiles are write capable", () => {
  const supportedInputs = {
    platform: "linux",
    architecture: "x64",
    uid: 1000,
    nodeVersion: "v24.14.0",
    osRelease: 'ID=ubuntu\nVERSION_ID="24.04"\n',
    codexVersion: "0.153.2",
    codexSchemaHash: REQUIRED_CODEX_SCHEMA_HASH,
    credentialProtectionLevel: "software_protected",
  } as const;
  const supported = evaluateSupport(supportedInputs);
  assert.equal(supported.supported, true);
  assert.equal(supported.writable, true);

  const compatiblePatch = evaluateSupport({ ...supportedInputs, codexVersion: "0.153.4" });
  assert.equal(compatiblePatch.supported, true);
  assert.equal(compatiblePatch.writable, true);

  const compatibleNewerSeries = evaluateSupport({ ...supportedInputs, codexVersion: "0.154.0", codexSchemaHash: "f3487938786b729cb6773dbc9e83a7efab9c78c845db7094e8f539f373cbacc9" });
  assert.equal(compatibleNewerSeries.supported, true);
  assert.equal(compatibleNewerSeries.writable, true);

  const ubuntu2204 = evaluateSupport({
    ...supportedInputs,
    osRelease: 'ID=ubuntu\nVERSION_ID="22.04"\n',
  });
  assert.equal(ubuntu2204.supported, true);
  assert.equal(ubuntu2204.writable, true);
  for (const osRelease of ['ID=ubuntu\nVERSION_ID="25.04"\n', 'ID=debian\nVERSION_ID="13"\n', 'ID=fedora\nVERSION_ID="42"\n', ""]) {
    const linux = evaluateSupport({ ...supportedInputs, osRelease });
    assert.equal(linux.writable, true, "Linux distro labels must not override validated runtime compatibility");
    assert.equal(evaluateSupport({ ...supportedInputs, osRelease, codexSchemaHash: "wrong" }).writable, false);
  }

  const root = evaluateSupport({ ...supportedInputs, uid: 0 });
  assert.equal(root.supported, true);
  assert.equal(root.writable, true);

  const macos = evaluateSupport({
    ...supportedInputs,
    platform: "darwin",
    architecture: "arm64",
    uid: 501,
    osRelease: "ID=macos\nVERSION_ID=15.6\n",
  });
  assert.equal(macos.supported, true);
  assert.equal(macos.writable, true);

  const windowsInputs = {
    ...supportedInputs,
    platform: "win32",
    architecture: "x64",
    uid: null,
    osRelease: "ID=windows\nVERSION_ID=10.0.26100\n",
  } as const;
  const windows = evaluateSupport(windowsInputs);
  assert.equal(windows.supported, true);
  assert.equal(windows.writable, true);

  const windowsArm = evaluateSupport({ ...windowsInputs, architecture: "arm64" });
  assert.equal(windowsArm.writable, false);
  assert.equal(windowsArm.readable, true, "validated reads remain available outside the write OS profile");

  const wrong = evaluateSupport({
    platform: "linux",
    architecture: "arm64",
    uid: 0,
    nodeVersion: "v23.0.0",
    osRelease: 'ID=ubuntu\nVERSION_ID="25.04"\n',
    codexVersion: "0.154.0",
    codexSchemaHash: null,
    credentialProtectionLevel: "unknown",
  });
  assert.equal(wrong.writable, false);
  assert.equal(wrong.readable, false, "unknown schemas never implicitly enable reads");
  assert.ok(wrong.readOnlyReasons.length >= 4);
});

test("project authorization canonicalizes a real directory and rejects a symlink root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-project-test-"));
  const projectRoot = join(directory, "project");
  const link = join(directory, "project-link");
  await mkdir(projectRoot);
  await symlink(projectRoot, link);
  const project = await resolveProject(projectRoot, "my-project");
  assert.equal(project.root, projectRoot);
  await assert.doesNotReject(verifyProjectIdentity(project));
  await assert.rejects(resolveProject(link, "linked"), /must not itself be a symlink/);
  await assert.rejects(resolveProject(projectRoot, "bad alias!"), /alias must be/);
});

test("CLI convenience defaults derive a machine name and Project basename", () => {
  assert.ok(defaultMachineName().length > 0);
  assert.equal(defaultProjectAlias("/srv/work/example-repo"), "example-repo");
});

test("Codex thread cwd discovery prefers the nearest Git root and is deterministic", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-discovery-test-"));
  const repository = join(directory, "workspace", "fleet-repo");
  const nested = join(repository, "packages", "web");
  await mkdir(join(repository, ".git"), { recursive: true });
  await mkdir(nested, { recursive: true });

  const first = await discoverProjectFromCwd(nested, []);
  const second = await discoverProjectFromCwd(repository, []);
  const nonGit = await discoverProjectFromCwd("/", []);

  assert.equal(first.root, repository);
  assert.equal(first.alias, "fleet-repo");
  assert.equal(first.id, second.id);
  assert.equal(first.source, "session_discovery");
  assert.equal(nonGit.root, "/");
  assert.notEqual(nonGit.id, first.id);
  await assert.rejects(discoverProjectFromCwd("relative/path", []), /absolute path/);
});

test("installing in a home directory does not merge nested repositories or worktrees", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-home-discovery-"));
  const initial = { ...await resolveProject(directory, "home"), source: "bootstrap_fallback" as const };
  const roots = [join(directory, "repo-a"), join(directory, "repo-b"), join(directory, "repo-a", "nested-repo")];
  for (const root of roots) await mkdir(join(root, ".git"), { recursive: true });
  const projects = [initial];
  for (const root of roots) {
    const found = await discoverProjectFromCwd(root, projects);
    assert.equal(found.root, root);
    projects.push(found as typeof initial);
  }
  const oldHome = { ...initial, source: "explicit" as const };
  assert.equal((await discoverProjectFromCwd(roots[0]!, [oldHome])).root, roots[0]);
});
