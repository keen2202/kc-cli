/**
 * SWE-bench Prediction Runner
 *
 * Runs KC-CLI on all SWE-bench instances and generates predictions.json
 *
 * Usage:
 *   npx tsx run_predictions.ts --dataset verified --split dev
 *   npx tsx run_predictions.ts --dataset lite --split dev --limit 10
 *   npx tsx run_predictions.ts --model claude-sonnet-4-20250514 --provider anthropic
 */

import * as fs from 'fs';
import * as path from 'path';
import { solveInstance } from './adapter';
import { loadDataset } from './dataset';
import type { RunConfig, RunResult, Prediction, PredictionsFile, RunSummary } from './types';

// Parse CLI arguments
function parseArgs(): RunConfig {
  const args = process.argv.slice(2);
  const config: RunConfig = {
    dataset: 'verified',
    split: 'dev',
    model: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    maxTurns: 30,
    timeout: 300, // 5 minutes per instance
    concurrency: 1,
    outputDir: path.join(__dirname, 'output'),
    limit: undefined,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dataset': config.dataset = args[++i] as any; break;
      case '--split': config.split = args[++i] as any; break;
      case '--model': config.model = args[++i]; break;
      case '--provider': config.provider = args[++i]; break;
      case '--max-turns': config.maxTurns = parseInt(args[++i]); break;
      case '--timeout': config.timeout = parseInt(args[++i]); break;
      case '--concurrency': config.concurrency = parseInt(args[++i]); break;
      case '--limit': config.limit = parseInt(args[++i]); break;
      case '--output': config.outputDir = args[++i]; break;
    }
  }

  return config;
}

/**
 * Run predictions sequentially (simplest, most reliable)
 */
async function runSequential(
  instances: Awaited<ReturnType<typeof loadDataset>>,
  config: RunConfig
): Promise<RunResult[]> {
  const results: RunResult[] = [];
  const total = instances.length;

  for (let i = 0; i < total; i++) {
    const instance = instances[i];
    const progress = `[${i + 1}/${total}]`;

    console.log(`${progress} Solving: ${instance.instance_id}...`);

    const result = await solveInstance(instance, config);
    results.push(result);

    const status = result.success ? '✅' : '❌';
    const duration = (result.duration / 1000).toFixed(1);
    console.log(`${progress} ${status} ${instance.instance_id} (${duration}s, ${result.turns} turns)`);

    if (result.error) {
      console.log(`  Error: ${result.error}`);
    }

    // Save intermediate results
    savePredictions(results, config);
  }

  return results;
}

/**
 * Run predictions with concurrency
 */
async function runConcurrent(
  instances: Awaited<ReturnType<typeof loadDataset>>,
  config: RunConfig
): Promise<RunResult[]> {
  const results: RunResult[] = [];
  const total = instances.length;
  let completed = 0;

  // Process in batches
  for (let i = 0; i < total; i += config.concurrency) {
    const batch = instances.slice(i, i + config.concurrency);
    const batchResults = await Promise.all(
      batch.map(async (instance) => {
        const result = await solveInstance(instance, config);
        completed++;
        const status = result.success ? '✅' : '❌';
        console.log(`[${completed}/${total}] ${status} ${instance.instance_id}`);
        return result;
      })
    );
    results.push(...batchResults);

    // Save intermediate results
    savePredictions(results, config);
  }

  return results;
}

/**
 * Save predictions in SWE-bench format
 */
function savePredictions(results: RunResult[], config: RunConfig): void {
  fs.mkdirSync(config.outputDir, { recursive: true });

  const predictions: PredictionsFile = {};
  for (const result of results) {
    predictions[result.instanceId] = {
      model_patch: result.patch,
      model_name_or_path: `kc-cli-v3.0.0-${config.model}`,
    };
  }

  const outputPath = path.join(config.outputDir, 'preds.json');
  fs.writeFileSync(outputPath, JSON.stringify(predictions, null, 2));
}

/**
 * Generate summary report
 */
function generateSummary(results: RunResult[], config: RunConfig): RunSummary {
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success && !r.error);
  const errored = results.filter(r => r.error);

  const summary: RunSummary = {
    total: results.length,
    solved: successful.length,
    failed: failed.length,
    errored: errored.length,
    avgDuration: results.reduce((sum, r) => sum + r.duration, 0) / results.length,
    avgTurns: results.reduce((sum, r) => sum + r.turns, 0) / results.length,
    results,
  };

  // Save summary
  const summaryPath = path.join(config.outputDir, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  return summary;
}

/**
 * Main entry point
 */
async function main() {
  const config = parseArgs();

  console.log('='.repeat(60));
  console.log('KC-CLI SWE-bench Evaluation');
  console.log('='.repeat(60));
  console.log(`Dataset:    ${config.dataset} / ${config.split}`);
  console.log(`Model:      ${config.model}`);
  console.log(`Provider:   ${config.provider}`);
  console.log(`Max turns:  ${config.maxTurns}`);
  console.log(`Timeout:    ${config.timeout}s per instance`);
  console.log(`Concurrency: ${config.concurrency}`);
  if (config.limit) console.log(`Limit:      ${config.limit} instances`);
  console.log('='.repeat(60));

  // Load dataset
  const instances = await loadDataset(config);
  console.log(`Loaded ${instances.length} instances\n`);

  // Run predictions
  const startTime = Date.now();
  const results = config.concurrency > 1
    ? await runConcurrent(instances, config)
    : await runSequential(instances, config);

  // Generate summary
  const summary = generateSummary(results, config);
  const totalDuration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

  console.log('\n' + '='.repeat(60));
  console.log('RESULTS');
  console.log('='.repeat(60));
  console.log(`Total:      ${summary.total}`);
  console.log(`Solved:     ${summary.solved} (${((summary.solved / summary.total) * 100).toFixed(1)}%)`);
  console.log(`Failed:     ${summary.failed}`);
  console.log(`Errored:    ${summary.errored}`);
  console.log(`Avg time:   ${(summary.avgDuration / 1000).toFixed(1)}s`);
  console.log(`Avg turns:  ${summary.avgTurns.toFixed(1)}`);
  console.log(`Total time: ${totalDuration} min`);
  console.log('='.repeat(60));

  // Save final predictions
  savePredictions(results, config);
  console.log(`\nPredictions saved to: ${path.join(config.outputDir, 'preds.json')}`);
  console.log(`Summary saved to: ${path.join(config.outputDir, 'summary.json')}`);

  // Exit with code based on results
  process.exit(summary.solved > 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
