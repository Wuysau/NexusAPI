import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
export const serviceNames = ['worker', 'budget']

/** Bundle local TypeScript and aliases; runtime dependencies remain npm packages. */
export async function buildServices(names = serviceNames, outdir = resolve(root, 'dist')) {
  if (!names.length || names.some((name) => ![...serviceNames, 'observer'].includes(name))) {
    throw new Error('Expected worker, budget, observer, or all')
  }
  return build({
    absWorkingDir: root,
    entryPoints: Object.fromEntries(names.map((name) => [name, `services/${name}/index.ts`])),
    outdir,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    packages: 'external',
    tsconfig: resolve(root, 'tsconfig.json'),
    logLevel: 'info',
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const selected = process.argv.slice(2)
  await buildServices(
    selected.length === 0 || (selected.length === 1 && selected[0] === 'all') ? serviceNames : selected,
  )
}
