# Security Policy

## Supported versions

The plugin is a local DSH bundle; only the latest `main` line is supported.

| Version | Supported |
|---|---|
| 1.5.x | ✅ |
| < 1.5 | ❌ |

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through
[GitHub private security advisories](https://github.com/kevin-qiao/dsh-todo/security/advisories/new)
with:

- the plugin version / commit you tested,
- DSH version and OS,
- a minimal reproduction (request payload, note content, steps),
- the impact you expect.

You can expect an initial acknowledgement within a few days. Please give a reasonable window for a
fix before any public disclosure.

## Scope

In scope:

- the Host half (`index.js`, `lib/*`): the `/dsh-todo` HTTP route, input validation, the JSON
  document store and file writes, the `sticker_todo` tool registration, model prompt handling;
- the Client half (`client.js`): XSS/HTML injection through note text, tags, AI output or
  `localStorage` preferences, and requests the panel makes on your behalf.

Out of scope:

- vulnerabilities in DeepSeek Harness itself (report them to the Harness project),
- issues that require the attacker to already be able to run code on your machine,
- the model provider's own behaviour.

## Data & privacy notes

- Notes live in `~/.dsh-sticker-todo/todos.json` on your machine; the plugin has no server of its own
  and no telemetry.
- AI features send the board content to the model configured as DSH's default model — the same model
  your other DSH features use. They can be fully avoided by not using the AI actions; every AI feature
  has a deterministic local fallback.
- The plugin's HTTP route is loopback-only, matching the DSH Web GUI origin.
