#!/usr/bin/env node
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// ../plugin-runtime/core.js
var require_core = __commonJS({
  "../plugin-runtime/core.js"(exports2, module2) {
    var fs = require("fs");
    var path = require("path");
    var https = require("https");
    var { execSync } = require("child_process");
    var { createHash, randomUUID } = require("crypto");
    var SUPABASE_URL = "https://api.devclocked.com";
    var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhhcWZna2ttZWdseXJ1bG1waXN0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTIwMDYyODcsImV4cCI6MjA2NzU4MjI4N30.fTonLdDRqqtV44tBcl0Z7ryvaSD5Gczy-OTkzHUw0o4";
    var DEVCLOCKED_HOME = path.join(process.env.HOME || "~", ".config", "devclocked");
    var CLI_CONFIG_PATH = path.join(DEVCLOCKED_HOME, "cli.json");
    var PLUGIN_ACTIVITY_DIR = path.join(DEVCLOCKED_HOME, "plugin-activity");
    var TICK_INTERVAL_MS = 3e4;
    var LOCK_STALE_MS = 6e4;
    var GIT_CACHE_TTL_MS = 6e4;
    var MAX_SHIP_ATTEMPTS = 5;
    var RETRY_BACKOFF_MS = 15e3;
    var PLUGIN_ACTIVITY_RETENTION_MS = 72 * 60 * 60 * 1e3;
    var MAX_PLUGIN_ACTIVITY_ENTRIES = 1e3;
    var STREAM_STATE_TTL_MS = 6 * 60 * 60 * 1e3;
    function readPluginVersion(shipperPath) {
      try {
        const root = path.dirname(path.dirname(shipperPath));
        const manifest = JSON.parse(fs.readFileSync(path.join(root, ".cursor-plugin", "plugin.json"), "utf-8"));
        return typeof manifest.version === "string" && manifest.version ? manifest.version : "unknown";
      } catch {
        return "unknown";
      }
    }
    function ensureDir(dirPath) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    function safeId(value) {
      return String(value).replace(/[^a-zA-Z0-9_-]/g, "_");
    }
    function writeJsonFile(filePath, value) {
      ensureDir(path.dirname(filePath));
      fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
    }
    function readJsonFile(filePath) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
    function normalizeOpaqueId(value) {
      if (value === null || value === void 0) return null;
      const lines = String(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (lines.length === 0) return null;
      const preferredCallId = lines.find((line) => line.startsWith("call_"));
      if (preferredCallId) return preferredCallId;
      return lines[0];
    }
    function firstOpaqueId(...values) {
      for (const value of values) {
        const normalized = normalizeOpaqueId(value);
        if (normalized) return normalized;
      }
      return null;
    }
    function createPluginRuntime(options) {
      const namespace = options.namespace;
      const source = options.source;
      const shipperPath = options.shipperPath;
      const pluginVersion = options.pluginVersion || readPluginVersion(shipperPath);
      const STATE_DIR = path.join(DEVCLOCKED_HOME, `${namespace}-state`);
      const QUEUE_DIR = path.join(DEVCLOCKED_HOME, `${namespace}-queue`);
      const LOG_DIR = path.join(DEVCLOCKED_HOME, `${namespace}-logs`);
      const GIT_CACHE_DIR = path.join(DEVCLOCKED_HOME, `${namespace}-cache`);
      const SHIPPER_LOCK_PATH = path.join(QUEUE_DIR, "shipper.lock");
      const PLUGIN_ACTIVITY_PATH = path.join(PLUGIN_ACTIVITY_DIR, `${source}.json`);
      function appendLog(name, message, extra) {
        try {
          ensureDir(LOG_DIR);
          const entry = {
            timestamp: (/* @__PURE__ */ new Date()).toISOString(),
            message,
            ...extra ? { extra } : {}
          };
          fs.appendFileSync(path.join(LOG_DIR, `${name}.log`), `${JSON.stringify(entry)}
`);
        } catch {
        }
      }
      function loadAuth() {
        try {
          const config = readJsonFile(CLI_CONFIG_PATH);
          return config.api_key || null;
        } catch {
          return null;
        }
      }
      function getStreamState(streamId) {
        try {
          return readJsonFile(path.join(STATE_DIR, `stream_${safeId(streamId)}.json`));
        } catch {
          return null;
        }
      }
      function saveStreamState(streamId, state) {
        writeJsonFile(path.join(STATE_DIR, `stream_${safeId(streamId)}.json`), state);
      }
      function removeStreamState(streamId) {
        try {
          fs.unlinkSync(path.join(STATE_DIR, `stream_${safeId(streamId)}.json`));
        } catch {
        }
      }
      function shouldThrottle(streamId) {
        const state = getStreamState(streamId);
        if (!state || !state.last_tick_at) return false;
        return Date.now() - state.last_tick_at < TICK_INTERVAL_MS;
      }
      function pruneStaleStreamState(now = Date.now(), ttlMs = STREAM_STATE_TTL_MS) {
        let removed = 0;
        let files;
        try {
          files = fs.readdirSync(STATE_DIR);
        } catch {
          return 0;
        }
        for (const name of files) {
          if (!name.startsWith("stream_") || !name.endsWith(".json")) continue;
          const filePath = path.join(STATE_DIR, name);
          let stale = true;
          try {
            const state = readJsonFile(filePath);
            const lastSeen = state.last_tick_at || state.started_at;
            stale = !lastSeen || now - lastSeen > ttlMs;
          } catch {
            stale = true;
          }
          if (!stale) continue;
          try {
            fs.unlinkSync(filePath);
            removed += 1;
          } catch {
          }
        }
        return removed;
      }
      function toAbsoluteDir(maybePath) {
        if (!maybePath || typeof maybePath !== "string") return null;
        const candidate = path.isAbsolute(maybePath) ? maybePath : path.join(process.env.HOME || "/", maybePath);
        try {
          const stat = fs.statSync(candidate);
          if (stat.isDirectory()) return candidate;
          return path.dirname(candidate);
        } catch {
          return null;
        }
      }
      function gitExec(cwd, command) {
        try {
          return execSync(command, {
            cwd,
            timeout: 3e3,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"]
          }).trim();
        } catch {
          return null;
        }
      }
      function parseRepoFullName(repoUrl) {
        if (!repoUrl) return null;
        let match = repoUrl.match(/^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/i);
        if (!match) match = repoUrl.match(/^https?:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?(?:\/)?$/i);
        if (!match) match = repoUrl.match(/^ssh:\/\/git@[^/]+\/([^/]+)\/(.+?)(?:\.git)?$/i);
        if (!match) return null;
        return `${match[1]}/${match[2]}`.toLowerCase();
      }
      function getGitCachePath(workingDir) {
        try {
          const resolved = fs.realpathSync(workingDir).replace(/\/+$/, "").toLowerCase();
          const cacheKey = createHash("sha256").update(resolved).digest("hex");
          return path.join(GIT_CACHE_DIR, `${cacheKey}.json`);
        } catch {
          return null;
        }
      }
      function loadCachedGitContext(workingDir) {
        const cachePath = getGitCachePath(workingDir);
        if (!cachePath) return null;
        try {
          const cached = readJsonFile(cachePath);
          if (!cached.cached_at || Date.now() - cached.cached_at > GIT_CACHE_TTL_MS) {
            return null;
          }
          return cached.git_context || null;
        } catch {
          return null;
        }
      }
      function saveCachedGitContext(workingDir, gitContext) {
        const cachePath = getGitCachePath(workingDir);
        if (!cachePath) return;
        writeJsonFile(cachePath, {
          cached_at: Date.now(),
          git_context: gitContext
        });
      }
      function resolveGitContext(input) {
        const roots = Array.isArray(input.workspace_roots) ? input.workspace_roots : [];
        const pathCandidates = [
          input.file_path,
          input.tool_input?.file_path,
          Array.isArray(input.modified_files) ? input.modified_files[0] : null,
          roots[0],
          input.cwd
        ];
        let workingDir = null;
        for (const candidate of pathCandidates) {
          const abs = toAbsoluteDir(candidate);
          if (abs) {
            workingDir = abs;
            break;
          }
        }
        if (!workingDir) {
          return {
            workspaceFingerprint: null,
            repoUrl: null,
            repoFullName: null,
            repoName: null,
            branch: null,
            gitRoot: null
          };
        }
        const cached = loadCachedGitContext(workingDir);
        if (cached) return cached;
        const gitRoot = gitExec(workingDir, "git rev-parse --show-toplevel") || workingDir;
        let workspaceFingerprint = null;
        try {
          const resolvedRoot = fs.realpathSync(gitRoot).replace(/\/+$/, "").toLowerCase();
          workspaceFingerprint = createHash("sha256").update(resolvedRoot).digest("hex");
        } catch {
          workspaceFingerprint = null;
        }
        const repoUrl = gitExec(gitRoot, "git remote get-url origin");
        const repoFullName = parseRepoFullName(repoUrl);
        const branch = gitExec(gitRoot, "git rev-parse --abbrev-ref HEAD");
        const repoName = repoFullName ? repoFullName.split("/").pop() : path.basename(gitRoot);
        const gitContext = {
          workspaceFingerprint,
          repoUrl: repoUrl || null,
          repoFullName,
          repoName: repoName || null,
          branch: branch || null,
          gitRoot
        };
        saveCachedGitContext(workingDir, gitContext);
        return gitContext;
      }
      function stampPluginVersion(body) {
        if (!body || !Array.isArray(body.ticks)) return;
        for (const tick of body.ticks) {
          const aiTool = tick && tick.activity_context && tick.activity_context.ai_tool;
          if (aiTool && typeof aiTool === "object" && aiTool.plugin_version === void 0) {
            aiTool.plugin_version = pluginVersion;
          }
        }
      }
      function callEdgeFunction(apiKey, fnName, body) {
        return new Promise((resolve, reject) => {
          const url = new URL(`/functions/v1/${fnName}`, SUPABASE_URL);
          if (fnName === "track-tick") stampPluginVersion(body);
          const data = JSON.stringify(body);
          const req = https.request(
            url,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "apikey": SUPABASE_ANON_KEY,
                "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
                "x-devclocked-key": apiKey,
                "x-devclocked-source": source,
                "x-devclocked-plugin-version": pluginVersion,
                "Content-Length": Buffer.byteLength(data)
              },
              timeout: 1e4
            },
            (res) => {
              let responseBody = "";
              res.on("data", (chunk) => responseBody += chunk);
              res.on("end", () => {
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                  resolve({ status: res.statusCode, body: responseBody });
                  return;
                }
                reject(new Error(`edge_function_${res.statusCode || "unknown"}`));
              });
            }
          );
          req.on("error", reject);
          req.on("timeout", () => {
            req.destroy();
            reject(new Error("timeout"));
          });
          req.write(data);
          req.end();
        });
      }
      function isTrackTickProcessed(response) {
        try {
          const body = typeof response?.body === "string" ? JSON.parse(response.body) : response?.body;
          return body?.session_updated === true || Number(body?.processed_count || 0) > 0;
        } catch {
          return false;
        }
      }
      function nextQueueFilePath() {
        ensureDir(QUEUE_DIR);
        return path.join(QUEUE_DIR, `${Date.now()}-${process.pid}-${randomUUID()}.json`);
      }
      function enqueueHookEvent(input) {
        const envelope = {
          id: randomUUID(),
          captured_at: (/* @__PURE__ */ new Date()).toISOString(),
          attempts: 0,
          input
        };
        const filePath = nextQueueFilePath();
        writeJsonFile(filePath, envelope);
        return filePath;
      }
      function listQueueFiles() {
        try {
          ensureDir(QUEUE_DIR);
          return fs.readdirSync(QUEUE_DIR).filter((name) => name.endsWith(".json")).sort().map((name) => path.join(QUEUE_DIR, name));
        } catch {
          return [];
        }
      }
      function isProcessAlive(pid) {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      }
      function acquireShipperLock() {
        ensureDir(QUEUE_DIR);
        try {
          const fd = fs.openSync(SHIPPER_LOCK_PATH, "wx");
          fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: Date.now() }));
          return fd;
        } catch (error) {
          if (error.code !== "EEXIST") return null;
          try {
            const existing = readJsonFile(SHIPPER_LOCK_PATH);
            const stale = !existing.started_at || Date.now() - existing.started_at > LOCK_STALE_MS;
            const dead = !existing.pid || !isProcessAlive(existing.pid);
            if (stale || dead) {
              fs.unlinkSync(SHIPPER_LOCK_PATH);
              return acquireShipperLock();
            }
          } catch {
            try {
              fs.unlinkSync(SHIPPER_LOCK_PATH);
              return acquireShipperLock();
            } catch {
              return null;
            }
          }
          return null;
        }
      }
      function releaseShipperLock(fd) {
        try {
          fs.closeSync(fd);
        } catch {
        }
        try {
          fs.unlinkSync(SHIPPER_LOCK_PATH);
        } catch {
        }
      }
      function markEnvelopeRetry(filePath, envelope, errorMessage) {
        envelope.attempts = (envelope.attempts || 0) + 1;
        envelope.last_error = errorMessage;
        envelope.last_attempt_at = (/* @__PURE__ */ new Date()).toISOString();
        envelope.retry_after = new Date(Date.now() + RETRY_BACKOFF_MS).toISOString();
        writeJsonFile(filePath, envelope);
      }
      function shouldRetryEnvelope(envelope) {
        if (!envelope.retry_after) return true;
        return Date.now() >= new Date(envelope.retry_after).getTime();
      }
      function discardEnvelope(filePath, envelope, reason) {
        appendLog("shipper", "Dropping queued hook event", {
          file: path.basename(filePath),
          reason,
          hook_event_name: envelope.input?.hook_event_name || null,
          attempts: envelope.attempts || 0
        });
        try {
          fs.unlinkSync(filePath);
        } catch {
        }
      }
      function wakeShipper() {
        try {
          const { spawn } = require("child_process");
          const child = spawn(process.execPath, [shipperPath], {
            detached: true,
            stdio: "ignore"
          });
          child.unref();
        } catch (error) {
          appendLog("hook", "Failed to wake shipper", {
            error: error instanceof Error ? error.message : "unknown_error"
          });
        }
      }
      function readPluginActivity() {
        try {
          const raw = readJsonFile(PLUGIN_ACTIVITY_PATH);
          const entries = Array.isArray(raw.entries) ? raw.entries : [];
          return {
            version: 1,
            entries
          };
        } catch {
          return {
            version: 1,
            entries: []
          };
        }
      }
      function recordPluginActivity(entry) {
        const observedAtMs = new Date(entry.observedAt || Date.now()).getTime();
        const cutoff = Date.now() - PLUGIN_ACTIVITY_RETENTION_MS;
        const current = readPluginActivity();
        const retained = current.entries.filter((item) => {
          const ts = new Date(item.observedAt || 0).getTime();
          return Number.isFinite(ts) && ts >= cutoff;
        });
        retained.push({
          workspaceFingerprint: entry.workspaceFingerprint || null,
          rootStreamId: entry.rootStreamId || null,
          streamId: entry.streamId || null,
          sessionFileId: entry.sessionFileId || null,
          observedAt: Number.isFinite(observedAtMs) ? new Date(observedAtMs).toISOString() : (/* @__PURE__ */ new Date()).toISOString()
        });
        const deduped = [];
        const seen = /* @__PURE__ */ new Set();
        for (const item of retained.slice(-MAX_PLUGIN_ACTIVITY_ENTRIES)) {
          const key = [
            item.workspaceFingerprint || "",
            item.rootStreamId || "",
            item.streamId || "",
            item.sessionFileId || "",
            item.observedAt || ""
          ].join("::");
          if (seen.has(key)) continue;
          seen.add(key);
          deduped.push(item);
        }
        writeJsonFile(PLUGIN_ACTIVITY_PATH, {
          version: 1,
          updated_at: (/* @__PURE__ */ new Date()).toISOString(),
          entries: deduped
        });
      }
      return {
        SUPABASE_URL,
        SUPABASE_ANON_KEY,
        CLI_CONFIG_PATH,
        DEVCLOCKED_HOME,
        STATE_DIR,
        QUEUE_DIR,
        LOG_DIR,
        GIT_CACHE_DIR,
        SHIPPER_LOCK_PATH,
        SHIPPER_PATH: shipperPath,
        MAX_SHIP_ATTEMPTS,
        appendLog,
        acquireShipperLock,
        callEdgeFunction,
        discardEnvelope,
        enqueueHookEvent,
        ensureDir,
        firstOpaqueId,
        getStreamState,
        isTrackTickProcessed,
        listQueueFiles,
        loadAuth,
        markEnvelopeRetry,
        normalizeOpaqueId,
        readJsonFile,
        recordPluginActivity,
        releaseShipperLock,
        removeStreamState,
        resolveGitContext,
        saveStreamState,
        shouldRetryEnvelope,
        shouldThrottle,
        pruneStaleStreamState,
        wakeShipper,
        writeJsonFile,
        pluginVersion
      };
    }
    module2.exports = {
      MAX_SHIP_ATTEMPTS,
      createPluginRuntime
    };
  }
});

