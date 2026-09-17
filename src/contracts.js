export const EFFORT_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

export class DispatcherError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function requireShortString(value, field, maxLength) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new DispatcherError("invalid_input", `${field} must be a non-empty string no longer than ${maxLength} characters`);
  }
  return value.trim();
}

export function validateDispatchInput(input, allowedModels) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new DispatcherError("invalid_input", "dispatch input must be an object");
  }
  if (input.agent !== "workbuddy") {
    throw new DispatcherError("unsupported_agent", "only the workbuddy agent is supported");
  }

  const project = requireShortString(input.project, "project", 80);
  const task = requireShortString(input.task, "task", 8_000);
  const model = requireShortString(input.model, "model", 160);
  const effort = input.effort === undefined ? "medium" : requireShortString(input.effort, "effort", 20);

  if (!EFFORT_LEVELS.has(effort)) {
    throw new DispatcherError("invalid_effort", "effort must be a supported CodeBuddy effort level");
  }
  if (!(allowedModels instanceof Set) || !allowedModels.has(model)) {
    throw new DispatcherError("invalid_model", "model is not in the Dispatcher allowlist");
  }
  return { agent: "workbuddy", project, task, model, effort };
}

export function resolveProject(project, registry) {
  if (!registry || typeof registry.resolve !== "function") {
    throw new DispatcherError("invalid_registry", "project registry must provide a resolver");
  }
  return registry.resolve(project);
}
