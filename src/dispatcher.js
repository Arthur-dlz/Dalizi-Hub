import { randomUUID } from "node:crypto";
import { DispatcherError, resolveProject, validateDispatchInput } from "./contracts.js";

const TERMINAL = new Set(["COMPLETED", "FAILED"]);

function now() {
  return new Date().toISOString();
}

export class Dispatcher {
  constructor({ registry, allowedModels, store, runner, codexRunner, antigravityRunner }) {
    this.registry = registry;
    this.allowedModels = allowedModels;
    this.store = store;
    this.runner = runner;
    this.codexRunner = codexRunner;
    this.antigravityRunner = antigravityRunner;
    this.activeJobId = null;
  }

  async dispatch(input) {
    if (this.activeJobId) throw new DispatcherError("dispatcher_busy", "only one Dispatcher job may run at a time");
    const validated = validateDispatchInput(input, this.allowedModels);
    const cwd = await resolveProject(validated.project, this.registry);
    const jobId = randomUUID();
    this.activeJobId = jobId;
    try {
      const job = await this.store.create({
        job_id: jobId,
        agent: validated.agent,
        project: validated.project,
        cwd,
        requested_model: validated.model,
        actual_model: "NOT_OBSERVABLE",
        effort: validated.effort,
        status: "QUEUED",
        created_at: now(),
        started_at: null,
        finished_at: null,
        pid: null,
        final_text: null,
        error: null,
      });
      setImmediate(() => void this.#execute(job, validated));
      return { job_id: job.job_id, status: job.status };
    } catch (error) {
      this.activeJobId = null;
      throw error;
    }
  }

  async get(jobId) {
    return this.store.get(jobId);
  }

  async #execute(job, input) {
    try {
      await this.store.update(job.job_id, { status: "RUNNING", started_at: now() });
      const runner = input.agent === "codex"
        ? this.codexRunner
        : input.agent === "antigravity"
          ? this.antigravityRunner
          : this.runner;
      const run = await runner.run({
        cwd: job.cwd,
        model: input.model,
        effort: input.effort,
        task: input.task,
        onStarted: async (pid) => this.store.update(job.job_id, { pid }),
      });
      await this.store.update(job.job_id, {
        pid: run.pid,
        status: TERMINAL.has(run.status) ? run.status : "FAILED",
        actual_model: run.actualModel ?? "NOT_OBSERVABLE",
        final_text: run.finalText,
        error: run.error,
        diagnostics: run.diagnostics ?? null,
        finished_at: now(),
      });
    } catch (error) {
      await this.store.update(job.job_id, { status: "FAILED", error: `dispatcher_error: ${error.message}`, finished_at: now() });
    } finally {
      this.activeJobId = null;
    }
  }
}
