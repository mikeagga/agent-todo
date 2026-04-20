import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const sourceGitUrl = process.env.PI_EXTENSION_GIT_URL?.trim();
const sourceRef = process.env.PI_EXTENSION_REF?.trim() || "main";
const sourceSubdir = process.env.PI_EXTENSION_SUBDIR?.trim();
const required = (process.env.PI_EXTENSION_SYNC_REQUIRED ?? "false").toLowerCase() === "true";
const targetDir = path.resolve(process.env.PI_EXTENSION_TARGET_DIR ?? ".pi/extensions/todo-reminders");

function runGit(args: string[], cwd?: string) {
  execFileSync("git", args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
}

function run(command: string, fn: () => void) {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${command} failed: ${message}`);
  }
}

function moveSubdirIntoTarget(subdir: string): void {
  const sourcePath = path.resolve(targetDir, subdir);
  if (!existsSync(sourcePath)) {
    throw new Error(`PI_EXTENSION_SUBDIR not found: ${sourcePath}`);
  }

  run(`git sparse-checkout set ${subdir}`, () => {
    runGit(["sparse-checkout", "init", "--cone"], targetDir);
    runGit(["sparse-checkout", "set", subdir], targetDir);
  });
}

function syncFromGit(): void {
  if (!sourceGitUrl) {
    console.log("[extension-sync] PI_EXTENSION_GIT_URL not set. Using bundled extension.");
    return;
  }

  mkdirSync(path.dirname(targetDir), { recursive: true });

  if (!existsSync(targetDir)) {
    console.log(`[extension-sync] cloning ${sourceGitUrl}#${sourceRef} -> ${targetDir}`);
    run("git clone", () => {
      runGit(["clone", "--depth", "1", "--branch", sourceRef, sourceGitUrl, targetDir]);
    });
  } else if (existsSync(path.join(targetDir, ".git"))) {
    console.log(`[extension-sync] updating ${targetDir} (${sourceRef})`);
    run("git fetch", () => {
      runGit(["fetch", "origin", sourceRef, "--depth", "1"], targetDir);
      runGit(["checkout", sourceRef], targetDir);
      runGit(["reset", "--hard", `origin/${sourceRef}`], targetDir);
    });
  } else {
    throw new Error(`Target dir exists but is not a git repository: ${targetDir}`);
  }

  if (sourceSubdir) {
    moveSubdirIntoTarget(sourceSubdir);
  }

  console.log("[extension-sync] extension sync complete.");
}

try {
  syncFromGit();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (required) {
    console.error(`[extension-sync] fatal: ${message}`);
    process.exit(1);
  }

  console.warn(`[extension-sync] warning: ${message}`);
  console.warn("[extension-sync] continuing with existing extension.");
}
