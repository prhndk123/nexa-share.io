import { mkdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('.', import.meta.url));
const output = join(root, 'dist');
if (relative(root, output) !== 'dist') {
  throw new Error('Build output must be the API dist directory.');
}

// Remove old tsc output so Vercel cannot select the stale app.js entrypoint.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

// Bundle workspace code and npm dependencies: Vercel may relocate dist to
// the function root, where source files and workspace symlinks are unavailable.
await build({
  absWorkingDir: root,
  entryPoints: ['src/app.ts'],
  outfile: join(output, 'app.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
});
