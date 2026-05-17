export type CommandCategory = 'admin' | 'filtered' | 'passthrough' | 'none' | 'host';

export interface SlashCommandDefinition {
  command: string;
  category: Exclude<CommandCategory, 'none'>;
  description?: string;
  /** For host category commands: whether admin role is required. Defaults true. */
  adminOnly?: boolean;
}

const DEFINITIONS: SlashCommandDefinition[] = [
  // Filtered: silently dropped, never reach the container
  { command: '/help', category: 'filtered' },
  { command: '/login', category: 'filtered' },
  { command: '/logout', category: 'filtered' },
  { command: '/doctor', category: 'filtered' },
  { command: '/config', category: 'filtered' },
  { command: '/remote-control', category: 'filtered' },
  { command: '/start', category: 'filtered' },
  // Admin: routed to container if admin, denied otherwise
  { command: '/clear', category: 'admin', description: 'Clear conversation history' },
  { command: '/compact', category: 'admin', description: 'Compact conversation context' },
  { command: '/context', category: 'admin', description: 'Show context window usage' },
  { command: '/cost', category: 'admin', description: 'Show session cost' },
  { command: '/files', category: 'admin', description: 'List session files' },
  { command: '/model', category: 'admin', description: 'Switch AI model (e.g. /model claude-opus-4)' },
  { command: '/background', category: 'admin', description: 'Run a prompt as a background task' },
  { command: '/verbose', category: 'admin', description: 'Toggle tool update verbosity (on/off)' },
  { command: '/tasks', category: 'admin', description: 'List scheduled tasks' },
  { command: '/cron', category: 'admin', description: 'Manage scheduled tasks' },
  // Host-handled, admin-only
  { command: '/approve', category: 'host', adminOnly: true, description: 'Approve a pending command or request' },
  { command: '/deny', category: 'host', adminOnly: true, description: 'Deny a pending command or request' },
  { command: '/stop', category: 'host', adminOnly: true, description: 'Stop the current agent session' },
  { command: '/update', category: 'host', adminOnly: true, description: 'Check for ClawBridge updates' },
  // Host-handled, any authorized user
  { command: '/status', category: 'host', adminOnly: false, description: 'Show current session status' },
  { command: '/whoami', category: 'host', adminOnly: false, description: 'Show your user info and permissions' },
  { command: '/commands', category: 'host', adminOnly: false, description: 'List available commands' },
  { command: '/goal', category: 'host', adminOnly: false, description: 'Set or clear a persistent goal (/goal <target> or /goal clear)' },
];

export const COMMAND_REGISTRY = Object.freeze(DEFINITIONS.map((def) => Object.freeze({ ...def })));

const COMMAND_BY_NAME = new Map(COMMAND_REGISTRY.map((def) => [def.command, def]));

export interface SlashCommandClassification {
  category: CommandCategory;
  command: string;
}

export function extractSlashCommand(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return '';
  return (trimmed.split(/\s+/)[0] ?? '').toLowerCase();
}

export function classifySlashCommand(text: string): SlashCommandClassification {
  const command = extractSlashCommand(text);
  if (!command) return { category: 'none', command: '' };
  const def = COMMAND_BY_NAME.get(command);
  if (!def) return { category: 'passthrough', command };
  return { category: def.category, command };
}

export function isCommand(text: string, command: string): boolean {
  return extractSlashCommand(text) === command.toLowerCase();
}