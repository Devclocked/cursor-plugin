# DevClocked Cursor Plugin

Automatic time tracking for developers using Cursor.

DevClocked tracks coding sessions, file activity, git commits, and Cursor interaction metadata, then shows the results on your [dashboard](https://app.devclocked.com).

## Setup

1. **Get your API key** at [devclocked.com](https://devclocked.com) (free account)
2. **Install and authenticate:**
   ```bash
   npx devclocked setup
   ```
3. **Install this plugin** from the Cursor marketplace
4. **Start coding** — tracking is automatic

## How It Works

Cursor hooks now use a two-stage flow:

- the hook captures a tiny local event and exits immediately
- a background shipper enriches the event with repo metadata and sends it to DevClocked

That keeps tracking reliable even when git or network calls are slow.

## Debugging

If you need to inspect local Cursor tracking state, run:

```bash
node ~/.cursor/plugins/cache/devclocked/devclocked/<plugin-version>/hooks/status.js
```

Or for machine-readable output:

```bash
node ~/.cursor/plugins/cache/devclocked/devclocked/<plugin-version>/hooks/status.js --json
```

The status report shows:

- whether `~/.config/devclocked/cli.json` is present
- queued hook events waiting to ship
- active stream state files
- cached git context entries
- whether a shipper lock is active
- recent local hook and shipper logs

## What's included

### MCP Server
Provides tools for fetching today's activity, weekly summaries, active sessions, and project lists.

### Rules
Persistent Cursor guidance so time tracking is active and productivity summaries use real data.

### Skills
- **Time Review** — ask about your coding time and get a clear summary
- **Productivity Summary** — weekly recaps with actionable insights

## Privacy

- Your code never leaves your machine — only timestamps and metadata are synced
- No prompts or responses are collected
- All data encrypted in transit (TLS 1.3)
- [Read more](https://devclocked.com/privacy)

## Support

- **Documentation**: [devclocked.com/docs](https://devclocked.com/docs)
- **Issues**: [GitHub Issues](https://github.com/devclocked/trackers/issues)
- **Email**: support@devclocked.com

## License

MIT
