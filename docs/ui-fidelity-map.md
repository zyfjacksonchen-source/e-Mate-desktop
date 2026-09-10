# e-Mate UI ownership map

The current Profile is the only UI source of truth. Historical e-Mate checkouts, screenshots, prototypes, and release receipts are not runtime or acceptance contracts.

## Native owners

- DSH 0.1.5 owns Workspace, Session, Conversation, Composer, Tool, approval, Job, Skill, settings, and client slot behavior.
- `packages/dsh/profile/plugins/emate-shell` owns e-Mate branding and product presentation through those native slots.
- Other bundled Profile packages may contribute only through their declared Harness services, Tools, and slots.
- Browser code does not create a second transport, event projection, store, router, updater, or fake activity state.

## Product assets

Current logos, marks, avatars, and shell styles live under `packages/dsh/profile/plugins/emate-shell`. Enterprise pages reuse those assets instead of depending on a historical application checkout.

## Responsive baseline

- Support widths from 320px upward without horizontal overflow or occluded controls.
- Preserve visible keyboard focus, semantic controls, and at least 44px targets for coarse pointers.
- Honor `prefers-reduced-motion` for nonessential animation.
- Keep the native Harness owner and event identity when changing layout or presentation.

Design QA evidence belongs to its task or release record and is not committed as a parallel source contract.
