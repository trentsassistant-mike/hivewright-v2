import { spawnSync } from "node:child_process";

const pgrep = spawnSync("pgrep", ["-af", "tsx src/dispatcher/index.ts|dispatcher-bundle|npm run dispatcher"], { encoding: "utf8" });
const output = pgrep.stdout.trim();
const processLines = output
  ? output.split("\n").map((line) => {
    const [pid] = line.trim().split(/\s+/, 1);
    const kind = line.includes("dispatcher-bundle")
      ? "dispatcher-bundle"
      : line.includes("npm run dispatcher")
        ? "npm-run-dispatcher"
        : "tsx-dispatcher";
    return { pid, kind };
  })
  : [];
const dispatcherProcessDetected = processLines.length > 0;
console.log(JSON.stringify({
  dispatcherProcessDetected,
  processes: processLines,
  restartCommand: "npm run dispatcher",
  note: "For controlled-autonomy proof, restart only after confirming no approved external action is mid-flight.",
}, null, 2));
if (!dispatcherProcessDetected) process.exitCode = 1;
