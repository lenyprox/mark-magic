import type { NextConfig } from 'next';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd(), '..', '..');
const envFile = path.join(root, '.env.local');
if (fs.existsSync(envFile)) {
  try { process.loadEnvFile(envFile); } catch { /* older node */ }
}
process.env.MTG_ROOT ??= root;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['better-sqlite3'],
  outputFileTracingRoot: root,
  turbopack: { root },
  experimental: { externalDir: true },
  typescript: { tsconfigPath: './tsconfig.json', ignoreBuildErrors: true },
  // The engine (src/**) uses Node-ESM style './x.js' imports for .ts files; webpack needs the extension alias.
  webpack: (config) => {
    config.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'], '.mjs': ['.mts', '.mjs'] };
    // src/** lives outside apps/web; webpack would otherwise snapshot it as immutable and never rebuild on change.
    config.snapshot = { ...config.snapshot, managedPaths: [/[\/]node_modules[\/]/], immutablePaths: [] };
    return config;
  },
  agentRules: false,
};

export default nextConfig;
