import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import postgres from "postgres";
import { verifyCredentials, countUsers } from "./auth/users";
import { authConfig } from "./auth.config";
import { resolveBootstrapDashboardPassword } from "./auth/defaults";

// Dedicated SQL handle so auth.ts doesn't depend on the shared API-layer pool.
// NextAuth runs before request handlers, so using the singleton here could
// deadlock during cold start.
function db() {
  return postgres(
    process.env.DATABASE_URL ||
      "postgresql://hivewright@localhost:5432/hivewrightv2",
    { max: 2 },
  );
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      name: "Email + password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const sql = db();
        try {
          const email = (credentials?.email as string | undefined) ?? "";
          const password = (credentials?.password as string | undefined) ?? "";

          // Development-only bootstrap path for local first-run setup.
          // Outside development, an explicit DASHBOARD_PASSWORD is required.
          const users = await countUsers(sql);
          if (users === 0) {
            const fallback = resolveBootstrapDashboardPassword();
            if (password === fallback) {
              return {
                id: "owner-bootstrap",
                name: "Owner (bootstrap)",
                email: "owner@hivewright.local",
              };
            }
            return null;
          }

          if (!email || !password) return null;
          const user = await verifyCredentials(sql, email, password);
          if (!user) return null;
          return {
            id: user.id,
            name: user.displayName ?? user.email,
            email: user.email,
          };
        } finally {
          await sql.end({ timeout: 1 });
        }
      },
    }),
  ],
});
