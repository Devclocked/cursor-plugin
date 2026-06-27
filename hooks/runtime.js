#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const { createHash, randomUUID } = require('crypto');

const SUPABASE_URL = 'https://api.devclocked.com';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhhcWZna2ttZWdseXJ1bG1waXN0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTIwMDYyODcsImV4cCI6MjA2NzU4MjI4N30.fTonLdDRqqtV44tBcl0Z7ryvaSD5Gczy-OTkzHUw0o4';
const DEVCLOCKED_HOME = path.join(process.env.HOME || '~', '.config', 'devclocked');
const CLI_CONFIG_PATH = path.join(DEVCLOCKED_HOME, 'cli.json');
const STATE_DIR = path.join(DEVCLOCKED_HOME, 'cursor-hook-state');
const QUEUE_DIR = path.join(DEVCLOCKED_HOME, 'cursor-hook-queue');
const LOG_DIR = path.join(DEVCLOCKED_HOME, 'cursor-hook-logs');
const GIT_CACHE_DIR = path.join(DEVCLOCKED_HOME, 'cursor-hook-cache');
const SHIPPER_LOCK_PATH = path.join(QUEUE_DIR, 'shipper.lock');
const SHIPPER_PATH = path.join(__dirname, 'ship.js');

const TICK_INTERVAL_MS = 30_000;
const LOCK_STALE_MS = 60_000;
const GIT_CACHE_TTL_MS = 60_000;
const MAX_SHIP_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = 15_000;
const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const STREAM_STATE_TTL_MS = 6 * 60 * 60 * 1000;

function readPluginVersion() {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '.cursor-plugin', 'plugin.json'), 'utf-8')
    );
    return typeof manifest.version === 'string' && manifest.version ? manifest.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

const PLUGIN_VERSION = readPluginVersion();

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function safeId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function writeJsonFile(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function appendLog(name, message, extra) {
  try {
    ensureDir(LOG_DIR);
    const entry = {
      timestamp: new Date().toISOString(),
      message,
      ...(extra ? { extra } : {}),
    };
    fs.appendFileSync(path.join(LOG_DIR, `${name}.log`), `${JSON.stringify(entry)}\n`);
  } catch {
    // Logging must never block hooks.
  }
}

function normalizeOpaqueId(value) {
  if (value === null || value === undefined) return null;
  const lines = String(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return null;

  const preferredCallId = lines.find((line) => line.startsWith('call_'));
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

function toTokenNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return 0;
}

function firstTokenNumber(source, names) {
  if (!source || typeof source !== 'object') return 0;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(source, name)) {
      const value = toTokenNumber(source[name]);
      if (value > 0) return value;
    }
  }
  return 0;
}

function tokenUsageHasValue(usage) {
  return Boolean(usage && (usage.input > 0 || usage.output > 0 || usage.cached > 0 || usage.reasoning > 0));
}

function mergeTokenUsage(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cached: (a.cached || 0) + (b.cached || 0),
    reasoning: (a.reasoning || 0) + (b.reasoning || 0),
  };
}

function normalizeTokenUsage(container) {
  if (!container || typeof container !== 'object') return null;

  const input = firstTokenNumber(container, [
    'input',
    'input_tokens',
    'inputTokens',
    'prompt_tokens',
    'promptTokens',
    'promptTokenCount',
  ]);
  const output = firstTokenNumber(container, [
    'output',
    'output_tokens',
    'outputTokens',
    'completion_tokens',
    'completionTokens',
    'completionTokenCount',
    'generated_tokens',
    'generatedTokens',
  ]);
  let cached = firstTokenNumber(container, [
    'cached',
    'cached_tokens',
    'cachedTokens',
    'cached_input_tokens',
    'cachedInputTokens',
    'cache_read_input_tokens',
    'cacheReadInputTokens',
    'cache_creation_input_tokens',
    'cacheCreationInputTokens',
  ]);
  let reasoning = firstTokenNumber(container, [
    'reasoning',
    'reasoning_tokens',
    'reasoningTokens',
    'reasoning_output_tokens',
    'reasoningOutputTokens',
  ]);

  const inputDetails = container.input_tokens_details || container.inputTokensDetails || container.prompt_tokens_details || container.promptTokensDetails;
  if (inputDetails && typeof inputDetails === 'object') {
    cached += firstTokenNumber(inputDetails, ['cached_tokens', 'cachedTokens', 'cache_read_input_tokens', 'cacheReadInputTokens']);
  }

  const outputDetails = container.output_tokens_details || container.outputTokensDetails || container.completion_tokens_details || container.completionTokensDetails;
  if (outputDetails && typeof outputDetails === 'object') {
    reasoning += firstTokenNumber(outputDetails, ['reasoning_tokens', 'reasoningTokens']);
  }

  const usage = { input, output, cached, reasoning };
  return tokenUsageHasValue(usage) ? usage : null;
}

