/**
 * Build the dsh-point browser extension (MV3) into extension/dist/.
 */
import { build } from 'esbuild'

const OUTDIR = 'extension/dist'

await build({
  entryPoints: ['extension/src/background.ts'],
  outfile: `${OUTDIR}/background.js`,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  bundle: true,
})

await build({
  entryPoints: ['extension/src/content.ts'],
  outfile: `${OUTDIR}/content.js`,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  bundle: true,
})

await build({
  entryPoints: ['extension/src/sidepanel.ts'],
  outfile: `${OUTDIR}/sidepanel.js`,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  bundle: true,
})

await build({
  entryPoints: ['extension/src/options.ts'],
  outfile: `${OUTDIR}/options.js`,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  bundle: true,
})

console.log('extension build done')
