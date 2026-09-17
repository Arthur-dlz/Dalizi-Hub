import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DispatcherError } from "./contracts.js";

function jobPath(directory, jobId) {
  if (typeof jobId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) {
    throw new DispatcherError("invalid_job_id", "job_id has an invalid format");
  }
  return path.join(directory, `${jobId}.json`);
}

export class JobStore {
  constructor(directory) {
    this.directory = directory;
  }

  async create(job) {
    if (!job || typeof job !== "object" || typeof job.job_id !== "string") {
      throw new DispatcherError("invalid_job", "job must include job_id");
    }
    await this.#write(jobPath(this.directory, job.job_id), job);
    return job;
  }

  async get(jobId) {
    const filename = jobPath(this.directory, jobId);
    try {
      return JSON.parse(await readFile(filename, "utf8"));
    } catch (error) {
      if (error && error.code === "ENOENT") {
        throw new DispatcherError("unknown_job", "job_id was not found");
      }
      throw error;
    }
  }

  async update(jobId, patch) {
    const current = await this.get(jobId);
    const next = { ...current, ...patch, job_id: current.job_id };
    await this.#write(jobPath(this.directory, jobId), next);
    return next;
  }

  async #write(filename, value) {
    await mkdir(this.directory, { recursive: true });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, filename);
  }
}
