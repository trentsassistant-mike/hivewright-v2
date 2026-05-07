export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") {
    return;
  }

  const { assertDashboardStartupMigrations } = await import("./dashboard/startup");

  try {
    await assertDashboardStartupMigrations();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    throw err;
  }
}
