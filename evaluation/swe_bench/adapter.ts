/**
 * KC-CLI SWE-bench Adapter
 *
 * Bridges KC-CLI's QueryEngine with SWE-bench's evaluation format.
 * For each SWE-bench instance:
 *   1. Clone repo at specific commit
 *   2. Initialize KC-CLI QueryEngine
 *   3. Submit the issue as a prompt
 *   4. Collect the git diff patch
 *   5. Return in SWE-bench prediction format
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';
import type { SWEBenchInstance, Prediction, RunResult, RunConfig } from './types';
import { buildSystemPrompt, buildUserPrompt } from './prompt';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import KC-CLI core modules
// These are imported dynamically to avoid build issues
let QueryEngine: any;
let registerBuiltInTools: any;
let toolRegistry: any;

async function initKCCLI() {
  if (!QueryEngine) {
    const qeMod = await import('../../src/query/QueryEngine');
    QueryEngine = qeMod.QueryEngine;
    const toolsMod = await import('../../src/tools');
    registerBuiltInTools = toolsMod.registerBuiltInTools;
    toolRegistry = toolsMod.toolRegistry;
  }
}

/**
 * Solve a single SWE-bench instance using KC-CLI
 */
export async function solveInstance(
  instance: SWEBenchInstance,
  config: RunConfig
): Promise<RunResult> {
  const startTime = Date.now();
  const workDir = `/tmp/swe-bench/${instance.instance_id}`;

  try {
    // 1. Prepare workspace
    await prepareWorkspace(instance, workDir);

    // 2. Initialize KC-CLI
    await initKCCLI();
    await registerBuiltInTools();
    const tools = toolRegistry.getAllTools();

    // 3. Build prompt
    const systemPrompt = buildSystemPrompt(instance);
    const userPrompt = buildUserPrompt(instance);

    // 4. Create QueryEngine
    const queryEngine = new QueryEngine(
      {
        model: config.model,
        provider: config.provider as any,
        apiKey: getApiKey(config.provider),
        maxTurns: config.maxTurns,
        maxBudgetUsd: null,
        systemPrompt,
      },
      tools
    );

    // 5. Run agent with timeout
    let turnCount = 0;
    const fullPrompt = `${systemPrompt}\n\n---\n\n${userPrompt}`;

    const result = await runWithTimeout(
      async () => {
        for await (const event of queryEngine.submitMessage(fullPrompt)) {
          if (event.type === 'agent:turn_complete') {
            turnCount++;
          }
          if (event.type === 'agent:complete') {
            break;
          }
          if (event.type === 'agent:error') {
            throw new Error(event.error?.message || 'Agent error');
          }
        }
      },
      config.timeout * 1000
    );

    // 6. Collect patch
    const patch = collectPatch(workDir);

    return {
      instanceId: instance.instance_id,
      success: patch.length > 0,
      patch,
      duration: Date.now() - startTime,
      turns: turnCount,
    };
  } catch (error) {
    return {
      instanceId: instance.instance_id,
      success: false,
      patch: '',
      duration: Date.now() - startTime,
      turns: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    // Cleanup workspace
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Prepare the workspace: clone repo and checkout specific commit
 */
async function prepareWorkspace(instance: SWEBenchInstance, workDir: string): Promise<void> {
  // Clean up previous run
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {}

  fs.mkdirSync(path.dirname(workDir), { recursive: true });

  // Clone the repository (shallow for speed)
  const repoUrl = `https://github.com/${instance.repo}.git`;
  execSync(`git clone --depth 1 ${repoUrl} ${workDir}`, {
    stdio: 'pipe',
    timeout: 120000,
  });

  // Fetch and checkout the specific commit
  execSync(`git fetch --depth 1 origin ${instance.base_commit}`, {
    cwd: workDir,
    stdio: 'pipe',
    timeout: 60000,
  });

  execSync(`git checkout ${instance.base_commit}`, {
    cwd: workDir,
    stdio: 'pipe',
    timeout: 30000,
  });

  // Apply test patch (so tests exist for evaluation)
  if (instance.test_patch) {
    try {
      applyPatch(workDir, instance.test_patch);
    } catch (err) {
      console.warn(`Warning: Failed to apply test patch for ${instance.instance_id}: ${err}`);
    }
  }
}

/**
 * Apply a git patch to the workspace
 */
function applyPatch(workDir: string, patch: string): void {
  const patchFile = path.join(workDir, '.swe_bench_patch');
  fs.writeFileSync(patchFile, patch);
  try {
    execSync(`git apply .swe_bench_patch`, {
      cwd: workDir,
      stdio: 'pipe',
      timeout: 30000,
    });
  } finally {
    try { fs.unlinkSync(patchFile); } catch {}
  }
}

/**
 * Collect the git diff patch from the workspace
 */
function collectPatch(workDir: string): string {
  try {
    // First try staged changes
    let patch = execSync('git diff --cached', {
      cwd: workDir,
      encoding: 'utf-8',
      timeout: 10000,
    });

    // If no staged changes, try unstaged
    if (!patch.trim()) {
      patch = execSync('git diff', {
        cwd: workDir,
        encoding: 'utf-8',
        timeout: 10000,
      });
    }

    // Also check for new untracked files
    const untracked = execSync('git ls-files --others --exclude-standard', {
      cwd: workDir,
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();

    if (untracked) {
      for (const file of untracked.split('\n')) {
        if (file.trim()) {
          try {
            const addDiff = execSync(`git diff --no-index /dev/null "${file.trim()}"`, {
              cwd: workDir,
              encoding: 'utf-8',
              timeout: 10000,
            });
            patch += '\n' + addDiff;
          } catch {
            // git diff --no-index returns non-zero, but still outputs the diff
          }
        }
      }
    }

    return patch.trim();
  } catch {
    return '';
  }
}

/**
 * Run a function with a timeout
 */
function runWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    fn()
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

/**
 * Get API key for the provider
 */
function getApiKey(provider: string): string {
  const envMap: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    qwen: 'DASHSCOPE_API_KEY',
    glm: 'ZHIPU_API_KEY',
    ollama: '',
  };

  const envVar = envMap[provider];
  if (!envVar) return '';

  const key = process.env[envVar];
  if (!key) {
    throw new Error(`Missing API key. Set ${envVar} environment variable.`);
  }
  return key;
}
