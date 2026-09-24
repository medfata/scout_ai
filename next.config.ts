import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["postgres"],
  typedRoutes: true,
  experimental: {
    // Server Actions are the only mutation path from the UI (section 4).
    serverActions: {
      bodySizeLimit: "1mb",
    },
  },
};

export default withWorkflow(nextConfig);
