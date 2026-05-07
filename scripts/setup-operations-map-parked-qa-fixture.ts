import "dotenv/config";
import postgres from "postgres";
import {
  cleanupOperationsMapParkedQaFixture,
  createOperationsMapParkedQaFixture,
} from "../src/quality/operations-map-qa-fixture";
import { requireEnv } from "../src/lib/required-env";

const DATABASE_URL = requireEnv("DATABASE_URL");

async function main() {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    if (process.argv.includes("--cleanup")) {
      await cleanupOperationsMapParkedQaFixture(sql);
      console.log(JSON.stringify({ ok: true, cleaned: true }, null, 2));
      return;
    }

    const fixture = await createOperationsMapParkedQaFixture(sql);
    console.log(
      JSON.stringify(
        {
          ok: true,
          fixture,
          manualVerification: [
            "Start the app and sign in as the local owner.",
            "Open / and select the Operations Map Parked QA hive in the hive switcher.",
            "Confirm the Operations Map source pills show 1 critical item.",
            "Confirm the Critical lane lists Operations Map manual QA parked task with the Parked state.",
            "Run this script again with --cleanup when verification is finished.",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
