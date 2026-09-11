# Source receipt

- Upstream: `https://github.com/Moximxxx/dsh-find-skill`
- e-Mate fork: `https://github.com/zyfjacksonchen-source/dsh-find-skill`
- Commit: `e217fb0c8d8e377be6d9c0514446f9455821a79b`
- Base commit: `584c2f03fe98a7cee61884f7061f1d549a5a389e`
- License: MIT

The fork commit `e217fb0c8d8e377be6d9c0514446f9455821a79b` ports the client contribution to the pinned Harness 0.1.5
conversation owner (`uiConversation.events`) instead of the retired rc.6 `conversationEvents`
service, which no 0.1.5 package provides.

The e-Mate adaptation pins the external CLI, routes it through `ctx.subprocess`, requires an explicit agent-owned User Questions confirmation before model-driven installation, returns exact trusted catalog matches without mixing in remote alternatives, and keeps repository source locations out of user-visible install cards and confirmations.
