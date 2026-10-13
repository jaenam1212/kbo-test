import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "./types.js";

const ROOT = process.cwd();

export function loadConfig(): AppConfig {
  const configPath = path.join(ROOT, "config.json");
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as AppConfig;
  return {
    ...raw,
    seatCount: Number(process.env.SEAT_COUNT || raw.seatCount || 2),
    pollIntervalMs: Number(process.env.POLL_MS || raw.pollIntervalMs || 1500),
    headless: process.env.HEADLESS === "1" ? true : raw.headless,
    profileDir: process.env.PROFILE_DIR || raw.profileDir,
  };
}

export function resolveProfileDir(config: AppConfig): string {
  return path.isAbsolute(config.profileDir)
    ? config.profileDir
    : path.join(ROOT, config.profileDir);
}
