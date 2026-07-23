import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // The supplied-image action enforces a 5 MiB file cap before decode. The
    // small envelope accounts for multipart/RSC framing while keeping
    // Next's global request-parser ceiling close to the 5 MiB product limit.
    // The image action rejects the file itself at 5 MiB before Sharp runs.
    serverActions: { bodySizeLimit: "8mb" },
  },
};

export default nextConfig;
