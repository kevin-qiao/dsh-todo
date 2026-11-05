## Summary

<!-- What does this PR change, and why? Link the issue or contract section. -->

## Checklist

- [ ] [`CONTRACT.md`](../CONTRACT.md) updated when a route, payload or Todo field changed
- [ ] Both languages updated in the single `TEXT` table (no hardcoded visible strings)
- [ ] No second write path: panel / HTTP route / agent tool still share `runAction`
- [ ] Styles stay inside the plugin (one `<style>`, `--dsw-alias-*` chrome tokens, no `document.body`)
- [ ] `node verify/check-static.mjs` passes
- [ ] `node verify/host-actions.mjs` passes
- [ ] `node verify/client-render.mjs` passes
- [ ] `node verify/api-smoke.mjs <port>` was run if the HTTP route changed
- [ ] `CHANGELOG.md` updated for user-facing changes
