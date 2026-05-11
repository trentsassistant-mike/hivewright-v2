import type { NextConfig } from "next";
import path from "path";
import withSerwistInit from "@serwist/next";
import { settingsToSetupRedirects } from "./src/navigation/setup-redirects";

function allowedDevOrigins(): string[] {
  const configured = process.env.HIVEWRIGHT_ALLOWED_DEV_ORIGINS
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean) ?? [];

  return ["localhost", "127.0.0.1", "100.72.184.71", ...configured];
}

const withSerwist = withSerwistInit({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  disable: process.env.NODE_ENV !== "production",
});

const nextConfig: NextConfig = {
  redirects: async () => settingsToSetupRedirects,
  allowedDevOrigins: allowedDevOrigins(),
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default withSerwist(nextConfig);
