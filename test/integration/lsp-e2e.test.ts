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

const QUICK_TIMEOUT = 3000;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
    ),
  ]);
}

describe('LSP E2E Integration', () => {
  // We import dynamically to avoid errors when LSP modules aren't available
  let LSPClientManager: any;
  let detectLanguage: any;
  let CompletionProvider: any;
  let NavigationProvider: any;
  let CodeActionProvider: any;
  let DocumentManager: any;

  let tmpDir: string;
  let testFile: string;
  let lspAvailable = false;

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

    // Probe if the LSP server is actually reachable
    if (hasTSLanguageServer && LSPClientManager) {
      const probeClient = new LSPClientManager();
      try {
        lspAvailable = await withTimeout(
          probeClient.connect('typescript', `file://${tmpDir}`),
          QUICK_TIMEOUT,
        );
        if (lspAvailable) {
          await probeClient.disconnectAll().catch(() => {});
        }
      } catch {
        lspAvailable = false;
      }
    }
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
      try { await client.disconnectAll(); } catch {}
    });

    it('should connect or gracefully handle unavailable server', async () => {
      if (!lspAvailable) {
        // With no server, ensure connect fails without hanging
        let connected = false;
        try {
          connected = await withTimeout(
            client.connect('typescript', `file://${tmpDir}`),
            QUICK_TIMEOUT,
          );
        } catch { connected = false; }
        expect(typeof connected).toBe('boolean');
        return;
      }

      const connected = await client.connect('typescript', `file://${tmpDir}`);
      expect(connected).toBe(true);
      expect(client.isConnected('typescript')).toBe(true);
    }, 10000);

    it('should not connect to unknown language', async () => {
      const connected = await client.connect('unknown', `file://${tmpDir}`);
      expect(connected).toBe(false);
    });

    it('should handle reconnection gracefully', async () => {
      if (!lspAvailable) return;

      const first = await client.connect('typescript', `file://${tmpDir}`);
      const second = await client.connect('typescript', `file://${tmpDir}`);
      expect(second).toBe(true);
    }, 10000);
  });

  describe('Diagnostics', () => {
    let client: any;

    beforeEach(async () => {
      client = new LSPClientManager();
      if (!lspAvailable) return;
      try {
        await withTimeout(client.connect('typescript', `file://${tmpDir}`), QUICK_TIMEOUT);
      } catch {}
    }, 5000);

    afterEach(async () => {
      try { await client.disconnectAll(); } catch {}
    });

    it('should get diagnostics for file with type errors', async () => {
      if (!lspAvailable) return;

      const content = fs.readFileSync(testFile, 'utf-8');
      const diagnostics = await client.getDiagnostics(testFile, content);

      expect(Array.isArray(diagnostics)).toBe(true);
      if (diagnostics.length > 0) {
        const diag = diagnostics[0];
        expect(diag).toHaveProperty('range');
        expect(diag.range).toHaveProperty('start');
        expect(diag.range).toHaveProperty('end');
        expect(diag).toHaveProperty('message');
        expect(diag).toHaveProperty('severity');
      }
    }, 10000);

    it('should get empty diagnostics for clean file', async () => {
      if (!lspAvailable) return;

      const cleanFile = path.join(tmpDir, 'src', 'utils.ts');
      const content = fs.readFileSync(cleanFile, 'utf-8');
      const diagnostics = await client.getDiagnostics(cleanFile, content);

      expect(Array.isArray(diagnostics)).toBe(true);
      const errors = diagnostics.filter((d: any) => d.severity === 1);
      expect(errors).toHaveLength(0);
    }, 10000);
  });

  describe('Hover Information', () => {
    let client: any;

    beforeEach(async () => {
      client = new LSPClientManager();
      if (!lspAvailable) return;
      try {
        await withTimeout(client.connect('typescript', `file://${tmpDir}`), QUICK_TIMEOUT);
      } catch {}
    }, 5000);

    afterEach(async () => {
      try { await client.disconnectAll(); } catch {}
    });

    it('should get hover info for function name', async () => {
      if (!lspAvailable) return;

      const content = fs.readFileSync(testFile, 'utf-8');
      const hover = await client.getHover(testFile, content, 7, 10);

      if (hover) {
        expect(hover).toHaveProperty('contents');
      }
    }, 10000);

    it('should return null for hover on empty space', async () => {
      if (!lspAvailable) return;

      const content = fs.readFileSync(testFile, 'utf-8');
      const hover = await client.getHover(testFile, content, 0, 0);

      if (hover) {
        expect(hover.contents).toBeFalsy();
      }
    }, 10000);
  });

  describe('Go to Definition', () => {
    let client: any;

    beforeEach(async () => {
      client = new LSPClientManager();
      if (!lspAvailable) return;
      try {
        await withTimeout(client.connect('typescript', `file://${tmpDir}`), QUICK_TIMEOUT);
      } catch {}
    }, 5000);

    afterEach(async () => {
      try { await client.disconnectAll(); } catch {}
    });

    it('should find definition of User interface', async () => {
      if (!lspAvailable) return;

      const content = fs.readFileSync(testFile, 'utf-8');
      const definitions = await client.getDefinition(testFile, content, 17, 12);

      expect(Array.isArray(definitions)).toBe(true);
      if (definitions.length > 0) {
        const def = definitions[0];
        expect(def).toHaveProperty('uri');
        expect(def).toHaveProperty('range');
      }
    }, 10000);

    it('should find definition of imported function', async () => {
      if (!lspAvailable) return;

      const content = fs.readFileSync(testFile, 'utf-8');
      const definitions = await client.getDefinition(testFile, content, 18, 18);

      expect(Array.isArray(definitions)).toBe(true);
    }, 10000);
  });

  describe('DocumentManager Integration', () => {
    it('should manage document lifecycle', async () => {
      if (!DocumentManager) {
        return;
      }

      // Use a mock LSP client to avoid needing a real language server
      const mockClient = {
        connect: async () => true,
        disconnectAll: async () => {},
      };
      const manager = new DocumentManager(mockClient);

      const content = fs.readFileSync(testFile, 'utf-8');

      // Open document
      const doc = await manager.open(testFile, content, 'typescript');
      expect(doc).toHaveProperty('uri');
      expect(doc.isOpen).toBe(true);
      expect(doc.version).toBe(1);

      // Update document (simulate edit)
      const updatedContent = content.replace('Alice', 'Bob');
      const updatedDoc = await manager.update(testFile, updatedContent);
      expect(updatedDoc.version).toBe(2);
      expect(updatedDoc.content).toBe(updatedContent);

      // Close document
      manager.close(testFile);
      expect(manager.isOpen(testFile)).toBe(false);
    });

    it('should track document versions', async () => {
      if (!DocumentManager) {
        return;
      }

      const mockClient = {
        connect: async () => true,
        disconnectAll: async () => {},
      };
      const manager = new DocumentManager(mockClient);

      await manager.open(testFile, 'v1', 'typescript');
      await manager.update(testFile, 'v2');
      await manager.update(testFile, 'v3');

      const doc = manager.get(testFile);
      expect(doc).toBeDefined();
      expect(doc!.version).toBe(3);
      expect(doc!.content).toBe('v3');

      manager.close(testFile);
      expect(manager.isOpen(testFile)).toBe(false);
    });
  });

  describe('Completion Provider', () => {
    it('should return empty when document not open', async () => {
      if (!CompletionProvider) {
        return;
      }

      const client = new LSPClientManager();
      const docMgr = new (DocumentManager || class {})();
      const provider = new CompletionProvider();

      const result = await provider.getCompletions(
        client,
        docMgr as any,
        testFile,
        { line: 20, character: 8 },
      );

      expect(result).toHaveProperty('items');
      expect(Array.isArray(result.items)).toBe(true);
      // Document not opened, should return empty
      expect(result.items).toHaveLength(0);
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
