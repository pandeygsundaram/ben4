import fs from "fs-extra";
import path from "path";

export const PROJECTS_DIR = "/home/sundaram/data/reel-server/projects";

export type JobStatus = "pending" | "transcribing" | "rendering" | "done" | "error";

export type Clip = {
  videoPath: string;
  description: string;
  captions?: any[];
};

export type Job = {
  id: string;
  status: JobStatus;
  clips: Clip[];
  projectPath: string;
  outputPath?: string;
  error?: string;
  createdAt: number;
};

const jobs = new Map<string, Job>();

export function createJob(id: string, clips: Clip[], projectPath: string): Job {
  const job: Job = { id, status: "pending", clips, projectPath, createdAt: Date.now() };
  jobs.set(id, job);
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function updateJob(id: string, patch: Partial<Job>): void {
  const job = jobs.get(id);
  if (job) jobs.set(id, { ...job, ...patch });
}

export async function loadJobsFromDisk(): Promise<void> {
  if (!await fs.pathExists(PROJECTS_DIR)) return;

  const entries = await fs.readdir(PROJECTS_DIR);

  for (const entry of entries) {
    const jobFile = path.join(PROJECTS_DIR, entry, "job.json");
    if (!await fs.pathExists(jobFile)) continue;

    try {
      const data = await fs.readJson(jobFile);
      const job: Job = {
        id: data.jobId ?? entry,
        status: data.status ?? "pending",
        clips: data.clips ?? [],
        projectPath: path.join(PROJECTS_DIR, entry),
        outputPath: data.outputPath,
        error: data.error,
        createdAt: data.createdAt ?? 0,
      };
      jobs.set(job.id, job);
    } catch {
      console.warn(`[jobs] could not load ${jobFile}`);
    }
  }

  console.log(`[jobs] loaded ${jobs.size} jobs from disk`);
}
