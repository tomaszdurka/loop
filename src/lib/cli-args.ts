export type ParsedCliArgs = {
  positional: string[];
  named: Map<string, string>;
  flags: Set<string>;
};

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const positional: string[] = [];
  const named = new Map<string, string>();
  const flags = new Set<string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      flags.add(token);
      continue;
    }

    named.set(token, value);
    i += 1;
  }

  return { positional, named, flags };
}
