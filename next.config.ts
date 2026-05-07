import type { NextConfig } from "next";
import path from "path";
import withSerwistInit from "@serwist/next";
import { settingsToSetupRedirects } from "./src/navigation/setup-redirects";

const withSerwist = withSerwistInit({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  disable: process.env.NODE_ENV !== "production",
});

const allowedDevOrigins = (process.env.HIVEWRIGHT_ALLOWED_DEV_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  redirects: async () => settingsToSetupRedirects,
  allowedDevOrigins,
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default withSerwist(nextConfig);
