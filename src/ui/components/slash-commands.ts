/**
 * Slash command normalization.
 *
 * Kept as a standalone, dependency-free module so the mapping can be unit
 * tested without pulling in the React/Ink component tree.
 */

/**
 * Map of Chinese command aliases to their canonical English slash command.
 * Only aliases for already-implemented commands are included.
 */
export const SLASH_COMMAND_ALIASES: Record<string, string> = {
  '/帮助': '/help',
  '/帮助信息': '/help',
  '/密钥': '/key',
  '/清空': '/clear',
  '/清除': '/clear',
  '/模式': '/mode',
  '/工具': '/tools',
  '/状态': '/status',
  '/级别': '/level',
  '/退出': '/exit',
  '/自动': '/auto',
  '/目标': '/goal',
  '/交互': '/interactive',
};

/**
 * Normalize a slash command token to its canonical English form.
 * Chinese aliases (e.g. "/帮助") are mapped to their English equivalent
 * ("/help"); unknown or already-English commands are returned unchanged.
 */
export function normalizeSlashCommand(cmd: string): string {
  return SLASH_COMMAND_ALIASES[cmd] ?? cmd;
}
