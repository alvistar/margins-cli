import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  clean: true,
  dts: false,
  minify: false,
  outDir: 'dist',
  // Hermetic bundle: every runtime dependency is compiled into dist so the
  // published package declares zero `dependencies`. This is load-bearing for
  // the supply-chain story — `npx -y margins-cli@<exact>` must perform no
  // additional dependency resolution (caret-ranged deps would otherwise be
  // re-resolved from the registry on every consumer run). All runtime deps
  // live in devDependencies; node: builtins stay external via platform: node.
  // `npm run check:dist` must run at release to verify the bundle is current.
  noExternal: [
    '@clack/prompts',
    '@commander-js/extra-typings',
    'commander',
    'conf',
    'oauth4webapi',
    'open',
  ],
  banner: {
    js: '#!/usr/bin/env node',
  },
})
