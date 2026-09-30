import test from "node:test";
import assert from "node:assert/strict";
import {
  USAGE_SCHEMA_VERSION,
  METRIC_SCOPES,
  METRIC_KINDS,
  METRIC_QUALITIES,
  CANONICAL_METRIC_NAMES,
  createMetric,
  UsageAggregator,
} from "../src/usage.js";

const UNDECLARED_INCLUSION = { input_includes_cache: null, output_includes_reasoning: null };

function reported(value, overrides = {}) {
  return { value, unit: "tokens", scope: "session", kind: "snapshot", source_field: "usage.input_tokens", quality: "reported", ...overrides };
}

test("createMetric builds a reported metric and the module exports the semantic constants", () => {
  const metric = createMetric(reported(42, { source_field: "usage.total_tokens" }));
  assert.deepEqual(metric, {
    value: 42,
    unit: "tokens",
    scope: "session",
    kind: "snapshot",
    source_field: "usage.total_tokens",
    quality: "reported",
  });
  assert.equal(USAGE_SCHEMA_VERSION, 1);
  assert.deepEqual(METRIC_SCOPES, ["step", "turn", "invocation", "session"]);
  assert.deepEqual(METRIC_KINDS, ["delta", "snapshot"]);
  assert.deepEqual(METRIC_QUALITIES, ["reported", "derived", "partial", "unavailable"]);
  assert.ok(CANONICAL_METRIC_NAMES.includes("generation_tokens_per_second"));
});

test("createMetric rejects invalid scopes, kinds, qualities, units and source fields", () => {
  assert.throws(() => createMetric(reported(1, { scope: "lifetime" })), /metric_unknown_scope/);
  assert.throws(() => createMetric(reported(1, { kind: "gauge" })), /metric_unknown_kind/);
  assert.throws(() => createMetric(reported(1, { quality: "estimated" })), /metric_unknown_quality/);
  assert.throws(() => createMetric(reported(1, { unit: "" })), /metric_requires_unit/);
  assert.throws(() => createMetric(reported(1, { source_field: "" })), /metric_requires_source_field/);
});

test("createMetric enforces null-implies-unavailable and rejects negative or non-finite values", () => {
  assert.throws(() => createMetric(reported(null)), /metric_requires_unavailable_reason_for_null_value/);
  assert.throws(() => createMetric(reported(null, { quality: "unavailable" })), /metric_requires_unavailable_reason_for_null_value/);
  assert.throws(() => createMetric(reported(1, { quality: "unavailable" })), /metric_unavailable_quality_requires_null_value/);
  assert.throws(() => createMetric(reported(1, { unavailable_reason: "why" })), /metric_unavailable_reason_requires_null_value/);
  assert.throws(() => createMetric(reported(-5)), /metric_value_must_not_be_negative/);
  assert.throws(() => createMetric(reported(Number.POSITIVE_INFINITY)), /metric_value_must_be_a_finite_number/);
  const unavailable = createMetric(reported(null, { quality: "unavailable", unavailable_reason: "source_field_absent" }));
  assert.deepEqual(unavailable, {
    value: null,
    unit: "tokens",
    scope: "session",
    kind: "snapshot",
    source_field: "usage.input_tokens",
    quality: "unavailable",
    unavailable_reason: "source_field_absent",
  });
});

test("a reported zero stays zero and never degrades into null", () => {
  const aggregator = new UsageAggregator({ inclusion: UNDECLARED_INCLUSION });
  aggregator.applySnapshot("output_tokens", { value: 0, unit: "tokens", scope: "turn", source_field: "usage.output_tokens", quality: "reported" });
  assert.equal(aggregator.snapshot().metrics.output_tokens.value, 0);
  assert.equal(aggregator.snapshot().metrics.output_tokens.quality, "reported");
});

test("a missing field is stored as null with an unavailable reason, not zero", () => {
  const aggregator = new UsageAggregator({ inclusion: UNDECLARED_INCLUSION });
  aggregator.applySnapshot("input_tokens", {
    value: null,
    unit: "tokens",
    scope: "turn",
    source_field: "usage.input_tokens",
    quality: "unavailable",
    unavailable_reason: "source_field_absent",
  });
  const metric = aggregator.snapshot().metrics.input_tokens;
  assert.equal(metric.value, null);
  assert.equal(metric.unavailable_reason, "source_field_absent");
});

