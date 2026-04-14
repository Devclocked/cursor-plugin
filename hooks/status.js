#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  CLI_CONFIG_PATH,
  GIT_CACHE_DIR,
  LOG_DIR,
  QUEUE_DIR,
  SHIPPER_LOCK_PATH,
  STATE_DIR,
  loadAuth,
  readJsonFile,
} = require('./runtime');

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
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').slice(-count);
  } catch {
    return [];
  }
}

function newestFile(dirPath, names) {
  const withStats = names
    .map((name) => ({ name, stats: fileStats(path.join(dirPath, name)) }))
    .filter((entry) => entry.stats);
  withStats.sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);
  return withStats[0] || null;
}

function summarizeQueue() {
  const files = safeList(QUEUE_DIR, (name) => name.endsWith('.json'));
  const oldest = files[0] ? fileStats(path.join(QUEUE_DIR, files[0])) : null;
  return {
    dir: QUEUE_DIR,
    pending: files.length,
    oldestQueuedAt: oldest ? oldest.mtime.toISOString() : null,
  };
}

function summarizeState() {
  const files = safeList(STATE_DIR, (name) => name.endsWith('.json'));
  return {
    dir: STATE_DIR,
    activeStreams: files.length,
  };
}

function summarizeCache() {
  const files = safeList(GIT_CACHE_DIR, (name) => name.endsWith('.json'));
  const newest = newestFile(GIT_CACHE_DIR, files);
  return {
    dir: GIT_CACHE_DIR,
    entries: files.length,
    newestUpdatedAt: newest ? newest.stats.mtime.toISOString() : null,
  };
}

function summarizeLock() {
  if (!exists(SHIPPER_LOCK_PATH)) {
    return {
      path: SHIPPER_LOCK_PATH,
      present: false,
      holder: null,
    };
  }

  try {
    const holder = readJsonFile(SHIPPER_LOCK_PATH);
    return {
      path: SHIPPER_LOCK_PATH,
      present: true,
      holder,
    };
  } catch {
    return {
      path: SHIPPER_LOCK_PATH,
      present: true,
      holder: 'unreadable',
    };
  }
}

function summarizeLogs() {
  const files = safeList(LOG_DIR, (name) => name.endsWith('.log'));
  const result = {};
  for (const file of files) {
    result[file] = tailLines(path.join(LOG_DIR, file), 5);
  }
  return {
    dir: LOG_DIR,
    files,
    recent: result,
  };
}

function main() {
  const status = {
    auth: {
      configPath: CLI_CONFIG_PATH,
      configPresent: exists(CLI_CONFIG_PATH),
      apiKeyPresent: Boolean(loadAuth()),
    },
    queue: summarizeQueue(),
    state: summarizeState(),
    cache: summarizeCache(),
    shipperLock: summarizeLock(),
    logs: summarizeLogs(),
  };

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    process.exit(0);
  }

  const lines = [
    'DevClocked Cursor Hook Status',
    `auth: ${status.auth.apiKeyPresent ? 'configured' : 'missing'} (${status.auth.configPath})`,
    `queue: ${status.queue.pending} pending${status.queue.oldestQueuedAt ? `, oldest ${status.queue.oldestQueuedAt}` : ''}`,
    `streams: ${status.state.activeStreams} active state file(s)`,
    `git cache: ${status.cache.entries} entry(s)${status.cache.newestUpdatedAt ? `, newest ${status.cache.newestUpdatedAt}` : ''}`,
    `shipper lock: ${status.shipperLock.present ? 'present' : 'not present'}`,
  ];

  if (status.logs.files.length) {
    lines.push(`logs: ${status.logs.files.join(', ')}`);
    for (const file of status.logs.files) {
      lines.push(`recent ${file}:`);
      for (const line of status.logs.recent[file]) {
        lines.push(line);
      }
    }
  } else {
    lines.push(`logs: none (${LOG_DIR})`);
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

main();
