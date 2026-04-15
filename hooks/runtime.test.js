const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTrackTickRequest, normalizeOpaqueId, resolveStream } = require('./runtime');

test('normalizeOpaqueId strips multiline Cursor subagent ids down to a single opaque id', () => {
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

test('resolveStream sanitizes multiline subagent ids and preserves hierarchy', () => {
  const stream = resolveStream('subagentStart', {
    conversation_id: 'b950150f-eda9-4c38-9d83-c92d2a6be18a',
    session_id: 'b950150f-eda9-4c38-9d83-c92d2a6be18a',
    generation_id: 'b950150f-eda9-4c38-9d83-c92d2a6be18a',
    subagent_id: 'call_SbFRlMHiWQGs7gPhfSlvuQuR\nfc_010746da2e9a9d97f09c8e9103e69c7f606f8119c6abb2db795051005982a',
    tool_call_id: 'call_SbFRlMHiWQGs7gPhfSlvuQuR\nfc_010746da2e9a9d97f09c8e9103e69c7f606f8119c6abb2db795051005982a',
    parent_conversation_id: 'b950150f-eda9-4c38-9d83-c92d2a6be18a',
    subagent_type: 'general-purpose',
  });

  assert.equal(stream.streamId, 'call_SbFRlMHiWQGs7gPhfSlvuQuR');
  assert.equal(stream.parentStreamId, 'b950150f-eda9-4c38-9d83-c92d2a6be18a');
  assert.equal(stream.rootStreamId, 'b950150f-eda9-4c38-9d83-c92d2a6be18a');
  assert.equal(stream.throttleId, 'call_SbFRlMHiWQGs7gPhfSlvuQuR');
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
      isSubagent: false,
      subagentType: null,
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
