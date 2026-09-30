import { StringDecoder } from "node:string_decoder";

function redact(value) {
  return String(value)
    .replace(/(bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|password)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(authorization\s*:\s*(?:bearer\s+)?|(?:cookie|session|credential)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

function safeErrorCode(value, depth = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 3) return null;
  if (typeof value.code === "string") {
    const code = value.code.trim();
    if (/^[A-Z][A-Z0-9_.:-]{0,79}$/.test(code) || /^\d{3}$/.test(code)) return code;
    return "PRESENT";
  }
  for (const key of ["error", "detail", "details"]) {
    const nested = safeErrorCode(value[key], depth + 1);
    if (nested) return nested;
  }
  return null;
}

function errorEventText(value, depth = 0) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = errorEventText(item, depth + 1);
      if (text) return text;
    }
  }
  if (!value || typeof value !== "object" || depth > 3) return null;
  for (const key of ["message", "name", "error", "detail", "details"]) {
    const text = errorEventText(value[key], depth + 1);
    if (text) return text;
  }
  return null;
}

function safeErrorText(value) {
  if (value === null || value === undefined) return null;
  const text = redact(value).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.slice(0, 240);
}

function errorEventKeys(value, prefix = "", depth = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 3) return [];
  const keys = [];
  for (const key of ["type", "subtype", "code", "name", "message", "error", "detail", "details"]) {
    if (!Object.hasOwn(value, key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    keys.push(path);
    if (["error", "detail", "details"].includes(key)) keys.push(...errorEventKeys(value[key], path, depth + 1));
  }
  return keys;
}

function safeErrorSummary(value, errorEvent = null) {
  const text = String(value ?? "").toLowerCase();
  let category = "unclassified_error";
  if (/(auth|login|credential|session|cookie|bearer|token|api[_-]?key|password|unauthori[sz]ed|forbidden|permission)/.test(text)) {
    category = "authentication_or_permission";
  } else if (/(quota|budget|rate limit|too many requests)/.test(text)) category = "quota_or_rate_limit";
  else if (/(network|connect|connection|timeout|dns|socket|proxy|offline)/.test(text)) category = "network";
  else if (/(model|not found|unsupported|invalid model)/.test(text)) category = "model_configuration";
  else if (/(internal|server|\b5\d\d\b)/.test(text)) category = "service_internal";
  const code = safeErrorCode(errorEvent);
  const message = safeErrorText(errorEventText(errorEvent));
  return [category, code ? `code=${code}` : null, message ? `message=${message}` : null].filter(Boolean).join(";");
}

function textFrom(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = textFrom(item);
      if (text) return text;
    }
  }
  if (value && typeof value === "object") {
    for (const key of ["message", "error", "text", "result", "final_text", "detail", "details", "code", "name"]) {
      const text = textFrom(value[key]);
      if (text) return text;
    }
  }
  return null;
}

// Incremental NDJSON decoder: accepts string or Buffer chunks, survives
// multi-byte UTF-8 split across chunk boundaries, half lines, several lines in
// one chunk, streams that do not end with a newline, and bad JSON lines (which
// are reported through onMalformed instead of throwing).
export class StreamJsonDecoder {
  constructor({ onEvent, onMalformed } = {}) {
    this.onEvent = typeof onEvent === "function" ? onEvent : null;
    this.onMalformed = typeof onMalformed === "function" ? onMalformed : null;
    this.textDecoder = new StringDecoder("utf8");
    this.pending = "";
  }

  push(chunk) {
    if (chunk === null || chunk === undefined) return;
    if (typeof chunk === "string") {
      this.pending += chunk;
    } else {
      this.pending += this.textDecoder.write(chunk);
    }
    let newline = this.pending.indexOf("\n");
    while (newline !== -1) {
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      this.#handleLine(line);
      newline = this.pending.indexOf("\n");
    }
  }

  // Processes a trailing half line when the stream ends without a newline.
  flush() {
    this.pending += this.textDecoder.end();
    const rest = this.pending;
    this.pending = "";
    if (rest) this.#handleLine(rest);
  }

  #handleLine(rawLine) {
    let line = rawLine;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      this.onMalformed?.(line, error);
      return;
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      this.onMalformed?.(line, new Error("event_is_not_a_json_object"));
      return;
    }
    this.onEvent?.(event);
  }
}

// Folds a stream of parsed events into the V0 run summary state. Shared by
// interpretRun (whole-output parsing) and the runners (incremental parsing) so
// verdict equivalence is guaranteed by construction, not by duplicate logic.
export class RunInterpreter {
  constructor() {
    this.eventTypes = new Set();
    this.assistantContentBlockTypes = new Set();
    this.terminalResult = null;
    this.parsedError = null;
    this.errorEvent = null;
    this.actualModel = "NOT_OBSERVABLE";
    this.malformedOutput = false;
  }

