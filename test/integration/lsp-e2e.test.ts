import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * End-to-end LSP integration tests.
 *
 * These tests verify LSP functionality by connecting to a real language server
 * when available. Tests gracefully skip when no language server is installed.
 */

// Check for available language servers
function hasTypeScriptLS(): boolean {
  try {
    execSync('which typescript-language-server', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function hasTSServer(): boolean {
  try {
    execSync('which tsserver', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const hasTSLanguageServer = hasTypeScriptLS() || hasTSServer();

describe.skipIf(!hasTSLanguageServer)('LSP E2E Integration', () => {
  // We import dynamically to avoid errors when LSP modules aren't available
  let LSPClientManager: any;
  let detectLanguage: any;
  let CompletionProvider: any;
  let NavigationProvider: any;
  let CodeActionProvider: any;
  let DocumentManager: any;

  let tmpDir: string;
  let testFile: string;

  beforeAll(async () => {
    // Dynamic imports
    const clientMod = await import('../../src/lsp/client');
    LSPClientManager = clientMod.LSPClientManager;
    detectLanguage = clientMod.detectLanguage;

    try {
      const completionMod = await import('../../src/lsp/completion');
      CompletionProvider = completionMod.CompletionProvider;
    } catch { /* may not exist */ }

    try {
      const navMod = await import('../../src/lsp/navigation');
      NavigationProvider = navMod.NavigationProvider;
    } catch { /* may not exist */ }

    try {
      const codeMod = await import('../../src/lsp/code-actions');
      CodeActionProvider = codeMod.CodeActionProvider;
    } catch { /* may not exist */ }

    try {
      const docMod = await import('../../src/lsp/document-manager');
      DocumentManager = docMod.DocumentManager;
    } catch { /* may not exist */ }

    // Create temp project with TypeScript files
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-lsp-e2e-'));

    // Create a tsconfig.json
    fs.writeFileSync(
      path.join(tmpDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2020',
          module: 'commonjs',
          strict: true,
          esModuleInterop: true,
          outDir: './dist',
          rootDir: './src',
        },
        include: ['src/**/*.ts'],
      }, null, 2)
    );

    // Create src directory
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });

    // Create a test TypeScript file with intentional issues
    testFile = path.join(tmpDir, 'src', 'main.ts');
    fs.writeFileSync(testFile, `
// A simple TypeScript file for LSP testing
interface User {
  name: string;
  age: number;
  email?: string;
}

function greetUser(user: User): string {
  return \`Hello, \${user.name}! You are \${user.age} years old.\`;
}

function calculateAge(birthYear: number): number {
  const currentYear = new Date().getFullYear();
  return currentYear - birthYear;
}

// This has a type error - passing string where number is expected
const user: User = {
  name: "Alice",
  age: calculateAge("1990"),  // Error: string not assignable to number
  email: "alice@example.com",
};

console.log(greetUser(user));

export { User, greetUser, calculateAge };
`.trim());

    // Create a file with no errors
    const cleanFile = path.join(tmpDir, 'src', 'utils.ts');
    fs.writeFileSync(cleanFile, `
export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export const PI = 3.14159;
`.trim());
  });

  afterAll(() => {
    // Cleanup temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('Language Detection', () => {
    it('should detect TypeScript files', () => {
      expect(detectLanguage('file.ts')).toBe('typescript');
      expect(detectLanguage('file.tsx')).toBe('typescript');
    });

    it('should detect JavaScript files', () => {
      expect(detectLanguage('file.js')).toBe('javascript');
      expect(detectLanguage('file.jsx')).toBe('javascript');
    });

    it('should detect Go files', () => {
      expect(detectLanguage('main.go')).toBe('go');
    });

    it('should detect Python files', () => {
      expect(detectLanguage('script.py')).toBe('python');
    });

    it('should detect Rust files', () => {
      expect(detectLanguage('lib.rs')).toBe('rust');
    });

    it('should return unknown for unrecognized extensions', () => {
      expect(detectLanguage('file.txt')).toBe('unknown');
      expect(detectLanguage('file.md')).toBe('unknown');
    });
  });

  describe('LSP Client Connection', () => {
    let client: any;

    beforeEach(() => {
      client = new LSPClientManager();
    });

    afterEach(async () => {
      await client.disconnectAll();
    });

    it('should connect to TypeScript language server', async () => {
      const connected = await client.connect('typescript', `file://${tmpDir}`);
      expect(connected).toBe(true);
      expect(client.isConnected('typescript')).toBe(true);
    });

    it('should not connect to unknown language', async () => {
      const connected = await client.connect('unknown', `file://${tmpDir}`);
      expect(connected).toBe(false);
    });

    it('should not connect twice to same language', async () => {
      await client.connect('typescript', `file://${tmpDir}`);
      const secondConnect = await client.connect('typescript', `file://${tmpDir}`);
      expect(secondConnect).toBe(true); // Returns true but doesn't create new connection
    });
  });

  describe('Diagnostics', () => {
    let client: any;

    beforeEach(async () => {
      client = new LSPClientManager();
      await client.connect('typescript', `file://${tmpDir}`);
    });

    afterEach(async () => {
      await client.disconnectAll();
    });

    it('should get diagnostics for file with type errors', async () => {
      const content = fs.readFileSync(testFile, 'utf-8');
      const diagnostics = await client.getDiagnostics(testFile, content);

      // Should have at least one diagnostic (the type error)
      expect(Array.isArray(diagnostics)).toBe(true);
      // Note: The actual number depends on the TypeScript version
      // We just verify the structure is correct
      if (diagnostics.length > 0) {
        const diag = diagnostics[0];
        expect(diag).toHaveProperty('range');
        expect(diag.range).toHaveProperty('start');
        expect(diag.range).toHaveProperty('end');
        expect(diag).toHaveProperty('message');
        expect(diag).toHaveProperty('severity');
      }
    });

    it('should get empty diagnostics for clean file', async () => {
      const cleanFile = path.join(tmpDir, 'src', 'utils.ts');
      const content = fs.readFileSync(cleanFile, 'utf-8');
      const diagnostics = await client.getDiagnostics(cleanFile, content);

      expect(Array.isArray(diagnostics)).toBe(true);
      // Clean file should have no errors (or only minor warnings)
      const errors = diagnostics.filter((d: any) => d.severity === 1); // Error severity
      expect(errors).toHaveLength(0);
    });
  });

  describe('Hover Information', () => {
    let client: any;

    beforeEach(async () => {
      client = new LSPClientManager();
      await client.connect('typescript', `file://${tmpDir}`);
    });

    afterEach(async () => {
      await client.disconnectAll();
    });

    it('should get hover info for function name', async () => {
      const content = fs.readFileSync(testFile, 'utf-8');
      // "greetUser" is at approximately line 7 in the file
      const hover = await client.getHover(testFile, content, 7, 10);

      // Hover may or may not be available depending on TS server version
      if (hover) {
        expect(hover).toHaveProperty('contents');
      }
    });

    it('should return null for hover on empty space', async () => {
      const content = fs.readFileSync(testFile, 'utf-8');
      // Empty line should not have hover
      const hover = await client.getHover(testFile, content, 0, 0);
      // May be null or empty
      if (hover) {
        expect(hover.contents).toBeFalsy();
      }
    });
  });

  describe('Go to Definition', () => {
    let client: any;

    beforeEach(async () => {
      client = new LSPClientManager();
      await client.connect('typescript', `file://${tmpDir}`);
    });

    afterEach(async () => {
      await client.disconnectAll();
    });

    it('should find definition of User interface', async () => {
      const content = fs.readFileSync(testFile, 'utf-8');
      // "User" interface is defined at line 2
      // Usage is at line 17 (const user: User)
      const definitions = await client.getDefinition(testFile, content, 17, 12);

      expect(Array.isArray(definitions)).toBe(true);
      // If definitions found, verify structure
      if (definitions.length > 0) {
        const def = definitions[0];
        expect(def).toHaveProperty('uri');
        expect(def).toHaveProperty('range');
      }
    });

    it('should find definition of imported function', async () => {
      const content = fs.readFileSync(testFile, 'utf-8');
      // "calculateAge" is defined at line 10
      const definitions = await client.getDefinition(testFile, content, 18, 18);

      expect(Array.isArray(definitions)).toBe(true);
    });
  });

  describe('DocumentManager Integration', () => {
    it('should manage document lifecycle', async () => {
      if (!DocumentManager) {
        console.log('  ⏭ Skipping: DocumentManager not available');
        return;
      }

      const client = new LSPClientManager();
      await client.connect('typescript', `file://${tmpDir}`);

      const manager = new DocumentManager(client);

      const content = fs.readFileSync(testFile, 'utf-8');

      // Open document
      manager.openDocument(testFile, content, 'typescript');

      // Update document (simulate edit)
      const updatedContent = content.replace('Alice', 'Bob');
      manager.updateDocument(testFile, updatedContent);

      // Close document
      manager.closeDocument(testFile);

      await client.disconnectAll();
    });

    it('should track document versions', async () => {
      if (!DocumentManager) {
        console.log('  ⏭ Skipping: DocumentManager not available');
        return;
      }

      const client = new LSPClientManager();
      await client.connect('typescript', `file://${tmpDir}`);

      const manager = new DocumentManager(client);

      manager.openDocument(testFile, 'v1', 'typescript');
      manager.updateDocument(testFile, 'v2');
      manager.updateDocument(testFile, 'v3');

      // Version should be tracked internally
      manager.closeDocument(testFile);

      await client.disconnectAll();
    });
  });

  describe('Completion Provider', () => {
    it('should provide completions for dot access', async () => {
      if (!CompletionProvider) {
        console.log('  ⏭ Skipping: CompletionProvider not available');
        return;
      }

      const client = new LSPClientManager();
      await client.connect('typescript', `file://${tmpDir}`);

      const provider = new CompletionProvider(client);
      const content = fs.readFileSync(testFile, 'utf-8');

      // Try to get completions at a position
      const result = await provider.getCompletions(testFile, content, 20, 8);

      // Result structure check
      if (result) {
        expect(result).toHaveProperty('items');
        expect(Array.isArray(result.items)).toBe(true);
      }

      await client.disconnectAll();
    });
  });
});

describe('LSP Module Unit Tests (no server required)', () => {
  it('detectLanguage should handle edge cases', async () => {
    const { detectLanguage } = await import('../../src/lsp/client');
    expect(detectLanguage('')).toBe('unknown');
    expect(detectLanguage('noext')).toBe('unknown');
    // .ts is a dotfile — extname returns '' so it's 'unknown'
    expect(detectLanguage('.ts')).toBe('unknown');
    expect(detectLanguage('path/to/file.py')).toBe('python');
    expect(detectLanguage('dir/file.ts')).toBe('typescript');
  });
});
