import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// The pinned harness packages keep their build-time deps as devDependencies, so a
// Node-resolved test run cannot see them while the renderer bundle can. Inline the
// one such package and map its bare imports to the pinned harness copy, instead of
// changing dependency pins or the lockfile.
const harnessModules = resolve(import.meta.dirname, '../../upstream/deepseek-harness/node_modules/.pnpm')
const zustand = resolve(harnessModules, 'zustand@4.4.7_@types+react@18.3.31_immer@10.2.0_react@18.3.1/node_modules/zustand')

export default defineConfig({
  resolve: {
    alias: [
      { find: /^zustand$/, replacement: resolve(zustand, 'index.js') },
      { find: /^zustand\/(.*)$/, replacement: resolve(zustand, '$1') },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    server: { deps: { inline: [/@deepseek-ai\/dsh-client-store/u] } },
  },
})
