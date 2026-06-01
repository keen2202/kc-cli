/**
 * ModelSelector — Provider and model selection component.
 *
 * Architecture: chalk-based string rendering for readline TUI.
 * Provides a list of known providers and their common models.
 */

import chalk from 'chalk';
import type { Theme } from '../theme';

// Pre-compiled regex for ANSI escape stripping (reused across render calls)
const ANSI_STRIP_REGEX = /\x1B\[[0-9;]*m/g;

// ─── Types ───

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  contextWindow: number;
  maxOutput: number;
}

export interface ProviderInfo {
  id: string;
  label: string;
  description: string;
  models: ModelInfo[];
}

export interface ModelSelectorState {
  /** Whether selector is active */
  active: boolean;
  /** Selected provider index */
  providerIndex: number;
  /** Selected model index within provider */
  modelIndex: number;
  /** Available providers */
  providers: ProviderInfo[];
}

// ─── Known Provider Models ───

export function getKnownProviders(): ProviderInfo[] {
  return [
    {
      id: 'deepseek',
      label: 'DeepSeek',
      description: 'High-quality code generation models',
      models: [
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', description: 'Latest flagship model', contextWindow: 131072, maxOutput: 8192 },
        { id: 'deepseek-chat', name: 'DeepSeek Chat', description: 'General purpose chat', contextWindow: 65536, maxOutput: 4096 },
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', description: 'Reasoning-focused model', contextWindow: 65536, maxOutput: 4096 },
      ],
    },
    {
      id: 'anthropic',
      label: 'Anthropic',
      description: 'Safety-focused AI with excellent code capabilities',
      models: [
        { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', description: 'Balanced performance and speed', contextWindow: 200000, maxOutput: 8192 },
        { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', description: 'Most capable Claude model', contextWindow: 200000, maxOutput: 8192 },
        { id: 'claude-haiku-4-20250514', name: 'Claude Haiku 4', description: 'Fast and cost-effective', contextWindow: 200000, maxOutput: 4096 },
      ],
    },
    {
      id: 'openai',
      label: 'OpenAI',
      description: 'Industry-leading models with broad capabilities',
      models: [
        { id: 'gpt-4o', name: 'GPT-4o', description: 'Flagship multimodal model', contextWindow: 128000, maxOutput: 16384 },
        { id: 'gpt-4.1', name: 'GPT-4.1', description: 'Latest code-optimized model', contextWindow: 1000000, maxOutput: 32768 },
        { id: 'o4-mini', name: 'o4 Mini', description: 'Fast reasoning model', contextWindow: 200000, maxOutput: 100000 },
      ],
    },
    {
      id: 'qwen',
      label: 'Qwen',
      description: 'Alibaba Cloud models, strong in Chinese',
      models: [
        { id: 'qwen-max', name: 'Qwen Max', description: 'Most capable Qwen model', contextWindow: 131072, maxOutput: 8192 },
        { id: 'qwen-plus', name: 'Qwen Plus', description: 'Balanced performance', contextWindow: 131072, maxOutput: 4096 },
        { id: 'qwen-coder-plus', name: 'Qwen Coder Plus', description: 'Code-optimized model', contextWindow: 131072, maxOutput: 8192 },
      ],
    },
    {
      id: 'glm',
      label: 'GLM (Zhipu AI)',
      description: 'Chinese-optimized models',
      models: [
        { id: 'glm-4.7', name: 'GLM-4.7', description: 'Latest GLM model', contextWindow: 128000, maxOutput: 4096 },
        { id: 'glm-4.6', name: 'GLM-4.6', description: 'Stable release', contextWindow: 128000, maxOutput: 4096 },
      ],
    },
    {
      id: 'mimo',
      label: 'MiMo (小米)',
      description: 'Xiaomi AI models',
      models: [
        { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro', description: 'Flagship reasoning model', contextWindow: 1048576, maxOutput: 8192 },
        { id: 'mimo-v2.5', name: 'MiMo V2.5', description: 'General purpose', contextWindow: 1048576, maxOutput: 8192 },
        { id: 'mimo-v2-flash', name: 'MiMo V2 Flash', description: 'Fast and efficient', contextWindow: 262144, maxOutput: 4096 },
      ],
    },
    {
      id: 'kimi',
      label: 'Kimi (月之暗面)',
      description: 'Moonshot AI — agentic MoE models',
      models: [
        { id: 'kimi-k2.6', name: 'Kimi K2.6', description: 'Latest flagship, 262K ctx', contextWindow: 262144, maxOutput: 8192 },
        { id: 'kimi-k2.5', name: 'Kimi K2.5', description: 'Strong reasoning', contextWindow: 262144, maxOutput: 8192 },
        { id: 'kimi-k2', name: 'Kimi K2', description: '1T MoE, agentic', contextWindow: 131072, maxOutput: 8192 },
        { id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking', description: 'Extended thinking mode', contextWindow: 262144, maxOutput: 8192 },
      ],
    },
    {
      id: 'step',
      label: 'Step (阶跃星辰)',
      description: 'StepFun AI models',
      models: [
        { id: 'step-3.7-flash', name: 'Step 3.7 Flash', description: 'Latest fast model, 256K ctx', contextWindow: 256000, maxOutput: 8192 },
        { id: 'step-3.5-flash', name: 'Step 3.5 Flash', description: '262K context', contextWindow: 262144, maxOutput: 8192 },
        { id: 'step-2-16k', name: 'Step 2 16K', description: 'Previous gen', contextWindow: 16384, maxOutput: 4096 },
      ],
    },
    {
      id: 'gemini',
      label: 'Gemini (Google)',
      description: 'Google AI models, 1M+ context',
      models: [
        { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Most capable, thinking model', contextWindow: 1048576, maxOutput: 65536 },
        { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'Fast and capable', contextWindow: 1048576, maxOutput: 65536 },
        { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', description: 'Cost-efficient', contextWindow: 1048576, maxOutput: 65536 },
        { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', description: 'Previous gen', contextWindow: 1048576, maxOutput: 8192 },
      ],
    },
    {
      id: 'openai-compatible',
      label: 'OpenAI Compatible',
      description: 'Any OpenAI-compatible endpoint',
      models: [
        { id: 'custom', name: 'Custom Model', description: 'Manually specified model name', contextWindow: 65536, maxOutput: 4096 },
      ],
    },
    {
      id: 'ollama',
      label: 'Ollama',
      description: 'Local LLM runtime',
      models: [
        { id: 'auto', name: 'Auto-detect', description: 'Use Ollama default model', contextWindow: 32768, maxOutput: 4096 },
      ],
    },
  ];
}

// ─── State Management ───

export function createModelSelectorState(
  currentProvider?: string,
  currentModel?: string
): ModelSelectorState {
  const providers = getKnownProviders();

  let providerIndex = providers.findIndex(p => p.id === currentProvider);
  if (providerIndex < 0) providerIndex = 0;

  let modelIndex = 0;
  if (currentModel && providers[providerIndex]) {
    const found = providers[providerIndex]!.models.findIndex(m => m.id === currentModel);
    if (found >= 0) modelIndex = found;
  }

  return {
    active: false,
    providerIndex,
    modelIndex,
    providers,
  };
}

// ─── Rendering ───

/**
 * Render the model selector panel.
 */
export function renderModelSelector(
  state: ModelSelectorState,
  options: { maxWidth?: number; maxHeight?: number; theme?: Theme } = {}
): string {
  const tokens = options.theme?.resolve();
  const maxWidth = options.maxWidth ?? 60;
  const maxHeight = options.maxHeight ?? 12;
  const lines: string[] = [];

  const currentProvider = state.providers[state.providerIndex];
  const currentModel = currentProvider?.models[state.modelIndex];

  // Header
  const borderColor = tokens ? tokens['overlay.border'] : chalk.gray;
  const headerColor = tokens ? tokens['overlay.selected'] : chalk.cyan.bold;
  lines.push(
    headerColor('┌─ ') +
    headerColor('Select Model') +
    borderColor(' ─' + '─'.repeat(Math.max(0, maxWidth - 16)) + '┐')
  );

  // Current selection info
  lines.push(
    borderColor('│ ') +
    chalk.dim('Provider: ') +
    chalk.white(currentProvider?.label ?? '—') +
    chalk.gray('  →  ') +
    chalk.dim('Model: ') +
    chalk.white(currentModel?.name ?? '—') +
    ' '.repeat(Math.max(0, maxWidth - (currentProvider?.label.length ?? 2) - (currentModel?.name.length ?? 2) - 30)) +
    borderColor('│')
  );
  lines.push(borderColor('├' + '─'.repeat(maxWidth) + '┤'));

  // Provider list
  for (let i = 0; i < Math.min(state.providers.length, maxHeight - 4); i++) {
    const provider = state.providers[i];
    if (!provider) continue;
    const isSelected = i === state.providerIndex;

    const marker = isSelected ? (tokens ? tokens['overlay.selected']('❯ ') : chalk.cyan.bold('❯ ')) : '  ';
    const label = isSelected ? chalk.white.bold(provider.label) : chalk.dim(provider.label);
    const desc = isSelected ? chalk.gray(` — ${provider.description}`) : '';

    const row = `${marker}${label}${desc}`;
    const plainRow = row.replace(ANSI_STRIP_REGEX, '');
    const padding = Math.max(0, maxWidth - plainRow.length + 1);

    lines.push(borderColor('│') + ' ' + row + ' '.repeat(padding) + borderColor('│'));

    // Show models for selected provider
    if (isSelected && provider.models.length > 0) {
      for (let j = 0; j < Math.min(provider.models.length, 4); j++) {
        const model = provider.models[j];
        if (!model) continue;
        const isModelSelected = j === (i === state.providerIndex ? state.modelIndex : 0);
        const mMarker = isModelSelected ? (tokens ? tokens['overlay.selected']('  › ') : chalk.cyan('  › ')) : chalk.dim('    ');
        const mLabel = isModelSelected ? (tokens ? tokens['tool.success'](model.name) : chalk.green(model.name)) : chalk.dim(model.name);
        const mDesc = chalk.gray.dim(` ${model.description}`);
        const mContext = chalk.gray.dim(` [${model.contextWindow / 1000}K ctx]`);

        const mRow = `${mMarker}${mLabel}${mDesc}${mContext}`;
        const mPlain = mRow.replace(ANSI_STRIP_REGEX, '');
        const mPad = Math.max(0, maxWidth - mPlain.length - 1);

        lines.push(borderColor('│') + ' ' + mRow + ' '.repeat(mPad) + borderColor('│'));
      }
    }
  }

  // Fill empty rows
  const contentLines = lines.length;
  for (let i = contentLines; i < maxHeight + 1; i++) {
    lines.push(borderColor('│') + ' '.repeat(maxWidth + 1) + borderColor('│'));
  }

  // Footer
  lines.push(borderColor('├' + '─'.repeat(maxWidth) + '┤'));
  lines.push(
    borderColor('│ ') +
    chalk.dim('↑↓ Select  Enter Confirm  Esc Back  ') +
    ' '.repeat(Math.max(0, maxWidth - 40)) +
    borderColor('│')
  );
  lines.push(borderColor('└' + '─'.repeat(maxWidth) + '┘'));

  return lines.join('\n');
}

// ─── Navigation ───

export function modelSelectorMoveUp(state: ModelSelectorState): void {
  // If selecting within models, move model selection up
  const currentProvider = state.providers[state.providerIndex];
  if (currentProvider && state.modelIndex > 0) {
    state.modelIndex--;
  } else {
    // Move provider up
    state.providerIndex = (state.providerIndex - 1 + state.providers.length) % state.providers.length;
    state.modelIndex = 0;
  }
}

export function modelSelectorMoveDown(state: ModelSelectorState): void {
  const currentProvider = state.providers[state.providerIndex];
  if (currentProvider && state.modelIndex < currentProvider.models.length - 1) {
    state.modelIndex++;
  } else {
    state.providerIndex = (state.providerIndex + 1) % state.providers.length;
    state.modelIndex = 0;
  }
}

export function modelSelectorGetSelected(state: ModelSelectorState): {
  providerId: string;
  modelId: string;
  modelName: string;
} | null {
  const provider = state.providers[state.providerIndex];
  const model = provider?.models[state.modelIndex];
  if (!provider || !model) return null;

  return {
    providerId: provider.id,
    modelId: model.id,
    modelName: model.name,
  };
}
