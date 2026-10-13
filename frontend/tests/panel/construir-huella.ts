import { resolve, join } from 'node:path'
import { build } from 'vite'

const root = resolve(process.argv[2])
await build({
  root, configFile: join(root, 'vite.config.ts'), envDir: join(root, 'sin-env'),
  build: { outDir: join(root, 'dist') },
})
