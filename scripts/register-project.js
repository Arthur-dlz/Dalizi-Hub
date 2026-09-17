import path from "node:path";
import { fileURLToPath } from "node:url";
import { DispatcherError } from "../src/contracts.js";
import { projectRegistryPath, registerProject } from "../src/project-registry.js";

function argumentsFrom(argv) {
  if (argv.length !== 4 || argv[0] !== "--alias" || argv[2] !== "--cwd") {
    throw new DispatcherError("invalid_arguments", "usage: node scripts/register-project.js --alias <alias> --cwd <absolute-path>");
  }
  return { alias: argv[1], cwd: argv[3] };
}

export async function registerFromCommandLine(argv, environment = process.env) {
  const { alias, cwd } = argumentsFrom(argv);
  const dataDirectory = environment.DISPATCHER_DATA_DIR || path.join(process.cwd(), ".dispatcher-data");
  return registerProject({ registryFile: projectRegistryPath(dataDirectory), alias, cwd });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  registerFromCommandLine(process.argv.slice(2)).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      const code = error instanceof DispatcherError ? error.code : "registration_failed";
      process.stderr.write(`project registration failed: ${code}\n`);
      process.exitCode = 1;
    },
  );
}