function collectTokenUsageCandidates(value, candidates = [], depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return candidates;

  const direct = normalizeTokenUsage(value);
  if (direct) candidates.push(direct);

  const knownContainers = ['usage', 'token_usage', 'tokenUsage', 'tokenCount', 'last_token_usage'];
  for (const key of knownContainers) {
    const usage = normalizeTokenUsage(value[key]);
    if (usage) candidates.push(usage);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectTokenUsageCandidates(item, candidates, depth + 1);
    }
    return candidates;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (knownContainers.includes(key)) continue;
    if (nested && typeof nested === 'object') {
      collectTokenUsageCandidates(nested, candidates, depth + 1);
    }
  }

  return candidates;
}

function objectContainsId(value, ids, depth = 0) {
  if (!value || typeof value !== 'object' || ids.length === 0 || depth > 6) return false;

  if (Array.isArray(value)) {
    return value.some((item) => objectContainsId(item, ids, depth + 1));
  }

  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === 'string' && ids.includes(nested)) {
      const lowerKey = key.toLowerCase();
      if (lowerKey.includes('id') || lowerKey.includes('request')) return true;
    }
    if (nested && typeof nested === 'object' && objectContainsId(nested, ids, depth + 1)) {
      return true;
    }
  }

  return false;
}

function readTranscriptTail(filePath) {
  if (!filePath || typeof filePath !== 'string' || !path.isAbsolute(filePath)) return null;

  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    const length = Math.min(stat.size, MAX_TRANSCRIPT_BYTES);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, stat.size - length);
      return buffer.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function extractTokenUsageFromTranscript(input) {
  const raw = readTranscriptTail(input.transcript_path);
  if (!raw) return null;

  const ids = [
    input.generation_id,
    input.request_id,
    input.turn_id,
    input.prompt_id,
    input.message_id,
    input.interaction_id,
  ]
    .map(normalizeOpaqueId)
    .filter(Boolean);

  let latest = null;
  let matched = null;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const record = JSON.parse(trimmed);
      const candidates = collectTokenUsageCandidates(record);
      if (candidates.length === 0) continue;

      const recordUsage = candidates.reduce((sum, usage) => mergeTokenUsage(sum, usage), null);
      if (!recordUsage) continue;

      if (objectContainsId(record, ids)) {
        matched = mergeTokenUsage(matched, recordUsage);
      } else {
        latest = recordUsage;
      }
    } catch {
      // Transcript formats vary; ignore non-JSON lines.
    }
  }

  return matched || latest;
}

function extractTokenUsage(input) {
  const directCandidates = collectTokenUsageCandidates(input);
  const directUsage = directCandidates.reduce((sum, usage) => mergeTokenUsage(sum, usage), null);
  if (directUsage) return directUsage;
  return extractTokenUsageFromTranscript(input);
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
    // ignore
  }
}

function shouldThrottle(streamId) {
  const state = getStreamState(streamId);
  if (!state || !state.last_tick_at) return false;
  return Date.now() - state.last_tick_at < TICK_INTERVAL_MS;
}

function pruneStaleStreamState(now = Date.now(), dir = STATE_DIR, ttlMs = STREAM_STATE_TTL_MS) {
  let removed = 0;
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return 0;
  }

  for (const name of files) {
    if (!name.startsWith('stream_') || !name.endsWith('.json')) continue;
    const filePath = path.join(dir, name);
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
      // ignore
    }
  }
  return removed;
}

