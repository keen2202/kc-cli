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
  private statusIndex = new Map<TaskRecord['status'], Set<string>>();
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
    // Update status index
    let statusSet = this.statusIndex.get('pending');
    if (!statusSet) {
      statusSet = new Set();
      this.statusIndex.set('pending', statusSet);
    }
    statusSet.add(id);
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

    // Update status index if status changed
    if (updates.status && updates.status !== task.status) {
      this.statusIndex.get(task.status)?.delete(id);
      let newSet = this.statusIndex.get(updates.status);
      if (!newSet) {
        newSet = new Set();
        this.statusIndex.set(updates.status, newSet);
      }
      newSet.add(id);
    }

    Object.assign(task, updates);
    return task;
  }

  getByStatus(status: TaskRecord['status']): TaskRecord[] {
    // O(1) lookup via status index instead of O(n) full scan
    const ids = this.statusIndex.get(status);
    if (!ids || ids.size === 0) return [];
    const results: TaskRecord[] = [];
    for (const id of ids) {
      const task = this.tasks.get(id);
      if (task) results.push(task);
    }
    return results;
  }
}

// Singleton instance
export const taskStore = new TaskStore();
