# DevClocked — Cursor Plugin

**Automatic time tracking with AI-powered insights, built natively for Cursor.**

DevClocked tracks your coding sessions, file activity, git commits, and AI interactions — then gives you a complete picture on your [dashboard](https://app.devclocked.com).

This plugin connects Cursor's AI to your real time tracking data, so you can ask questions like:

- "How long have I been coding today?"
- "What did I work on this week?"
- "Where is most of my time going?"

...and get answers backed by actual data, not guesses.

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
Connects Cursor's AI to your DevClocked data. Provides tools for fetching today's activity, weekly summaries, active sessions, and project lists.

### Rules
Persistent AI guidance so Cursor knows time tracking is active and uses real data when discussing your productivity.

### Skills
- **Time Review** — ask about your coding time and get a clear summary
- **Productivity Summary** — weekly recaps with actionable insights

### Agent
- **Productivity Coach** — a developer-focused coach that grounds suggestions in your actual tracked activity

## The full DevClocked ecosystem

This Cursor plugin tracks your AI-assisted coding. For full-workflow coverage:

- **[Web Dashboard](https://app.devclocked.com)** — analytics, session history, project breakdowns
- **[VS Code Extension](https://marketplace.visualstudio.com/items?itemName=devclocked.devclocked-vscode)** — IDE activity tracking
- **[Desktop App](https://devclocked.com/download)** — macOS menubar app, tracks Claude Code terminal sessions
- **[Chrome Extension](https://devclocked.com/download)** — tracks GitHub, Stack Overflow, and browser-based dev tools

## Privacy

- Your code never leaves your machine — only timestamps and metadata are synced
- No prompts or AI responses are collected
- All data encrypted in transit (TLS 1.3)
- [Read more](https://devclocked.com/privacy)

## Support

- **Documentation**: [devclocked.com/docs](https://devclocked.com/docs)
- **Issues**: [GitHub Issues](https://github.com/devclocked/trackers/issues)
- **Email**: support@devclocked.com

## License

MIT — [view source](https://github.com/devclocked/trackers)