test("the same (name, scope) snapshot replaces the previous value", () => {
  const aggregator = new UsageAggregator({ inclusion: UNDECLARED_INCLUSION });
  aggregator.applySnapshot("output_tokens", { value: 10, unit: "tokens", scope: "turn", source_field: "usage_update.output_tokens", quality: "reported" });
  aggregator.applySnapshot("output_tokens", { value: 25, unit: "tokens", scope: "turn", source_field: "usage_update.output_tokens", quality: "reported" });
  assert.equal(aggregator.snapshot().metrics.output_tokens.value, 25);
});

test("a replayed deltaId never accumulates twice while new deltaIds do", () => {
  const aggregator = new UsageAggregator({ inclusion: UNDECLARED_INCLUSION });
  const fields = { unit: "tokens", scope: "turn", source_field: "usage.input_tokens" };
  assert.equal(aggregator.applyDelta("input_tokens", { value: 5, ...fields }, { deltaId: "delta-1" }), true);
  assert.equal(aggregator.applyDelta("input_tokens", { value: 5, ...fields }, { deltaId: "delta-1" }), false);
  assert.equal(aggregator.applyDelta("input_tokens", { value: 3, ...fields }, { deltaId: "delta-2" }), true);
  assert.deepEqual(aggregator.snapshot().metrics.input_tokens, {
    value: 8,
    unit: "tokens",
    scope: "turn",
    kind: "delta",
    source_field: "usage.input_tokens",
    quality: "reported",
  });
});

test("deltas in different scopes accumulate in isolation and never pollute each other", () => {
  const aggregator = new UsageAggregator({ inclusion: UNDECLARED_INCLUSION });
  const fields = { unit: "tokens", source_field: "usage.input_tokens" };
  aggregator.applyDelta("input_tokens", { value: 5, ...fields, scope: "turn" }, { deltaId: "turn-1" });
  aggregator.applyDelta("input_tokens", { value: 100, ...fields, scope: "session" }, { deltaId: "session-1" });
  aggregator.applyDelta("input_tokens", { value: 1, ...fields, scope: "turn" }, { deltaId: "turn-2" });
  assert.equal(aggregator.snapshot().metrics.input_tokens.value, 100);

  aggregator.applySnapshot("input_tokens", {
    value: null,
    unit: "tokens",
    scope: "session",
    source_field: "usage.input_tokens",
    quality: "unavailable",
    unavailable_reason: "source_field_absent",
  });
  const turn = aggregator.snapshot().metrics.input_tokens;
  assert.equal(turn.value, 6, "the turn accumulator must only ever see turn deltas");
  assert.equal(turn.scope, "turn");
});

test("terminal result usage replaces the temporary aggregate instead of adding to it", () => {
  const aggregator = new UsageAggregator({ inclusion: UNDECLARED_INCLUSION });
  aggregator.applySnapshot("input_tokens", { value: 40, unit: "tokens", scope: "turn", source_field: "usage.input_tokens", quality: "reported" });
  aggregator.applySnapshot("output_tokens", { value: 10, unit: "tokens", scope: "turn", source_field: "usage.output_tokens", quality: "reported" });
  aggregator.applyResultUsage({
    input_tokens: { value: 100, unit: "tokens", source_field: "usage.input_tokens", quality: "reported" },
    output_tokens: { value: 50, unit: "tokens", source_field: "usage.output_tokens", quality: "reported" },
  });
  const { metrics } = aggregator.snapshot();
  assert.equal(metrics.input_tokens.value, 100);
  assert.equal(metrics.input_tokens.scope, "session");
  assert.equal(metrics.output_tokens.value, 50);
});

test("background sub-task usage is listed separately with unknown coverage and never merges into the main task", () => {
  const aggregator = new UsageAggregator({ inclusion: UNDECLARED_INCLUSION });
  aggregator.applySnapshot("output_tokens", { value: 50, unit: "tokens", scope: "turn", source_field: "usage.output_tokens", quality: "reported" });
  aggregator.setBackgroundUsage(
    { output_tokens: { value: 200, unit: "tokens", source_field: "custom_model_usage.output_tokens", quality: "reported" } },
    { source_field: "custom_model_usage" },
  );
  const snapshot = aggregator.snapshot();
  assert.equal(snapshot.metrics.output_tokens.value, 50);
  assert.deepEqual(snapshot.background, {
    coverage: "unknown",
    coverage_reason: "overlap_between_background_and_main_usage_has_no_evidence",
    metrics: {
      output_tokens: { value: 200, unit: "tokens", scope: "session", kind: "snapshot", source_field: "custom_model_usage.output_tokens", quality: "reported" },
    },
  });
});

