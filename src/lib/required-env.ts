export function requireEnv(
  key: string,
  env: { [key: string]: string | undefined } = process.env,
): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(
      `Missing required environment variable ${key}. Copy .env.example to .env and set ${key}.`,
    );
  }
  return value;
}
