import "dotenv/config";
import { runAgent } from "./agent.js";
import { loadConfig } from "./config.js";

interface Arguments {
  prompt: string;
  timeoutSeconds?: number;
  outputDirectory?: string;
}

const controller = new AbortController();
let signalCount = 0;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    signalCount += 1;
    if (signalCount === 1) {
      console.error(`\n${signal} received; cancelling and cleaning up...`);
      controller.abort(new Error(`Interrupted by ${signal}`));
    } else {
      console.error(`\nSecond ${signal} received; exiting immediately`);
      process.exit(130);
    }
  });
}

try {
  const args = parseArguments(process.argv.slice(2));
  const config = loadConfig(process.env, {
    ...(args.timeoutSeconds === undefined
      ? {}
      : { timeoutSeconds: args.timeoutSeconds }),
    ...(args.outputDirectory === undefined
      ? {}
      : { outputDirectory: args.outputDirectory }),
  });
  const completed = await runAgent(config, args.prompt, {
    signal: controller.signal,
  });
  console.log(`run           ${completed.runDirectory}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

export function parseArguments(argv: string[]): Arguments {
  const promptParts: string[] = [];
  let timeoutSeconds: number | undefined;
  let outputDirectory: string | undefined;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === "--timeout") {
      const value = argv[++index];
      if (!value) throw new Error("--timeout requires a number of seconds");
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error("--timeout must be a positive integer");
      }
      timeoutSeconds = parsed;
    } else if (argument === "--output") {
      const value = argv[++index];
      if (!value) throw new Error("--output requires a local path");
      outputDirectory = value;
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      promptParts.push(argument);
    }
  }

  const prompt = promptParts.join(" ").trim();
  if (!prompt) {
    throw new Error(
      'Usage: npm run agent -- "<prompt>" [--timeout <seconds>] [--output <path>]',
    );
  }
  return {
    prompt,
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    ...(outputDirectory === undefined ? {} : { outputDirectory }),
  };
}
