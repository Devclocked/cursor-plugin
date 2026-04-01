#!/usr/bin/env node

/**
 * DevClocked Cursor Hook Tracker — Stream-Aware
 *
 * Tracks Cursor agent activity with proper stream hierarchy:
 *
 *   Conversation (parent session)
 *     ├── Main agent stream (conversation_id)
 *     ├── Subagent stream A (subagent_id) → repo X, branch Y
 *     ├── Subagent stream B (subagent_id) → repo Z, branch W
 *     └── ...parallel workers
 *
 * Each subagent is tracked as its own stream with independent
 * throttling, repo/branch attribution, and tick generation.
 *
 * Works independently of the VS Code extension — captures
 * activity in Cursor Glass and standalone agent mode.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// --- Config ---

const SUPABASE_URL = 'https://jboeqjaosyfqnxlnpvxl.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impib2VxamFvc3lmcW54bG5wdnhsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzgzMjM2OTYsImV4cCI6MjA1Mzg5OTY5Nn0.59FDUFjXJiFGuxObjHMqNKkMK8JGZOqfuKB2MjM0Iy4';
const CLI_CONFIG_PATH = path.join(
  process.env.HOME || '~',
  '.config',
  'devclocked',
  'cli.json'
);
const STATE_DIR = path.join(
  process.env.HOME || '~',
  '.config',
  'devclocked',
  'cursor-hook-state'
);

// Throttle: don't send ticks more often than every 30s per stream
const TICK_INTERVAL_MS = 30_000;

// --- Helpers ---

function loadAuth() {
  try {
    const raw = fs.readFileSync(CLI_CONFIG_PATH, 'utf-8');
    const config = JSON.parse(raw);
    return config.api_key || null;
  } catch {
    return null;
  }
}

function ensureStateDir() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  } catch {
    // already exists
  }
}

function getStreamState(streamId) {
  try {
    // Sanitize stream ID for filename
    const safeId = streamId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const p = path.join(STATE_DIR, `stream_${safeId}.json`);
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function saveStreamState(streamId, state) {
  ensureStateDir();
  const safeId = streamId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const p = path.join(STATE_DIR, `stream_${safeId}.json`);
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
}

function removeStreamState(streamId) {
  try {
    const safeId = streamId.replace(/[^a-zA-Z0-9_-]/g, '_');
    fs.unlinkSync(path.join(STATE_DIR, `stream_${safeId}.json`));
  } catch {
    // ignore
  }
}

function shouldThrottle(streamId) {
  const state = getStreamState(streamId);
  if (!state || !state.last_tick_at) return false;
  return Date.now() - state.last_tick_at < TICK_INTERVAL_MS;
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
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 10_000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body }));
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

// --- Stream Identity ---

/**
 * Resolve which stream this event belongs to.
 *
 * Cursor provides:
 * - conversation_id: the current agent/subagent conversation
 * - For subagentStart: subagent_id + parent_conversation_id
 * - For subagentStop: same
 * - For regular hooks inside a subagent: conversation_id IS the subagent's ID
 *
 * We use conversation_id as the stream ID — when a hook fires inside
 * a subagent, conversation_id is already the subagent's own ID.
 */
function resolveStream(hookEvent, input) {
  const streamId = input.conversation_id || input.session_id || 'unknown';

  // For subagentStart, the stream is the NEW subagent being created
  if (hookEvent === 'subagentStart') {
    return {
      streamId: input.subagent_id || streamId,
      parentStreamId: input.parent_conversation_id || null,
      isSubagent: true,
      isParallel: input.is_parallel_worker || false,
      subagentType: input.subagent_type || null,
      gitBranch: input.git_branch || null,
      task: input.task || null,
    };
  }

  // For subagentStop, the stream is the subagent that just finished
  if (hookEvent === 'subagentStop') {
    return {
      streamId: input.subagent_id || streamId,
      parentStreamId: input.parent_conversation_id || null,
      isSubagent: true,
      isParallel: false,
      subagentType: input.subagent_type || null,
      gitBranch: null,
      task: input.task || null,
    };
  }

  // For sessionStart/sessionEnd, this is the root conversation
  if (hookEvent === 'sessionStart' || hookEvent === 'sessionEnd') {
    return {
      streamId: input.session_id || streamId,
      parentStreamId: null,
      isSubagent: false,
      isParallel: false,
      subagentType: null,
      gitBranch: null,
      task: null,
    };
  }

  // For all other hooks (afterFileEdit, postToolUse, etc.),
  // conversation_id is the agent/subagent that triggered it.
  // Check if we have stored state indicating this is a subagent.
  const existingState = getStreamState(streamId);

  return {
    streamId,
    parentStreamId: existingState?.parent_stream_id || null,
    isSubagent: existingState?.is_subagent || false,
    isParallel: existingState?.is_parallel || false,
    subagentType: existingState?.subagent_type || null,
    gitBranch: existingState?.git_branch || null,
    task: existingState?.task || null,
  };
}

// --- Repo Detection ---

/**
 * Determine the repo/project for this event.
 * Priority: git_branch > cwd > workspace_roots > modified_files
 */
