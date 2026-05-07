import fs from "fs";
import path from "path";

export function defaultEnvFilePath(): string {
  return path.join(process.cwd(), ".env");
}

function quoteEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

export function upsertEnvFileValue(
  key: string,
  value: string,
  envFilePath = defaultEnvFilePath(),
): { envFilePath: string; updated: boolean } {
  const line = `${key}=${quoteEnvValue(value)}`;
  const existing = fs.existsSync(envFilePath)
    ? fs.readFileSync(envFilePath, "utf-8")
    : "";
  const lines = existing.split(/\r?\n/);
  let updated = false;
  const nextLines = lines.map((current) => {
    if (current.match(new RegExp(`^\\s*${key}\\s*=`))) {
      updated = true;
      return line;
    }
    return current;
  });

  if (!updated) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== "") {
      nextLines.push("");
    }
    nextLines.push(line);
  }

  fs.writeFileSync(envFilePath, `${nextLines.join("\n").replace(/\n+$/, "")}\n`, "utf-8");
  return { envFilePath, updated };
}
