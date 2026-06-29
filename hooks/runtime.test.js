const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildTrackTickRequest,
  extractTokenUsage,
  normalizeOpaqueId,
  resolveStream,
  pruneStaleStreamState,
  resolveModel,
  inferModelProvider,
  PLUGIN_VERSION,
} = require('./runtime');

test('normalizeOpaqueId strips multiline Cursor ids down to a single opaque id', () => {
  const value = 'call_SbFRlMHiWQGs7gPhfSlvuQuR\nfc_010746da2e9a9d97f09c8e9103e69c7f606f8119c6abb2db795051005982a';
  assert.equal(normalizeOpaqueId(value), 'call_SbFRlMHiWQGs7gPhfSlvuQuR');
});

test('resolveStream uses generation_id for primary Cursor activity but keeps session root stable', () => {
  const stream = resolveStream('postToolUse', {
    conversation_id: 'ec6a6d6e-1afe-413c-a5d4-824c271722fe',
    session_id: 'ec6a6d6e-1afe-413c-a5d4-824c271722fe',
    generation_id: '8e2b18ab-16e4-4abe-9bc7-6c2370dce25b',
    tool_name: 'Read',
  });

  assert.equal(stream.streamId, '8e2b18ab-16e4-4abe-9bc7-6c2370dce25b');
  assert.equal(stream.rootStreamId, 'ec6a6d6e-1afe-413c-a5d4-824c271722fe');
  assert.equal(stream.throttleId, 'ec6a6d6e-1afe-413c-a5d4-824c271722fe');
  assert.equal(stream.parentStreamId, null);
});

test('buildTrackTickRequest ships sanitized ids in activity context', () => {
  const payload = buildTrackTickRequest(
    'postToolUse',
    {
      conversation_id: 'ec6a6d6e-1afe-413c-a5d4-824c271722fe',
      session_id: 'ec6a6d6e-1afe-413c-a5d4-824c271722fe',
      generation_id: '8e2b18ab-16e4-4abe-9bc7-6c2370dce25b',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/example.ts' },
    },
    {
      streamId: '8e2b18ab-16e4-4abe-9bc7-6c2370dce25b',
      parentStreamId: null,
      rootStreamId: 'ec6a6d6e-1afe-413c-a5d4-824c271722fe',
      gitBranch: null,
    },
    { branch: 'main', repo_name: 'example' },
    { repoUrl: null, repoFullName: null, workspaceFingerprint: null }
  );

  const aiTool = payload.ticks[0].activity_context.ai_tool;
  assert.equal(aiTool.stream_id, '8e2b18ab-16e4-4abe-9bc7-6c2370dce25b');
  assert.equal(aiTool.root_stream_id, 'ec6a6d6e-1afe-413c-a5d4-824c271722fe');
  assert.equal(aiTool.session_file_id, 'ec6a6d6e-1afe-413c-a5d4-824c271722fe');
});

test('extractTokenUsage normalizes common Cursor token shapes', () => {
  assert.deepEqual(
    extractTokenUsage({
      tokenCount: {
        inputTokens: 1200,
        outputTokens: 300,
      },
    }),
    { input: 1200, output: 300, cached: 0, reasoning: 0 }
  );

  assert.deepEqual(
    extractTokenUsage({
      usage: {
        input_tokens: 1000,
        output_tokens: 250,
        cached_input_tokens: 75,
        output_tokens_details: { reasoning_tokens: 25 },
      },
    }),
    { input: 1000, output: 250, cached: 75, reasoning: 25 }
  );
});

test('extractTokenUsage reads matching Cursor transcript usage without shipping content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devclocked-cursor-transcript-'));
  const transcriptPath = path.join(dir, 'transcript.jsonl');

  fs.writeFileSync(
    transcriptPath,
    [
      JSON.stringify({
        generation_id: 'older-generation',
        text: 'older generated text should be ignored',
        tokenCount: { inputTokens: 10, outputTokens: 2 },
      }),
      JSON.stringify({
        generation_id: 'current-generation',
        text: 'current generated text should never enter the payload',
        tokenCount: { inputTokens: 3000, outputTokens: 700 },
      }),
    ].join('\n')
  );

  try {
    assert.deepEqual(
      extractTokenUsage({
        generation_id: 'current-generation',
        transcript_path: transcriptPath,
      }),
      { input: 3000, output: 700, cached: 0, reasoning: 0 }
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildTrackTickRequest includes token usage on Cursor stop ticks', () => {
  const payload = buildTrackTickRequest(
    'stop',
    {
      conversation_id: 'ec6a6d6e-1afe-413c-a5d4-824c271722fe',
      generation_id: '8e2b18ab-16e4-4abe-9bc7-6c2370dce25b',
      hook_event_name: 'stop',
      input_tokens: 2000,
      output_tokens: 500,
    },
    {
      streamId: '8e2b18ab-16e4-4abe-9bc7-6c2370dce25b',
      parentStreamId: null,
      rootStreamId: 'ec6a6d6e-1afe-413c-a5d4-824c271722fe',
      gitBranch: null,
    },
    { branch: 'main', repo_name: 'example' },
    { repoUrl: null, repoFullName: null, workspaceFingerprint: null }
  );

  const tick = payload.ticks[0];
  assert.equal(tick.entity, 'cursor://turn/8e2b18ab-16e4-4abe-9bc7-6c2370dce25b');
  assert.deepEqual(tick.activity_context.ai_tool.token_usage, {
    input: 2000,
    output: 500,
    cached: undefined,
    reasoning: undefined,
  });
});