function toAbsoluteDir(maybePath) {
  if (!maybePath || typeof maybePath !== 'string') return null;
  const candidate = path.isAbsolute(maybePath)
    ? maybePath
    : path.join(process.env.HOME || '/', maybePath);
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
      timeout: 3000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
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
    const resolved = fs.realpathSync(workingDir).replace(/\/+$/, '').toLowerCase();
    const cacheKey = createHash('sha256').update(resolved).digest('hex');
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
    git_context: gitContext,
  });
}

function resolveGitContext(input) {
  const roots = Array.isArray(input.workspace_roots) ? input.workspace_roots : [];
  const pathCandidates = [
    input.file_path,
    input.tool_input?.file_path,
    Array.isArray(input.modified_files) ? input.modified_files[0] : null,
    roots[0],
    input.cwd,
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
      gitRoot: null,
    };
  }

  const cached = loadCachedGitContext(workingDir);
  if (cached) return cached;

  const gitRoot = gitExec(workingDir, 'git rev-parse --show-toplevel') || workingDir;
  let workspaceFingerprint = null;
  try {
    const resolvedRoot = fs.realpathSync(gitRoot).replace(/\/+$/, '').toLowerCase();
    workspaceFingerprint = createHash('sha256').update(resolvedRoot).digest('hex');
  } catch {
    workspaceFingerprint = null;
  }

  const repoUrl = gitExec(gitRoot, 'git remote get-url origin');
  const repoFullName = parseRepoFullName(repoUrl);
  const branch = gitExec(gitRoot, 'git rev-parse --abbrev-ref HEAD');
  const repoName = repoFullName ? repoFullName.split('/').pop() : path.basename(gitRoot);

  const gitContext = {
    workspaceFingerprint,
    repoUrl: repoUrl || null,
    repoFullName,
    repoName: repoName || null,
    branch: branch || null,
    gitRoot,
  };

  saveCachedGitContext(workingDir, gitContext);
  return gitContext;
}

function callEdgeFunction(apiKey, fnName, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(`/functions/v1/${fnName}`, SUPABASE_URL);
    const data = JSON.stringify(body);

    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'x-devclocked-key': apiKey,
          'x-devclocked-source': 'cursor-plugin',
          'x-devclocked-plugin-version': PLUGIN_VERSION,
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 10_000,
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk) => (responseBody += chunk));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, body: responseBody });
            return;
          }
          reject(new Error(`edge_function_${res.statusCode || 'unknown'}`));
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.write(data);
    req.end();
  });
}

