import { mkdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DispatcherError } from "./contracts.js";

export const PROJECT_REGISTRY_FILENAME = "project-registry.json";
const ALIAS_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

function invalidRegistry(message) {
  return new DispatcherError("invalid_registry", message);
}

function validateAlias(alias) {
  if (typeof alias !== "string" || !ALIAS_PATTERN.test(alias)) {
    throw new DispatcherError("invalid_project_alias", "project alias must use lowercase letters, numbers, and hyphens");
  }
  return alias;
}

function validateEntry(entry, seenAliases) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalidRegistry("project entry must be an object");
  const keys = Object.keys(entry).sort();
  if (keys.length !== 3 || keys[0] !== "alias" || keys[1] !== "cwd" || keys[2] !== "enabled") {
    throw invalidRegistry("project entry must contain only alias, cwd, and enabled");
  }
  try {
    validateAlias(entry.alias);
  } catch {
    throw invalidRegistry("project entry alias is invalid");
  }
  if (seenAliases.has(entry.alias)) throw invalidRegistry("project aliases must be unique");
  if (typeof entry.cwd !== "string" || !path.isAbsolute(entry.cwd)) throw invalidRegistry("project entry cwd must be absolute");
  if (typeof entry.enabled !== "boolean") throw invalidRegistry("project entry enabled must be boolean");
  seenAliases.add(entry.alias);
  return { alias: entry.alias, cwd: entry.cwd, enabled: entry.enabled };
}

export function parseProjectRegistry(raw, source = "project registry") {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalidRegistry(`${source} must be valid JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !Array.isArray(value.projects)) {
    throw invalidRegistry(`${source} must be an object with a projects array`);
  }
  const seenAliases = new Set();
  return { projects: value.projects.map((entry) => validateEntry(entry, seenAliases)) };
}

export function projectRegistryPath(dataDirectory) {
  return path.resolve(dataDirectory, PROJECT_REGISTRY_FILENAME);
}

function readRegistry(registryFile, { missingIsEmpty } = { missingIsEmpty: false }) {
  try {
    return parseProjectRegistry(readFileSync(registryFile, "utf8"));
  } catch (error) {
    if (missingIsEmpty && error && error.code === "ENOENT") return { projects: [] };
    if (error instanceof DispatcherError) throw error;
    throw invalidRegistry("project registry cannot be read");
  }
}

async function canonicalDirectory(cwd) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    throw new DispatcherError("invalid_project_cwd", "project cwd must be an absolute directory path");
  }
  try {
    const resolved = await realpath(cwd);
    if (!(await stat(resolved)).isDirectory()) throw new Error("not a directory");
    return resolved;
  } catch {
    throw new DispatcherError("invalid_project_cwd", "project cwd must be an existing directory");
  }
}

async function writeRegistry(registryFile, registry) {
  const directory = path.dirname(registryFile);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(registryFile)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, registryFile);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function registerProject({ registryFile, alias, cwd }) {
  if (typeof registryFile !== "string" || !path.isAbsolute(registryFile)) {
    throw new DispatcherError("invalid_registry", "registry file path must be absolute");
  }
  const validatedAlias = validateAlias(alias);
  const canonicalCwd = await canonicalDirectory(cwd);
  const registry = readRegistry(registryFile, { missingIsEmpty: true });
  const existing = registry.projects.find((entry) => entry.alias === validatedAlias);
  if (existing) {
    if (existing.cwd !== canonicalCwd) throw new DispatcherError("duplicate_project_alias", "project alias is already registered to a different cwd");
    return { alias: validatedAlias, created: false };
  }
  registry.projects.push({ alias: validatedAlias, cwd: canonicalCwd, enabled: true });
  await writeRegistry(registryFile, registry);
  return { alias: validatedAlias, created: true };
}

export class ProjectRegistry {
  constructor(registryFile) {
    if (typeof registryFile !== "string" || !path.isAbsolute(registryFile)) {
      throw new DispatcherError("invalid_registry", "registry file path must be absolute");
    }
    this.registryFile = registryFile;
  }

  resolve(alias) {
    const entry = readRegistry(this.registryFile, { missingIsEmpty: true }).projects.find((project) => project.alias === alias);
    if (!entry) throw new DispatcherError("unknown_project", "project is not registered");
    if (!entry.enabled) throw new DispatcherError("disabled_project", "project is disabled");
    try {
      const resolved = realpathSync(entry.cwd);
      if (!statSync(resolved).isDirectory()) throw new Error("not a directory");
      return resolved;
    } catch {
      throw new DispatcherError("project_cwd_unavailable", "registered project cwd is unavailable");
    }
  }
}
