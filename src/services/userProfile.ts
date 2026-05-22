// User Profile Service - tracks preferences, coding style, and user level

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const SETTINGS_FILE = '.kc-cli/settings.json';

export type UserLevel = 'beginner' | 'intermediate' | 'advanced';

export interface CodingStyle {
  primaryLanguage: string | null;
  indentation: 'spaces' | 'tabs' | null;
  indentSize: number | null;
  namingConvention: 'camelCase' | 'snake_case' | 'PascalCase' | null;
}

export interface UserProfile {
  level: UserLevel;
  preferredTools: string[];
  codingStyle: CodingStyle;
  sessionCount: number;
  totalToolCalls: number;
  createdAt: number;
  updatedAt: number;
}

const DEFAULT_PROFILE: UserProfile = {
  level: 'beginner',
  preferredTools: [],
  codingStyle: {
    primaryLanguage: null,
    indentation: null,
    indentSize: null,
    namingConvention: null,
  },
  sessionCount: 0,
  totalToolCalls: 0,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

/**
 * User profile service
 */
export class UserProfileService {
  private profile: UserProfile;
  private settingsPath: string;
  private preferredToolsSet: Set<string>;

  constructor(settingsPath?: string) {
    this.settingsPath = settingsPath || path.join(os.homedir(), SETTINGS_FILE);
    this.profile = { ...DEFAULT_PROFILE };
    this.preferredToolsSet = new Set(this.profile.preferredTools);
  }

  /**
   * Get current profile
   */
  getProfile(): UserProfile {
    return { ...this.profile };
  }

  /**
   * Update user level
   */
  updateLevel(level: UserLevel): void {
    this.profile.level = level;
    this.profile.updatedAt = Date.now();
  }

  /**
   * Record tool preference (called after tool usage)
   * Uses Set for O(1) deduplication instead of O(n) Array.includes
   */
  recordToolPreference(toolName: string): void {
    // Add to preferred tools if not already there (O(1) Set lookup)
    if (!this.preferredToolsSet.has(toolName)) {
      this.preferredToolsSet.add(toolName);
      this.profile.preferredTools.push(toolName);
    }

    // Keep top 10 most recent tools
    if (this.profile.preferredTools.length > 10) {
      const removed = this.profile.preferredTools.splice(0, this.profile.preferredTools.length - 10);
      for (const tool of removed) {
        this.preferredToolsSet.delete(tool);
      }
    }

    this.profile.totalToolCalls++;
    this.profile.updatedAt = Date.now();
  }

  /**
   * Record coding style from file analysis
   */
  recordCodingStyle(style: Partial<CodingStyle>): void {
    if (style.primaryLanguage !== undefined) {
      this.profile.codingStyle.primaryLanguage = style.primaryLanguage;
    }
    if (style.indentation !== undefined) {
      this.profile.codingStyle.indentation = style.indentation;
    }
    if (style.indentSize !== undefined) {
      this.profile.codingStyle.indentSize = style.indentSize;
    }
    if (style.namingConvention !== undefined) {
      this.profile.codingStyle.namingConvention = style.namingConvention;
    }

    this.profile.updatedAt = Date.now();
  }

  /**
   * Increment session count
   */
  incrementSessionCount(): void {
    this.profile.sessionCount++;
    this.profile.updatedAt = Date.now();
  }

  /**
   * Get user level
   */
  getLevel(): UserLevel {
    return this.profile.level;
  }

  /**
   * Get preferred tools
   */
  getPreferredTools(): string[] {
    return [...this.profile.preferredTools];
  }

  /**
   * Get coding style
   */
  getCodingStyle(): CodingStyle {
    return { ...this.profile.codingStyle };
  }

  /**
   * Persist profile to disk
   */
  async persist(): Promise<void> {
    const dir = path.dirname(this.settingsPath);
    await fs.mkdir(dir, { recursive: true });

    // Read existing settings to preserve other fields
    let existingSettings: Record<string, any> = {};
    try {
      const content = await fs.readFile(this.settingsPath, 'utf-8');
      existingSettings = JSON.parse(content);
    } catch {
      // File doesn't exist or is invalid, start fresh
    }

    const settings = {
      ...existingSettings,
      userProfile: this.profile,
    };

    await fs.writeFile(this.settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  }

  /**
   * Load profile from disk
   */
  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.settingsPath, 'utf-8');
      const settings = JSON.parse(content);

      if (settings.userProfile) {
        this.profile = {
          ...DEFAULT_PROFILE,
          ...settings.userProfile,
          codingStyle: {
            ...DEFAULT_PROFILE.codingStyle,
            ...settings.userProfile.codingStyle,
          },
        };
        // Rebuild Set from loaded preferredTools
        this.preferredToolsSet = new Set(this.profile.preferredTools);
      }
    } catch {
      // File doesn't exist or is invalid, use defaults
    }
  }

  /**
   * Reset profile to defaults
   */
  reset(): void {
    this.profile = {
      ...DEFAULT_PROFILE,
      preferredTools: [],
      codingStyle: { ...DEFAULT_PROFILE.codingStyle },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.preferredToolsSet.clear();
  }
}

/**
 * Detect coding style from file content
 */
export function detectCodingStyle(content: string, fileName: string): Partial<CodingStyle> {
  const style: Partial<CodingStyle> = {};

  // Detect language from file extension
  const ext = path.extname(fileName).toLowerCase();
  const languageMap: Record<string, string> = {
    '.ts': 'TypeScript',
    '.tsx': 'TypeScript',
    '.js': 'JavaScript',
    '.jsx': 'JavaScript',
    '.py': 'Python',
    '.rs': 'Rust',
    '.go': 'Go',
    '.java': 'Java',
    '.rb': 'Ruby',
    '.cpp': 'C++',
    '.c': 'C',
  };

  if (languageMap[ext]) {
    style.primaryLanguage = languageMap[ext];
  }

  // Detect indentation
  const lines = content.split('\n');
  let spaceCount = 0;
  let tabCount = 0;
  let indentSize = 0;

  for (const line of lines) {
    if (line.startsWith('\t')) {
      tabCount++;
    } else if (line.startsWith('  ')) {
      spaceCount++;
      // Detect indent size
      const match = line.match(/^( +)/);
      if (match && indentSize === 0) {
        indentSize = match[1].length;
      }
    }
  }

  if (tabCount > spaceCount) {
    style.indentation = 'tabs';
  } else if (spaceCount > tabCount) {
    style.indentation = 'spaces';
    style.indentSize = indentSize || 2;
  }

  // Detect naming convention from file names
  const baseName = path.basename(fileName, ext);
  if (baseName.includes('_')) {
    style.namingConvention = 'snake_case';
  } else if (baseName[0] === baseName[0].toUpperCase() && /[A-Z]/.test(baseName)) {
    style.namingConvention = 'PascalCase';
  } else if (baseName[0] === baseName[0].toLowerCase()) {
    style.namingConvention = 'camelCase';
  }

  return style;
}
