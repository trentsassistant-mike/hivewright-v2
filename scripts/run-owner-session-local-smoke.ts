import {
  getOwnerSessionSmokeConfig,
  runOwnerSessionLocalSmoke,
  serializeOwnerSessionSmokeError,
} from "../src/auth/owner-session-smoke";

async function main() {
  const config = getOwnerSessionSmokeConfig();
  const result = await runOwnerSessionLocalSmoke(config);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify(serializeOwnerSessionSmokeError(error), null, 2));
  process.exit(1);
});
