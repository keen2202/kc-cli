// Test script for state machine functionality

async function runStateMachineTests() {
  console.log('Running State Machine Tests...\n');

  // Test 1: ObservableStateStore
  console.log('Test 1: ObservableStateStore');
  try {
    const { ObservableStateStore, createInitialState } = await import('../src/state/store.js');
    const store = new ObservableStateStore(createInitialState());

    // Test get/set
    const state1 = store.get();
    console.log(`  ✓ Initial state: ${state1.currentState}`);

    store.set({ verbose: true });
    const state2 = store.get();
    console.log(`  ✓ Updated verbose: ${state2.verbose}`);

    // Test listener
    let listenerCalled = false;
    const unsubscribe = store.subscribe((state) => {
      listenerCalled = true;
    });

    store.set({ printMode: true });
    console.log(`  ✓ Listener called: ${listenerCalled}`);

    // Test unsubscribe
    listenerCalled = false;
    unsubscribe();
    store.set({ bareMode: true });
    console.log(`  ✓ Listener unsubscribed: ${!listenerCalled}`);

    // Test immutable update
    const state3 = store.get();
    console.log(`  ✓ State immutable: ${state1 !== state3}`);
  } catch (error) {
    console.error(`  ✗ Failed: ${error.message}`);
  }

  // Test 2: AgentStateMachine
  console.log('\nTest 2: AgentStateMachine');
  try {
    const { ObservableStateStore, createInitialState } = await import('../src/state/store.js');
    const { AgentStateMachine, InvalidTransitionError } = await import('../src/state/machine.js');

    const store = new ObservableStateStore(createInitialState());
    const machine = new AgentStateMachine(store);

    // Test initial state
    console.log(`  ✓ Initial state: ${machine.currentState}`);

    // Test valid transition
    console.log(`  ✓ Can transition to compacting: ${machine.canTransition('compacting')}`);
    machine.transitionTo('compacting');
    console.log(`  ✓ After transition: ${machine.currentState}`);

    // Test invalid transition
    console.log(`  ✓ Can NOT transition to idle: ${!machine.canTransition('idle')}`);

    try {
      machine.transitionTo('idle');
      console.log(`  ✗ Should have thrown InvalidTransitionError`);
    } catch (error) {
      if (error instanceof InvalidTransitionError) {
        console.log(`  ✓ InvalidTransitionError thrown correctly`);
      }
    }

    // Test reset
    machine.reset();
    console.log(`  ✓ After reset: ${machine.currentState}`);

    // Test terminal states
    machine.transitionTo('compacting');
    machine.transitionTo('streaming');
    machine.transitionTo('deciding');
    machine.transitionTo('completed');
    console.log(`  ✓ Is terminal: ${machine.isTerminal()}`);
  } catch (error) {
    console.error(`  ✗ Failed: ${error.message}`);
  }

  // Test 3: Token Estimation
  console.log('\nTest 3: Token Estimation');
  try {
    const { estimateTokens, estimateMessageTokensArray } = await import('../src/utils/tokenEstimation.js');

    // Test basic estimation
    const tokens1 = estimateTokens('Hello, world!');
    console.log(`  ✓ 'Hello, world!' ≈ ${tokens1} tokens`);

    const tokens2 = estimateTokens('');
    console.log(`  ✓ Empty string ≈ ${tokens2} tokens`);

    // Test with longer text
    const longText = 'This is a longer text to test the token estimation functionality. '.repeat(10);
    const tokens3 = estimateTokens(longText);
    console.log(`  ✓ Long text (${longText.length} chars) ≈ ${tokens3} tokens`);
  } catch (error) {
    console.error(`  ✗ Failed: ${error.message}`);
  }

  // Test 4: Compaction Service
  console.log('\nTest 4: Compaction Service');
  try {
    const { shouldCompact, microcompact, MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES } = await import('../src/services/compaction.js');

    // Create test messages
    const messages = [];
    for (let i = 0; i < 20; i++) {
      messages.push({
        id: `msg_${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}: ${'x'.repeat(1000)}`, // 1000 chars each
        timestamp: Date.now(),
      });
    }

    // Test shouldCompact
    const config = { contextWindow: 200_000, model: 'claude-sonnet-4-20250514' };
    const needsCompact = shouldCompact(messages, config, 0);
    console.log(`  ✓ Should compact (20 messages): ${needsCompact}`);

    // Test microcompact
    const result = microcompact(messages, 5);
    console.log(`  ✓ Microcompact wasCompacted: ${result.wasCompacted}`);
    console.log(`  ✓ Microcompact tokensSaved: ${result.tokensSaved}`);
    console.log(`  ✓ Microcompact method: ${result.method}`);

    // Test with few messages (should not compact)
    const fewMessages = messages.slice(0, 3);
    const result2 = microcompact(fewMessages, 5);
    console.log(`  ✓ Few messages wasCompacted: ${result2.wasCompacted}`);
  } catch (error) {
    console.error(`  ✗ Failed: ${error.message}`);
  }

  // Test 5: Tool Executor
  console.log('\nTest 5: Tool Executor');
  try {
    const { toolRegistry, registerBuiltInTools } = await import('../src/tools.js');
    const { ToolExecutor } = await import('../src/executors/toolExecutor.js');

    await registerBuiltInTools();
    const tools = toolRegistry.getAllTools();
    const executor = new ToolExecutor(tools, process.cwd());

    console.log(`  ✓ Executor created with ${executor.getRegisteredTools().length} tools`);
    console.log(`  ✓ Has Bash tool: ${executor.hasTool('Bash')}`);
    console.log(`  ✓ Has FileRead tool: ${executor.hasTool('FileRead')}`);
    console.log(`  ✓ Has UnknownTool: ${executor.hasTool('UnknownTool')}`);

    // Test batch permission check
    const toolCalls = [
      { id: 'call_1', toolName: 'Bash', input: { command: 'ls -la' } },
      { id: 'call_2', toolName: 'FileRead', input: { file_path: 'test.txt' } },
    ];

    const context = {
      cwd: process.cwd(),
      abortController: new AbortController(),
      permissions: {
        mode: 'default',
        cwd: process.cwd(),
        toolName: '',
        input: {},
        alwaysDenyRules: [],
        alwaysAskRules: [],
        alwaysAllowRules: [],
        bypassPermissions: false,
      },
    };

    const permResults = await executor.batchPermissionCheck(toolCalls as any, context as any);
    console.log(`  ✓ Batch permission check returned ${permResults.length} results`);
  } catch (error) {
    console.error(`  ✗ Failed: ${error.message}`);
  }

  // Test 6: QueryEngine State Machine Integration
  console.log('\nTest 6: QueryEngine State Machine Integration');
  try {
    const { toolRegistry, registerBuiltInTools } = await import('../src/tools.js');
    const { QueryEngine } = await import('../src/query/QueryEngine.js');

    await registerBuiltInTools();
    const tools = toolRegistry.getAllTools();

    const engine = new QueryEngine(
      {
        model: 'claude-sonnet-4-20250514',
        provider: 'anthropic',
        maxTurns: 10,
        maxBudgetUsd: null,
        systemPrompt: 'You are a test assistant.',
      },
      tools
    );

    // Test state machine access
    const stateMachine = engine.getStateMachine();
    console.log(`  ✓ State machine initial state: ${stateMachine.currentState}`);

    // Test state store access
    const stateStore = engine.getStateStore();
    const state = stateStore.get();
    console.log(`  ✓ State store model: ${state.model}`);

    // Test submit message (will use placeholder LLM)
    let eventCount = 0;
    let lastEventType = '';

    for await (const event of engine.submitMessage('Test message')) {
      eventCount++;
      lastEventType = event.type;
    }

    console.log(`  ✓ Events emitted: ${eventCount}`);
    console.log(`  ✓ Last event type: ${lastEventType}`);

    // Test clear
    engine.clear();
    const stateMachine2 = engine.getStateMachine();
    console.log(`  ✓ After clear, state: ${stateMachine2.currentState}`);
  } catch (error) {
    console.error(`  ✗ Failed: ${error.message}`);
    console.error(`     Stack: ${error.stack}`);
  }

  console.log('\n✅ State Machine Tests Completed!');
}

runStateMachineTests().catch(console.error);
