// Shared task store - single source of truth for TaskCreate and TaskGet tools

export interface TaskRecord {
  id: string;
  command: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  createdAt: number;
  output?: string;
}

/**
 * Global task store singleton
 * Shared between TaskCreateTool and TaskGetTool
 */
class TaskStore {
  private tasks = new Map<string, TaskRecord>();
  private nextTaskId = 1;

  create(command: string): TaskRecord {
    const id = `task_${this.nextTaskId++}`;
    const task: TaskRecord = {
      id,
      command,
      status: 'pending',
      createdAt: Date.now(),
    };
    this.tasks.set(id, task);
    return task;
  }

  get(id: string): TaskRecord | undefined {
    return this.tasks.get(id);
  }

  getAll(): TaskRecord[] {
    return Array.from(this.tasks.values());
  }

  update(id: string, updates: Partial<TaskRecord>): TaskRecord | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    Object.assign(task, updates);
    return task;
  }

  getByStatus(status: TaskRecord['status']): TaskRecord[] {
    return this.getAll().filter(t => t.status === status);
  }
}

// Singleton instance
export const taskStore = new TaskStore();