function resolveRepo(input, stream) {
  // 1. Git branch from subagent (most specific)
  if (stream.gitBranch) {
    return {
      branch: stream.gitBranch,
      repo_name: null, // will be resolved by backend from branch
    };
  }

  // 2. CWD from tool use (file edits, shell commands)
  if (input.cwd) {
    return {
      branch: null,
      repo_name: path.basename(input.cwd),
    };
  }

  // 3. File path from edits — derive repo from path
  if (input.file_path) {
    // Try to find a workspace root that contains this file
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

  // 4. Modified files from subagent stop
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

  // 5. First workspace root as fallback
  if (input.workspace_roots && input.workspace_roots.length > 0) {
    return {
      branch: null,
      repo_name: path.basename(input.workspace_roots[0]),
    };
  }

  return { branch: null, repo_name: 'unknown' };
}

// --- Activity Classification ---

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
    case 'subagentStart':
      return { activity_type: 'planning', sub_type: 'stream_start' };
    case 'subagentStop':
      return { activity_type: 'coding', sub_type: 'stream_end' };
    default:
      return { activity_type: 'coding', sub_type: hookEvent };
  }
}

// --- Tick Builder ---

/**
 * Build a TrackTickRequest payload that matches the backend's expected format:
 * { ticks: [{ entity, entity_type, timestamp, branch?, project_name?, ... }] }
 *
 * The x-devclocked-source header handles source attribution separately.
 */
function buildTrackTickRequest(hookEvent, input, stream, repo) {
  const now = new Date().toISOString();

  // Determine entity (what was acted on) and entity_type
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
      isWrite = false;
    } else {
      entity = `cursor://tool/${toolName}`;
      entityType = 'window';
    }
  } else if (hookEvent === 'afterShellExecution' && input.command) {
    entity = `cursor://shell/${input.command.split(/\s/)[0]}`;
    entityType = 'window';
    isWrite = true;
  } else if (hookEvent === 'subagentStart' || hookEvent === 'subagentStop') {
    const agentType = input.subagent_type || stream.subagentType || 'agent';
    entity = `cursor://agent/${agentType}/${stream.streamId}`;
    entityType = 'window';
  } else if (hookEvent === 'sessionStart' || hookEvent === 'sessionEnd') {
    entity = `cursor://session/${stream.streamId}`;
    entityType = 'window';
  }

  // Build the tick in the format track-tick expects
  const tick = {
    entity,
    entity_type: entityType,
    timestamp: now,
    is_write: isWrite,
    project_name: repo.repo_name || undefined,
    branch: repo.branch || stream.gitBranch || undefined,
    code_lines_added: linesAdded || undefined,
    code_lines_deleted: linesDeleted || undefined,
  };

  // Build the full request payload
  const request = {
    ticks: [tick],
  };

  // Add workspace fingerprint if available
  if (input.workspace_roots && input.workspace_roots[0]) {
    request.workspace_fingerprint = input.workspace_roots[0];
  }

  return request;
}

// --- Main ---

async function main() {
  // Read JSON from stdin
  let rawInput = '';
  for await (const chunk of process.stdin) {
    rawInput += chunk;
  }

  let input;
  try {
    input = JSON.parse(rawInput);
  } catch {
    process.exit(0); // malformed input, fail open
  }

  const hookEvent = input.hook_event_name;
  if (!hookEvent) process.exit(0);

  // Load auth
  const apiKey = loadAuth();
  if (!apiKey) process.exit(0); // not authenticated, skip silently

  // Resolve stream identity
  const stream = resolveStream(hookEvent, input);

  // --- Stream lifecycle management ---

  // Session start: create root stream state
  if (hookEvent === 'sessionStart') {
    saveStreamState(stream.streamId, {
      started_at: Date.now(),
      last_tick_at: null,
      is_subagent: false,
      parent_stream_id: null,
      is_parallel: false,
      subagent_type: null,
      git_branch: null,
      task: null,
    });
  }

  // Subagent start: create subagent stream state with full context
  if (hookEvent === 'subagentStart') {
    saveStreamState(stream.streamId, {
      started_at: Date.now(),
      last_tick_at: null,
      is_subagent: true,
      parent_stream_id: stream.parentStreamId,
      is_parallel: stream.isParallel,
      subagent_type: stream.subagentType,
      git_branch: stream.gitBranch,
      task: stream.task,
    });
  }

  // Throttle non-lifecycle events (per stream, not per session)
  const isLifecycleEvent = ['sessionStart', 'sessionEnd', 'subagentStart', 'subagentStop'].includes(hookEvent);
  if (!isLifecycleEvent) {
    if (shouldThrottle(stream.streamId)) {
      process.exit(0);
    }
  }

  // Resolve repo/project attribution
  const repo = resolveRepo(input, stream);

  // Build and send tick in track-tick API format
  const payload = buildTrackTickRequest(hookEvent, input, stream, repo);

  try {
    await callEdgeFunction(apiKey, 'track-tick', payload);

    // Update throttle state for this stream
    const state = getStreamState(stream.streamId) || {};
    state.last_tick_at = Date.now();
    saveStreamState(stream.streamId, state);
  } catch {
    // fail silently — don't block Cursor
  }

  // Clean up stream state on completion
  if (hookEvent === 'sessionEnd') {
    removeStreamState(stream.streamId);
  }
  if (hookEvent === 'subagentStop') {
    removeStreamState(stream.streamId);
  }

  // Output empty JSON (hooks expect valid JSON response)
  process.stdout.write('{}');
  process.exit(0);
}

main();
