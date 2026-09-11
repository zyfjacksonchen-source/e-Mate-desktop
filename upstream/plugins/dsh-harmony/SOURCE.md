# Vendored: dsh-harmony

Third-party **published** package copied into source control, vendored the same
way as `upstream/plugins/dsh-turn-fold` (see
`upstream/deepseek-harness/vendor/README.md` for the policy this follows).

## Provenance

| Field | Value |
|---|---|
| npm name | `dsh-harmony` |
| Version | `0.8.10` |
| Repository | https://github.com/memorax-ai/dsh-harmony |
| npm `gitHead` | `44e7de03d6414c5681eb314d1d9f1cfb2e2c9428` |
| Published | 2026-08-14T21:40:45.927Z |
| Fetch method | `npm pack dsh-harmony@0.8.10` in a scratch directory, then unpacked published content |
| Tarball | `https://registry.npmjs.org/dsh-harmony/-/dsh-harmony-0.8.10.tgz` (320829 bytes) |
| Tarball sha256 | `a45b92a4acb9e71f97c1ab62bdb2ac79974c5429e4bd2631e8afab01af42f4c4` |
| npm integrity | `sha512-397JkAGn1rz44Mq+2f9rn9jkUbzUD/yDMicxuXhYzRe5w+NYfu7DTPnAKKKo1zoNtclNxcWAquwCG8Ok4ncJ/g==` |
| npm shasum (sha1) | `45abbf5130c763958f27bc7f946f6ce313acef88` |
| npm provenance | `https://registry.npmjs.org/-/npm/v1/attestations/dsh-harmony@0.8.10` (SLSA provenance v1) |
| Published file count | 69 |

The vendored tree is the published tarball's `package/` content verbatim: built
`lib/`, `browser-dist/`, `assets/`, `scripts/`, `harmony.patch.yml`, READMEs,
`package.json` and `LICENSE`. Upstream source (`src/`, `test/`, tsconfigs) is
**not** published and therefore **not** available here — this directory is a
binary (JS) vendor, not a source vendor.

Owning e-Mate package: `packages/dsh-plugin-harmony` (`@e-mate/dsh-plugin-harmony`).

## What it owns

`dsh-harmony` is the **runtime patcher** that makes the whole Path C design
possible. It ships a Cordis service (`apply`/`inject` from `lib/index.js`) that
loads enabled plugins' manifests, reads their `dsh.harmony.patches` lists,
transforms the named **already-compiled** target files in memory (TypeScript AST
via `@phenomnomnominal/tsquery` + `magic-string`), and optionally exposes a
Settings panel. Its own bundle patch inserts two rows:

```yaml
- insert:
    - id: harmony
      name: dsh-harmony
    - id: harmony-settings
      name: dsh-harmony/settings
```

Its four builtin patches are listed in `package.json#dsh.harmony.patches`; the
e-Mate package re-declares that list against its own copied paths and re-verifies
every selector against the pinned 0.1.5 build (`packages/dsh-plugin-harmony/scripts/seams.mjs`).

## Local modifications vs upstream

None yet. Slice 1 vendors the published tree verbatim. The e-Mate side keeps its
own `package.json`, `cordis.patch.yml`, README and scripts under
`packages/dsh-plugin-harmony`. Any future divergence (for example narrowing the
builtin list, or re-basing a selector) must be logged here with the reason.

## File inventory (sha256 of the vendored content)

