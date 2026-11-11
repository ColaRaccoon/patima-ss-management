import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import { resolve } from "node:path";

const nextConfig = (phase: string): NextConfig => ({
  outputFileTracingRoot: resolve(__dirname, "../.."),
  distDir: process.env.NEXT_DIST_DIR ?? (phase === PHASE_DEVELOPMENT_SERVER ? ".next-dev" : ".next"),
  transpilePackages: ["@patima/shared"],
});

export default nextConfig;