function resolveStream(hookEvent, input) {
  const sessionRootId =
    firstOpaqueId(input.session_id, input.conversation_id, input.parent_conversation_id) || 'unknown';
  const primaryStreamId =
    firstOpaqueId(
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
  if (hookEvent === 'sessionStart' || hookEvent === 'sessionEnd') {
    return {
      streamId: sessionRootId,
      parentStreamId: null,
      rootStreamId: sessionRootId,
      throttleId: sessionRootId,
      gitBranch: null,
      task: null,
    };
  }

  const existingState = getStreamState(primaryStreamId) || getStreamState(sessionRootId);

  return {
    streamId: primaryStreamId,
    parentStreamId: existingState?.parent_stream_id || null,
    rootStreamId: existingState?.root_stream_id || sessionRootId,
    throttleId: existingState?.parent_stream_id ? primaryStreamId : sessionRootId,
    gitBranch: existingState?.git_branch || null,
    task: existingState?.task || null,
  };
}

function resolveRepo(input, stream, gitContext) {
  if (stream.gitBranch) {
    return {
      branch: stream.gitBranch,
      repo_name: gitContext.repoName || null,
    };
  }

  if (gitContext.repoName || gitContext.branch) {
    return {
      branch: gitContext.branch || null,
      repo_name: gitContext.repoName || null,
    };
  }

  if (input.cwd) {
    return {
      branch: null,
      repo_name: path.basename(input.cwd),
    };
  }

  if (input.file_path) {
    const roots = input.workspace_roots || [];
    for (const root of roots) {
      if (input.file_path.startsWith(root)) {
        return {
          branch: null,
          repo_name: path.basename(root),
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
          repo_name: path.basename(root),
        };
      }
    }
  }

  if (input.workspace_roots && input.workspace_roots.length > 0) {
    return {
      branch: null,
      repo_name: path.basename(input.workspace_roots[0]),
    };
  }

  return { branch: null, repo_name: 'unknown' };
}

function classifyActivity(hookEvent, input) {
  switch (hookEvent) {
    case 'sessionStart':
      return { activity_type: 'coding', sub_type: 'session_start' };
    case 'sessionEnd':
      return { activity_type: 'coding', sub_type: 'session_end' };
    case 'afterFileEdit':
      return { activity_type: 'coding', sub_type: 'file_edit' };
    case 'postToolUse':
      if (input.tool_name === 'Shell') return { activity_type: 'coding', sub_type: 'shell' };
      if (input.tool_name === 'Read') return { activity_type: 'reading', sub_type: 'file_read' };
      if (input.tool_name === 'Write') return { activity_type: 'coding', sub_type: 'file_write' };
      if (input.tool_name === 'Task') return { activity_type: 'planning', sub_type: 'task_spawn' };
      if (input.tool_name?.startsWith('MCP:')) return { activity_type: 'coding', sub_type: 'mcp_tool' };
      return { activity_type: 'coding', sub_type: 'tool_use' };
    case 'afterShellExecution':
      return { activity_type: 'coding', sub_type: 'shell' };
    case 'stop':
      return { activity_type: 'coding', sub_type: 'turn_stop' };
    default:
      return { activity_type: 'coding', sub_type: hookEvent };
  }
}

function buildTrackTickRequest(hookEvent, input, stream, repo, gitContext) {
  const now = new Date().toISOString();

  let entity = `cursor://${hookEvent}`;
  let entityType = 'window';
  let isWrite = false;
  let linesAdded = 0;
  let linesDeleted = 0;

  if (hookEvent === 'afterFileEdit' && input.file_path) {
    entity = input.file_path;
    entityType = 'file';
    isWrite = true;
    for (const edit of input.edits || []) {
      linesAdded += (edit.new_string || '').split('\n').length;
      linesDeleted += (edit.old_string || '').split('\n').length;
    }
  } else if (hookEvent === 'postToolUse') {
    const toolName = input.tool_name || 'unknown';
    if (toolName === 'Write' && input.tool_input?.file_path) {
      entity = input.tool_input.file_path;
      entityType = 'file';
      isWrite = true;
    } else if (toolName === 'Read' && input.tool_input?.file_path) {
      entity = input.tool_input.file_path;
      entityType = 'file';
    } else {
      entity = `cursor://tool/${toolName}`;
      entityType = 'window';
    }
  } else if (hookEvent === 'afterShellExecution' && input.command) {
    entity = `cursor://shell/${input.command.split(/\s/)[0]}`;
    entityType = 'window';
    isWrite = true;
  } else if (hookEvent === 'sessionStart' || hookEvent === 'sessionEnd') {
    entity = `cursor://session/${stream.streamId}`;
  } else if (hookEvent === 'stop') {
    entity = `cursor://turn/${stream.streamId}`;
  }

  const activity = classifyActivity(hookEvent, input);
  const tokenUsage = extractTokenUsage(input);
  const workSignature = {
    read_count: activity.activity_type === 'reading' ? 1 : 0,
    write_count: isWrite ? 1 : 0,
    exec_count: activity.sub_type === 'shell' ? 1 : 0,
    plan_count: activity.activity_type === 'planning' || (tokenUsage && !isWrite) ? 1 : 0,
    total_turns: 1,
  };
  const runtimeMs = 5_000;
  const runtimeEndedAt = new Date(new Date(now).getTime() + runtimeMs).toISOString();
  const sessionFileId = firstOpaqueId(input.session_id, input.conversation_id) || undefined;
  const runId = `cursor:${stream.rootStreamId || stream.streamId}`;

  const tick = {
    entity,
    entity_type: entityType,
    timestamp: now,
    is_write: isWrite,
    project_name: repo.repo_name || undefined,
    branch: repo.branch || stream.gitBranch || undefined,
    repo_url: gitContext.repoUrl || undefined,
    repository_full_name: gitContext.repoFullName || undefined,
    repos: gitContext.repoFullName ? { full_name: gitContext.repoFullName } : undefined,
    code_lines_added: linesAdded || undefined,
    code_lines_deleted: linesDeleted || undefined,
    activity_context: {
      ai_tool: {
        tool: 'cursor',
        activity_type: activity.activity_type,
        work_signature: workSignature,
        summary: `Cursor ${activity.sub_type}`,
        timestamp: now,
        session_file_id: sessionFileId,
        run_id: runId,
        request_key: `${runId}:${hookEvent}:${now}`,
        runtime_ms: runtimeMs,
        runtime_started_at: now,
        runtime_ended_at: runtimeEndedAt,
        token_usage: tokenUsage ? {
          input: tokenUsage.input,
          output: tokenUsage.output,
          cached: tokenUsage.cached > 0 ? tokenUsage.cached : undefined,
          reasoning: tokenUsage.reasoning > 0 ? tokenUsage.reasoning : undefined,
        } : undefined,
        measurement_quality: 'estimated',
        is_sidechain: Boolean(stream.parentStreamId),
        stream_id: stream.streamId,
        parent_stream_id: stream.parentStreamId || undefined,
        root_stream_id: stream.rootStreamId || stream.streamId,
        stream_role: stream.parentStreamId ? 'sidechain' : 'primary',
        ai_tool_version: 1,
        plugin_version: PLUGIN_VERSION,
      },
    },
  };

  const request = { ticks: [tick] };
  if (gitContext.workspaceFingerprint) {
    request.workspace_fingerprint = gitContext.workspaceFingerprint;
  }
  return request;
}

function nextQueueFilePath() {
  ensureDir(QUEUE_DIR);
  return path.join(QUEUE_DIR, `${Date.now()}-${process.pid}-${randomUUID()}.json`);
}

function enqueueHookEvent(input) {
  const envelope = {
    id: randomUUID(),
    captured_at: new Date().toISOString(),
    attempts: 0,
    input,
  };
  const filePath = nextQueueFilePath();
  writeJsonFile(filePath, envelope);
  return filePath;
}

function listQueueFiles() {
  try {
    ensureDir(QUEUE_DIR);
    return fs
      .readdirSync(QUEUE_DIR)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => path.join(QUEUE_DIR, name));
  } catch {
    return [];
  }
}