test("deriveTotalTokens records unavailable while inclusion is undeclared", () => {
  const aggregator = new UsageAggregator({ inclusion: UNDECLARED_INCLUSION });
  aggregator.applyResultUsage({
    input_tokens: { value: 100, unit: "tokens", source_field: "usage.input_tokens", quality: "reported" },
    output_tokens: { value: 50, unit: "tokens", source_field: "usage.output_tokens", quality: "reported" },
  });
  aggregator.deriveTotalTokens();
  assert.deepEqual(aggregator.snapshot().metrics.total_tokens, {
    value: null,
    unit: "tokens",
    scope: "session",
    kind: "snapshot",
    source_field: "derived:total_tokens",
    quality: "unavailable",
    unavailable_reason: "inclusion_not_declared",
  });
});

test("deriveTotalTokens derives once inclusion is declared for both directions", () => {
  const aggregator = new UsageAggregator({ inclusion: { input_includes_cache: false, output_includes_reasoning: false } });
  aggregator.applyResultUsage({
    input_tokens: { value: 100, unit: "tokens", source_field: "usage.input_tokens", quality: "reported" },
    cache_read_tokens: { value: 20, unit: "tokens", source_field: "usage.cache_read_input_tokens", quality: "reported" },
    cache_write_tokens: { value: 10, unit: "tokens", source_field: "usage.cache_creation_input_tokens", quality: "reported" },
    output_tokens: { value: 50, unit: "tokens", source_field: "usage.output_tokens", quality: "reported" },
    reasoning_tokens: { value: 30, unit: "tokens", source_field: "usage.reasoning_tokens", quality: "reported" },
  });
  aggregator.deriveTotalTokens();
  const total = aggregator.snapshot().metrics.total_tokens;
  assert.equal(total.value, 210);
  assert.equal(total.quality, "derived");
  assert.equal(total.source_field, "derived:input_tokens+output_tokens");
});

test("a provider-reported total keeps priority and makes deriveTotalTokens a no-op", () => {
  const aggregator = new UsageAggregator({ inclusion: { input_includes_cache: false, output_includes_reasoning: false } });
  aggregator.applyResultUsage({
    input_tokens: { value: 100, unit: "tokens", source_field: "usage.input_tokens", quality: "reported" },
    output_tokens: { value: 50, unit: "tokens", source_field: "usage.output_tokens", quality: "reported" },
    total_tokens: { value: 999, unit: "tokens", source_field: "usage.total_tokens", quality: "reported" },
  });
  aggregator.deriveTotalTokens();
  const total = aggregator.snapshot().metrics.total_tokens;
  assert.equal(total.value, 999);
  assert.equal(total.quality, "reported");
  assert.equal(total.source_field, "usage.total_tokens");
});

test("deriveThroughput distinguishes the three throughput tiers", () => {
  const aggregator = new UsageAggregator({ inclusion: UNDECLARED_INCLUSION });
  aggregator.applyResultUsage({
    output_tokens: { value: 50, unit: "tokens", source_field: "usage.output_tokens", quality: "reported" },
    wall_duration_ms: { value: 1000, unit: "ms", source_field: "usage.duration_ms", quality: "reported" },
  });
  aggregator.deriveThroughput();
  const { metrics } = aggregator.snapshot();
  assert.deepEqual(metrics.job_output_tokens_per_second, {
    value: 50,
    unit: "tokens/s",
    scope: "session",
    kind: "snapshot",
    source_field: "derived:output_tokens/wall_duration_ms",
    quality: "derived",
  });
  assert.equal(metrics.model_output_tokens_per_second.value, null);
  assert.equal(metrics.model_output_tokens_per_second.unavailable_reason, "model_duration_ms_unavailable");
  assert.equal(metrics.generation_tokens_per_second.value, null);
  assert.equal(metrics.generation_tokens_per_second.unavailable_reason, "generation_interval_not_observable");

  const withModel = new UsageAggregator({ inclusion: UNDECLARED_INCLUSION });
  withModel.applyResultUsage({
    output_tokens: { value: 60, unit: "tokens", source_field: "usage.output_tokens", quality: "reported" },
    wall_duration_ms: { value: 4000, unit: "ms", source_field: "usage.duration_ms", quality: "reported" },
    model_duration_ms: { value: 2000, unit: "ms", source_field: "usage.duration_api_ms", quality: "reported" },
  });
  withModel.deriveThroughput();
  assert.equal(withModel.snapshot().metrics.job_output_tokens_per_second.value, 15);
  assert.equal(withModel.snapshot().metrics.model_output_tokens_per_second.value, 30);
  assert.equal(withModel.snapshot().metrics.generation_tokens_per_second.value, null);
});

