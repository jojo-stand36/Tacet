---
applyTo: "packages/adapters/**,docs/adapters/**"
---

# Agent adapters

- Every adapter implements `AgentAdapter` from `@tacet/core` and declares honest `capabilities()`. Do not claim a capability the vendor surface does not provide; emulate it only if the emulation is tested.
- All vendor output is normalized to `AgentEvent` before leaving the adapter. No vendor-specific types leak into other packages.
- Every adapter must pass the shared conformance suite. Add vendor-specific tests next to it, using recorded fixtures, never live vendor calls in CI.
- Pin the vendor CLI/SDK version you tested against, and record it in `docs/adapters/capability-matrix.md` with the date and a source link.
- Never read, store or forward vendor OAuth tokens. Launch the vendor's own binary or SDK and let it use the user's existing login or an API key from the environment.
- Process hygiene: kill child process trees on close, handle crashes as `status: error` events, never leave orphaned PTYs.
- Before relying on any flag, method name or event shape, verify it against primary docs (`verify-vendor-facts` skill).
