function redact(value) {
  return String(value)
    .replace(/(bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|password)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

function textFrom(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    for (const key of ["message", "error", "text", "result", "final_text"]) {
      const text = textFrom(value[key]);
      if (text) return text;
    }
  }
  return null;
}

export function interpretRun({ stdout, stderr, exitCode }) {
  let parsedError = null;
  let parsedResult = null;
  let actualModel = "NOT_OBSERVABLE";

  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof event.model === "string" && event.model.trim()) actualModel = event.model;
    if (typeof event.actual_model === "string" && event.actual_model.trim()) actualModel = event.actual_model;
    if (event.type === "error" || event.is_error === true) parsedError ??= textFrom(event.error) ?? textFrom(event);
    if (event.type === "result" || event.type === "final") parsedResult ??= textFrom(event.result) ?? textFrom(event.final_text) ?? textFrom(event.text);
  }

  if (parsedError) return { status: "FAILED", finalText: null, error: `parsed_error: ${redact(parsedError)}`, actualModel };
  if (parsedResult) return { status: "COMPLETED", finalText: redact(parsedResult), error: null, actualModel };
  if (exitCode === 0) return { status: "FAILED", finalText: null, error: "missing_parsed_result", actualModel };
  return { status: "FAILED", finalText: null, error: `process_exit_${exitCode}: ${redact(stderr || "no parsed result")}`, actualModel };
}
