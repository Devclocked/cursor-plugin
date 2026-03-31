---
name: time-review
description: Review coding time and session stats. Use when the user asks about how long they've been coding, what they worked on, or wants to see their tracked activity.
---

# Time Review

## When to use
- User asks "how long have I been coding today?"
- User asks "what did I work on today/this week?"
- User wants to see their active session or recent sessions
- User asks about time spent on a specific project

## Instructions

1. **Always call `get_summary` first** — it returns a pre-formatted dashboard with progress bars, repo breakdowns, and stats in a visual box layout. Display this output directly in a code block:

   ```
   ╭────────────────────────────────────────────────────────╮
   │ ◉ repo-name  ████████░░░░░░░░░░░░  45m  ● Tracking   │
   │  Today: 2h 15m · 3 repos · 5 blocks · +120/-34 · 2k tok │
   ├────────────────────────────────────────────────────────┤
   │  project-a               ████████████████████  1h 20m │
   │  project-b               ████████░░░░░░░░░░░    35m  │
   │  project-c               ███░░░░░░░░░░░░░░░░░    20m  │
   ╰────────────────────────────────────────────────────────╯
   ```

2. **Display the `get_summary` output as-is** inside a code block. Do not reformat it, summarize it, or convert it to bullet points. The formatted dashboard IS the response.

3. Only call `get_today_activity` (raw JSON) if the user asks for specific details not in the summary (e.g., exact session start times, individual work block details, or token counts per block).

4. For weekly views, call `get_weekly_summary` which also returns pre-formatted text. Display it in a code block.

5. You can add a brief one-line comment before or after the dashboard if relevant (e.g., "You're on a good streak today!" or "Looks like a quiet morning"), but the dashboard itself should be shown unmodified.

6. If no data is available, suggest the user run `npx devclocked setup` to configure tracking.
