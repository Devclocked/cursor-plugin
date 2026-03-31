#!/usr/bin/env node

/**
 * DevClocked Cursor Hook Tracker
 *
 * Receives Cursor hook events via stdin (JSON), generates ticks,
 * and sends them to the DevClocked backend. Works independently
 * of the VS Code extension — tracks activity in Cursor Glass
 * and standalone agent mode.
 *
 * Hooks wired: sessionStart, sessionEnd, afterFileEdit,
 * postToolUse, afterShellExecution, subagentStart, subagentStop
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

// Throttle: don't send ticks more often than every 30s per session
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

function getSessionState(sessionId) {
  try {
    const p = path.join(STATE_DIR, `${sessionId}.json`);
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function saveSessionState(sessionId, state) {
  ensureStateDir();
  const p = path.join(STATE_DIR, `${sessionId}.json`);
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
}

function removeSessionState(sessionId) {
  try {
    fs.unlinkSync(path.join(STATE_DIR, `${sessionId}.json`));
  } catch {
    // ignore
  }
}

function shouldThrottle(sessionId) {
  const state = getSessionState(sessionId);
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

// --- Tick Generation ---

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
      if (input.tool_name === 'Task') return { activity_type: 'planning', sub_type: 'task' };
      if (input.tool_name?.startsWith('MCP:')) return { activity_type: 'coding', sub_type: 'mcp_tool' };
      return { activity_type: 'coding', sub_type: 'tool_use' };
    case 'afterShellExecution':
      return { activity_type: 'coding', sub_type: 'shell' };
    case 'subagentStart':
      return { activity_type: 'planning', sub_type: 'subagent_start' };
    case 'subagentStop':
      return { activity_type: 'coding', sub_type: 'subagent_end' };
    default:
      return { activity_type: 'coding', sub_type: hookEvent };
  }
}

function buildTick(hookEvent, input) {
  const { activity_type, sub_type } = classifyActivity(hookEvent, input);

  // Determine workspace/project from the input
  const workspace = (input.workspace_roots && input.workspace_roots[0]) || input.cwd || '';
  const repoName = workspace ? path.basename(workspace) : 'unknown';

  const tick = {
    source: 'cursor-plugin',
    device_name: 'cursor',
    activity_type,
    metadata: {
      hook_event: hookEvent,
      sub_type,
      session_id: input.conversation_id || input.session_id || null,
      model: input.model || null,
    },
  };

  // Add file info for file edits
  if (hookEvent === 'afterFileEdit' && input.file_path) {
    tick.metadata.file_path = input.file_path;
    tick.metadata.lines_changed = (input.edits || []).reduce((sum, e) => {
      const added = (e.new_string || '').split('\n').length;
      const removed = (e.old_string || '').split('\n').length;
      return sum + Math.abs(added - removed);
    }, 0);
  }

  // Add tool info
  if (hookEvent === 'postToolUse') {
    tick.metadata.tool_name = input.tool_name;
    tick.metadata.duration_ms = input.duration;
  }

  // Add shell command info (command name only, not full args for privacy)
  if (hookEvent === 'afterShellExecution' && input.command) {
    tick.metadata.command_name = input.command.split(/\s/)[0];
    tick.metadata.duration_ms = input.duration;
  }

  // Add subagent info
  if (hookEvent === 'subagentStop') {
    tick.metadata.subagent_type = input.subagent_type;
    tick.metadata.tool_call_count = input.tool_call_count;
    tick.metadata.modified_files_count = (input.modified_files || []).length;
    tick.metadata.duration_ms = input.duration_ms;
  }

  // Session end info
  if (hookEvent === 'sessionEnd') {
    tick.metadata.reason = input.reason;
    tick.metadata.duration_ms = input.duration_ms;
  }

  return tick;
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

  const sessionId = input.conversation_id || input.session_id || 'unknown';

  // Session lifecycle management
  if (hookEvent === 'sessionStart') {
    saveSessionState(sessionId, {
      started_at: Date.now(),
      last_tick_at: null,
      is_background: input.is_background_agent || false,
      composer_mode: input.composer_mode || null,
    });
  }

  // Throttle non-lifecycle events
  if (hookEvent !== 'sessionStart' && hookEvent !== 'sessionEnd') {
    if (shouldThrottle(sessionId)) {
      process.exit(0);
    }
  }

  // Build and send tick
  const tick = buildTick(hookEvent, input);

  try {
    await callEdgeFunction(apiKey, 'track-tick', tick);

    // Update throttle state
    const state = getSessionState(sessionId) || {};
    state.last_tick_at = Date.now();
    saveSessionState(sessionId, state);
  } catch {
    // fail silently — don't block Cursor
  }

  // Clean up session state on end
  if (hookEvent === 'sessionEnd') {
    removeSessionState(sessionId);
  }

  // Output empty JSON (hooks expect valid JSON response)
  process.stdout.write('{}');
  process.exit(0);
}

main();
