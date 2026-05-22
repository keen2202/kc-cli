import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Plugin, PluginManifest } from './types';
import { createLogger } from '../services/logger';

const logger = createLogger('plugins:loader');

const KC_PLUGIN_PREFIX = 'kc-plugin-';

export async function discoverPlugins(projectDir: string): Promise<string[]> {
  const pluginDirs: string[] = [];

  // User global plugins: ~/.kc-cli/plugins/
  const userPluginDir = path.join(os.homedir(), '.kc-cli', 'plugins');
  if (fs.existsSync(userPluginDir)) {
    const entries = await fs.promises.readdir(userPluginDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        pluginDirs.push(path.join(userPluginDir, entry.name));
      }
    }
  }

  // Project plugins: .kc-cli/plugins/
  const projectPluginDir = path.join(projectDir, '.kc-cli', 'plugins');
  if (fs.existsSync(projectPluginDir)) {
    const entries = await fs.promises.readdir(projectPluginDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        pluginDirs.push(path.join(projectPluginDir, entry.name));
      }
    }
  }

  // npm package discovery and package.json check in parallel (independent reads)
  const [npmPluginDirs, packageJsonPlugins] = await Promise.all([
    discoverNpmPlugins(projectDir),
    discoverPackageJsonPlugins(projectDir),
  ]);
  pluginDirs.push(...npmPluginDirs);
  pluginDirs.push(...packageJsonPlugins);

  // Deduplicate
  return [...new Set(pluginDirs)];
}

/**
 * Scan node_modules/ for packages matching kc-plugin-* pattern
 */
async function discoverNpmPlugins(projectDir: string): Promise<string[]> {
  const pluginDirs: string[] = [];
  const nodeModulesDir = path.join(projectDir, 'node_modules');

  if (!fs.existsSync(nodeModulesDir)) return pluginDirs;

  try {
    const entries = await fs.promises.readdir(nodeModulesDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith(KC_PLUGIN_PREFIX)) {
        pluginDirs.push(path.join(nodeModulesDir, entry.name));
      }

      // Handle scoped packages: @scope/kc-plugin-*
      if (entry.isDirectory() && entry.name.startsWith('@')) {
        const scopeDir = path.join(nodeModulesDir, entry.name);
        try {
          const scopedEntries = await fs.promises.readdir(scopeDir, { withFileTypes: true });
          for (const scopedEntry of scopedEntries) {
            if (scopedEntry.isDirectory() && scopedEntry.name.startsWith(KC_PLUGIN_PREFIX)) {
              pluginDirs.push(path.join(scopeDir, scopedEntry.name));
            }
          }
        } catch (error) {
          logger.debug('Failed to read scoped directory', { scopeDir, error: String(error) });
        }
      }
    }
  } catch (error) {
    logger.debug('Failed to read node_modules', { nodeModulesDir, error: String(error) });
  }

  return pluginDirs;
}

/**
 * Check project package.json dependencies/devDependencies for kc-plugin-* entries
 */
async function discoverPackageJsonPlugins(projectDir: string): Promise<string[]> {
  const pluginDirs: string[] = [];
  const packageJsonPath = path.join(projectDir, 'package.json');

  if (!fs.existsSync(packageJsonPath)) return pluginDirs;

  try {
    const content = await fs.promises.readFile(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(content);
    const allDeps: Record<string, string> = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };

    for (const depName of Object.keys(allDeps)) {
      if (depName.startsWith(KC_PLUGIN_PREFIX)) {
        const depPath = path.join(projectDir, 'node_modules', depName);
        if (fs.existsSync(depPath)) {
          pluginDirs.push(depPath);
        }
      }
    }
  } catch (error) {
    logger.debug('Failed to read package.json', { packageJsonPath, error: String(error) });
  }

  return pluginDirs;
}

export async function loadPlugin(pluginDir: string): Promise<Plugin | null> {
  try {
    const manifestPath = path.join(pluginDir, 'package.json');
    if (!fs.existsSync(manifestPath)) return null;

    const manifest: PluginManifest = JSON.parse(
      await fs.promises.readFile(manifestPath, 'utf-8')
    );

    // Accept plugins with kcPlugin flag OR matching kc-plugin-* name
    if (!manifest.kcPlugin && !manifest.name.startsWith(KC_PLUGIN_PREFIX)) return null;

    const mainPath = path.join(pluginDir, manifest.main || 'index.js');
    if (!fs.existsSync(mainPath)) return null;

    const mod = await import(mainPath);
    const plugin: Plugin = mod.default || mod.plugin || mod;

    if (!plugin.name || !plugin.version) return null;

    return plugin;
  } catch (error) {
    logger.warn('Failed to load plugin', { pluginDir, error: String(error) });
    return null;
  }
}
