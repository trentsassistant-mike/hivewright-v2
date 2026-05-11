import postgres from "postgres";
import {
  assertLocalOwnerSessionResetAllowed,
  DEFAULT_LOCAL_OWNER_DISPLAY_NAME,
  DEFAULT_LOCAL_OWNER_EMAIL,
  seedLocalOwnerSession,
} from "../src/auth/local-owner-session";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://hivewright@localhost:5432/hivewrightv2";

async function main() {
  assertLocalOwnerSessionResetAllowed(DATABASE_URL);

  const email = process.env.OWNER_EMAIL?.trim() || DEFAULT_LOCAL_OWNER_EMAIL;
  const password = process.env.OWNER_PASSWORD?.trim();
  const displayName =
    process.env.OWNER_DISPLAY_NAME?.trim() || DEFAULT_LOCAL_OWNER_DISPLAY_NAME;

  if (!password) {
    throw new Error("OWNER_PASSWORD is required.");
  }

  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const result = await seedLocalOwnerSession(sql, {
      email,
      password,
      displayName,
    });
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: result.mode,
          user: result.user,
          databaseUrl: DATABASE_URL,
        },
        null,
        2,
      ),
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
