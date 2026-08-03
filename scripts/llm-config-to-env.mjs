#!/usr/bin/env node
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const mappings = [
  { section: "llm", provider: "ASSESSMENT_PROVIDER", prefix: "CHAT" },
  { section: "transcribe", provider: "TRANSCRIPTION_PROVIDER", prefix: "TRANSCRIPTION" },
  { section: "tts", provider: "TTS_PROVIDER", prefix: "TTS" },
];

function usage() {
  console.log(`Usage: bun run llm:env -- [options]

Options:
  --input <path>       JSON config (default: llm_config.json)
  --output <path>      dotenv output (default: .env)
  --template <path>    dotenv template (default: .env.example)
  --enable-providers   set provider modes to openai-compatible
  --force              overwrite an existing output file
  --help               show this help

Secrets are written to the output file and never printed.`);
}

function parseArgs(argv) {
  const args = {
    input: "llm_config.json",
    output: ".env",
    template: ".env.example",
    enableProviders: false,
    force: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      usage();
      process.exit(0);
    }
    if (argument === "--enable-providers") {
      args.enableProviders = true;
      continue;
    }
    if (argument === "--force") {
      args.force = true;
      continue;
    }
    if (["--input", "--output", "--template"].includes(argument)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} needs a path`);
      args[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  return args;
}

function asString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function dotenvValue(value) {
  return JSON.stringify(value);
}

function setEnvValue(source, key, value) {
  if (!value) return source;
  const line = `${key}=${dotenvValue(value)}`;
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=.*$`, "gm");
  const replaced = source.replace(pattern, line);
  return replaced === source ? `${source.trimEnd()}\n${line}\n` : replaced;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.input);
  const outputPath = path.resolve(args.output);
  const templatePath = path.resolve(args.template);

  if (!existsSync(inputPath)) throw new Error(`Input not found: ${args.input}`);
  if (existsSync(outputPath) && !args.force) {
    throw new Error(`Output exists: ${args.output}; use --force to replace it.`);
  }

  const parsed = JSON.parse(readFileSync(inputPath, "utf8"));
  let output = existsSync(outputPath)
    ? readFileSync(outputPath, "utf8")
    : existsSync(templatePath)
      ? readFileSync(templatePath, "utf8")
      : "";
  const generated = [];

  for (const mapping of mappings) {
    const section = parsed?.[mapping.section];
    if (!section || typeof section !== "object") continue;
    const values = {
      [`${mapping.prefix}_BASE_URL`]: asString(section.base_url),
      [`${mapping.prefix}_API_KEY`]: asString(section.api_key),
      [`${mapping.prefix}_MODEL`]: Array.isArray(section.models)
        ? asString(section.models[0])
        : undefined,
    };
    for (const [key, value] of Object.entries(values)) {
      if (!value) continue;
      output = setEnvValue(output, key, value);
      generated.push(key);
    }
    const presentValues = Object.values(values).filter(Boolean);
    if (args.enableProviders && presentValues.length > 0 && presentValues.length < 3) {
      throw new Error(
        `${mapping.section} needs base_url, api_key, and the first models entry before enabling it.`,
      );
    }
    if (args.enableProviders && presentValues.length === 3) {
      output = setEnvValue(output, mapping.provider, "openai-compatible");
      generated.push(mapping.provider);
    }
    if (mapping.section === "transcribe" && args.enableProviders && presentValues.length === 3) {
      output = setEnvValue(output, "TRANSCRIPTION_RESPONSE_FORMAT", "auto");
      generated.push("TRANSCRIPTION_RESPONSE_FORMAT");
    }
  }

  writeFileSync(outputPath, output.endsWith("\n") ? output : `${output}\n`, { mode: 0o600 });
  chmodSync(outputPath, 0o600);
  console.log(`Wrote ${args.output} (${generated.length} values; secrets not printed).`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not generate dotenv file");
  process.exitCode = 1;
}
