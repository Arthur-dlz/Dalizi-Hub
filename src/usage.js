export const USAGE_SCHEMA_VERSION = 1;

export const METRIC_SCOPES = ["step", "turn", "invocation", "session"];
export const METRIC_KINDS = ["delta", "snapshot"];
export const METRIC_QUALITIES = ["reported", "derived", "partial", "unavailable"];

export const CANONICAL_METRIC_NAMES = [
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
  "wall_duration_ms",
  "model_duration_ms",
  "num_turns",
  "total_cost_usd",
  "job_output_tokens_per_second",
  "model_output_tokens_per_second",
  "generation_tokens_per_second",
];

const CANONICAL_NAMES = new Set(CANONICAL_METRIC_NAMES);

// Projection precedence when one canonical name exists in several scopes:
// the widest (most cumulative) scope wins in snapshot().
const SCOPE_PRECEDENCE = ["session", "invocation", "turn", "step"];

const BACKGROUND_COVERAGE = "unknown";
const BACKGROUND_COVERAGE_REASON = "overlap_between_background_and_main_usage_has_no_evidence";

const DEFAULT_UNITS = new Map([
  ["input_tokens", "tokens"],
  ["output_tokens", "tokens"],
  ["total_tokens", "tokens"],
  ["cache_read_tokens", "tokens"],
  ["cache_write_tokens", "tokens"],
  ["reasoning_tokens", "tokens"],
  ["wall_duration_ms", "ms"],
  ["model_duration_ms", "ms"],
  ["num_turns", "turns"],
  ["total_cost_usd", "usd"],
  ["job_output_tokens_per_second", "tokens/s"],
  ["model_output_tokens_per_second", "tokens/s"],
  ["generation_tokens_per_second", "tokens/s"],
]);

function assertCanonicalName(name) {
  if (typeof name !== "string" || !CANONICAL_NAMES.has(name)) {
    throw new Error(`unknown_canonical_metric_name: ${String(name)}`);
  }
}

