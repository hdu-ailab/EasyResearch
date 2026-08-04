export type CliCommand = "new" | "run" | "web" | "help";

export interface ParsedArgs {
  command: CliCommand;
  /** positional args after the command (e.g. topic for `new`) */
  positionals: string[];
  /** subcommand flags (e.g. --auto, -c) */
  flags: Record<string, string | boolean>;
}

const KNOWN_COMMANDS: CliCommand[] = ["new", "run", "web", "help"];

/** Flags that take a value: `--name value` and `--name=value` are equivalent. */
const VALUE_FLAGS = new Set(["model", "port"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { command: "help", positionals: [], flags: {} };

  const [first, ...rest] = argv;
  if (first === undefined) return result;

  if (KNOWN_COMMANDS.includes(first as CliCommand)) {
    result.command = first as CliCommand;
  } else if (first.startsWith("-")) {
    result.command = "help";
    return result;
  } else {
    result.command = "help";
    result.positionals = [first];
    return result;
  }

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--") {
      result.positionals.push(...rest.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        result.flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else if (VALUE_FLAGS.has(arg.slice(2))) {
        const value = rest[i + 1];
        if (value !== undefined && !value.startsWith("-")) {
          result.flags[arg.slice(2)] = value;
          i++;
        } else {
          result.flags[arg.slice(2)] = true;
        }
      } else {
        result.flags[arg.slice(2)] = true;
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      result.flags[arg.slice(1)] = true;
    } else {
      result.positionals.push(arg);
    }
  }

  return result;
}
