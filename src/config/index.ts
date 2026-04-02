import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface PetricodeConfig {
  [key: string]: unknown;
}

const GLOBAL_CONFIG_PATH = join(homedir(), ".config", "petricode", "config.json");
const PROJECT_CONFIG_NAME = "petricode.config.json";

function loadJsonFile(path: string): PetricodeConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PetricodeConfig;
  } catch {
    return {};
  }
}

export function loadConfig(cwd: string = process.cwd()): PetricodeConfig {
  const global = loadJsonFile(GLOBAL_CONFIG_PATH);
  const project = loadJsonFile(join(cwd, PROJECT_CONFIG_NAME));
  return { ...global, ...project };
}
