// Docker image management for sandbox containers
// Handles image pulling, caching, custom Dockerfiles, and cleanup.

import { spawnSync } from 'child_process';
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
    if (this.imageExists(image)) {
      this.checkedImages.add(image);
      onProgress?.({ status: 'exists', message: `Image ${image} already cached` });
      return;
    }

    // Pull the image
    onProgress?.({ status: 'pulling', message: `Pulling ${image}...` });
    try {
      const result = spawnSync('docker', ['pull', image], {
        encoding: 'utf-8',
        timeout: 300000, // 5 minutes for large images
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (result.status !== 0) {
        throw new Error((result.stderr as string)?.trim() || `docker pull failed with status ${result.status}`);
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

      const result = spawnSync('docker', ['build', '-t', tag, '-f', dockerfilePath, tempDir], {
        encoding: 'utf-8',
        timeout: 600000, // 10 minutes for builds
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (result.status !== 0) {
        throw new Error((result.stderr as string)?.trim() || `docker build failed with status ${result.status}`);
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
    if (this.imageExists(tag)) {
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
  listCachedImages(): ImageInfo[] {
    try {
      const result = spawnSync(
        'docker',
        ['images', '--format', '{{.Repository}}:{{.Tag}}|{{.ID}}|{{.Size}}|{{.CreatedAt}}', '--filter', 'reference=node', '--filter', 'reference=kc-cli-*'],
        { encoding: 'utf-8', timeout: 10000 }
      );
      if (result.status !== 0) return [];
      const output = (result.stdout as string).trim();

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
  pruneUnused(): number {
    try {
      const result = spawnSync(
        'docker',
        ['image', 'prune', '-f', '--filter', 'label=kc-cli-sandbox'],
        { encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'ignore'] }
      );
      if (result.status !== 0) return 0;
      const output = (result.stdout as string).trim();

      const match = output.match(/(\d+)\s+image/);
      return match ? parseInt(match[1], 10) : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Check if a Docker image exists locally.
   */
  private imageExists(image: string): boolean {
    try {
      const result = spawnSync('docker', ['image', 'inspect', image], {
        stdio: 'ignore',
        timeout: 5000,
      });
      return result.status === 0;
    } catch {
      return false;
    }
  }
}
