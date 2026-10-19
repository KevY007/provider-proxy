## Summary

<!-- What does this change and why? -->

## How to test

<!-- Commands, scenarios, screenshots. -->

## Checklist

- [ ] `pnpm typecheck`, `pnpm lint` (0 errors), `pnpm test`, `pnpm build` pass locally
- [ ] Schema changes come with a migration (`pnpm db:migrate`) and a seed update if needed
- [ ] Gateway behaviour stays a faithful 1:1 proxy (docs/PLAN.md §9d) or the deviation is documented
- [ ] Money paths (pricing, holds, metering, billing) have tests
- [ ] No secrets, live keys or customer data in the diff
- [ ] Docs updated (README / docs/ / customer docs pages) where behaviour changed
