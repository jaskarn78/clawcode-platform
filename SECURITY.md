# Security Policy

## Security maintainer

**Jaskarn Jagpal** is the security maintainer for ClawCode and is the person who
receives, triages and coordinates the fix for every vulnerability report.

## Reporting a vulnerability

Email **security@jjagpal.me** with:

- a description of the issue and the component it affects (file path or command),
- the version or commit you tested,
- steps to reproduce, or a proof of concept,
- the impact you expect (what an attacker gains).

Please do not open a public issue or pull request for a suspected vulnerability.
Report it by email first so a fix can be prepared before details are public.

Do not include real credentials, tokens or personal data in a report. If a
proof of concept needs a secret, use a throwaway value.

This project does not currently publish a PGP key. Send details as plain text
and keep secrets out of them.

## What to expect

- The maintainer will acknowledge a report and say whether it is accepted as a
  vulnerability, needs more information, or is out of scope.
- Accepted reports are fixed on the default branch and released as a new
  version. The reporter is credited in the release notes unless they ask not to
  be.
- Details are disclosed after a fix is available. Please allow reasonable time
  for a fix before publishing; coordinate the date with the maintainer.

## Supported versions

Security fixes are made against the latest release and the default branch only.
Older releases do not receive fixes; upgrade to the latest release.

| Version                | Supported |
| ---------------------- | --------- |
| Latest release (1.x)   | Yes       |
| Default branch         | Yes       |
| Any earlier release    | No        |

## Scope

In scope: code in this repository, including the daemon, the CLI, the MCP
servers and shims, the Discord and OpenAI-compatible HTTP interfaces, the
dashboard, the secret-handling paths (1Password reference and `${ENV}` resolution,
credential stripping for child processes), and the OS sandbox
(bubblewrap) integration.

Out of scope: vulnerabilities in third-party dependencies that have no
reachable path in this project (report those upstream), problems that need
prior control of the host or of the operator's account, and misconfiguration
that the documentation warns against (for example, committing `clawcode.yaml`).

## Hardening notes for operators

- Keep `clawcode.yaml` out of version control. Reference secrets with
  `op://example-vault/<item>/<field>` (substitute your vault name; or `${ENV_VAR}` in MCP server `env` blocks);
  never paste literal tokens.
- Run the daemon as an unprivileged user.
- The dashboard listens on `127.0.0.1` unless `CLAWCODE_DASHBOARD_HOST` says
  otherwise. Keep it on loopback or put authentication in front of it.
- The OpenAI-compatible endpoint (`defaults.openai`) is enabled by default and
  its default `host` is `0.0.0.0` (all interfaces), port 3101. Requests need a
  bearer key (`clawcode openai-key`). If you do not need remote access, set
  `defaults.openai.enabled: false` or `defaults.openai.host: 127.0.0.1`.
- The daemon strips `ANTHROPIC_API_KEY` from child process environments so
  agents use the logged-in Claude subscription. An MCP server that needs the
  key must be given it explicitly in its `env` block.