function isReason(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function createMetric({ value, unit, scope, kind, source_field, quality, unavailable_reason } = {}) {
  if (value === null) {
    if (!isReason(unavailable_reason)) throw new Error("metric_requires_unavailable_reason_for_null_value");
    if (quality !== "unavailable") throw new Error("metric_null_value_requires_unavailable_quality");
    if (kind === "delta") throw new Error("metric_delta_requires_non_null_value");
  } else {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("metric_value_must_be_a_finite_number");
    if (value < 0) throw new Error("metric_value_must_not_be_negative");
    if (unavailable_reason !== undefined && unavailable_reason !== null) throw new Error("metric_unavailable_reason_requires_null_value");
    if (quality === "unavailable") throw new Error("metric_unavailable_quality_requires_null_value");
  }
  if (typeof unit !== "string" || unit.trim().length === 0) throw new Error("metric_requires_unit");
  if (typeof source_field !== "string" || source_field.trim().length === 0) throw new Error("metric_requires_source_field");
  if (!METRIC_SCOPES.includes(scope)) throw new Error(`metric_unknown_scope: ${String(scope)}`);
  if (!METRIC_KINDS.includes(kind)) throw new Error(`metric_unknown_kind: ${String(kind)}`);
  if (!METRIC_QUALITIES.includes(quality)) throw new Error(`metric_unknown_quality: ${String(quality)}`);

  const metric = { value, unit, scope, kind, source_field, quality };
  if (value === null) metric.unavailable_reason = unavailable_reason;
  return metric;
}

function slotKey(name, scope) {
  return `${name}\u0000${scope}`;
}

// Projection preference between two slots of the same canonical name: a
// non-null value always outranks a null/unavailable one; between equal
// value-presence the widest (most cumulative) scope wins.
function prefersProjection(candidate, current) {
  if (candidate.value !== null && current.value === null) return true;
  if (candidate.value === null && current.value !== null) return false;
  return SCOPE_PRECEDENCE.indexOf(candidate.scope) < SCOPE_PRECEDENCE.indexOf(current.scope);
}

function normalizeInclusion(inclusion) {
  const normalize = (flag) => (typeof flag === "boolean" ? flag : null);
  const source = inclusion && typeof inclusion === "object" ? inclusion : {};
  return {
    input_includes_cache: normalize(source.input_includes_cache),
    output_includes_reasoning: normalize(source.output_includes_reasoning),
  };
}

export class UsageAggregator {
  constructor({ inclusion } = {}) {
    this.inclusion = normalizeInclusion(inclusion);
    this.slots = new Map();
    this.backgroundMetrics = new Map();
    this.seenDeltaIds = new Set();
  }

  // A snapshot replaces the previous value stored for the same (name, scope).
  applySnapshot(name, fields = {}) {
    assertCanonicalName(name);
    const metric = createMetric({ ...fields, kind: "snapshot" });
    this.slots.set(slotKey(name, metric.scope), metric);
  }

  // A delta accumulates onto the delta entry for the same (name, scope).
  // A deltaId already seen is skipped so replays never double count.
  // Returns true when the delta was accumulated, false when it was skipped.
  applyDelta(name, fields = {}, { deltaId } = {}) {
    assertCanonicalName(name);
    if (deltaId !== undefined && deltaId !== null) {
      const key = String(deltaId);
      if (this.seenDeltaIds.has(key)) return false;
      if (typeof fields.value !== "number" || !Number.isFinite(fields.value) || fields.value < 0) {
        throw new Error("metric_delta_requires_non_negative_finite_value");
      }
      this.seenDeltaIds.add(key);
    }
    const scope = fields.scope ?? "session";
    const key = slotKey(name, scope);
    const existing = this.slots.get(key);
    const base = existing && existing.kind === "delta" && existing.value !== null ? existing.value : 0;
    const metric = createMetric({
      value: base + fields.value,
      unit: fields.unit ?? DEFAULT_UNITS.get(name),
      scope,
      kind: "delta",
      source_field: fields.source_field,
      quality: fields.quality ?? "reported",
    });
    this.slots.set(key, metric);
    return true;
  }

  // Terminal result usage replaces the whole main-task aggregation (all scopes);
  // it is authoritative and is never added on top of temporary aggregates.
  applyResultUsage(dict) {
    const entries = dict && typeof dict === "object" && !Array.isArray(dict) ? Object.entries(dict) : [];
    const next = new Map();
    for (const [name, entry] of entries) {
      assertCanonicalName(name);
      const source = entry && typeof entry === "object" ? entry : {};
      const unavailableReason = source.unavailable_reason ?? (source.value === null ? "not_reported_in_result" : null);
      const metric = createMetric({
        value: source.value ?? null,
        unit: source.unit ?? DEFAULT_UNITS.get(name),
        scope: source.scope ?? "session",
        kind: "snapshot",
        source_field: source.source_field,
        quality: source.quality ?? "reported",
        unavailable_reason: unavailableReason,
      });
      next.set(slotKey(name, metric.scope), metric);
    }
    this.slots = next;
  }

  // Background sub-task usage is listed separately and never merged into the
  // main task. Overlap with main-task usage has no evidence, so coverage stays
  // "unknown". Entries without an observed value are skipped.
  setBackgroundUsage(dict, { source_field } = {}) {
    const entries = dict && typeof dict === "object" && !Array.isArray(dict) ? Object.entries(dict) : {};
    for (const [name, entry] of entries) {
      assertCanonicalName(name);
      const source = entry && typeof entry === "object" ? entry : {};
      if (source.value === null || source.value === undefined) continue;
      this.backgroundMetrics.set(
        name,
        createMetric({
          value: source.value,
          unit: source.unit ?? DEFAULT_UNITS.get(name),
          scope: source.scope ?? "session",
          kind: "snapshot",
          source_field: source.source_field ?? source_field,
          quality: source.quality ?? "reported",
        }),
      );
    }
  }

  // Provider-reported total wins (no-op). Otherwise the total is derived only
  // when both inclusion flags are declared; when they are not, the metric is
  // recorded as unavailable with the reason "inclusion_not_declared".
  deriveTotalTokens() {
    const current = this.#projectMetric("total_tokens");
    if (current && current.quality === "reported" && current.value !== null) return;

    const { input_includes_cache, output_includes_reasoning } = this.inclusion;
    if (input_includes_cache === null || output_includes_reasoning === null) {
      this.#setUnavailable("total_tokens", "inclusion_not_declared", "derived:total_tokens");
      return;
    }

    const components = [];
    const input = this.#projectMetric("input_tokens");
    if (!input || input.value === null) return this.#setUnavailable("total_tokens", "input_tokens_unavailable", "derived:total_tokens");
    components.push(input.value);
    if (input_includes_cache === false) {
      const cacheRead = this.#projectMetric("cache_read_tokens");
      const cacheWrite = this.#projectMetric("cache_write_tokens");
      if (!cacheRead || cacheRead.value === null || !cacheWrite || cacheWrite.value === null) {
        return this.#setUnavailable("total_tokens", "cache_tokens_unavailable", "derived:total_tokens");
      }
      components.push(cacheRead.value, cacheWrite.value);
    }
    const output = this.#projectMetric("output_tokens");
    if (!output || output.value === null) return this.#setUnavailable("total_tokens", "output_tokens_unavailable", "derived:total_tokens");
    components.push(output.value);
    if (output_includes_reasoning === false) {
      const reasoning = this.#projectMetric("reasoning_tokens");
      if (!reasoning || reasoning.value === null) {
        return this.#setUnavailable("total_tokens", "reasoning_tokens_unavailable", "derived:total_tokens");
      }
      components.push(reasoning.value);
    }

    this.slots.set(
      slotKey("total_tokens", "session"),
      createMetric({
        value: components.reduce((sum, value) => sum + value, 0),
        unit: "tokens",
        scope: "session",
        kind: "snapshot",
        source_field: "derived:input_tokens+output_tokens",
        quality: "derived",
      }),
    );
  }

  // Throughput is derived in three tiers: job-average output throughput needs
  // output_tokens + wall_duration_ms; model throughput additionally needs
  // model_duration_ms; generation speed is never observable without a
  // generation-interval witness and stays honestly unavailable.
  deriveThroughput() {
    const output = this.#projectMetric("output_tokens");
    const wall = this.#projectMetric("wall_duration_ms");
    if (output && output.value !== null && wall && wall.value !== null && wall.value > 0) {
      this.#setDerived("job_output_tokens_per_second", output.value / (wall.value / 1000), "derived:output_tokens/wall_duration_ms");
    } else {
      const reason = !output || output.value === null ? "output_tokens_unavailable" : "wall_duration_ms_unavailable";
      this.#setUnavailable("job_output_tokens_per_second", reason, "derived:output_tokens/wall_duration_ms");
    }

    const model = this.#projectMetric("model_duration_ms");
    if (output && output.value !== null && model && model.value !== null && model.value > 0) {
      this.#setDerived("model_output_tokens_per_second", output.value / (model.value / 1000), "derived:output_tokens/model_duration_ms");
    } else {
      const reason = !output || output.value === null ? "output_tokens_unavailable" : "model_duration_ms_unavailable";
      this.#setUnavailable("model_output_tokens_per_second", reason, "derived:output_tokens/model_duration_ms");
    }

    const generation = this.#projectMetric("generation_tokens_per_second");
    if (!generation || generation.quality !== "reported") {
      this.#setUnavailable("generation_tokens_per_second", "generation_interval_not_observable", "derived:generation_tokens_per_second");
    }
  }

  snapshot() {
    const metrics = {};
    for (const [key, metric] of this.slots) {
      const name = key.slice(0, key.indexOf("\u0000"));
      const existing = metrics[name];
      if (!existing || prefersProjection(metric, existing)) {
        metrics[name] = { ...metric };
      }
    }
    const background = {};
    for (const [name, metric] of this.backgroundMetrics) {
      background[name] = { ...metric };
    }
    return {
      schema_version: USAGE_SCHEMA_VERSION,
      inclusion: { ...this.inclusion },
      metrics,
      background: {
        coverage: BACKGROUND_COVERAGE,
        coverage_reason: BACKGROUND_COVERAGE_REASON,
        metrics: background,
      },
    };
  }

  #projectMetric(name) {
    let best = null;
    for (const [key, metric] of this.slots) {
      if (key.slice(0, key.indexOf("\u0000")) !== name) continue;
      if (!best || prefersProjection(metric, best)) best = metric;
    }
    return best;
  }

  #setUnavailable(name, reason, source_field) {
    this.slots.set(
      slotKey(name, "session"),
      createMetric({
        value: null,
        unit: DEFAULT_UNITS.get(name),
        scope: "session",
        kind: "snapshot",
        source_field,
        quality: "unavailable",
        unavailable_reason: reason,
      }),
    );
  }

  #setDerived(name, value, source_field) {
    this.slots.set(
      slotKey(name, "session"),
      createMetric({
        value,
        unit: DEFAULT_UNITS.get(name),
        scope: "session",
        kind: "snapshot",
        source_field,
        quality: "derived",
      }),
    );
  }
}
