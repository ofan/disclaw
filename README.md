# disclaw

Discord workspace structure + OpenClaw routing managed as code.

## Commands

```bash
disclaw diff                    # show full diff (read-only)
disclaw apply -y                # push config → Discord
disclaw import -y               # pull Discord → config
disclaw rollback -y             # restore from snapshot
```

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
