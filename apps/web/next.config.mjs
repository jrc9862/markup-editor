import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@markup/sync-core'],
  // Self-contained production server (apps/web/Dockerfile runs the traced
  // output with plain `node`). Tracing root = repo root so the monorepo
  // workspace symlinks resolve.
  output: 'standalone',
  experimental: {
    outputFileTracingRoot: path.join(__dirname, '../../'),
  },
};

export default nextConfig;
