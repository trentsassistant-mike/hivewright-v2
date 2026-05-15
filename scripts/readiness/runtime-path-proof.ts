import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildRuntimePathProof, renderRuntimePathProofMarkdown } from "@/readiness/runtime-path-proof";

const proof = buildRuntimePathProof();
const outputDir = path.join(process.cwd(), "tmp", "readiness");
mkdirSync(outputDir, { recursive: true });
const outputPath = path.join(outputDir, "runtime-path-proof.md");
writeFileSync(outputPath, `${renderRuntimePathProofMarkdown(proof)}\n`);
console.log(outputPath);
if (proof.status !== "pass") process.exitCode = 1;
