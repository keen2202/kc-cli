import { describe, it, expect, beforeEach } from 'vitest';

// We need to test the TaskStore class. Since it's a singleton,
// we'll import the module and test via the exported taskStore.
// To get a fresh store, we'll use dynamic import or just test the singleton.
import { taskStore } from '../../src/tools/TaskStore';

describe('TaskStore', () => {
  // Note: taskStore is a singleton, so state persists across tests.
  // We'll work with that.

  it('should create a task', () => {
    const task = taskStore.create('echo hello');
    expect(task.id).toMatch(/^task_\d+$/);
    expect(task.command).toBe('echo hello');
    expect(task.status).toBe('pending');
    expect(task.createdAt).toBeGreaterThan(0);
  });

  it('should get a task by id', () => {
    const task = taskStore.create('ls -la');
    const found = taskStore.get(task.id);
    expect(found).toBeDefined();
    expect(found!.command).toBe('ls -la');
  });

  it('should return undefined for unknown id', () => {
    expect(taskStore.get('task_999999')).toBeUndefined();
  });

  it('should get all tasks', () => {
    const all = taskStore.getAll();
    expect(all.length).toBeGreaterThan(0);
    // Each task should have required fields
    for (const task of all) {
      expect(task).toHaveProperty('id');
      expect(task).toHaveProperty('command');
      expect(task).toHaveProperty('status');
    }
  });

  it('should update a task', () => {
    const task = taskStore.create('test update');
    const updated = taskStore.update(task.id, { status: 'running' });
    expect(updated).toBeDefined();
    expect(updated!.status).toBe('running');
    // Verify via get
    expect(taskStore.get(task.id)!.status).toBe('running');
  });

  it('should return undefined when updating unknown task', () => {
    expect(taskStore.update('task_999999', { status: 'completed' })).toBeUndefined();
  });

  it('should get tasks by status', () => {
    taskStore.create('pending task');
    const running = taskStore.getByStatus('running');
    expect(Array.isArray(running)).toBe(true);
    for (const task of running) {
      expect(task.status).toBe('running');
    }
  });

  it('should update task with output', () => {
    const task = taskStore.create('echo test');
    taskStore.update(task.id, { status: 'completed', output: 'test output' });
    const found = taskStore.get(task.id);
    expect(found!.status).toBe('completed');
    expect(found!.output).toBe('test output');
  });
});
