---
name: productivity-summary
description: Generate a branded DevClocked productivity summary as a visual dashboard — bar charts, tables, and shipped-work recaps. Use when the user wants a weekly recap, wants to understand their work patterns, or is planning their time.
---

# Productivity Summary

## When to use
- User asks for a weekly summary or recap
- User wants to understand their work patterns
- User is planning work and wants context on recent activity
- User asks "where did my time go this week?"

## Fetch — pick tools by question
| Question | Tool | Render as |
|---|---|---|
| Hours per day this week | `get_weekly_summary_raw` (JSON) | daily-hours bar chart |
| When in the day do I work? | `get_time_breakdown` `group_by=hour` | time-of-day activity profile |
| Which weekdays? | `get_time_breakdown` `group_by=weekday` | weekday distribution chart |
| What did I ship? | `get_delivery_report` | shipped-work summary (commits/PRs/cost) |
| Quick dashboard | `get_summary` / `get_weekly_summary` | preformatted ASCII — display verbatim in a code block; never paraphrase the box art away |

`get_today_activity` and `get_projects` fill in detail when needed. Never guess or estimate time — always fetch.

## Render — capability ladder
DevClocked brand: dark bg `#0a0a0b`, gold accent `#D4A843`. Activity colors: coding=gold `#D4A843`, planning=purple, debugging=green, reading=cyan.

1. **HTML/React artifacts available** → build a branded dashboard artifact from the raw JSON tools using the brand tokens above.
2. **Markdown (Cursor chat — the default here)** → markdown tables + code-block bar charts built from `█`/`░`, clear headers, gold-accent phrasing (lead with the standout stat).
3. **Plain text only** → ASCII box dashboard matching the DevClocked CLI look.

In Cursor, default to tier 2. Example bar chart from `get_weekly_summary_raw`:

```
Mon  ████████░░░░  4.2h
Tue  ██████████░░  5.1h
Wed  ███░░░░░░░░░  1.6h
```

## Tone
- Helpful, not judgmental — tracking is self-awareness, not surveillance.
- Offer 1–2 data-backed observations (top project share, deep-work blocks, busiest days).
- For exportable reports, point to app.devclocked.com.
