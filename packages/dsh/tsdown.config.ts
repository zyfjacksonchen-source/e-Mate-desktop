const node = {
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}

export default [
  {
    ...node,
    entry: {
      bin: 'src/bin.ts',
      'e-mate': 'src/e-mate.ts',
      'legacy-migration': 'src/legacy-migration.ts',
      'legacy-schedule': 'src/legacy-schedule.ts',
    },
    outDir: 'lib',
  },
  {
    ...node,
    noExternal: ['qrcode'],
    entry: {
      health: 'src/profile/health.ts',
      'agent-operations': 'src/profile/agent-operations.ts',
      'artifact-open-boundary': 'src/profile/artifact-open-boundary.ts',
      capabilities: 'src/profile/capabilities.ts',
      'credentials-os': 'src/profile/credentials-os.ts',
      'general-workspace': 'src/profile/general-workspace.ts',
      'settings-document-boundary': 'src/profile/settings-document-boundary.ts',
      share: 'src/profile/share.ts',
    },
    outDir: 'profile/plugins',
  },
  {
    ...node,
    noExternal: ['qrcode'],
    entry: { 'qr-generation': 'src/profile/qr-generation.ts' },
    outDir: 'profile/plugins',
  },
  {
    ...node,
    entry: { 'image-history': 'src/profile/image-history.ts' },
    outDir: 'profile/plugins',
  },
  {
    ...node,
    entry: { 'model-policy': 'src/profile/model-policy.ts' },
    outDir: 'profile/plugins',
  },
  {
    ...node,
    entry: { audit: 'src/profile/audit.ts' },
    outDir: 'profile/plugins',
  },
  {
    ...node,
    entry: { 'legacy-migration': 'src/profile/legacy-migration.ts' },
    outDir: 'profile/plugins',
  },
  {
    ...node,
    entry: { 'schedule-import': 'src/profile/schedule-import.ts' },
    outDir: 'profile/plugins',
  },
  {
    ...node,
    entry: {
      index: 'src/profile/identity/index.ts',
      agreements: 'src/profile/identity/agreements.ts',
    },
    outDir: 'profile/plugins/identity',
  },
]
