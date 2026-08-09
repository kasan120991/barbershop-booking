import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  // @francis/shared ships TypeScript source, so it must be bundled rather than
  // left as a bare import Node cannot resolve at runtime.
  noExternal: ['@francis/shared'],
});
