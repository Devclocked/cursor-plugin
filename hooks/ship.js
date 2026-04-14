#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  MAX_SHIP_ATTEMPTS,
  appendLog,
  acquireShipperLock,
  buildTrackTickRequest,
  callEdgeFunction,
  discardEnvelope,
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
} = require('./runtime');

function isLifecycleEvent(hookEvent) {
  return ['sessionStart', 'sessionEnd', 'subagentStart', 'subagentStop'].includes(hookEvent);
}

function initializeLifecycleState(hookEvent, stream) {
  if (hookEvent === 'sessionStart') {
    saveStreamState(stream.streamId, {
      started_at: Date.now(),
      last_tick_at: null,
      is_subagent: false,
      parent_stream_id: null,
      root_stream_id: stream.streamId,
      is_parallel: false,
      subagent_type: null,
      git_branch: null,
      task: null,
    });
  }

  if (hookEvent === 'subagentStart') {
    saveStreamState(stream.streamId, {
      started_at: Date.now(),
      last_tick_at: null,
      is_subagent: true,
      parent_stream_id: stream.parentStreamId,
      root_stream_id: stream.rootStreamId || stream.parentStreamId || stream.streamId,
      is_parallel: stream.isParallel,
      subagent_type: stream.subagentType,
      git_branch: stream.gitBranch,
      task: stream.task,
    });
  }
}

async function processEnvelope(filePath, apiKey) {
  const envelope = readJsonFile(filePath);
  if (!shouldRetryEnvelope(envelope)) return;

  const input = envelope.input || {};
  const hookEvent = input.hook_event_name;
  if (!hookEvent) {
    discardEnvelope(filePath, envelope, 'missing_hook_event_name');
    return;
  }

  const stream = resolveStream(hookEvent, input);
  initializeLifecycleState(hookEvent, stream);

  if (!isLifecycleEvent(hookEvent) && shouldThrottle(stream.streamId)) {
    discardEnvelope(filePath, envelope, 'throttled');
    return;
  }

  const gitContext = resolveGitContext(input);
  const repo = resolveRepo(input, stream, gitContext);
  const payload = buildTrackTickRequest(hookEvent, input, stream, repo, gitContext);

  try {
    await callEdgeFunction(apiKey, 'track-tick', payload);
    if (!isLifecycleEvent(hookEvent)) {
      const state = getStreamState(stream.streamId) || {};
      state.last_tick_at = Date.now();
      saveStreamState(stream.streamId, state);
    }

    if (hookEvent === 'sessionEnd' || hookEvent === 'subagentStop') {
      removeStreamState(stream.streamId);
    }

    fs.unlinkSync(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown_error';
    if ((envelope.attempts || 0) + 1 >= MAX_SHIP_ATTEMPTS) {
      discardEnvelope(filePath, envelope, `max_attempts:${message}`);
      return;
    }
    markEnvelopeRetry(filePath, envelope, message);
    appendLog('shipper', 'Queued hook event failed to send', {
      file: path.basename(filePath),
      hook_event_name: hookEvent,
      attempts: (envelope.attempts || 0) + 1,
      error: message,
    });
  }
}

async function main() {
  const lockFd = acquireShipperLock();
  if (!lockFd) process.exit(0);

  try {
    const apiKey = loadAuth();
    if (!apiKey) {
      appendLog('shipper', 'Skipping ship pass because auth is missing');
      process.exit(0);
    }

    const queueFiles = listQueueFiles();
    for (const filePath of queueFiles) {
      await processEnvelope(filePath, apiKey);
    }
  } catch (error) {
    appendLog('shipper', 'Shipper crashed', {
      error: error instanceof Error ? error.message : 'unknown_error',
    });
  } finally {
    releaseShipperLock(lockFd);
  }

  process.exit(0);
}

main();
