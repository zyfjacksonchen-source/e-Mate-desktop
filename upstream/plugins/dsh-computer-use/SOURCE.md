# Vendored: dsh-computer-use

Third-party source copy, vendored by e-Mate following the same spirit as
`upstream/deepseek-harness/vendor/README.md`: the copied tree is auditable and
pinned, divergence from upstream is logged here, and every file hash is recorded
so a later sync can prove what changed.

## Provenance

| Field | Value |
|---|---|
| npm / package name | `@anionex/dsh-computer-use` |
| Version | `0.1.0` |
| Repository | https://github.com/Anionex/dsh-computer-use |
| Commit | `5863c14d053f584dc2e118352beefcf7906122fa` |
| Commit subject / date | `0.1.5 compat: replace the removed settingsNamespace() with the plain namespace string` — 2026-09-11T13:32:01+08:00 |
| Commit author | e-Mate migration |
| Upstream commit it sits on | 76bfe8607f61945c1cbb84e73976e601100c13a2 — `release: publish @anionex/dsh-computer-use (#4)` |
| License | MIT License — Copyright (c) 2026 anionex (`LICENSE` in this directory) |
| Vendored by | e-Mate 2.0.18 (`docs/2.0.18/submodule-vendoring.md`) |

The vendored tree contains **tracked upstream content only**: no `.git`, no
`.gitignore`-hidden build output and no `node_modules`. The file set and the file
modes (`100644` / `100755`) match the pinned commit exactly, and every byte does
except the two files listed under [Local modifications](#local-modifications-vs-upstream)
below; the sha256 inventory at the end of this file is the proof.

## Why it is vendored rather than depended on

The pinned commit is an **e-Mate commit** that does not exist on the third-party
upstream: `git for-each-ref --contains 5863c14d refs/remotes` inside the former
submodule returns **0 refs**, so a fresh clone cannot materialise this tree and the
root build stops at the first empty one. Carrying the pinned content as ordinary
files is what makes a fresh clone buildable with no manual file transfer.

## Consumers in this repository

- `packages/dsh-plugin-computer-use/scripts/build.mjs:7` resolves this tree and copies `lib/`,
  `assets/` and `scripts/build-native.mjs` out of it; the `lib/` copy is the first thing the
  root build touches, and an empty tree fails with `ENOENT …/upstream/plugins/dsh-computer-use/lib`.
- `packages/dsh-plugin-computer-use/src/windows.ts:8-11` imports this tree's
  `src/{backend,config,types,errors}.ts` as build-time types and the running
  `ComputerUseError`.
- `packages/dsh-plugin-computer-use/test/windows-source.test.mjs:262,358` and
  `test/contract.test.mjs:22` read `src/{service,leases,confirmations}.ts` and
  `lib/{skill,leases}.js` from it.

## Local modifications vs upstream

One 0.1.5-compatibility change, in two files. Every other file is the pinned
revision verbatim, taken from the submodule working tree that was already
materialised at that commit and copied unchanged.

| File:line | Change |
|---|---|
| `src/leases.ts:188` | `currentTurn(agent.session.events)` → `currentTurn(agent.session.snapshotEvents())` |
| `lib/leases.js:135` | the same seam, kept textually consistent with the source |

Reason: 0.1.5-rc.1 replaced the Session event list with the snapshot accessors. A
real `Session` has **no `events` member** — only `snapshotEvents(fromSeq, toSeqExclusive)`
(the full log, the faithful replacement for the accessor the pinned revision was
written against) and `ownEvents()` (child-owned events only) — so
`currentTurn(agent.session.events)` threw `TypeError: Cannot read properties of
undefined (reading 'length')` on the first interactive read or control lease
request, instead of raising the intended `COMPUTER_PERMISSION_REQUIRED`.

This seam lives here rather than in `packages/dsh-plugin-computer-use/scripts/build.mjs`
because `test/contract.test.mjs:82` asserts the shipped `lib/leases.js` is
byte-identical to this file: the guard is what proves e-Mate ships the pinned
owner's lease manager, so a build-time rewrite of the shipped copy would fail it.
This tree is already an e-Mate 0.1.5-compat branch (see Provenance), which is
where the pinned revision's earlier 0.1.5 fix also lives. The e-Mate adapter no
longer rewrites this file; `lib/leases.js.map` embeds no source text and is
unchanged. The vendored tree's own `pnpm run build` was not used to produce the
artifact — it also rebuilds `native/macos/bin` and `native/macos/manifest.json`,
which this repository pins by hash — so `lib/leases.js` is kept hand-consistent
with `src/leases.ts`.

## File inventory (sha256 of the vendored content)

```
e5116a9a38e3cc047a953100be440a47c856cbba402615eb0ffd6b1383c06311  .github/FUNDING.yml
c9a5b957bf79c70eb818f6e2326e38ec1da1fca6e3443cce5c47706dad241221  .github/ISSUE_TEMPLATE/bug.yml
8b09e7df09fc7534371988062769ee427af2954a02c04c763e8a8005be0f2be4  .github/ISSUE_TEMPLATE/config.yml
e0829b50d2ef842d8720225a162391478b9aaac2b59154ffa839ca3b3ca2885a  .github/ISSUE_TEMPLATE/feature.yml
1a12f406a6ba11eba030a0a94e73615a489c5f9a9051f2cad43bd817d90c4da9  .github/ISSUE_TEMPLATE/question.yml
230ea2369afe415758ebc2583b8f73d80e4b9557a1f747313e259452d6bc429a  .github/PULL_REQUEST_TEMPLATE.md
d61b9475e9707b9b91da5e99676d80c1fcb0c76c2a35150eac31b65d178d4e5f  .gitignore
65a87ce9da6426a73cf912d6d66e3f5dd878540594664527b6af4f10c6b1d4fe  AGENTS.md
c686c20b9c6419eaa2dd706a0aaffd2d5b5fa2e4d093d3db09ce1b0709f6ee28  CHANGELOG.md
29a14227c2f5fc11b0a3b6b5e9a2e4f18b4b85a5726a2528b8ba6fb6ba756909  CODE_OF_CONDUCT.md
c1564642cb97ea340ae236fe872987ac2edd2d44ebf40a85c635f9d9d9e50837  CONTRIBUTING.md
dd91fd0130d4e5b77796883e9cd6f349887e48fc5680655c69acafa7ba7f8dba  FUNDING.md
ab087dd49725c21f8207f6442045c938478d0bbee2fdc68eab9ca64671475f12  LICENSE
7e9f9dc766aacea3a0db9f4c652afc33c0af1602d1e9fa1659b24e5a3cab3bcb  README.i18n.yaml
492a187300e6f3c0683987087be71cf8371be4b4e00e644900d0c63791a53abc  README.md
6674e8556ee15efc602c10397fb63af2ed1b5abdd68c7ce9b13208c6e2e46a32  README.zh.md
1502f118318e070d8b369a9f680c12a27bc22844abe4f9c241b2c0e21ab4c027  SECURITY.md
ffe980d2b8ac491f22a70a6207a147f6b468bf3c1e83279292aac14974e04fbe  SUPPORT.md
0165eaead0566d43bcffe07ffdcb9f3de5c635720a044e279476738ff4b38ae6  assets/computer-use-fixture.png
5cf9edf354d2b47abec2862365f68c39929936298f0cb97f43acaf2b4c9e355f  assets/cursor.png
f25162c72c7dea20c0e1c40397dbadb4fa1f1297a01df59cf71e143477ad3608  cordis.patch.yml
1affa922e4a8131a914203a2932cedf8c5d3f555106d28d6ce80b0baf89f23e4  docs/interaction-policy.i18n.yaml
feb7665cfc0803b33e2d07de889bb1d8f4833b09a496ab2d6e40ca1d5b1fa112  docs/interaction-policy.md
3dfee36a0b528d1ac2c546fde080b34960b65c598ac2ecda8e819d2ebca9ce95  docs/interaction-policy.zh.md
ef0c54fb3ac1eb5a097b500899b21af5ba6799b1b21c84199ba9ebf9be4faf79  lib/approval-policy.js
e1cfae947b61f7f3b8be40f7ebce9447e0fea3db2f100312640b6f98bdc6a8d6  lib/approval-policy.js.map
26d7142af07ed773ecc71f97552d6617697eda8d73b2164d819056259681be37  lib/artifacts.js
3548ebd75312ebfd1452a23cc24d08565b35663cc4256ba1c4b893e9db26d58d  lib/artifacts.js.map
0242f2dd6eaef7a75836294dd7bf722e731c6ea147baf880c81c7892bd77e620  lib/backend.js
1141f98093d1688d2f1dc7a2006b2ef22590bd67cbafea5d67879816dc326421  lib/backend.js.map
749bccea6a9ea39f7b02d30123fa0bb2178c3ea2c3ac8a1183b4b477ae44a606  lib/client.js
4bcf46a5b6f5bc80925a32ccb6e879837167b66d2270bb52c7f14046e7d18784  lib/client.js.map
30aba03dde8d6a0b93a6039290004b0efbb5eb2fde27aefb240b792b71633e92  lib/config.js
3851c7eca9b707f5d53fd96fd49411384c5dcddf932118536c8d9e6a31e13a86  lib/config.js.map
c11e00f3041c46e8130e3f2bcbba8f0293014f0b223cc2e2f006c6a779314477  lib/confirmations.js
e917d199fe6e8c75b2401f9aba6379dbe87687ba4640126c0eec76280d3b33e6  lib/confirmations.js.map
c2824ff3f537708e96e50bc26f859b442ba49088af948fd2671024494a789294  lib/diff.js
8ab60a9ea2cfae065c5d25c506817197a87b9699e743d25891a6da5e07b0fcb2  lib/diff.js.map
630547212a9e2571eb0c797476a6cbb0e8d8137c6f5cd7cc462d070455f23229  lib/errors.js
37aca2500dc8785601baa9192ae042f5f573e99293ddfcbf44887f2c10978daa  lib/errors.js.map
cda76d620781a18ac7b7930f1607a4ce8bb12738d5d3a93d94ee480892631b35  lib/exposure.js
59be80c51a275a856093251df04c7ddb16267e502aaf83cc4db2e27d9b8b29de  lib/exposure.js.map
cbd94104fe5337e6219be266f2931f7b4d44ed2fd8883b409a6c59008f0b39d4  lib/index.js
a95bf53f43bfd88d740ef2b05fbbf0a2974188d5b1cbafd1f94f8e0d3fe7c0ba  lib/index.js.map
53bc9892b7c8121d7a7aab9d71808c33dcbd2b255a39c70df130e5c7e8942ae8  lib/leases.js
f30a08862fcb750e13f87caadf8e1eb69377103cb5f03fef1084baf1a09110e4  lib/leases.js.map
2e7a57012f70b874a943d9e06dde40c913b5f05fed2512aadb6e2024ab86610a  lib/providers/macos.js
70abcf7101ea1ee77660db8232d6456e13d24e90d9f739b43be4f21b0b29063c  lib/providers/macos.js.map
a6222b791aab30d65bef973a0f9c0b64b4c5e7157d4127c7f4748f646a39a852  lib/providers/native-helper.js
30c687b71d2c03bd3e45a7006ce26604725b57491a70315a6ee820fbfa3fc452  lib/providers/native-helper.js.map
bab6959f92b35db980e780bcdba07574ebe31e1cec6eef4319b23bc92b51a7c6  lib/service.js
cd9aaf4455387d73d6432c37dc5b10ef5972015f5a5392f107ddec343414dc39  lib/service.js.map
7d36d82628edeee12010b6f536098c0d80920152699249e0f791f4bbda91fc95  lib/skill.js
92c1649ab419458411af9804455f5a21c4d4eaa34614bde3ece0f072a5e4e083  lib/skill.js.map
e61c125a8382a847179cfb1301ea688b1cf477dee63683f8e12b74e1b41a5255  lib/target-resolver.js
16016b02095975db45475186094666314e7b1713905dbd18579503746ee2ed8e  lib/target-resolver.js.map
c6cc6fdada5b2576e2358d10656a61df90ced937ee2f78f8432333553472b489  lib/tools.js
e1a7351ac8fd0e1b3b43fb607421641391c21367399aeba1fc2fdda17460256b  lib/tools.js.map
ba60a54b3721f3fdc07aa4db96ca07a555ddfcf0bf6b109cb4f7013ab40eb5b5  lib/types.js
e33a843253ca1986aaf035468409451a176baf29d3d96d0765000f5f65496fad  lib/types.js.map
0df091663a6ea9cc19fad27f80c41470174b52d3b3484fade6cd1e6937052854  lib/types/approval-policy.d.ts
cd77258b770a69e9e2462603ae6e8db8fc0c70e45a709d47cca122ea0059dedb  lib/types/approval-policy.d.ts.map
49ab1f5a599fd26c01a63e4cb690b61d3d2995fcb1b188a1b22c24e123d4a610  lib/types/artifacts.d.ts
5939fb0b3b0740d79538d6439ab8e14a873ca6736e6f78b4c752f6778846fde4  lib/types/artifacts.d.ts.map
1db5335d06b6001ec74394e93d40eb85701d040c0c54af53db880b7267aa2c00  lib/types/backend.d.ts
a9368e4e1ff679a054f6993db03d40aaea89be96561668f704b280cd56b3618b  lib/types/backend.d.ts.map
9549144a26156ae48b222eacb6fb0b905014c44be0e02db6849f3cd27c6e4e12  lib/types/client/index.d.ts
64b51e635e85f0f43aa515a822bbc38ac2cbce1420560b2816c483aef017f2cf  lib/types/client/index.d.ts.map
c60a7e05a7d068329657d8e910c6e11bb49714b3817e5d2b50f982218a24556a  lib/types/config.d.ts
8dcb378baf3785ee82b73919be5d41cbb85a188ff3466e4af5589b1dc3025b80  lib/types/config.d.ts.map
238299df1d56a03cb64539d039b3b2cf7e75be24f30b2cffdb7d22b1a3f1dbbd  lib/types/confirmations.d.ts
a6686d52783eb28072df32e601d0ca38eb17a9a07df3a0a54eb112f9dccc6d13  lib/types/confirmations.d.ts.map
c92e6fd06746ac8220152c318bf634613d764e765991c7d55150fc1c4b0c7aa0  lib/types/diff.d.ts
acb0d242ad397aa37e1133dbf717c098e3f643320b5d639f43943325302f7abb  lib/types/diff.d.ts.map
508af397fa0da1663f3fd17b8df8d6f48f344d3260b5ebc760329b418defee7b  lib/types/errors.d.ts
a4ddcad8d2b1cd2dadba571f434543603776cf75bd9833c3f8f6cb6ea82fd76a  lib/types/errors.d.ts.map
d746f4374c9970369734108437f625ef6334353f588562cb3d2c7a035669273a  lib/types/exposure.d.ts
fcc94d738eb82200c718a06a12c3b3987e6fc695ff1b067e30021bbe7d0e71af  lib/types/exposure.d.ts.map
00d9127054a48add99b17aa0f5bf5d06ec4697b0fc7e0cbc9be2ce13202c5228  lib/types/index.d.ts
8bd7bfac0bec4feaa20296d447688b4e150b002388b26959a216e827e82356b5  lib/types/index.d.ts.map
3a551afe665a19e7acaa47a6fe9b71ea16019e7c4cfbff58217b58a5dde73959  lib/types/leases.d.ts
4236e0154c89edbca863fd51eb6874d389d8d0e498e951a21a0165beaa569a84  lib/types/leases.d.ts.map
d75384494a9159f293ac9eba6cf48025f12d93666ab4ba696ca4fce5315184f3  lib/types/providers/macos.d.ts
f50be07aeab17d12a32d91141381dec79d16088b74a6dc9768cc553d2d18a508  lib/types/providers/macos.d.ts.map
2b7fdb518b76fc34911d4f3b2680f076eb1b20c10e7c072f613ccc2beedda0cf  lib/types/providers/native-helper.d.ts
49259ea4edf4cb32e118d457833a3c726f995da9e42cbc0976504f6edc0241e0  lib/types/providers/native-helper.d.ts.map
d0a7e58ab60213e7186ce2d1fdbd0a80e6a1887c503d19991b14b91f1f181c5f  lib/types/service.d.ts
a43c62ed11c627806c83cdcc43b37599285ee2924a99bfd9b91d5d67c43ea402  lib/types/service.d.ts.map
eaea54389517cb06a2178da3ae175879210c2aedf41820b0d408857eb217b714  lib/types/skill.d.ts
8ba030b355eaa59553ee29665a690a22204b71d78cf993e696f517f73a7a2a8f  lib/types/skill.d.ts.map
6b7d790d9516b495a1c1cd4fec5b2f6847dc32d6af49ed4de6e118faf7faafa6  lib/types/target-resolver.d.ts
4ce77cd6f6edbb2d1490f29e9cb94005160fed2d3b7d78bc7aa5457c5d558ec6  lib/types/target-resolver.d.ts.map
5bf5423ac35e7277219f8c0c31927bc31eaab36bfbe7dc32ce73b14db43118d1  lib/types/tools.d.ts
4c06e6dc8169101af00c7d6e80106fd859cbfc883ebd0d592bfcc49d680e5b46  lib/types/tools.d.ts.map
56d11d6a6e4034e614776160382b2f5d4860c35f999c16c14fb6a5bf636c2b44  lib/types/types.d.ts
efef82b12d5a788014a31e4eb7745f43c8892847dc99e899d329e019fa5ec475  lib/types/types.d.ts.map
383e33c792580a8c392849fe237eed018f12a0627d452b88ef7436056e8737aa  lib/types/web.d.ts
0102ce0fa3a34bae3b4ad4f4b251f41a424bd4efa55dc32caadafb0187643c31  lib/types/web.d.ts.map
5b1e59530ea8181c041a6c80bafd89363382f07647704a14e2493d8d47b061a8  lib/web.js
79447e259f2b6dc3b16289e6edcbba2c288e612504656f515238d227ea4b9873  lib/web.js.map
f23a4d0dc0bf8dbaab28e8a9c8611b5907178a23b2c8a6ea3b81cd7314745be8  native/macos/Sources/Fixture/main.swift
fa7cde2885bafcd8ed05009ae513f5914effa8bfb45876911d1e9305695338a6  native/macos/Sources/Helper/CursorImage.swift
84cd244f82793cd3448c26f751986a1c2eab4ece683a1fecf8613eefa63e6268  native/macos/Sources/Helper/CursorOverlay.swift
8261583f558eae4eef30e70af1a652c15101fa72efa2e25e74f521075f643d59  native/macos/Sources/Helper/TargetedPointer.swift
25e4c64b6bba03464a6f425e891d2e5f4813edd6b2c38d72d662c9a20ce0fd4e  native/macos/Sources/Helper/main.swift
896a1c72b92ca5c2fbc8180a8da86588677ac469e6ef7998c5763ec27e5f7da6  native/macos/Sources/Monitor/main.swift
6dbb7d4b171d9f480e046a4c69df6e3b41c8c5bf0decfabc6e5331c1dc79af91  native/macos/bin/dsh-computer-use-helper
c46a338be5a06f7a356e59e84472836697f73cfd1d0595173f64bf381b6e4d4b  native/macos/manifest.json
8c1899517b6e202915b3409c3f3f8d8cf3e0f7e518d30b580eb05c6374aa390b  package.json
0ffb59aefafc437378f5788415e541dab8577900a9e23f9cefbae738224280a0  pnpm-lock.yaml
e6874f27cedc414218dbb95d7298a7b6ceeb436116070065c95aefb6eac09fb6  pnpm-workspace.yaml
fd54a92d6fef8e3a9e98d385a3da556d2a45f254aecc154b7a4b9dab87061864  scripts/build-client.mjs
2a0f7a5829f8b8b8b4eb1cc74f17d5228a779a7848b99488c5cec66ed63f6555  scripts/build-native.mjs
60ce7e74715fcafe89c41b622b893d2b49705c25563e00f487540718a46f552a  scripts/check-native.mjs
b1e8f84d47effc9b6dc9dc787da019233131cd21ad799c83dc9ab532a30adea5  scripts/model-e2e.mjs
164771e839aa330b1af7bccc830be3c517d875aedcec087b072b3f5cc7e24e03  scripts/session-transcript.mjs
9e5fd39dcdcc19fac8c4b9411a8a63836c90ae8a15db3ea234047e08e1f40cb9  scripts/validate.mjs
9c93f294d904c25b4fc6deac5ac6d7f8bb9be914633a8ba57bd87c9efe3dc854  src/approval-policy.ts
1c38f84bcd3c075bfe4ba853c818c54bc219accf65442ac01d4c66611d699989  src/artifacts.ts
c07309b100a489621093669326f8dad008947cd886125d6afec80cd65bd559a1  src/backend.ts
1ea70d935321b3e4b3fd9bde0cb178f75a61df8112cb01f847ebbef102792e74  src/client/index.tsx
8080b4d1f56fef1c6315bc21ff7720ae615cf1d96d84d2323609c2c4d9c5f6db  src/config.ts
0350f03e61e3e155cc84fc1ed65d459978ee9ac0878681c7104adc4574a4e4c6  src/confirmations.ts
18e29d9bc2862184b4f9baaec6ec206fd449a7a944f12d3efc0f446e251b70b1  src/diff.ts
9b29caf118329fc018f143d3db3492c60e5bf56f0ddef8dd7d76db956dfd8511  src/errors.ts
c27ad92ac3d006aa3decb28507840690d4691550e7a8f462db03a105143a0b50  src/exposure.ts
e265b14dee19f58f5e2e6169ed426f71834ecd1cf1b36ccaa9566055703097a4  src/index.ts
cb7d50bdb4aca04b824fbb8a99244788ab709d1a12ba3d3cbe8d6dfa2f889e3f  src/leases.ts
3e1ca9de776f26faaf02d9066e0760ff42bbb4473c9d2026608229d69f0cb2c3  src/providers/macos.ts
b4d6c8a13551a3f1415194ac5cbfe8d439196f8c3ebcb597788e82ec384d96bc  src/providers/native-helper.ts
4e01b62f41b6aaea4f7100696a5c055668ba7f7b294a0471aa72174427089190  src/service.ts
e9a85a4f9a0e385c830e0d468dc61a24394d03f999e3935ae5c338da455b346d  src/skill.ts
21c75b1818a654e23809e0235d27e3e4fb9e2b3454e974653c04329632252a73  src/target-resolver.ts
53fb758da9d182198705cdaaba5d066fac20e02d83d0561ffd71123e9c5a0304  src/tools.ts
9532d09e9e6da7adee8ab73215409f5ea0bc06eb320e00d304f27b4aa5f96086  src/types.ts
6865a25facd12fa038e8280351a40b57f49c534caeb27ae3bc6f22d75be891fc  src/web.ts
5e815c2755d6af1ffe8bd3227c41d28e29c1446663582c4dea2651bb5d5f69a7  tests/artifacts.spec.ts
824813394403eeb5ffa731332d8ccd6be55a3e446bcdf67ba5a2969c48d94926  tests/client-copy.spec.ts
5955a648e1adcae9faf2aff88de78943c4f6c262bb6f74f6ba6d9117c4d67cd0  tests/config.spec.ts
c4f5d8f812311d2892b9c3bb098e7193fc41635506b498f99d99238bf6d1a124  tests/diff.spec.ts
e247fb36045921f9fa2c0e5d4f7da8b59cd26834db505f007377f23933f9d452  tests/exposure.spec.ts
ee8f552a51dfcae71ea62166b89010368f113827a6c51c7d1deda0daca687cc0  tests/helpers.ts
915e4d5ab9e49bd28f915c2b4c168e6d41c3687426032f3846f98e9e06ecb6eb  tests/native-fixture.e2e.spec.ts
a11bf5f6c80e7ac9b33a0d9cfb6129baf0afcb36ba322179d108525b71aeb3e7  tests/native-helper.spec.ts
0e7a216b21ad0e5ce9cdda338a19a458084dbef80f58a03d0c320436f9caa7d8  tests/package-layout.spec.ts
32347192d0a236970ba98c2265a78f8745e41b6820345323e836ed49fa3d95cd  tests/profile-install.e2e.spec.ts
b32c81509f4de6d52f2fc9c940ce92e33980bdac0afe3848560424a1a17938ce  tests/register.spec.ts
dfc91ba50f6b7726409c97ce3c945aa5bee01a7962c7ea888cdfbe1a597f50a7  tests/service.spec.ts
a5a94da052a2ff099d22243294a735216a0564ea3215b83a5cbdee2948685cf7  tests/session-transcript.spec.ts
f95af7b1305a4cc30a3930689efb9913b8babb9677a52802f7a448431d009c73  tests/target-resolver.spec.ts
284b109dc43a9344b3c834c947fc35f04307595aba6c5047397a0a927a86bd83  tests/tools.spec.ts
ed4b48d1f16c53c46fda89a5214af13c18d82566a5a08da2d25f18ddac10aa05  tests/web.spec.ts
8f14eaa40403b6b69e8c5f76dd833eed9e91fbbe22978f024402d2bfec6db314  tsconfig.client.json
ee0efcb7532125f2330d0ada5af5647aaa9fe42b41aaee4d910c0deeb64919b8  tsconfig.json
4a8d525179842b5ffcc13b832935742b3814c3e664fad8dbddd6a99ddd338931  vitest.config.ts
```