// hooks/runtime.js
var require_runtime = __commonJS({
  "hooks/runtime.js"(exports2, module2) {
    var path = require("path");
    var { createPluginRuntime } = require_core();
    var runtime2 = createPluginRuntime({
      namespace: "cursor-hook",
      source: "cursor-plugin",
      shipperPath: path.join(__dirname, "ship.js")
    });
    function resolveStream(hookEvent, input) {
      const sessionRootId = runtime2.firstOpaqueId(input.session_id, input.conversation_id, input.parent_conversation_id) || "unknown";
      const primaryStreamId = runtime2.firstOpaqueId(
        input.generation_id,
        input.request_id,
        input.turn_id,
        input.prompt_id,
        input.message_id,
        input.interaction_id,
        input.composer_id,
        input.conversation_id,
        input.session_id
      ) || sessionRootId;
      const parentConversationId = runtime2.firstOpaqueId(input.parent_conversation_id);
      const subagentId = runtime2.firstOpaqueId(input.subagent_id, input.tool_call_id);
      if (hookEvent === "subagentStart") {
        const parentState = parentConversationId ? runtime2.getStreamState(parentConversationId) : null;
        const rootStreamId = parentState?.root_stream_id || parentConversationId || sessionRootId;
        return {
          streamId: subagentId || primaryStreamId,
          parentStreamId: parentConversationId,
          rootStreamId,
          throttleId: subagentId || rootStreamId,
          isSubagent: true,
          isParallel: input.is_parallel_worker || false,
          subagentType: input.subagent_type || null,
          gitBranch: input.git_branch || null,
          task: input.task || null
        };
      }
      if (hookEvent === "subagentStop") {
        const existing = runtime2.getStreamState(subagentId || primaryStreamId);
        return {
          streamId: subagentId || primaryStreamId,
          parentStreamId: parentConversationId,
          rootStreamId: existing?.root_stream_id || parentConversationId || sessionRootId,
          throttleId: subagentId || parentConversationId || sessionRootId,
          isSubagent: true,
          isParallel: false,
          subagentType: input.subagent_type || null,
          gitBranch: null,
          task: input.task || null
        };
      }
      if (hookEvent === "sessionStart" || hookEvent === "sessionEnd") {
        return {
          streamId: sessionRootId,
          parentStreamId: null,
          rootStreamId: sessionRootId,
          throttleId: sessionRootId,
          isSubagent: false,
          isParallel: false,
          subagentType: null,
          gitBranch: null,
          task: null
        };
      }
      const existingState = runtime2.getStreamState(primaryStreamId) || runtime2.getStreamState(sessionRootId);
      return {
        streamId: primaryStreamId,
        parentStreamId: existingState?.parent_stream_id || null,
        rootStreamId: existingState?.root_stream_id || sessionRootId,
        throttleId: existingState?.parent_stream_id ? primaryStreamId : sessionRootId,
        isSubagent: existingState?.is_subagent || false,
        isParallel: existingState?.is_parallel || false,
        subagentType: existingState?.subagent_type || null,
        gitBranch: existingState?.git_branch || null,
        task: existingState?.task || null
      };
    }
    function resolveRepo(input, stream, gitContext) {
      if (stream.gitBranch) {
        return {
          branch: stream.gitBranch,
          repo_name: gitContext.repoName || null
        };
      }
      if (gitContext.repoName || gitContext.branch) {
        return {
          branch: gitContext.branch || null,
          repo_name: gitContext.repoName || null
        };
      }
      if (input.cwd) {
        return {
          branch: null,
          repo_name: path.basename(input.cwd)
        };
      }
      if (input.file_path) {
        const roots = input.workspace_roots || [];
        for (const root of roots) {
          if (input.file_path.startsWith(root)) {
            return {
              branch: null,
              repo_name: path.basename(root)
            };
          }
        }
      }
      if (input.modified_files && input.modified_files.length > 0) {
        const roots = input.workspace_roots || [];
        for (const root of roots) {
          if (input.modified_files[0].startsWith(root)) {
            return {
              branch: null,
              repo_name: path.basename(root)
            };
          }
        }
      }
      if (input.workspace_roots && input.workspace_roots.length > 0) {
        return {
          branch: null,
          repo_name: path.basename(input.workspace_roots[0])
        };
      }
      return { branch: null, repo_name: "unknown" };
    }
    var NON_MODEL_SENTINELS = /* @__PURE__ */ new Set(["default", "auto", "cursor-small", ""]);
    function resolveModel(input) {
      const raw = typeof input.model === "string" ? input.model.trim() : "";
      if (!raw) return null;
      if (NON_MODEL_SENTINELS.has(raw.toLowerCase())) return null;
      return raw;
    }
    function inferModelProvider(model) {
      if (!model) return null;
      const m = model.toLowerCase();
      if (m.includes("claude") || m.includes("fable") || m.includes("opus") || m.includes("sonnet") || m.includes("haiku")) {
        return "anthropic";
      }
      if (m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4") || m.includes("codex")) {
        return "openai";
      }
      if (m.includes("gemini")) return "google";
      if (m.includes("grok")) return "xai";
      if (m.includes("deepseek")) return "deepseek";
      return null;
    }
    function countEditLines(input) {
      let linesAdded = 0;
      let linesDeleted = 0;
      for (const edit of input.edits || []) {
        linesAdded += (edit.new_string || "").split("\n").length;
        linesDeleted += (edit.old_string || "").split("\n").length;
      }
      return { linesAdded, linesDeleted };
    }
    function isBalancedChurn(linesAdded, linesDeleted) {
      if (linesAdded <= 0 || linesDeleted <= 0) return false;
      if (linesAdded + linesDeleted < 30) return false;
      const ratio = linesAdded / linesDeleted;
      return ratio >= 0.5 && ratio <= 2;
    }
    function isSmallFix(linesAdded, linesDeleted) {
      const total = linesAdded + linesDeleted;
      return total > 0 && total <= 30;
    }
    function classifyActivity(hookEvent, input) {
      switch (hookEvent) {
        case "sessionStart":
          return { activity_type: "coding", sub_type: "session_start" };
        case "sessionEnd":
          return { activity_type: "coding", sub_type: "session_end" };
        case "afterFileEdit": {
          const { linesAdded, linesDeleted } = countEditLines(input);
          if (isBalancedChurn(linesAdded, linesDeleted)) {
            return { activity_type: "refactoring", sub_type: "file_refactor" };
          }
          if (isSmallFix(linesAdded, linesDeleted)) {
            return { activity_type: "debugging", sub_type: "file_fix" };
          }
          return { activity_type: "coding", sub_type: "file_edit" };
        }
        case "postToolUse":
          if (input.tool_name === "Shell") return { activity_type: "coding", sub_type: "shell" };
          if (input.tool_name === "Read") return { activity_type: "reading", sub_type: "file_read" };
          if (input.tool_name === "Write") return { activity_type: "coding", sub_type: "file_write" };
          if (input.tool_name === "Task") return { activity_type: "planning", sub_type: "task_spawn" };
          if (input.tool_name?.startsWith("MCP:")) return { activity_type: "coding", sub_type: "mcp_tool" };
          return { activity_type: "coding", sub_type: "tool_use" };
        case "afterShellExecution":
          return { activity_type: "coding", sub_type: "shell" };
        case "subagentStart":
          return { activity_type: "planning", sub_type: "stream_start" };
        case "subagentStop":
          return { activity_type: "coding", sub_type: "stream_end" };
        default:
          return { activity_type: "coding", sub_type: hookEvent };
      }
    }
    function buildTrackTickRequest(hookEvent, input, stream, repo, gitContext) {
      const now = (/* @__PURE__ */ new Date()).toISOString();
      let entity = `cursor://${hookEvent}`;
      let entityType = "window";
      let isWrite = false;
      let linesAdded = 0;
      let linesDeleted = 0;
      let filesChanged = 0;
      if (hookEvent === "afterFileEdit" && input.file_path) {
        entity = input.file_path;
        entityType = "file";
        isWrite = true;
        ({ linesAdded, linesDeleted } = countEditLines(input));
        filesChanged = 1;
      } else if (hookEvent === "postToolUse") {
        const toolName = input.tool_name || "unknown";
        if (toolName === "Write" && input.tool_input?.file_path) {
          entity = input.tool_input.file_path;
          entityType = "file";
          isWrite = true;
          filesChanged = 1;
        } else if (toolName === "Read" && input.tool_input?.file_path) {
          entity = input.tool_input.file_path;
          entityType = "file";
        } else {
          entity = `cursor://tool/${toolName}`;
          entityType = "window";
        }
      } else if (hookEvent === "afterShellExecution" && input.command) {
        entity = `cursor://shell/${input.command.split(/\s/)[0]}`;
        entityType = "window";
        isWrite = true;
      } else if (hookEvent === "subagentStart" || hookEvent === "subagentStop") {
        const agentType = input.subagent_type || stream.subagentType || "agent";
        entity = `cursor://agent/${agentType}/${stream.streamId}`;
      } else if (hookEvent === "sessionStart" || hookEvent === "sessionEnd") {
        entity = `cursor://session/${stream.streamId}`;
      }
      const activity = classifyActivity(hookEvent, input);
      const model = resolveModel(input);
      const modelProvider = inferModelProvider(model);
      const workSignature = {
        read_count: activity.activity_type === "reading" ? 1 : 0,
        write_count: isWrite ? 1 : 0,
        exec_count: activity.sub_type === "shell" ? 1 : 0,
        plan_count: activity.activity_type === "planning" ? 1 : 0,
        total_turns: 1
      };
      const runtimeMs = 5e3;
      const runtimeEndedAt = new Date(new Date(now).getTime() + runtimeMs).toISOString();
      const sessionFileId = runtime2.firstOpaqueId(input.session_id, input.conversation_id) || void 0;
      const runId = `cursor:${stream.rootStreamId || stream.streamId}`;
      const tick = {
        entity,
        entity_type: entityType,
        timestamp: now,
        is_write: isWrite,
        project_name: repo.repo_name || void 0,
        branch: repo.branch || stream.gitBranch || void 0,
        repo_url: gitContext.repoUrl || void 0,
        repository_full_name: gitContext.repoFullName || void 0,
        repos: gitContext.repoFullName ? { full_name: gitContext.repoFullName } : void 0,
        code_lines_added: linesAdded || void 0,
        code_lines_deleted: linesDeleted || void 0,
        files_changed: filesChanged || void 0,
        activity_context: {
          ai_tool: {
            tool: "cursor",
            model: model || void 0,
            model_provider: modelProvider || void 0,
            activity_type: activity.activity_type,
            work_signature: workSignature,
            summary: `Cursor ${activity.sub_type}`,
            timestamp: now,
            files_touched: filesChanged || void 0,
            lines_added_by_ai: linesAdded || void 0,
            lines_removed_by_ai: linesDeleted || void 0,
            session_file_id: sessionFileId,
            run_id: runId,
            request_key: `${runId}:${hookEvent}:${now}`,
            runtime_ms: runtimeMs,
            runtime_started_at: now,
            runtime_ended_at: runtimeEndedAt,
            measurement_quality: "estimated",
            is_sidechain: Boolean(stream.parentStreamId),
            stream_id: stream.streamId,
            parent_stream_id: stream.parentStreamId || void 0,
            root_stream_id: stream.rootStreamId || stream.streamId,
            stream_role: stream.parentStreamId ? "sidechain" : "primary",
            agent_id: stream.isSubagent ? stream.streamId : void 0,
            ai_tool_version: 1
          }
        }
      };
      const request = { ticks: [tick] };
      if (gitContext.workspaceFingerprint) {
        request.workspace_fingerprint = gitContext.workspaceFingerprint;
      }
      return request;
    }
    module2.exports = {
      ...runtime2,
      buildTrackTickRequest,
      classifyActivity,
      countEditLines,
      inferModelProvider,
      resolveModel,
      resolveRepo,
      resolveStream
    };
  }
});

