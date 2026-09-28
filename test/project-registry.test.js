import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Dispatcher } from "../src/dispatcher.js";
import { JobStore } from "../src/job-store.js";
import { ProjectRegistry, registerProject } from "../src/project-registry.js";

const execFile = promisify(execFileCallback);
const registerScript = fileURLToPath(new URL("../scripts/register-project.js", import.meta.url));

test("a trusted registration persists a canonical enabled alias across registry instances", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dalizi-registry-"));
  const project = path.join(root, "project");
  const registryFile = path.join(root, "runtime", "project-registry.json");
  try {
    await mkdir(project);
    const first = await registerProject({ registryFile, alias: "safe-project", cwd: project });
    assert.deepEqual(first, { alias: "safe-project", created: true });
    assert.equal(new ProjectRegistry(registryFile).resolve("safe-project"), await (await import("node:fs/promises")).realpath(project));

    const repeat = await registerProject({ registryFile, alias: "safe-project", cwd: project });
    assert.deepEqual(repeat, { alias: "safe-project", created: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registration rejects unsafe aliases, relative or missing directories, and conflicting aliases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dalizi-registry-"));
  const firstProject = path.join(root, "first");
  const secondProject = path.join(root, "second");
  const registryFile = path.join(root, "project-registry.json");
  try {
    await Promise.all([mkdir(firstProject), mkdir(secondProject)]);
    await assert.rejects(() => registerProject({ registryFile, alias: "unsafe alias", cwd: firstProject }), { code: "invalid_project_alias" });
    await assert.rejects(() => registerProject({ registryFile, alias: "safe-project", cwd: "relative" }), { code: "invalid_project_cwd" });
    await assert.rejects(() => registerProject({ registryFile, alias: "safe-project", cwd: path.join(root, "missing") }), { code: "invalid_project_cwd" });
    await registerProject({ registryFile, alias: "safe-project", cwd: firstProject });
    await assert.rejects(() => registerProject({ registryFile, alias: "safe-project", cwd: secondProject }), { code: "duplicate_project_alias" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the local CLI registers without exposing a project cwd in its result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dalizi-registry-cli-"));
  const project = path.join(root, "project");
  try {
    await mkdir(project);
    const { stdout } = await execFile(process.execPath, [registerScript, "--alias", "cli-project", "--cwd", project], {
      env: { ...process.env, DISPATCHER_DATA_DIR: path.join(root, "runtime") },
      windowsHide: true,
    });
    assert.deepEqual(JSON.parse(stdout), { alias: "cli-project", created: true });
    assert.equal(stdout.includes(project), false);
    const environment = { ...process.env, DISPATCHER_DATA_DIR: path.join(root, "runtime") };
    const repeat = await execFile(process.execPath, [registerScript, "--alias", "cli-project", "--cwd", project], { env: environment, windowsHide: true });
    assert.deepEqual(JSON.parse(repeat.stdout), { alias: "cli-project", created: false });
    assert.equal(new ProjectRegistry(path.join(root, "runtime", "project-registry.json")).resolve("cli-project"), await (await import("node:fs/promises")).realpath(project));
    await assert.rejects(
      () => execFile(process.execPath, [registerScript, "--alias", "cli-project", "--cwd", root], { env: environment, windowsHide: true }),
      /project registration failed: duplicate_project_alias/,
    );
    await assert.rejects(
      () => execFile(process.execPath, [registerScript, "--alias", "bad alias", "--cwd", project], { env: environment, windowsHide: true }),
      /project registration failed: invalid_project_alias/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a running dispatcher resolves a newly registered project on its next dispatch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dalizi-registry-dispatch-"));
  const project = path.join(root, "project");
  const registryFile = path.join(root, "runtime", "project-registry.json");
  const calls = [];
  try {
    await mkdir(project);
    const dispatcher = new Dispatcher({
      registry: new ProjectRegistry(registryFile),
      allowedModels: new Set(["custom-local:step-5-preview"]),
      store: new JobStore(path.join(root, "jobs")),
      runner: { async run(input) { calls.push(input); return { pid: 1, status: "COMPLETED", finalText: "REGISTRY_DISPATCH_MARKER", error: null, actualModel: "test-model" }; } },
    });
    await assert.rejects(() => dispatcher.dispatch({ agent: "workbuddy", project: "new-project", task: "read", model: "custom-local:step-5-preview" }), { code: "unknown_project" });
    await registerProject({ registryFile, alias: "new-project", cwd: project });
    const receipt = await dispatcher.dispatch({ agent: "workbuddy", project: "new-project", task: "read", model: "custom-local:step-5-preview" });
    const completed = await waitFor(() => dispatcher.get(receipt.job_id));
    assert.equal(completed.final_text, "REGISTRY_DISPATCH_MARKER");
    assert.equal(calls[0].cwd, await (await import("node:fs/promises")).realpath(project));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function waitFor(read) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const value = await read();
    if (value.status === "COMPLETED" || value.status === "FAILED") return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("job did not settle");
}

test("runtime resolution fails closed for unknown, disabled, missing, and malformed registrations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dalizi-registry-"));
  const registryFile = path.join(root, "project-registry.json");
  try {
    await writeFile(registryFile, JSON.stringify({ projects: [{ alias: "disabled-project", cwd: root, enabled: false }] }), "utf8");
    const registry = new ProjectRegistry(registryFile);
    assert.throws(() => registry.resolve("unknown"), { code: "unknown_project" });
    assert.throws(() => registry.resolve("disabled-project"), { code: "disabled_project" });

    await writeFile(registryFile, JSON.stringify({ projects: [{ alias: "missing-project", cwd: path.join(root, "gone"), enabled: true }] }), "utf8");
    assert.throws(() => registry.resolve("missing-project"), { code: "project_cwd_unavailable" });

    await writeFile(registryFile, "{not-json", "utf8");
    assert.throws(() => registry.resolve("any-project"), { code: "invalid_registry" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
