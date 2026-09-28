import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectRegistry, projectRegistryPath, workspaceRootsPath } from "../src/project-registry.js";

async function fixture(run) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "dalizi-resolver-"));
  const data = path.join(temp, "data");
  await mkdir(data);
  const registry = new ProjectRegistry(projectRegistryPath(data));
  const rootsFile = workspaceRootsPath(data);
  const configure = (roots) => writeFile(rootsFile, JSON.stringify({ roots }), "utf8");
  try {
    await run({ temp, data, registry, rootsFile, configure });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

test("registered aliases win over discovered names and keep their existing errors", async () => fixture(async ({ temp, data, registry, configure }) => {
  const workspace = path.join(temp, "workspace");
  const registered = path.join(workspace, "registered");
  const collision = path.join(workspace, "dlz-main");
  await mkdir(registered, { recursive: true });
  await mkdir(collision);
  await configure([workspace]);
  await writeFile(projectRegistryPath(data), JSON.stringify({ projects: [
    { alias: "dlz-canary", cwd: registered, enabled: true },
    { alias: "dlz-main", cwd: registered, enabled: true },
    { alias: "wxmp", cwd: registered, enabled: true },
    { alias: "th9320", cwd: registered, enabled: true },
    { alias: "disabled", cwd: collision, enabled: false },
  ] }), "utf8");
  for (const alias of ["dlz-canary", "dlz-main", "wxmp", "th9320"]) {
    assert.equal(registry.resolve(alias), await realpath(registered));
  }
  assert.throws(() => registry.resolve("disabled"), { code: "disabled_project" });
}));

test("discovers only unique direct child names, exact names before Windows case fallback", async () => fixture(async ({ temp, registry, configure }) => {
  const first = path.join(temp, "first");
  const second = path.join(temp, "second");
  const exact = path.join(first, "WXMP");
  const nested = path.join(exact, "Nested");
  await mkdir(nested, { recursive: true });
  await mkdir(second);
  await configure([first, second]);
  assert.equal(registry.resolve("WXMP"), await realpath(exact));
  if (process.platform === "win32") assert.equal(registry.resolve("wxmp"), await realpath(exact));
  else assert.throws(() => registry.resolve("wxmp"), { code: "unknown_project" });
  assert.throws(() => registry.resolve("Nested"), { code: "unknown_project" });
  assert.throws(() => registry.resolve("missing"), { code: "unknown_project" });
  await mkdir(path.join(second, "wxmp"));
  assert.equal(registry.resolve("WXMP"), await realpath(exact));
  if (process.platform === "win32") assert.throws(() => registry.resolve("WxMp"), { code: "ambiguous_project" });
}));

test("the same exact name under two roots is ambiguous", async () => fixture(async ({ temp, registry, configure }) => {
  const roots = [path.join(temp, "one"), path.join(temp, "two")];
  for (const root of roots) await mkdir(path.join(root, "project"), { recursive: true });
  await configure(roots);
  assert.throws(() => registry.resolve("project"), { code: "ambiguous_project" });
}));

test("path-like input cannot become a cwd", async () => fixture(async ({ temp, registry, configure }) => {
  const root = path.join(temp, "workspace");
  await mkdir(path.join(root, "project"), { recursive: true });
  await configure([root]);
  for (const input of ["..", "../project", "project/..", "project\\..", root, "C:\\Windows", "\\\\server\\share"]) {
    assert.throws(() => registry.resolve(input), { code: "unknown_project" });
  }
}));

test("discovered symlink escape and registered cwd outside an approved root fail closed", async (t) => fixture(async ({ temp, data, registry, configure }) => {
  const root = path.join(temp, "workspace");
  const outside = path.join(temp, "workspace-extra");
  await Promise.all([mkdir(root), mkdir(outside)]);
  await configure([root]);
  await writeFile(projectRegistryPath(data), JSON.stringify({ projects: [{ alias: "outside-alias", cwd: outside, enabled: true }] }), "utf8");
  assert.throws(() => registry.resolve("outside-alias"), { code: "project_out_of_root" });
  try {
    await symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.diagnostic(`symlink creation unavailable on this host: ${error.code}; alias containment verified`);
      return;
    }
    throw error;
  }
  assert.throws(() => registry.resolve("escape"), { code: "project_out_of_root" });
}));

test("missing roots allow legacy aliases only; malformed or nonexistent roots fail closed", async () => fixture(async ({ temp, data, registry, rootsFile, configure }) => {
  const root = path.join(temp, "workspace");
  await mkdir(path.join(root, "project"), { recursive: true });
  const project = path.join(root, "project");
  await writeFile(projectRegistryPath(data), JSON.stringify({ projects: [{ alias: "legacy", cwd: project, enabled: true }] }), "utf8");
  assert.equal(registry.resolve("legacy"), await realpath(project));
  assert.throws(() => registry.resolve("project"), { code: "unknown_project" });
  await writeFile(rootsFile, "{bad json", "utf8");
  assert.throws(() => registry.resolve("legacy"), { code: "invalid_workspace_roots" });
  await configure([path.join(temp, "missing")]);
  assert.throws(() => registry.resolve("project"), { code: "invalid_workspace_roots" });
  await configure(["relative"]);
  assert.throws(() => registry.resolve("project"), { code: "invalid_workspace_roots" });
  await configure([root]);
  assert.equal(registry.resolve("project"), await realpath(project));
}));
