---
name: productivity-summary
description: Generate a productivity summary with insights. Use when the user wants a weekly recap, wants to understand their work patterns, or is planning their time.
---

# Productivity Summary

## When to use
- User asks for a weekly summary or recap
- User wants to understand their work patterns
- User is planning work and wants context on recent activity
- User asks "where did my time go this week?"

## Instructions

1. Fetch data from the DevClocked MCP server:
   - Call `get_weekly_summary` for the 7-day breakdown
   - Call `get_today_activity` for today's detail
   - Call `get_projects` to understand the project landscape

2. Analyze and present insights:
   - Total hours tracked this week
   - Top projects by time spent
   - Day-by-day breakdown (busiest vs lightest days)
   - Comparison to previous patterns if the user asks

3. Offer actionable observations:
   - "You spent 60% of your week on project X — is that aligned with your priorities?"
   - "Tuesday and Thursday were your most productive days"
   - "You had 3 sessions over 2 hours — those were your deep work blocks"

4. Keep the tone helpful, not judgmental. Time tracking is a tool for self-awareness, not surveillance.

5. If the user wants to share this summary, suggest they visit app.devclocked.com for exportable reports.