  observe(event) {
    if (typeof event.type === "string" && event.type.trim()) this.eventTypes.add(event.type);
    if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block && typeof block === "object" && typeof block.type === "string" && block.type.trim()) {
          this.assistantContentBlockTypes.add(block.type);
        }
      }
    }
    if (typeof event.model === "string" && event.model.trim()) this.actualModel = event.model;
    if (typeof event.actual_model === "string" && event.actual_model.trim()) this.actualModel = event.actual_model;
    if (event.type === "result") this.terminalResult = event;
    if (event.type === "error" || event.is_error === true) {
      if (event.type === "error") this.errorEvent ??= event;
      this.parsedError ??= textFrom(event.error) ?? textFrom(event);
    }
  }

  noteMalformed() {
    this.malformedOutput = true;
  }
}

// Verdict cascade extracted from the original interpretRun: same precedence
// order (malformed -> terminal is_error -> parsed error -> protocol success ->
// missing terminal result -> process exit), same diagnostics field set.
export function finalizeRun(interpreter, { stderr, exitCode }) {
  const { terminalResult, parsedError, errorEvent, actualModel, malformedOutput, eventTypes, assistantContentBlockTypes } = interpreter;

  const diagnostics = (errorCategory = null, errorSummary = null) => ({
    process_exit_code: exitCode,
    stderr_present: Boolean(String(stderr ?? "").trim()),
    event_types: [...eventTypes],
    terminal_result_seen: terminalResult !== null,
    terminal_subtype: typeof terminalResult?.subtype === "string" ? terminalResult.subtype : null,
    terminal_is_error: typeof terminalResult?.is_error === "boolean" ? terminalResult.is_error : null,
    result_field_present: Boolean(terminalResult && Object.hasOwn(terminalResult, "result")),
    errors_present: Boolean(terminalResult && Object.hasOwn(terminalResult, "errors")),
    errors_info_present: Boolean(terminalResult && Object.hasOwn(terminalResult, "errors_info")),
    assistant_content_block_types: [...assistantContentBlockTypes],
    error_event_keys: errorEvent ? errorEventKeys(errorEvent) : [],
    error_category: errorCategory,
    safe_error_summary: errorSummary,
  });
  const result = ({ status, finalText, error, errorCategory = null, errorSummary = null }) => ({
    status,
    finalText,
    error,
    actualModel,
    diagnostics: diagnostics(errorCategory, errorSummary),
  });

  if (malformedOutput) return result({ status: "FAILED", finalText: null, error: "stream_json_protocol_error", errorCategory: "stream_json_protocol" });
  if (terminalResult?.is_error === true) {
    const subtype = typeof terminalResult.subtype === "string" && terminalResult.subtype.trim() ? terminalResult.subtype : "unknown";
    const summary = safeErrorSummary(textFrom(terminalResult.errors) ?? textFrom(terminalResult.errors_info) ?? textFrom(terminalResult.error));
    return result({ status: "FAILED", finalText: null, error: `workbuddy_error:${subtype}:${summary}`, errorCategory: "workbuddy_error", errorSummary: summary });
  }
  if (parsedError || errorEvent) {
    const summary = parsedError ? safeErrorSummary(parsedError, errorEvent) : "empty_error_event";
    return result({ status: "FAILED", finalText: null, error: `parsed_error: ${summary}`, errorCategory: "parsed_error", errorSummary: summary });
  }
  if (terminalResult?.subtype === "success" && terminalResult.is_error === false && typeof terminalResult.result === "string" && terminalResult.result.trim()) {
    return result({ status: "COMPLETED", finalText: redact(terminalResult.result.trim()), error: null });
  }
  if (exitCode === 0) return result({ status: "FAILED", finalText: null, error: "missing_terminal_result", errorCategory: "missing_terminal_result" });
  const summary = safeErrorSummary(stderr);
  return result({ status: "FAILED", finalText: null, error: `process_exit_${exitCode}: ${summary}`, errorCategory: "process_exit", errorSummary: summary });
}

export function interpretRun({ stdout, stderr, exitCode }) {
  const interpreter = new RunInterpreter();
  const decoder = new StreamJsonDecoder({
    onEvent: (event) => interpreter.observe(event),
    onMalformed: () => interpreter.noteMalformed(),
  });
  decoder.push(String(stdout ?? ""));
  decoder.flush();
  return finalizeRun(interpreter, { stderr, exitCode });
}
