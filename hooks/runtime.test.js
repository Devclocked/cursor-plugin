const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildTrackTickRequest, extractTokenUsage, normalizeOpaqueId, resolveStream } = require('./runtime');

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