test('buildTrackTickRequest stamps the installed plugin version', () => {
  const payload = buildTrackTickRequest(
    'postToolUse',
    { conversation_id: 'conv-1', session_id: 'conv-1', tool_name: 'Read' },
    { streamId: 'conv-1', parentStreamId: null, rootStreamId: 'conv-1', gitBranch: null },
    { branch: null, repo_name: 'example' },
    { repoUrl: null, repoFullName: null, workspaceFingerprint: null }
  );

  const aiTool = payload.ticks[0].activity_context.ai_tool;
  assert.equal(aiTool.plugin_version, PLUGIN_VERSION);
  assert.match(PLUGIN_VERSION, /^\d+\.\d+\.\d+$/);
});

test('resolveModel keeps real models and drops Cursor sentinels', () => {
  assert.equal(resolveModel({ model: 'claude-opus-4-8' }), 'claude-opus-4-8');
  assert.equal(resolveModel({ model: 'gpt-5.5' }), 'gpt-5.5');
  assert.equal(resolveModel({ model: 'default' }), null);
  assert.equal(resolveModel({ model: 'auto' }), null);
  assert.equal(resolveModel({}), null);
});

test('inferModelProvider maps model ids to providers', () => {
  assert.equal(inferModelProvider('claude-opus-4-8'), 'anthropic');
  assert.equal(inferModelProvider('gpt-5.5'), 'openai');
  assert.equal(inferModelProvider('gemini-2.5-pro'), 'google');
  assert.equal(inferModelProvider('some-unknown-model'), null);
  assert.equal(inferModelProvider(null), null);
});

test('buildTrackTickRequest emits model + provider on ticks', () => {
  const payload = buildTrackTickRequest(
    'postToolUse',
    { conversation_id: 'c1', session_id: 'c1', tool_name: 'Shell', model: 'claude-opus-4-8' },
    { streamId: 'c1', parentStreamId: null, rootStreamId: 'c1', gitBranch: null },
    { branch: null, repo_name: 'example' },
    { repoUrl: null, repoFullName: null, workspaceFingerprint: null }
  );
  const aiTool = payload.ticks[0].activity_context.ai_tool;
  assert.equal(aiTool.model, 'claude-opus-4-8');
  assert.equal(aiTool.model_provider, 'anthropic');
});

test('buildTrackTickRequest omits model when Cursor reports a sentinel', () => {
  const payload = buildTrackTickRequest(
    'postToolUse',
    { conversation_id: 'c1', session_id: 'c1', tool_name: 'Shell', model: 'auto' },
    { streamId: 'c1', parentStreamId: null, rootStreamId: 'c1', gitBranch: null },
    { branch: null, repo_name: 'example' },
    { repoUrl: null, repoFullName: null, workspaceFingerprint: null }
  );
  const aiTool = payload.ticks[0].activity_context.ai_tool;
  assert.equal(aiTool.model, undefined);
  assert.equal(aiTool.model_provider, undefined);
});

test('pruneStaleStreamState removes expired stream files and keeps fresh ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devclocked-cursor-state-'));
  const now = 1_000_000_000_000;
  const ttl = 6 * 60 * 60 * 1000;

  const write = (name, body) => fs.writeFileSync(path.join(dir, name), JSON.stringify(body));
  write('stream_fresh.json', { last_tick_at: now - 1000 });
  write('stream_stale.json', { last_tick_at: now - ttl - 1000 });
  write('stream_started_only.json', { started_at: now - ttl - 1000 });
  write('stream_orphan.json', {});
  write('not-a-stream.json', { last_tick_at: now });

  try {
    const removed = pruneStaleStreamState(now, dir, ttl);
    assert.equal(removed, 3);
    const remaining = fs.readdirSync(dir).sort();
    assert.deepEqual(remaining, ['not-a-stream.json', 'stream_fresh.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
