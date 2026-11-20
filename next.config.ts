import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // CSV imports are posted to a server action; a few years of history is a few hundred KB
  experimental: { serverActions: { bodySizeLimit: "5mb" } },
  // the local /skynet page reads data/backtests at request time; never trace data/ (licensed market data, gigabytes)
  outputFileTracingExcludes: { "/*": ["data/**/*"] },
};

export default nextConfig;
