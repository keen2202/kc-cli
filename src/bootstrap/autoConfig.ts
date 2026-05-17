// Auto-Configuration - project type detection and automatic LSP/sandbox setup

import * as fs from 'fs/promises';
import * as path from 'path';

export type ProjectType = 'node' | 'python' | 'go' | 'rust' | 'java' | 'ruby' | 'cpp' | 'unknown';

export interface ProjectDetection {
  type: ProjectType;
  name: string;
  indicators: string[];
  lspServer: string | null;
}

export interface AutoConfigResult {
  project: ProjectDetection;
  lspEnabled: boolean;
  sandboxConfigured: boolean;
  summary: string;
}

// Project type indicators (files that indicate a project type)
const PROJECT_INDICATORS: Record<ProjectType, string[]> = {
  node: ['package.json', 'tsconfig.json', '.nvmrc', 'yarn.lock', 'pnpm-lock.yaml'],
  python: ['pyproject.toml', 'setup.py', 'requirements.txt', 'Pipfile', 'poetry.lock'],
  go: ['go.mod', 'go.sum'],
  rust: ['Cargo.toml', 'Cargo.lock'],
  java: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
  ruby: ['Gemfile', 'Gemfile.lock', '.ruby-version'],
  cpp: ['CMakeLists.txt', 'Makefile', 'meson.build'],
  unknown: [],
};

// LSP servers for each project type
const LSP_SERVERS: Record<ProjectType, string | null> = {
  node: 'typescript-language-server',
  python: 'pyright',
  go: 'gopls',
  rust: 'rust-analyzer',
  java: 'jdtls',
  ruby: 'solargraph',
  cpp: 'clangd',
  unknown: null,
};

/**
 * Detect project type based on files in the directory
 */
export async function detectProjectType(projectDir: string): Promise<ProjectDetection> {
  const detectedTypes: { type: ProjectType; indicators: string[] }[] = [];

  for (const [type, indicators] of Object.entries(PROJECT_INDICATORS)) {
    if (type === 'unknown') continue;

    const foundIndicators: string[] = [];
    for (const indicator of indicators) {
      try {
        const filePath = path.join(projectDir, indicator);
        await fs.access(filePath);
        foundIndicators.push(indicator);
      } catch {
        // File doesn't exist, continue
      }
    }

    if (foundIndicators.length > 0) {
      detectedTypes.push({ type: type as ProjectType, indicators: foundIndicators });
    }
  }

  // Sort by number of indicators (most indicators = most likely primary type)
  detectedTypes.sort((a, b) => b.indicators.length - a.indicators.length);

  if (detectedTypes.length === 0) {
    return {
      type: 'unknown',
      name: 'Unknown Project',
      indicators: [],
      lspServer: null,
    };
  }

  const primary = detectedTypes[0];
  return {
    type: primary.type,
    name: getProjectName(primary.type),
    indicators: primary.indicators,
    lspServer: LSP_SERVERS[primary.type],
  };
}

/**
 * Get human-readable project name
 */
function getProjectName(type: ProjectType): string {
  const names: Record<ProjectType, string> = {
    node: 'Node.js',
    python: 'Python',
    go: 'Go',
    rust: 'Rust',
    java: 'Java',
    ruby: 'Ruby',
    cpp: 'C/C++',
    unknown: 'Unknown',
  };
  return names[type];
}

/**
 * Run auto-configuration for a project
 */
export async function autoConfigure(projectDir: string): Promise<AutoConfigResult> {
  const project = await detectProjectType(projectDir);

  const lspEnabled = project.lspServer !== null;
  const sandboxConfigured = project.type !== 'unknown';

  let summary = '';
  if (project.type !== 'unknown') {
    summary = `Detected ${project.name} project.`;
    if (lspEnabled) {
      summary += ` LSP enabled (${project.lspServer}).`;
    }
    if (sandboxConfigured) {
      summary += ' Sandbox configured.';
    }
  } else {
    summary = 'No specific project type detected. Using default configuration.';
  }

  return {
    project,
    lspEnabled,
    sandboxConfigured,
    summary,
  };
}

/**
 * Get recommended LSP server for a project type
 */
export function getRecommendedLsp(type: ProjectType): string | null {
  return LSP_SERVERS[type];
}

/**
 * Get all supported project types
 */
export function getSupportedProjectTypes(): ProjectType[] {
  return Object.keys(PROJECT_INDICATORS).filter(t => t !== 'unknown') as ProjectType[];
}
