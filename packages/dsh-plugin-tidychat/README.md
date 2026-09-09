# e-Mate tidychat

Derived from BananaSoldier01/dsh-tidychat v0.2.9, commit dd8bf4fa27049363bc5f9b4692009c912ae2556a (MIT; see LICENSE). Native rc7 component. Folding and navigation enabled by default. Automatic history loading code and setting are removed; existing saved autoLoad values are ignored. Native manual history loading remains untouched. Artifact rows remain in their original native terminal owner.

## Validation boundary

`test/folding.test.mjs` runs upstream-derived DOM surgery against jsdom. It covers image-only output, thought plus image, tool artifact terminals, delayed artifacts clearing stale folds, disabling fold, stale automatic-loading settings, and the original manual history button. Slot registration is a test double; navigation React rendering and native rc7 composition require the integrated client test. No installation or release is established by these focused checks.

The native component preset is reused (`clientBundle`); no alternate client loader or second navigation renderer is introduced. Integration must remove other fold/navigation registrations so tidychat is the single owner, while retaining existing e-Mate image terminal projection.
