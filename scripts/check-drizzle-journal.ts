import fs from "node:fs";
import path from "node:path";

const migrationsDir = path.resolve(process.cwd(), "drizzle");
const journalPath = path.join(migrationsDir, "meta", "_journal.json");

type JournalEntry = {
  tag?: unknown;
};

type Journal = {
  entries?: unknown;
};

function uniqueDuplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }

  return [...duplicates].sort();
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.map((value) => `  - ${value}`).join("\n") : "  - none";
}

function main() {
  const migrationStems = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => path.basename(entry.name, ".sql"))
    .sort();

  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as Journal;
  if (!Array.isArray(journal.entries)) {
    throw new Error(`${journalPath} must contain an entries array`);
  }

  const invalidEntryIndexes: number[] = [];
  const journalTags = (journal.entries as JournalEntry[]).flatMap((entry, index) => {
    if (typeof entry.tag !== "string" || entry.tag.length === 0) {
      invalidEntryIndexes.push(index);
      return [];
    }
    return [entry.tag];
  });

  const migrationStemSet = new Set(migrationStems);
  const journalTagSet = new Set(journalTags);
  const missingJournalEntries = migrationStems.filter((stem) => !journalTagSet.has(stem));
  const extraJournalEntries = journalTags.filter((tag) => !migrationStemSet.has(tag));
  const duplicateMigrationStems = uniqueDuplicates(migrationStems);
  const duplicateJournalTags = uniqueDuplicates(journalTags);
  const firstOrderMismatchIndex = migrationStems.findIndex((stem, index) => stem !== journalTags[index]);

  const hasDrift =
    invalidEntryIndexes.length > 0 ||
    migrationStems.length !== journalTags.length ||
    missingJournalEntries.length > 0 ||
    extraJournalEntries.length > 0 ||
    duplicateMigrationStems.length > 0 ||
    duplicateJournalTags.length > 0 ||
    firstOrderMismatchIndex !== -1;

  if (!hasDrift) {
    console.log(
      `[check-drizzle-journal] ok: ${migrationStems.length} migration files match ${journalTags.length} journal entries`,
    );
    return;
  }

  console.error("[check-drizzle-journal] Drizzle migration journal drift detected.");
  console.error(`Migration SQL files: ${migrationStems.length}`);
  console.error(`Journal entries: ${journalTags.length}`);

  if (invalidEntryIndexes.length > 0) {
    console.error(`Invalid journal entry indexes: ${invalidEntryIndexes.join(", ")}`);
  }

  if (duplicateMigrationStems.length > 0) {
    console.error("Duplicate migration stems:");
    console.error(formatList(duplicateMigrationStems));
  }

  if (duplicateJournalTags.length > 0) {
    console.error("Duplicate journal tags:");
    console.error(formatList(duplicateJournalTags));
  }

  if (missingJournalEntries.length > 0) {
    console.error("Migration files missing from journal:");
    console.error(formatList(missingJournalEntries));
  }

  if (extraJournalEntries.length > 0) {
    console.error("Journal entries without migration files:");
    console.error(formatList(extraJournalEntries));
  }

  if (firstOrderMismatchIndex !== -1) {
    console.error(
      `First order mismatch at index ${firstOrderMismatchIndex}: file=${migrationStems[firstOrderMismatchIndex] ?? "<none>"} journal=${journalTags[firstOrderMismatchIndex] ?? "<none>"}`,
    );
  }

  process.exitCode = 1;
}

main();
