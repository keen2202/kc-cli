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
  sandboxPolicy: SandboxPolicy;
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

// Sandbox policies for each project type
export interface SandboxPolicy {
  allowedCommands: string[];
  allowedPaths: string[];
  deniedPaths: string[];
}

const SANDBOX_POLICIES: Record<ProjectType, SandboxPolicy> = {
  node: {
    allowedCommands: ['npm', 'npx', 'yarn', 'pnpm', 'node', 'tsc', 'vitest', 'jest'],
    allowedPaths: ['.', 'node_modules/.bin'],
    deniedPaths: ['node_modules', '.env', '.env.*'],
  },
  python: {
    allowedCommands: ['python', 'python3', 'pip', 'pip3', 'poetry', 'pytest', 'mypy', 'ruff'],
    allowedPaths: ['.', '.venv/bin'],
    deniedPaths: ['.venv', '__pycache__', '.env', '.env.*'],
  },
  go: {
    allowedCommands: ['go', 'gofmt', 'golangci-lint'],
    allowedPaths: ['.', 'vendor'],
    deniedPaths: ['vendor', '.env'],
  },
  rust: {
    allowedCommands: ['cargo', 'rustc', 'rustfmt', 'clippy'],
    allowedPaths: ['.', 'target'],
    deniedPaths: ['target', '.env'],
  },
  java: {
    allowedCommands: ['mvn', 'gradle', 'java', 'javac'],
    allowedPaths: ['.', 'target', 'build'],
    deniedPaths: ['target', 'build', '.env'],
  },
  ruby: {
    allowedCommands: ['ruby', 'gem', 'bundle', 'rake', 'rspec'],
    allowedPaths: ['.'],
    deniedPaths: ['vendor', '.env'],
  },
  cpp: {
    allowedCommands: ['gcc', 'g++', 'clang', 'clang++', 'make', 'cmake', 'ninja'],
    allowedPaths: ['.', 'build'],
    deniedPaths: ['build', '.env'],
  },
  unknown: {
    allowedCommands: [],
    allowedPaths: ['.'],
    deniedPaths: ['.env'],
  },
};

/**
 * Detect project type based on files in the directory
 */
export async function detectProjectType(projectDir: string): Promise<ProjectDetection> {
  const detectedTypes: { type: ProjectType; indicators: string[] }[] = [];

  // Check all project types in parallel (each indicator is independent I/O)
  const typeChecks = Object.entries(PROJECT_INDICATORS)
    .filter(([type]) => type !== 'unknown')
    .map(async ([type, indicators]) => {
      const checks = indicators.map(async (indicator) => {
        try {
          const filePath = path.join(projectDir, indicator);
          await fs.access(filePath);
          return indicator;
        } catch {
          return null;
        }
      });
      const results = await Promise.all(checks);
      const foundIndicators = results.filter((r): r is string => r !== null);
      if (foundIndicators.length > 0) {
        return { type: type as ProjectType, indicators: foundIndicators };
      }
      return null;
    });

  const typeResults = await Promise.all(typeChecks);
  for (const result of typeResults) {
    if (result) {
      detectedTypes.push(result);
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
  const sandboxPolicy = SANDBOX_POLICIES[project.type];

  let summary = '';
  if (project.type !== 'unknown') {
    summary = `Detected ${project.name} project.`;
    if (lspEnabled) {
      summary += ` LSP enabled (${project.lspServer}).`;
    }
    if (sandboxConfigured) {
      summary += ` Sandbox configured (${sandboxPolicy.allowedCommands.length} allowed commands).`;
    }
  } else {
    summary = 'No specific project type detected. Using default configuration.';
  }

  return {
    project,
    lspEnabled,
    sandboxConfigured,
    sandboxPolicy,
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

/**
 * Get sandbox policy for a project type
 */
export function getSandboxPolicy(type: ProjectType): SandboxPolicy {
  return SANDBOX_POLICIES[type];
}
