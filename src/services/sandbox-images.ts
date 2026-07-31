// Docker image management for sandbox containers
// Handles image pulling, caching, custom Dockerfiles, and cleanup.
// All docker invocations are async (spawn) so multi-second pulls/builds
// never block the event loop.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getErrorMessage } from '../utils/errors';

export interface ImageInfo {
  repository: string;
  tag: string;
  id: string;
  size: string;
  createdAt: string;
}

export interface ImageProgress {
  status: 'pulling' | 'exists' | 'error';
  message: string;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run a docker command asynchronously with a hard timeout. */
function runDocker(args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`docker ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

export class ImageManager {
  private checkedImages = new Set<string>();

  /**
   * Ensure a Docker image is available locally.
   * Pulls it if not already cached.
   */
  async ensureImage(image: string, onProgress?: (progress: ImageProgress) => void): Promise<void> {
    // Already checked in this session
    if (this.checkedImages.has(image)) return;

    // Check if image exists locally
    if (await this.imageExists(image)) {
      this.checkedImages.add(image);
      onProgress?.({ status: 'exists', message: `Image ${image} already cached` });
      return;
    }

    // Pull the image
    onProgress?.({ status: 'pulling', message: `Pulling ${image}...` });
    try {
      const result = await runDocker(['pull', image], 300000); // 5 minutes for large images
      if (result.status !== 0) {
        throw new Error(result.stderr.trim() || `docker pull failed with status ${result.status}`);
      }
      this.checkedImages.add(image);
      onProgress?.({ status: 'pulling', message: `Successfully pulled ${image}` });
    } catch (error) {
      const msg = getErrorMessage(error);
      onProgress?.({ status: 'error', message: `Failed to pull ${image}: ${msg}` });
      throw new Error(`Failed to pull Docker image ${image}: ${msg}`);
    }
  }

  /**
   * Build a custom image from a Dockerfile.
   */
  async buildCustomImage(dockerfile: string, tag: string): Promise<void> {
    const tempDir = path.join(process.cwd(), '.kc-cli', '.docker-build');
    const dockerfilePath = path.join(tempDir, 'Dockerfile');

    try {
      fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(dockerfilePath, dockerfile);

      const result = await runDocker(['build', '-t', tag, '-f', dockerfilePath, tempDir], 600000); // 10 minutes for builds
      if (result.status !== 0) {
        throw new Error(result.stderr.trim() || `docker build failed with status ${result.status}`);
      }

      this.checkedImages.add(tag);
    } finally {
      // Clean up temp build directory
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Check if a project has a custom Dockerfile for sandbox.
   * Returns the image tag if built, or null if no custom Dockerfile exists.
   */
  async getProjectSandboxImage(projectDir: string): Promise<string | null> {
    const dockerfilePath = path.join(projectDir, '.kc-cli', 'Dockerfile.sandbox');
    if (!fs.existsSync(dockerfilePath)) return null;

    const tag = 'kc-cli-sandbox-custom:latest';
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf-8');

    // Check if already built
    if (await this.imageExists(tag)) {
      this.checkedImages.add(tag);
      return tag;
    }

    // Build the custom image
    await this.buildCustomImage(dockerfile, tag);
    return tag;
  }

  /**
   * List all cached sandbox-related images.
   */
  async listCachedImages(): Promise<ImageInfo[]> {
    try {
      const result = await runDocker(
        ['images', '--format', '{{.Repository}}:{{.Tag}}|{{.ID}}|{{.Size}}|{{.CreatedAt}}', '--filter', 'reference=node', '--filter', 'reference=kc-cli-*'],
        10000
      );
      if (result.status !== 0) return [];
      const output = result.stdout.trim();

      if (!output) return [];

      return output.split('\n').map(line => {
        const [repoTag, id, size, createdAt] = line.split('|');
        const [repository, tag] = repoTag.split(':');
        return { repository, tag, id, size, createdAt };
      });
    } catch {
      return [];
    }
  }

  /**
   * Remove unused sandbox images to free disk space.
   * Returns the number of images removed.
   */
  async pruneUnused(): Promise<number> {
    try {
      const result = await runDocker(
        ['image', 'prune', '-f', '--filter', 'label=kc-cli-sandbox'],
        30000
      );
      if (result.status !== 0) return 0;
      const output = result.stdout.trim();

      const match = output.match(/(\d+)\s+image/);
      return match ? parseInt(match[1], 10) : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Check if a Docker image exists locally.
   */
  private async imageExists(image: string): Promise<boolean> {
    try {
      const result = await runDocker(['image', 'inspect', image], 5000);
      return result.status === 0;
    } catch {
      return false;
    }
  }
}
