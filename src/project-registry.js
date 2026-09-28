import { mkdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DispatcherError } from "./contracts.js";

export const PROJECT_REGISTRY_FILENAME = "project-registry.json";
export const WORKSPACE_ROOTS_FILENAME = "workspace-roots.json";
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

export function workspaceRootsPath(dataDirectory) {
  return path.resolve(dataDirectory, WORKSPACE_ROOTS_FILENAME);
}

function withinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function readWorkspaceRoots(rootsFile) {
  let raw;
  try {
    raw = readFileSync(rootsFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      try {
        lstatSync(rootsFile);
      } catch (lookupError) {
        if (lookupError?.code === "ENOENT") return null;
      }
    }
    throw new DispatcherError("invalid_workspace_roots", "approved workspace roots cannot be read");
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).length !== 1 || !Array.isArray(value.roots) || value.roots.length === 0) {
      throw new Error("invalid shape");
    }
    const roots = value.roots.map((root) => {
      if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("root must be absolute");
      const canonical = realpathSync(root);
      if (!statSync(canonical).isDirectory()) throw new Error("root must be a directory");
      return canonical;
    });
    if (new Set(roots.map((root) => process.platform === "win32" ? root.toLowerCase() : root)).size !== roots.length) {
      throw new Error("duplicate root");
    }
    return roots;
  } catch {
    throw new DispatcherError("invalid_workspace_roots", "approved workspace roots must contain existing absolute directories");
  }
}

function canonicalResolvedProject(cwd, roots, alias) {
  let canonical;
  try {
    canonical = realpathSync(cwd);
    if (!statSync(canonical).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new DispatcherError(alias ? "project_cwd_unavailable" : "unknown_project", alias ? "registered project cwd is unavailable" : "project is not registered");
  }
  if (roots && !roots.some((root) => withinRoot(canonical, root))) {
    throw new DispatcherError("project_out_of_root", "project is outside approved workspace roots");
  }
  return canonical;
}

function discoverProject(name, roots) {
  if (!roots || typeof name !== "string" || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes(":") || name.includes("\0")) {
    throw new DispatcherError("unknown_project", "project is not registered");
  }
  const children = roots.flatMap((root) => {
    try {
      return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => ({ name: entry.name, cwd: path.join(root, entry.name) }));
    } catch {
      throw new DispatcherError("invalid_workspace_roots", "approved workspace roots cannot be read");
    }
  });
  let matches = children.filter((child) => child.name === name);
  if (matches.length === 0 && process.platform === "win32") {
    matches = children.filter((child) => child.name.toLowerCase() === name.toLowerCase());
  }
  if (matches.length === 0) throw new DispatcherError("unknown_project", "project is not registered");
  if (matches.length > 1) throw new DispatcherError("ambiguous_project", "project name matches multiple workspace directories");
  return canonicalResolvedProject(matches[0].cwd, roots, false);
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
  constructor(registryFile, rootsFile) {
    if (typeof registryFile !== "string" || !path.isAbsolute(registryFile)) {
      throw new DispatcherError("invalid_registry", "registry file path must be absolute");
    }
    this.registryFile = registryFile;
    this.rootsFile = rootsFile ?? workspaceRootsPath(path.dirname(registryFile));
  }

  resolve(alias) {
    const roots = readWorkspaceRoots(this.rootsFile);
    const entry = readRegistry(this.registryFile, { missingIsEmpty: true }).projects.find((project) => project.alias === alias);
    if (!entry) return discoverProject(alias, roots);
    if (!entry.enabled) throw new DispatcherError("disabled_project", "project is disabled");
    return canonicalResolvedProject(entry.cwd, roots, true);
  }
}
