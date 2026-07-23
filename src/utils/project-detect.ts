// Project language detection utility
// Detects project language by checking for marker files in the working directory.

import * as fs from 'fs';
import * as path from 'path';

export interface LanguageInfo {
  language: string;
  buildCommands: string[];
  testCommands: string[];
  lintCommands: string[];
  /** Command that performs type/compile checking (empty if none). */
  typeCheckCommand: string;
}

interface LanguageMarker {
  files: string[];
  info: LanguageInfo;
}

/**
 * Language markers ordered by specificity (most specific first).
 * First match wins.
 */
const LANGUAGE_MARKERS: LanguageMarker[] = [
  {
    files: ['go.mod'],
    info: {
      language: 'Go',
      buildCommands: ['go build ./...'],
      testCommands: ['go test ./...'],
      lintCommands: ['go vet ./...'],
      typeCheckCommand: 'go build ./...',
    },
  },
  {
    files: ['Cargo.toml'],
    info: {
      language: 'Rust',
      buildCommands: ['cargo build'],
      testCommands: ['cargo test'],
      lintCommands: ['cargo clippy'],
      typeCheckCommand: 'cargo check',
    },
  },
  {
    files: ['pom.xml'],
    info: {
      language: 'Java (Maven)',
      buildCommands: ['mvn compile'],
      testCommands: ['mvn test'],
      lintCommands: [],
      typeCheckCommand: 'mvn compile',
    },
  },
  {
    files: ['build.gradle', 'build.gradle.kts'],
    info: {
      language: 'Java (Gradle)',
      buildCommands: ['gradle build', './gradlew build'],
      testCommands: ['gradle test', './gradlew test'],
      lintCommands: [],
      typeCheckCommand: 'gradle compileJava',
    },
  },
  {
    files: ['pyproject.toml'],
    info: {
      language: 'Python',
      buildCommands: [],
      testCommands: ['python -m pytest'],
      lintCommands: ['python -m mypy .', 'ruff check .'],
      typeCheckCommand: 'python -m mypy .',
    },
  },
  {
    files: ['requirements.txt', 'setup.py', 'setup.cfg'],
    info: {
      language: 'Python',
      buildCommands: [],
      testCommands: ['python -m pytest'],
      lintCommands: ['python -m mypy .'],
      typeCheckCommand: 'python -m mypy .',
    },
  },
  {
    files: ['tsconfig.json'],
    info: {
      language: 'TypeScript',
      buildCommands: ['npx tsc --noEmit', 'npm run build'],
      testCommands: ['npm test', 'npx vitest run', 'npx jest'],
      lintCommands: ['npx eslint .'],
      typeCheckCommand: 'npx tsc --noEmit',
    },
  },
  {
    files: ['package.json'],
    info: {
      language: 'JavaScript/TypeScript',
      buildCommands: ['npm run build'],
      testCommands: ['npm test', 'npx vitest run', 'npx jest'],
      lintCommands: ['npx eslint .'],
      typeCheckCommand: 'npx tsc --noEmit',
    },
  },
  {
    files: ['Makefile'],
    info: {
      language: 'C/C++ (Make)',
      buildCommands: ['make'],
      testCommands: ['make test'],
      lintCommands: [],
      typeCheckCommand: '',
    },
  },
  {
    files: ['CMakeLists.txt'],
    info: {
      language: 'C/C++ (CMake)',
      buildCommands: ['cmake --build build'],
      testCommands: ['ctest'],
      lintCommands: [],
      typeCheckCommand: '',
    },
  },
];

/**
 * Detect the project language based on marker files in the working directory.
 * Returns the first matching language info, or null if no markers found.
 */
export function detectProjectLanguage(cwd: string): LanguageInfo | null {
  for (const marker of LANGUAGE_MARKERS) {
    for (const file of marker.files) {
      try {
        const filePath = path.join(cwd, file);
        fs.accessSync(filePath, fs.constants.F_OK);
        return marker.info;
      } catch {
        // File doesn't exist, continue checking
      }
    }
  }
  return null;
}
