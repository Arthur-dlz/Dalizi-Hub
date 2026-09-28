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

export function interpretRun({ stdout, stderr, exitCode }) {
  let parsedError = null;
  let terminalResult = null;
  let actualModel = "NOT_OBSERVABLE";
  let malformedOutput = false;
  let errorEvent = null;
  const eventTypes = new Set();
  const assistantContentBlockTypes = new Set();

  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      malformedOutput = true;
      continue;
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      malformedOutput = true;
      continue;
    }
    if (typeof event.type === "string" && event.type.trim()) eventTypes.add(event.type);
    if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block && typeof block === "object" && typeof block.type === "string" && block.type.trim()) {
          assistantContentBlockTypes.add(block.type);
        }
      }
    }
    if (typeof event.model === "string" && event.model.trim()) actualModel = event.model;
    if (typeof event.actual_model === "string" && event.actual_model.trim()) actualModel = event.actual_model;
    if (event.type === "result") terminalResult = event;
    if (event.type === "error" || event.is_error === true) {
      if (event.type === "error") errorEvent ??= event;
      parsedError ??= textFrom(event.error) ?? textFrom(event);
    }
  }

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
