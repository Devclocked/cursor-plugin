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

1. Use the DevClocked MCP server to fetch real tracking data:
   - Call `get_today_activity` for today's sessions and work blocks
   - Call `get_active_session` to check if tracking is currently active
   - Call `get_weekly_summary` for a broader view

2. Present the data clearly:
   - Show total time tracked today
   - Break down by project/repo if multiple
   - Mention the current active session if there is one
   - Note any gaps or idle periods if relevant

3. Keep it conversational — don't dump raw JSON. Summarize the key points:
   - "You've been coding for 3h 42m today across 2 projects"
   - "Most of your time went to devclocked-trackers (2h 15m)"
   - "You've been in this session for 47 minutes"

4. If no data is available, suggest the user run `npx devclocked setup` to configure tracking.
