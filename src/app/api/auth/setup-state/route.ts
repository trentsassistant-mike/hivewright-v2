import { sql } from "../../_lib/db";
import { jsonOk } from "../../_lib/responses";
import { countUsers } from "@/auth/users";

export async function GET() {
  const count = await countUsers(sql);
  return jsonOk({ needsSetup: count === 0, userCount: count });
}
