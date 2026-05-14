/**
 * SWE-bench Submission Script
 *
 * Submits predictions to the SWE-bench leaderboard.
 *
 * Usage:
 *   npx tsx submit.ts --run_id kc-cli-v3-20260514
 *   npx tsx submit.ts --run_id kc-cli-v3-20260514 --dataset verified --split test
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

interface SubmitConfig {
  runId: string;
  dataset: string;
  split: string;
  predictionsPath: string;
}

function parseArgs(): SubmitConfig {
  const args = process.argv.slice(2);
  const config: SubmitConfig = {
    runId: `kc-cli-v3-${new Date().toISOString().slice(0, 10)}`,
    dataset: 'swe-bench-verified',
    split: 'test',
    predictionsPath: path.join(__dirname, 'output', 'preds.json'),
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--run_id': config.runId = args[++i]; break;
      case '--dataset': config.dataset = args[++i]; break;
      case '--split': config.split = args[++i]; break;
      case '--predictions': config.predictionsPath = args[++i]; break;
    }
  }

  return config;
}

function checkPrerequisites(): void {
  // Check sb-cli installed
  try {
    execSync('sb-cli --version', { stdio: 'pipe' });
  } catch {
    console.error('Error: sb-cli not installed. Run: pip install sb-cli');
    process.exit(1);
  }

  // Check API key
  if (!process.env.SWEBENCH_API_KEY) {
    console.error('Error: SWEBENCH_API_KEY not set.');
    console.error('Get your key at: https://www.swebench.com');
    process.exit(1);
  }
}

function checkQuota(dataset: string, split: string): void {
  try {
    console.log('Checking API quota...');
    const output = execSync(`sb-cli quota ${dataset} ${split}`, {
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    console.log(output);
  } catch (error) {
    console.warn('Warning: Could not check quota. Continuing anyway...');
  }
}

async function main() {
  const config = parseArgs();

  console.log('='.repeat(60));
  console.log('SWE-bench Submission');
  console.log('='.repeat(60));
  console.log(`Run ID:       ${config.runId}`);
  console.log(`Dataset:      ${config.dataset} / ${config.split}`);
  console.log(`Predictions:  ${config.predictionsPath}`);
  console.log('='.repeat(60));

  // Check prerequisites
  checkPrerequisites();

  // Verify predictions file exists
  if (!fs.existsSync(config.predictionsPath)) {
    console.error(`Error: Predictions file not found: ${config.predictionsPath}`);
    console.error('Run run_predictions.ts first to generate predictions.');
    process.exit(1);
  }

  // Load and validate predictions
  const predictions = JSON.parse(fs.readFileSync(config.predictionsPath, 'utf-8'));
  const instanceCount = Object.keys(predictions).length;
  console.log(`Found ${instanceCount} predictions`);

  if (instanceCount === 0) {
    console.error('Error: No predictions to submit.');
    process.exit(1);
  }

  // Check quota
  checkQuota(config.dataset, config.split);

  // Submit predictions
  console.log('\nSubmitting predictions...');
  try {
    const output = execSync(
      `sb-cli submit ${config.dataset} ${config.split} --predictions_path ${config.predictionsPath} --run_id ${config.runId}`,
      { encoding: 'utf-8', stdio: 'pipe', timeout: 300000 }
    );
    console.log(output);
    console.log('\n✅ Submission successful!');
  } catch (error: any) {
    console.error('Submission failed:', error.message);
    if (error.stderr) console.error(error.stderr);
    process.exit(1);
  }

  // Print next steps
  console.log('\n' + '='.repeat(60));
  console.log('NEXT STEPS');
  console.log('='.repeat(60));
  console.log('1. Fork https://github.com/swe-bench/experiments');
  console.log(`2. Create directory: verified/kc-cli-v3/`);
  console.log('3. Add metadata.yaml and README.md');
  console.log('4. Submit PR with your run_id and email');
  console.log('='.repeat(60));
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
