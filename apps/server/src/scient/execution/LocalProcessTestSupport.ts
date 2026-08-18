// @effect-diagnostics nodeBuiltinImport:off -- process-tree fixtures probe captured child PIDs.
import * as NodeProcess from "node:process";

export function processExists(pid: number): boolean {
  try {
    NodeProcess.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

/** Spawns a descendant, reports its PID, and keeps the supervisor alive. */
export const descendantFixture = [
  "const { spawn } = require('node:child_process');",
  "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
  "process.stdout.write(String(child.pid) + '\\n');",
  "setInterval(() => {}, 1000);",
].join("\n");
