export enum TaskStatus {
  PENDING = "pending",
  IN_PROGRESS = "in_progress",
  COMPLETED = "completed",
  FAILED = "failed",
  VERIFYING = "verifying",
  FIXING = "fixing",
}

export type ToolCall = {
  name: string;
  args: Record<string, any>;
  result: string;
};

export type Task = {
  id: string;
  description: string;
  dependencies: string[];
  status: TaskStatus;
  attempts: number;
  result?: string;
  error?: string;
  toolCalls?: ToolCall[];
};

export type TaskSummary = {
  total: number;
  completed: number;
  failed: number;
  pending: number;
  inProgress: number;
};

export class TaskStore {
  private tasks = new Map<string, Task>();

  addTask(task: Omit<Task, "status" | "attempts">): void {
    this.tasks.set(task.id, { ...task, status: TaskStatus.PENDING, attempts: 0 });
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  getTasksByStatus(status: TaskStatus): Task[] {
    return Array.from(this.tasks.values()).filter((t) => t.status === status);
  }

  getNextExecutableTask(): Task | undefined {
    return Array.from(this.tasks.values()).find((task) => {
      if (task.status !== TaskStatus.PENDING) return false;
      return task.dependencies.every((depId) => {
        const dep = this.tasks.get(depId);
        return dep?.status === TaskStatus.COMPLETED;
      });
    });
  }

  getAllExecutableTasks(): Task[] {
    return Array.from(this.tasks.values()).filter((task) => {
      if (task.status !== TaskStatus.PENDING) return false;
      return task.dependencies.every((depId) => {
        const dep = this.tasks.get(depId);
        return dep?.status === TaskStatus.COMPLETED;
      });
    });
  }

  updateTask(id: string, updates: Partial<Task>): void {
    const task = this.tasks.get(id);
    if (task) this.tasks.set(id, { ...task, ...updates });
  }

  markTaskCompleted(id: string, result: string, toolCalls?: ToolCall[]): void {
    this.updateTask(id, { status: TaskStatus.COMPLETED, result, toolCalls });
  }

  markTaskFailed(id: string, error: string): void {
    this.updateTask(id, { status: TaskStatus.FAILED, error });
  }

  areAllTasksCompleted(): boolean {
    return Array.from(this.tasks.values()).every(
      (t) => t.status === TaskStatus.COMPLETED || t.status === TaskStatus.FAILED
    );
  }

  getSummary(): TaskSummary {
    const tasks = Array.from(this.tasks.values());
    return {
      total: tasks.length,
      completed: tasks.filter((t) => t.status === TaskStatus.COMPLETED).length,
      failed: tasks.filter((t) => t.status === TaskStatus.FAILED).length,
      pending: tasks.filter((t) => t.status === TaskStatus.PENDING).length,
      inProgress: tasks.filter((t) => t.status === TaskStatus.IN_PROGRESS).length,
    };
  }

  getAll(): Task[] {
    return Array.from(this.tasks.values());
  }

  clear(): void {
    this.tasks.clear();
  }
}