```
50a9d4933b0750a0c40b2e56a5b97ee87559f294d5c5d75a19e39241d137ce5c  LICENSE
3ceb78f98bde886a94eb2f5e104afbe4244851dd9ff3ce6a86dba401df876ae7  README.md
4b775d88ed3b67e5c8760b769b1af482821a7367ce4eb49ea97386d6294d50fe  README.zh-CN.md
b780efa61d9dd76a73baef3ab305db672cc2a5a687034c939246e93f010b2826  assets/harmony-icon-mono.png
799d7d4c829892a543759d23db7faaeea877ea2678f4d2aa28b54323542df9fa  assets/harmony-icon.png
b0f2fe56441447fcb0d20349ae8e01e3f276c78084cf8d685428b2c2675c7ee9  assets/harmony-preview-light.webp
cab845de86b52c4e6dda487bc202ca68ecc2c0021608eec4262f15845e413c8d  assets/harmony-preview.webp
87b4e0008e73e1588ffd69c376206d7fd1b0dfe1e3d6d4dbebd2119b1102d984  browser-dist/bootstrap-client.js
b64da89d961f3004db26add6a3c4ea90cbac1244b42ea2066726beaa8ea45351  browser-dist/client.js
600409098f91566b8dba9c93817c9dba5b2c25c167a69e2fbcff2d98069f9528  harmony.patch.yml
43e818adf60173644896298637f47b01d5819b17eda46eaa32d0c7d64724d012  lib/bin.d.ts
5bd417732c08fa53ed41a88a41e88df24f4b58b27603c6a0b15605bb9f73dd9c  lib/bin.js
ca08da27f3dfd3c81470c31262b1a5fc72d38f066b681cf378c8f693c70f84a3  lib/builtins/client-load-plan.patch.cjs
8e609bb71c20b858c77f0e9f90bb1319db8477b13f9f965f1a1e18524bf50881  lib/builtins/client-load-plan.patch.d.cts
d9b890e007dd460ebd8d71c3a34fc9640280f609f5d62df65483dc6c289460f2  lib/builtins/cordis-service-index.patch.cjs
8e609bb71c20b858c77f0e9f90bb1319db8477b13f9f965f1a1e18524bf50881  lib/builtins/cordis-service-index.patch.d.cts
e52f003b236f2fcc79d9fec0b7c86e1718660c74f46a573ac8576bab6f361984  lib/builtins/dsh-compat.cjs
8e9efcee75b2e9ff2f2e544e554b1e2a5ad275a7b99c76f8137fae3f5c64bdee  lib/builtins/dsh-compat.d.cts
22f521c76524ff0034e49aed025639b5b5da8142576be9829743fe6c44841eee  lib/builtins/session-profile.patch.cjs
8e609bb71c20b858c77f0e9f90bb1319db8477b13f9f965f1a1e18524bf50881  lib/builtins/session-profile.patch.d.cts
5ae0647e4c1497d724dab201240e81abed78b535ee75ab9e94858152c81d2be6  lib/builtins/settings.patch.cjs
8e609bb71c20b858c77f0e9f90bb1319db8477b13f9f965f1a1e18524bf50881  lib/builtins/settings.patch.d.cts
a2ea7574675fce1952f92d0c5f709abb11175e719e49a1cacaa65e3c162a0fe7  lib/compatibility.d.ts
82fc27553fd2abbc8b8584465d8e465774a31c00b80df2e83984f293605543c3  lib/compatibility.js
b5b29e043008122df8e0388f4897f5ddff3467ff2e0cfe5c9d397a02d56938e6  lib/control.d.ts
5bb0bf1583db4b61b46219b8afb6bacd5bc0855b93c241a8dce71b19bfaf6bd8  lib/control.js
28a274af095f0a81792018682a1ba3d0b9ea0e515d515e0de7b21d0f23e788d1  lib/dsh.d.ts
2ed40c46a36e026fa15e406def3866f902078243ff6459c292d1267ff5074110  lib/dsh.js
8ec4a1b647394394a5dd7d6ff7e08431d1ad105864e4eb318abb70164195299b  lib/hooks.d.ts
54933888da7504c161995f40ed5f02e1dae6eb1bcf1e7bcfdafc0515726af0a5  lib/hooks.js
064d8d2739f9766a93c5a354136d9019a5f0a01a18bb8abad80c96b87cda8421  lib/http.d.ts
c607ccca46b3756d785153e7249bfdc64d3c3ab1889f921c45d632d78f0c51c1  lib/http.js
60ec5a25d79c71c24f937301dd0f881d21972f7131e6963bd9b3af925fd6b131  lib/index.d.ts
b39d4f77b29bb62021466e02fd73a3e84bbf53e97607fcb8c7e64fea9d652c44  lib/index.js
8e609bb71c20b858c77f0e9f90bb1319db8477b13f9f965f1a1e18524bf50881  lib/inspection-worker.d.ts
7a878a25d0bfa4af76132bf29c3bda18e1908293966b1e15318b9c5d5c65349b  lib/inspection-worker.js
8d71950140303a03c452172ddb5ffa4843da487d2033457aa79256446c9af703  lib/installer.d.ts
2788ae62730b7b1334df7238338859ed91abf40f313316ec6e03280d9db7e227  lib/installer.js
bc05de84e7428c8274f1067d56010d376fe148771256b5b4615cf890faeedf6d  lib/launcher.d.ts
40daf34529f89272b1dd7bb2e6ca09595181e4a903f94da40629b647e300d05b  lib/launcher.js
5231b396ed346e0c9918509b44fd018de23dcb9fd27879af12dd367de113f7d0  lib/locale.d.ts
030bd9ca2d7b3a7053c0313e9f1d7c56c83891bb09cbcca04a2bdb4f289a9cdb  lib/locale.js
725b0b92432b029ab2691afbb5cef1f91a1e4d4b2c69dc8ee0552f34f3fe254f  lib/orchestrator.d.ts
15a4fdbe338e6f3064d898002c30fde97847fe6b7a1e005870d04292d2167a9b  lib/orchestrator.js
fadbb64ca06e84584174df5241879f6ec077d5f84c32e4bcb0c5ed9c8dd8a558  lib/order.d.ts
cc3eb4671852488b019bc665f72b66bee845dd3e217a62204431cb008936c76a  lib/order.js
ce8327a1e7b78cbe123b967e3dd66bd98515fdd6bf47d2ba3307d549ee169488  lib/plugin.d.ts
89cc062a9dd0d71d6c0fa9c404a0de1407f6628452767c8d76b1198022e762d3  lib/plugin.js
29110aad6546330b7e0dd7ba69b50171fd93df1a6164d02f3b4bb358c07bf2ef  lib/profile.d.ts
6911611d1796a19d4a7a258dc2fbb2f5cfddb7e8506092dedd72f492e0d027bb  lib/profile.js
f36e41b5b7f60172dafcfc0d40a952897ce4aaf08dd5f3db29bfd6794711cc3b  lib/runtime.d.ts
a93872cf817ddbd2cc35b1259f5d70343ce1865e1b9e1ebb071cc074febb4173  lib/runtime.js
debec100638b62ba7aee7233be97ea30c95197f480ecf223d24f1442423c97d3  lib/scheduler.d.ts
586e0c76e25f1819f17e4db27fda54f0a8239bbf08a771e8a89d548475457e4a  lib/scheduler.js
56c0b08be7bb623a6a344f9ddfb11976f5a5605be4306440af5d5f32c567a8ad  lib/session-profile.d.ts
e729bdef88d270b9dae7c0d4b2e1e78ee660765be165d0e5ed0666b613b6e2ee  lib/session-profile.js
b4c444962393fb40fd331354dd40369bead0998ebdfa7543e1b7b3c15725e69b  lib/settings.d.ts
1e487b7593a622b9ef1bb8e65bd7fe1d06db9ab692084c9ad3cc3209f0023509  lib/settings.js
98ae7a5267080874bedf5fae5c4f76440073ec53f55bad23b9420fbf51652058  lib/transform.d.ts
ed61c106ad109ff69de223a476eb1e00e1116c65f0cc59b93114484ef1583a8c  lib/transform.js
465ea5e36db96c8d3db84152e82130a49bcd2ab7c77bd892ccfb08e1972d1fc9  lib/tui.d.ts
e52d094113cc5cabc0a2b169357ea6b68486fd00e045616504d6867485bd347a  lib/tui.js
5745fc75638bff0715ef32c62c770cfddfd1843f50e6008778ab0d0e2fb01f61  package.json
8e8279fc1a6231bf22f210e60a81a5fa37e0cb5da48118595eed80fb108a1e3b  scripts/benchmark-dsh-load.mjs
908febf7ef7e4f0a4398475d57e4fa28614406844101fcecbe1490dcdf233761  scripts/benchmark-fleet.mjs
356a3481ba880f87635e7c6008c86b2a78d97ca74766a1a406583c241aa4ab03  scripts/bootstrap.cjs
1de369de50ac6b15b2e3c4558f1c1b4b952001ed1785d8c9e9369d4c16e37784  scripts/install-shim.cjs
bdffe57ac92de71c6eb019b762c8caf7d05a1829106b15c56ff1e2674fd8da7f  scripts/postinstall.cjs
3d698b99a3c7a51ca357ba928c1ad08120dfa4df061ca77579ddfe65f5fc2430  scripts/restart.cjs
```