// ../plugin-runtime/status.js
var require_status = __commonJS({
  "../plugin-runtime/status.js"(exports2, module2) {
    var fs = require("fs");
    var path = require("path");
    function exists(filePath) {
      try {
        fs.accessSync(filePath);
        return true;
      } catch {
        return false;
      }
    }
    function safeList(dirPath, filter = () => true) {
      try {
        return fs.readdirSync(dirPath).filter(filter).sort();
      } catch {
        return [];
      }
    }
    function fileStats(filePath) {
      try {
        return fs.statSync(filePath);
      } catch {
        return null;
      }
    }
    function tailLines(filePath, count) {
      try {
        const content = fs.readFileSync(filePath, "utf-8").trim();
        if (!content) return [];
        return content.split("\n").slice(-count);
      } catch {
        return [];
      }
    }
    function newestFile(dirPath, names) {
      const withStats = names.map((name) => ({ name, stats: fileStats(path.join(dirPath, name)) })).filter((entry) => entry.stats);
      withStats.sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);
      return withStats[0] || null;
    }
    function buildStatus(runtime2) {
      const queueFiles = safeList(runtime2.QUEUE_DIR, (name) => name.endsWith(".json"));
      const oldest = queueFiles[0] ? fileStats(path.join(runtime2.QUEUE_DIR, queueFiles[0])) : null;
      const stateFiles = safeList(runtime2.STATE_DIR, (name) => name.endsWith(".json"));
      const cacheFiles = safeList(runtime2.GIT_CACHE_DIR, (name) => name.endsWith(".json"));
      const newestCache = newestFile(runtime2.GIT_CACHE_DIR, cacheFiles);
      const logFiles = safeList(runtime2.LOG_DIR, (name) => name.endsWith(".log"));
      const logs = {};
      for (const file of logFiles) {
        logs[file] = tailLines(path.join(runtime2.LOG_DIR, file), 5);
      }
      let shipperLock = {
        path: runtime2.SHIPPER_LOCK_PATH,
        present: false,
        holder: null
      };
      if (exists(runtime2.SHIPPER_LOCK_PATH)) {
        try {
          shipperLock = {
            path: runtime2.SHIPPER_LOCK_PATH,
            present: true,
            holder: runtime2.readJsonFile(runtime2.SHIPPER_LOCK_PATH)
          };
        } catch {
          shipperLock = {
            path: runtime2.SHIPPER_LOCK_PATH,
            present: true,
            holder: "unreadable"
          };
        }
      }
      return {
        auth: {
          configPath: runtime2.CLI_CONFIG_PATH,
          configPresent: exists(runtime2.CLI_CONFIG_PATH),
          apiKeyPresent: Boolean(runtime2.loadAuth())
        },
        queue: {
          dir: runtime2.QUEUE_DIR,
          pending: queueFiles.length,
          oldestQueuedAt: oldest ? oldest.mtime.toISOString() : null
        },
        state: {
          dir: runtime2.STATE_DIR,
          activeStreams: stateFiles.length
        },
        cache: {
          dir: runtime2.GIT_CACHE_DIR,
          entries: cacheFiles.length,
          newestUpdatedAt: newestCache ? newestCache.stats.mtime.toISOString() : null
        },
        shipperLock,
        logs: {
          dir: runtime2.LOG_DIR,
          files: logFiles,
          recent: logs
        }
      };
    }
    function printStatus2(runtime2, label) {
      const status = buildStatus(runtime2);
      if (process.argv.includes("--json")) {
        process.stdout.write(`${JSON.stringify(status, null, 2)}
`);
        process.exit(0);
      }
      const lines = [
        `DevClocked ${label} Hook Status`,
        `auth: ${status.auth.apiKeyPresent ? "configured" : "missing"} (${status.auth.configPath})`,
        `queue: ${status.queue.pending} pending${status.queue.oldestQueuedAt ? `, oldest ${status.queue.oldestQueuedAt}` : ""}`,
        `streams: ${status.state.activeStreams} active state file(s)`,
        `git cache: ${status.cache.entries} entry(s)${status.cache.newestUpdatedAt ? `, newest ${status.cache.newestUpdatedAt}` : ""}`,
        `shipper lock: ${status.shipperLock.present ? "present" : "not present"}`
      ];
      if (status.logs.files.length) {
        lines.push(`logs: ${status.logs.files.join(", ")}`);
        for (const file of status.logs.files) {
          lines.push(`recent ${file}:`);
          for (const line of status.logs.recent[file]) {
            lines.push(line);
          }
        }
      } else {
        lines.push(`logs: none (${runtime2.LOG_DIR})`);
      }
      process.stdout.write(`${lines.join("\n")}
`);
    }
    module2.exports = {
      printStatus: printStatus2
    };
  }
});

// hooks/status.js
var runtime = require_runtime();
var { printStatus } = require_status();
printStatus(runtime, "Cursor");
