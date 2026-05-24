import { RenderConfig } from "../engine";
import { TaskStore, TaskStatus, TaskSummary, Task, ToolCall } from "./task-store";
import { createTools } from "./tools";
import { runTaskPlanner } from "./agents/task-planner";
import { runTaskExecutor, ExecutionResult } from "./agents/task-executor";
import { runResultVerifier } from "./agents/result-verifier";
import { runErrorFixer } from "./agents/error-fixer";

export type OrchestratorConfig = {
  jobId: string;
  projectDir: string;
  renderConfig: RenderConfig;
  renderError?: string;
  maxTaskAttempts?: number;
  onLog?: (msg: string) => void;
};

const READ_ONLY_TOOLS = new Set(["read_file", "list_files", "get_folder_structure"]);

function isReadOnly(toolCalls: ToolCall[]): boolean {
  return toolCalls.length > 0 && toolCalls.every((tc) => READ_ONLY_TOOLS.has(tc.name));
}

export class VideoCodeOrchestrator {
  private store = new TaskStore();
  private jobId: string;
  private projectDir: string;
  private renderConfig: RenderConfig;
  private renderError?: string;
  private maxTaskAttempts: number;
  private log: (msg: string) => void;
  private tools: ReturnType<typeof createTools>;

  constructor(config: OrchestratorConfig) {
    this.jobId = config.jobId;
    this.projectDir = config.projectDir;
    this.renderConfig = config.renderConfig;
    this.renderError = config.renderError;
    this.maxTaskAttempts = config.maxTaskAttempts ?? 3;
    this.log = config.onLog ?? console.log;
    this.tools = createTools(config.projectDir, this.log);
  }

  private async processTask(task: Task): Promise<void> {
    const tag = `[agent:${this.jobId}]`;
    this.log(`${tag} ▶ ${task.id} (attempt ${task.attempts + 1}): ${task.description}`);
    this.store.updateTask(task.id, { status: TaskStatus.IN_PROGRESS });

    // ── Execute ────────────────────────────────────────────────────────────────
    const execResult = await runTaskExecutor(task, this.tools, undefined, this.log);

    if (!execResult.success) {
      if (task.attempts + 1 < this.maxTaskAttempts) {
        this.log(`${tag} ✗ ${task.id} executor failed (attempt ${task.attempts + 1}) — will retry`);
        this.store.updateTask(task.id, {
          attempts: task.attempts + 1,
          status: TaskStatus.PENDING,
          error: execResult.result,
        });
      } else {
        this.log(`${tag} ✗ ${task.id} failed after ${this.maxTaskAttempts} attempts`);
        this.store.markTaskFailed(task.id, execResult.result);
      }
      return;
    }

    // ── Skip verification for read-only tasks ─────────────────────────────────
    if (isReadOnly(execResult.toolCalls)) {
      this.store.markTaskCompleted(task.id, execResult.result, execResult.toolCalls);
      this.log(`${tag} ✓ ${task.id} done (read-only, skipped verification)`);
      return;
    }

    // ── Verify ────────────────────────────────────────────────────────────────
    this.store.updateTask(task.id, { status: TaskStatus.VERIFYING });
    const verifyResult = await runResultVerifier(task, execResult);
    this.log(
      `${tag} verify ${task.id}: ${verifyResult.isCorrect ? "✓" : "✗"} (${verifyResult.confidence}%) — ${verifyResult.feedback.slice(0, 100)}`
    );

    if (verifyResult.isCorrect) {
      this.store.markTaskCompleted(task.id, execResult.result, execResult.toolCalls);
      this.log(`${tag} ✓ ${task.id} done`);
      return;
    }

    // ── Fix ───────────────────────────────────────────────────────────────────
    if (task.attempts + 1 < this.maxTaskAttempts) {
      this.store.updateTask(task.id, { status: TaskStatus.FIXING });
      this.log(`${tag} ↻ fixing ${task.id}: ${verifyResult.feedback.slice(0, 120)}`);

      const fixResult = await runErrorFixer(task, execResult, verifyResult, this.tools, task.attempts + 1, this.log);

      if (fixResult.success) {
        this.store.markTaskCompleted(task.id, fixResult.result, fixResult.toolCalls);
        this.log(`${tag} ✓ ${task.id} fixed and done`);
      } else {
        this.store.updateTask(task.id, {
          attempts: task.attempts + 1,
          status: TaskStatus.PENDING,
          error: fixResult.result,
        });
        this.log(`${tag} ✗ fix failed for ${task.id}, will retry`);
      }
    } else {
      this.store.markTaskFailed(task.id, verifyResult.feedback);
      this.log(`${tag} ✗ ${task.id} exhausted all attempts`);
    }
  }

  async run(): Promise<TaskSummary> {
    const tag = `[agent:${this.jobId}]`;

    // ── 1. Plan ────────────────────────────────────────────────────────────────
    this.log(`${tag} planning tasks${this.renderError ? " [error-fix mode]" : " [customize mode]"}...`);
    const plannedTasks = await runTaskPlanner(this.renderConfig, this.renderError);

    this.store.clear();
    plannedTasks.forEach((t) => this.store.addTask(t));
    this.log(
      `${tag} ${plannedTasks.length} tasks planned:\n` +
        plannedTasks.map((t) => `  ${t.id}: ${t.description} [deps: ${t.dependencies.join(", ") || "none"}]`).join("\n")
    );

    // ── 2. Execute loop — run all unblocked tasks in parallel ─────────────────
    let iteration = 0;
    const MAX_ITERATIONS = 50;

    while (!this.store.areAllTasksCompleted() && iteration < MAX_ITERATIONS) {
      iteration++;

      const readyTasks = this.store.getAllExecutableTasks();

      if (readyTasks.length === 0) {
        // Check for deadlock
        const pending = this.store.getTasksByStatus(TaskStatus.PENDING);
        const inProgress = this.store.getTasksByStatus(TaskStatus.IN_PROGRESS);

        if (pending.length > 0 && inProgress.length === 0) {
          this.log(`${tag} ⚠ deadlock detected — failing ${pending.length} stuck tasks`);
          pending.forEach((t) => this.store.markTaskFailed(t.id, "Deadlock: dependencies not satisfied"));
          break;
        }

        // Tasks are in-progress (running in parallel) — wait a tick
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }

      if (readyTasks.length > 1) {
        this.log(`${tag} ⚡ running ${readyTasks.length} tasks in parallel: ${readyTasks.map((t) => t.id).join(", ")}`);
      }

      // Run in parallel — processTask updates store directly
      await Promise.all(readyTasks.map((t) => this.processTask(t)));
    }

    const summary = this.store.getSummary();
    this.log(`${tag} ═══ complete: ${summary.completed}/${summary.total} tasks done, ${summary.failed} failed ═══`);

    if (summary.failed > 0) {
      this.store.getTasksByStatus(TaskStatus.FAILED).forEach((t) => {
        this.log(`${tag}   ✗ ${t.id}: ${t.error?.slice(0, 200)}`);
      });
    }

    return summary;
  }
}
