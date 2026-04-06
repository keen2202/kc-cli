// Simple test script for cc-cli

async function runTests() {
  console.log('Running cc-cli tests...\n');

  // Test 1: Tool Registry
  console.log('Test 1: Tool Registry');
  try {
    const { toolRegistry, registerBuiltInTools } = await import('../src/tools.js');
    await registerBuiltInTools();
    const tools = toolRegistry.getAllTools();
    console.log(`  ✓ Registered ${tools.length} tools: ${tools.map(t => t.name).join(', ')}`);
  } catch (error) {
    console.error(`  ✗ Failed: ${error.message}`);
  }

  // Test 2: Path Utilities
  console.log('\nTest 2: Path Utilities');
  try {
    const { isPathAllowed } = await import('../src/utils/path.js');
    const safeResult = isPathAllowed('/safe/path/file.txt', { cwd: '/safe', operation: 'read' });
    const unsafeResult = isPathAllowed('/etc/passwd', { cwd: '/safe', operation: 'read' });
    console.log(`  ✓ Safe path result: ${safeResult}, System path result: ${unsafeResult}`);
  } catch (error) {
    console.error(`  ✗ Failed: ${error.message}`);
  }

  // Test 3: Config Loading
  console.log('\nTest 3: Config Loading');
  try {
    const { loadConfig } = await import('../src/bootstrap/config.js');
    const { config, layers } = await loadConfig(process.cwd());
    console.log(`  ✓ Config loaded - Provider: ${config.provider}, Model: ${config.model}, Layers: ${layers.length}`);
  } catch (error) {
    console.error(`  ✗ Failed: ${error.message}`);
  }

  // Test 4: State Management
  console.log('\nTest 4: State Management');
  try {
    const { initializeState, getState } = await import('../src/bootstrap/state.js');
    initializeState();
    const state = getState();
    console.log(`  ✓ State initialized - CWD: ${state.cwd}, Session: ${state.sessionId}`);
  } catch (error) {
    console.error(`  ✗ Failed: ${error.message}`);
  }

  console.log('\n✅ Tests completed!');
}

runTests().catch(console.error);
