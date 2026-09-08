# Native Desktop packaging comparison

Reference: `anywhere-labs/deepseek-harness-desktop@6074088f5b660206e404b3591fab51fb99c69add`, inspected from the fixed Git object against e-Mate `fec07909`.

Windows retains the upstream package-win command sequence, host checks and assisted NSIS packaging; differences are workspace identity and log wording. Mac uses the upstream unsigned package-mac path for the explicitly unsigned product. Both retain native electron-builder and platform verifiers. Product Profile, Python and Calc use its files/extraResources configuration. This review does not claim installed or update acceptance.

Found and restored an omitted upstream safeguard: `verifyUnpackedArchiveMirror`. Every ASAR header entry must have a physical counterpart under app.asar.unpacked before package export resolution. A regression exercises the complete verifier with a missing transitive yaml file outside the curated required-entry list. The 51 packaged-runtime tests pass after restoration; the separate Profile fixture correction passed all 16 tests on macOS. Windows fixture acceptance remains pending native Remote availability.

Existing product-specific Vision, Calc and PTY checks stay in the same afterPack hook. Calc metadata preservation retains original hashes after Electron universal processing. The temporary private diagnostics Worker only transports receipts and never packages or publishes the app.

The restored verifier rejected the real ff4062 universal bundle: `base-contract.json` was present in ASAR but absent from app.asar.unpacked. Added that product contract to electron-builder's existing asarUnpack list. The old bundle is diagnostic evidence only; a new native package must prove physical inclusion. Full Desktop check at 1ed415a7 passed (487 tests, 4 platform skips); it preceded this package configuration correction.
