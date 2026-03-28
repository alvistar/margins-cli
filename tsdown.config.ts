import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  clean: true,
  dts: false,
  minify: false,
  outDir: 'dist',
  banner: {
    js: '#!/usr/bin/env node',
  },
})
