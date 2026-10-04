import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // CSV imports are posted to a server action; a few years of history is a few hundred KB
  experimental: { serverActions: { bodySizeLimit: "5mb" } },
};

export default nextConfig;
