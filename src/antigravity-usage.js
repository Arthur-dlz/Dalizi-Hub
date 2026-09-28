export function parseAntigravityUsage(rawOutput) {
  if (typeof rawOutput !== "string" && (typeof rawOutput !== "object" || rawOutput === null)) {
    return { status: "FAILED", error: "invalid_usage_output", groups: [] };
  }
  let data;
  if (typeof rawOutput === "string") {
    try {
      data = JSON.parse(rawOutput);
    } catch {
      return { status: "FAILED", error: "malformed_usage_json", groups: [] };
    }
  } else {
    data = rawOutput;
  }

  // Handle command.data.groups format from agy -p /usage --output-format json
  const commandData = data.command?.data ?? data.data ?? data;
  const rawGroups = Array.isArray(commandData.groups) ? commandData.groups : [];

  const groups = rawGroups.map((g) => {
    const name = typeof g?.name === "string" ? g.name.trim() : "Unknown Group";
    const description = typeof g?.description === "string" ? g.description.trim() : "";
    const rawBuckets = Array.isArray(g?.buckets) ? g.buckets : [];
    const buckets = rawBuckets.map((b) => ({
      id: typeof b?.id === "string" ? b.id.trim() : "",
      name: typeof b?.name === "string" ? b.name.trim() : "",
      window: typeof b?.window === "string" ? b.window.trim() : "",
      remaining_fraction: typeof b?.remaining_fraction === "number" ? b.remaining_fraction : 0,
      reset_time: typeof b?.reset_time === "string" ? b.reset_time.trim() : null,
    }));
    return { name, description, buckets };
  });

  return {
    status: data.status === "ERROR" ? "FAILED" : "SUCCESS",
    error: data.error ?? null,
    groups,
  };
}
