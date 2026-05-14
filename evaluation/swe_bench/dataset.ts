/**
 * SWE-bench dataset loader
 *
 * Loads SWE-bench datasets from HuggingFace or local JSON files.
 * Supports: verified, lite, full, multilingual
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SWEBenchInstance, RunConfig } from './types';

const DATASET_MAP: Record<string, string> = {
  verified: 'princeton-nlp/SWE-bench_Verified',
  lite: 'princeton-nlp/SWE-bench_Lite',
  full: 'princeton-nlp/SWE-bench',
  multilingual: 'princeton-nlp/SWE-bench_Multilingual',
};

/**
 * Load dataset from local JSON file or download from HuggingFace
 */
export async function loadDataset(config: RunConfig): Promise<SWEBenchInstance[]> {
  const localPath = path.join(__dirname, 'data', `${config.dataset}_${config.split}.json`);

  // Try local file first
  if (fs.existsSync(localPath)) {
    console.log(`Loading dataset from local file: ${localPath}`);
    const data = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
    return applyLimit(data, config.limit);
  }

  // Download from HuggingFace
  const datasetName = DATASET_MAP[config.dataset];
  if (!datasetName) {
    throw new Error(`Unknown dataset: ${config.dataset}. Available: ${Object.keys(DATASET_MAP).join(', ')}`);
  }

  console.log(`Downloading dataset: ${datasetName} (split: ${config.split})`);
  const instances = await downloadDataset(datasetName, config.split);

  // Cache locally
  const dataDir = path.join(__dirname, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(localPath, JSON.stringify(instances, null, 2));
  console.log(`Cached ${instances.length} instances to ${localPath}`);

  return applyLimit(instances, config.limit);
}

/**
 * Download dataset from HuggingFace using the datasets library or HTTP API
 */
async function downloadDataset(datasetName: string, split: string): Promise<SWEBenchInstance[]> {
  // Use HuggingFace Datasets API
  const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(datasetName)}&config=default&split=${split}&offset=0&length=1000`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as { rows: Array<{ row: SWEBenchInstance }> };
    return data.rows.map(r => r.row);
  } catch (error) {
    // Fallback: try loading with Python's datasets library
    console.warn('HuggingFace API failed, trying Python datasets library...');
    return loadWithPythonDatasets(datasetName, split);
  }
}

/**
 * Fallback: load dataset using Python's datasets library
 */
async function loadWithPythonDatasets(datasetName: string, split: string): Promise<SWEBenchInstance[]> {
  const { execSync } = await import('child_process');
  const tmpFile = `/tmp/swe-bench-${Date.now()}.json`;

  try {
    execSync(
      `python3 -c "
import json
from datasets import load_dataset
ds = load_dataset('${datasetName}', split='${split}')
with open('${tmpFile}', 'w') as f:
    json.dump([dict(row) for row in ds], f)
"`,
      { stdio: 'pipe', timeout: 120000 }
    );

    const data = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
    return data;
  } catch (error) {
    throw new Error(
      `Failed to load dataset. Install Python datasets: pip install datasets\n` +
      `Or manually download and place in evaluation/swe_bench/data/\n` +
      `Error: ${error}`
    );
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

/**
 * Apply limit for debugging
 */
function applyLimit(instances: SWEBenchInstance[], limit?: number): SWEBenchInstance[] {
  if (limit && limit > 0 && limit < instances.length) {
    console.log(`Limiting to ${limit} instances (out of ${instances.length})`);
    return instances.slice(0, limit);
  }
  return instances;
}

/**
 * Get dataset info without loading
 */
export function getDatasetInfo(dataset: string): { name: string; url: string } {
  const name = DATASET_MAP[dataset];
  if (!name) throw new Error(`Unknown dataset: ${dataset}`);
  return {
    name,
    url: `https://huggingface.co/datasets/${name}`,
  };
}