function acquireShipperLock() {
  ensureDir(QUEUE_DIR);
  try {
    const fd = fs.openSync(SHIPPER_LOCK_PATH, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: Date.now() }));
    return fd;
  } catch (error) {
    if (error.code !== 'EEXIST') return null;
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
    // ignore
  }
  try {
    fs.unlinkSync(SHIPPER_LOCK_PATH);
  } catch {
    // ignore
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

function markEnvelopeRetry(filePath, envelope, errorMessage) {
  envelope.attempts = (envelope.attempts || 0) + 1;
  envelope.last_error = errorMessage;
  envelope.last_attempt_at = new Date().toISOString();
  envelope.retry_after = new Date(Date.now() + RETRY_BACKOFF_MS).toISOString();
  writeJsonFile(filePath, envelope);
}

function shouldRetryEnvelope(envelope) {
  if (!envelope.retry_after) return true;
  return Date.now() >= new Date(envelope.retry_after).getTime();
}

function discardEnvelope(filePath, envelope, reason) {
  appendLog('shipper', 'Dropping queued hook event', {
    file: path.basename(filePath),
    reason,
    hook_event_name: envelope.input?.hook_event_name || null,
    attempts: envelope.attempts || 0,
  });
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

module.exports = {
  CLI_CONFIG_PATH,
  GIT_CACHE_DIR,
  LOG_DIR,
  SHIPPER_PATH,
  SHIPPER_LOCK_PATH,
  MAX_SHIP_ATTEMPTS,
  STATE_DIR,
  QUEUE_DIR,
  appendLog,
  acquireShipperLock,
  buildTrackTickRequest,
  callEdgeFunction,
  discardEnvelope,
  enqueueHookEvent,
  getStreamState,
  listQueueFiles,
  loadAuth,
  markEnvelopeRetry,
  readJsonFile,
  releaseShipperLock,
  removeStreamState,
  resolveGitContext,
  resolveRepo,
  resolveStream,
  saveStreamState,
  shouldRetryEnvelope,
  shouldThrottle,
  pruneStaleStreamState,
  normalizeOpaqueId,
  extractTokenUsage,
  PLUGIN_VERSION,
};
