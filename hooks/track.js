#!/usr/bin/env node

const { spawn } = require('child_process');
const { SHIPPER_PATH, appendLog, enqueueHookEvent } = require('./runtime');

async function readStdin() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  return raw;
}

function wakeShipper() {
  try {
    const child = spawn(process.execPath, [SHIPPER_PATH], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (error) {
    appendLog('hook', 'Failed to wake cursor shipper', {
      error: error instanceof Error ? error.message : 'unknown_error',
    });
  }
}

async function main() {
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw);
    if (!input?.hook_event_name) {
      process.stdout.write('{}');
      process.exit(0);
    }

    enqueueHookEvent(input);
    wakeShipper();
  } catch (error) {
    appendLog('hook', 'Failed to capture cursor hook event', {
      error: error instanceof Error ? error.message : 'unknown_error',
    });
  }

  process.stdout.write('{}');
  process.exit(0);
}

main();
