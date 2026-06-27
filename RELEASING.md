# Releasing the DevClocked Cursor plugin

This plugin is distributed through the Cursor marketplace, which tracks this
GitHub repo. Getting a new version to users has two parts: **cut the release**
(this repo) and **let Cursor propagate it** (marketplace settings).

## 1. Cut the release

1. Bump `version` in `.cursor-plugin/plugin.json` (semver). This value is the
   single source of truth — `hooks/runtime.js` reads it and stamps it on every
   tick as `activity_context.ai_tool.plugin_version` plus the
   `x-devclocked-plugin-version` header.
2. Run the tests: `node --test hooks/runtime.test.js`.
3. Build the distributable zip (excludes the test file and any `.git`):

   ```bash
   ver=$(node -p "require('./.cursor-plugin/plugin.json').version")
   stage="$(mktemp -d)/devclocked-cursor-plugin-${ver}-clean"
   mkdir -p "$stage"
   rsync -a --exclude='.git' --exclude='*.zip' --exclude='hooks/runtime.test.js' \
     LICENSE README.md mcp.json .cursor-plugin hooks rules skills assets "$stage/"
   ( cd "$(dirname "$stage")" && zip -rq "$OLDPWD/devclocked-cursor-plugin-${ver}-clean.zip" "$(basename "$stage")" )
   ```
4. Merge to `main` and tag: `git tag v${ver} && git push origin v${ver}`.
   Attach the zip to a GitHub release for that tag.

## 2. Let Cursor propagate it (one-time setup, then automatic)

Cursor only auto-updates a marketplace plugin when **all** of these are true:

- The **Cursor GitHub App** is installed on `Devclocked/cursor-plugin`.
- The marketplace listing has **Auto Refresh** enabled and tracks `main`.

With that wired, pushing to `main` propagates to users within ~10 minutes
(Cursor re-indexes at most once per 10 min). Without it, there is **no**
update path and every user stays frozen on whatever they manually installed.

### Known Cursor caveat

Cursor's plugin updater is unreliable as of mid-2026: Auto Refresh sometimes
fails to pick up changes, and the per-version cache at
`~/.cursor/plugins/cache/devclocked/devclocked/<version>/` is not cleaned up,
so users can get stuck on a stale cached build. The manual recovery is
**uninstall + reinstall** (which flushes the cache). Do not assume a pushed
release reached everyone — verify (below).

## 3. Verify a release actually reached a user

Because the version is stamped on every tick, confirm propagation from the DB:

```sql
select activity_context->'ai_tool'->>'plugin_version' as ver,
       count(*) as ticks, max(timestamp) as last
from activity_logs
where source = 'cursor-plugin'
  and user_id = '<user-uuid>'
  and timestamp > now() - interval '2 days'
group by 1 order by last desc;
```

`ver = <new version>` after a user codes (without them reinstalling) means
Auto Refresh works. If it stays stale, they need a manual reinstall — and we
should surface an "update available" nudge rather than rely on Cursor.
