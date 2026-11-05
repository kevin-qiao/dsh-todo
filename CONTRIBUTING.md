# Contributing

Thanks for taking a look! This is a small, zero-dependency DSH plugin, so the workflow is simple.

## Development setup

```bash
git clone https://github.com/kevin-qiao/dsh-todo.git
cd dsh-todo
```

Install the directory as a DSH bundle (Plugin Manager → install bundle, keeping the clone in place),
then **restart DSH** once so the Host half is loaded. `client.js`-only changes need just a page reload.

There is no build step and no `npm install`: `client.js` is a plain browser module and the Host half
is native ESM.

## Before opening a PR

Run the offline checks (Node ≥ 18):

```bash
node verify/check-static.mjs
node verify/host-actions.mjs
node verify/client-render.mjs
```

`verify/api-smoke.mjs` needs a running DSH Web GUI and is not part of CI; run it manually when you
touch the HTTP route:

```bash
node verify/api-smoke.mjs http://127.0.0.1:<your-gui-port>
```

## Ground rules

- **Contract first.** [`CONTRACT.md`](./CONTRACT.md) is the shared Host↔Client contract. If a change
  touches a route, a payload, a Todo field or a component contract, update the contract in the same
  PR.
- **Never throw from the panel.** Client network failures render an inline message; AI failures fall
  back to the deterministic local heuristic and report `source: "fallback"`.
- **Both languages, one table.** All visible strings live in the single `[zh, en]` `TEXT` table in
  `client.js`; keep both dictionaries complete, and make sure new strings follow the in-panel language
  switch.
- **Same data, same actions.** Panel buttons, the `/dsh-todo` route and the `sticker_todo` tool go
  through the same `runAction`; don't create a second write path.
- **Styles stay inside the plugin.** One rendered `<style>` element, `--dsw-alias-*` tokens for chrome,
  no `document.body` writes, no imports of Harness client packages.
- **Tests speak first.** New behavior should come with a check in the relevant `verify/*` script
  (offline tests are the project's safety net — `api-smoke` is the only one needing a live host).

## Commit messages

Keep them short and in the imperative mood, e.g. `fix: keep the reminder overlay in sync with the
language switch`. Group unrelated changes into separate commits when practical.

## License

By contributing you agree that your changes are released under the [MIT License](./LICENSE).