test("the end-to-end aggregated snapshot matches the sanitized sample expectation", () => {
  const aggregator = new UsageAggregator({ inclusion: UNDECLARED_INCLUSION });
  aggregator.applySnapshot("input_tokens", { value: 40, unit: "tokens", scope: "turn", source_field: "usage.input_tokens", quality: "reported" });
  aggregator.applySnapshot("output_tokens", { value: 10, unit: "tokens", scope: "turn", source_field: "usage.output_tokens", quality: "reported" });
  aggregator.applyResultUsage({
    input_tokens: { value: 100, unit: "tokens", source_field: "usage.input_tokens", quality: "reported" },
    output_tokens: { value: 50, unit: "tokens", source_field: "usage.output_tokens", quality: "reported" },
    total_tokens: { value: 150, unit: "tokens", source_field: "usage.total_tokens", quality: "reported" },
    wall_duration_ms: { value: 1000, unit: "ms", source_field: "usage.duration_ms", quality: "reported" },
  });
  aggregator.deriveTotalTokens();
  aggregator.deriveThroughput();
  assert.deepEqual(aggregator.snapshot(), {
    schema_version: USAGE_SCHEMA_VERSION,
    inclusion: UNDECLARED_INCLUSION,
    metrics: {
      input_tokens: { value: 100, unit: "tokens", scope: "session", kind: "snapshot", source_field: "usage.input_tokens", quality: "reported" },
      output_tokens: { value: 50, unit: "tokens", scope: "session", kind: "snapshot", source_field: "usage.output_tokens", quality: "reported" },
      total_tokens: { value: 150, unit: "tokens", scope: "session", kind: "snapshot", source_field: "usage.total_tokens", quality: "reported" },
      wall_duration_ms: { value: 1000, unit: "ms", scope: "session", kind: "snapshot", source_field: "usage.duration_ms", quality: "reported" },
      job_output_tokens_per_second: { value: 50, unit: "tokens/s", scope: "session", kind: "snapshot", source_field: "derived:output_tokens/wall_duration_ms", quality: "derived" },
      model_output_tokens_per_second: {
        value: null,
        unit: "tokens/s",
        scope: "session",
        kind: "snapshot",
        source_field: "derived:output_tokens/model_duration_ms",
        quality: "unavailable",
        unavailable_reason: "model_duration_ms_unavailable",
      },
      generation_tokens_per_second: {
        value: null,
        unit: "tokens/s",
        scope: "session",
        kind: "snapshot",
        source_field: "derived:generation_tokens_per_second",
        quality: "unavailable",
        unavailable_reason: "generation_interval_not_observable",
      },
    },
    background: {
      coverage: "unknown",
      coverage_reason: "overlap_between_background_and_main_usage_has_no_evidence",
      metrics: {},
    },
  });
});

test("the aggregator rejects unknown canonical metric names", () => {
  const aggregator = new UsageAggregator({ inclusion: UNDECLARED_INCLUSION });
  assert.throws(() => aggregator.applySnapshot("gpu_tokens", reported(1)), /unknown_canonical_metric_name/);
  assert.throws(() => aggregator.applyDelta("gpu_tokens", { value: 1, unit: "tokens", scope: "session", source_field: "x" }), /unknown_canonical_metric_name/);
  assert.throws(() => aggregator.applyResultUsage({ gpu_tokens: reported(1) }), /unknown_canonical_metric_name/);
  assert.throws(() => aggregator.setBackgroundUsage({ gpu_tokens: reported(1) }), /unknown_canonical_metric_name/);
});
