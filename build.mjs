/**
 * Build dsh-point's two artifacts with esbuild (spike build, no typecheck):
 *
 * - lib/index.js  (ESM)  — node half, imported by the host Loader.
 * - lib/client.js (classic-script CJS wrapped in the __ModuleLoader__.load
 *   handoff) — browser half, served by dsh-client-modules at
 *   /plugins/dsh-point/client.js and materialized by the client module table.
 *
 * The client bundle must NOT inline react: it is a platform module (seeded into
 * the browser module table), so react resolves through the factory's require.
 */
import { build } from 'esbuild'

const ID = 'dsh-point'

// The browser module table's seed words (mirrors dsh's packages/client/web/src/platform.ts).
const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react', '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment', '@deepseek-ai/dsh-client-schema-form',
]

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  bundle: true,
})

await build({
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  bundle: true,
  external: CLIENT_EXTERNALS,
  sourcemap: true,
  // Wrap the CJS bundle in the registration handoff the client module table
  // expects: execute -> window.__ModuleLoader__.load({ id, factory }). The
  // banner opens the factory and defines the CJS module/exports the emitted
  // code relies on (the browser has no Node CJS wrapper); the footer returns
  // the exports and closes the load() handoff.
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;` },
  footer: { js: 'return module.exports; } });' },
})
