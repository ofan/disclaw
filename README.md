# disclaw

[![npm](https://img.shields.io/npm/v/@ofan/disclaw)](https://www.npmjs.com/package/@ofan/disclaw)
[![license](https://img.shields.io/npm/l/@ofan/disclaw)](./LICENSE)
[![node](https://img.shields.io/node/v/@ofan/disclaw)](https://nodejs.org)

**Discord workspace structure + OpenClaw routing, managed as code.**

Declare your Discord server layout in a single YAML file — categories, channels, threads, private channels, agent bindings — and let disclaw diff, apply, and roll back changes with the safety of a real infrastructure tool. Manage one server or many from one config.

### Why disclaw

- **Declarative config** — YAML in, Discord out. Like Terraform, but for Discord servers.
- **Multi-server** — manage multiple Discord servers from one config file with `servers:` map.
- **Full workspace coverage** — categories, text channels, threads, private channels, age-restricted channels, and pinned messages (read-only).
- **OpenClaw native** — agent-to-channel bindings and routing gates managed alongside structure. Also available as a [ClawHub skill](https://clawhub.com/skills/disclaw) for direct install.
- **Strong verification** — Zod-validated API responses, config validation before any API call, schema checks safe for CI (`disclaw validate`).
- **Safe by default** — dry-run on every command, automatic snapshots before mutations, instant rollback, managed-scope-only writes. Nothing changes without `--yes`.
- **Zero extra dependencies** — just Node.js 20+. One `npm install` and you're running.
- **MIT licensed** — use it however you want.

### Install

```bash
npm install -g @ofan/disclaw
```

Or install the OpenClaw skill directly:

```bash
clawhub install disclaw
```

---

## Quick start

```bash
disclaw validate                 # check config (no API calls, CI-safe)
disclaw diff                     # show full diff (read-only)
disclaw apply -y                 # push config → Discord
disclaw import -y                # pull Discord → config
disclaw rollback -y              # restore from snapshot
```

### Multi-server

```yaml
version: 1
managedBy: disclaw
servers:
  production:
    guild: "111222333"
    channels:
      - name: general
  staging:
    guild: "444555666"
    channels:
      - name: general
```

Target a specific server: `disclaw diff -s production`

### Filtering

Scope any command to specific resource types:

```bash
disclaw diff -f channel,thread
disclaw apply -f binding -y
```

Flag: `-f, --filters <types>` (comma-separated: category, channel, thread, binding)

### JSON output

```bash
disclaw diff -j
```

Flat array for agent/LLM integration: `[{op, type, name, ...}]`

---

## What disclaw manages

| Resource | Create | Update | Delete | Import |
|----------|--------|--------|--------|--------|
| Categories | yes | yes | `--prune` | yes |
| Text channels | yes | yes | `--prune` | yes |
| Threads | yes | yes | `--prune` | yes |
| Private channels | yes | yes | `--prune` | yes |
| Age-restricted channels | yes | yes | `--prune` | yes |
| Pinned messages | — | — | — | read-only |
| OpenClaw bindings | yes | yes | yes | yes |
| Routing gates | auto | auto | auto | — |

## Safety model

Disclaw is designed so the default action is always the safe one:

1. **Dry-run by default** — every mutating command shows a preview. Nothing changes without `--yes`.
2. **Automatic snapshots** — a full state snapshot is saved before every apply.
3. **Instant rollback** — `disclaw rollback -y` restores from the latest snapshot, drift-aware.
4. **Managed-scope only** — disclaw only writes to resources it owns (`managedBy: disclaw`).
5. **Creates before deletes** — safe ordering during apply prevents broken references.
6. **No surprise deletions** — removed config entries become "unmanaged", not deleted. Explicit `--prune` required.
7. **Validated at every layer** — config schema (Zod), binding references, and all API responses are verified before use.
8. **CI-safe validation** — `disclaw validate` checks everything offline, zero API calls, exit code 1 on problems.

## Documentation

Full config format, all commands, workflows, and troubleshooting: see the [skill docs](./skills/disclaw/SKILL.md).

## License

[MIT](./LICENSE)
