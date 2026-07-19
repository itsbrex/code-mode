// CLI argument parsing. Lives outside index.ts so it can be imported by tests
// without executing the CLI's main() (index.ts runs main on import).

export interface Args {
  command: string;
  positionals: string[];
  config?: string;
  limit?: number;
  code?: string;
  file?: string;
  timeout?: number;
  paste: boolean;
  authCode?: string;
  offline: boolean;
  manualMode: boolean;
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { command: argv[0] || 'help', positionals: [], paste: false, offline: false, manualMode: false };
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    switch (t) {
      case '--config': a.config = argv[++i]; break;
      case '--limit': a.limit = Number(argv[++i]); break;
      case '-c': case '--code-string': a.code = argv[++i]; break;
      case '--file': a.file = argv[++i]; break;
      case '--timeout': a.timeout = Number(argv[++i]); break;
      case '--paste': a.paste = true; break;
      case '--code': a.authCode = argv[++i]; break;
      case '--offline': a.offline = true; break;
      case '--manual': a.manualMode = true; break;
      case '-h': case '--help': a.command = a.command === 'help' ? 'help' : a.command; a.positionals.push('--help'); break;
      default: a.positionals.push(t);
    }
  }
  return a;
}
