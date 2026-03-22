/**
 * wait-signal.js — 等待信号文件 + 自动状态文件
 *
 * 替代手写 PowerShell 轮询命令，支持单/多文件等待。
 * 自动写状态文件供 Commander 通过 view_file 读取（不依赖 stdout）。
 *
 * 自适应轮询：指数退避策略，初始 minInterval，每轮无变化乘以 1.5，
 * 上限 maxInterval。检测到新完成时重置为 minInterval。
 *
 * 用法：
 *   # 等待单个信号文件（自适应轮询 2s→15s）
 *   node wait-signal.js --file .commander/{id}/done.json --timeout 600
 *
 *   # 自定义轮询区间
 *   node wait-signal.js --file done.json --timeout 600 --min-interval 1 --max-interval 10
 *
 *   # 等待多个信号文件（Map-Reduce）
 *   node wait-signal.js --files .commander/{id}/done-1.json .commander/{id}/done-2.json --timeout 600
 *
 * 状态文件：
 *   自动写入 --status-file（默认：第一个信号文件同目录的 wait-status.json）
 *   Commander 通过 view_file 读取此文件获取实时进度，不再依赖 command_status。
 */

const fs = require('fs');
const path = require('path');
const { log, setLogFile, parseArg, parseMultiArg, sleep } = require('./cdp-utils');

/**
 * Write current status to status file. This is the PRIMARY output mechanism.
 * Commander reads this via view_file instead of relying on stdout/command_status.
 */
function writeStatus(statusFile, data) {
  try {
    const dir = path.dirname(statusFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Atomic write: write to .tmp then rename to prevent half-read
    const tmp = statusFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, statusFile);
  } catch (e) { log(`[writeStatus] write error: ${e.message}`); }
}

async function main() {
  const args = process.argv.slice(2);

  // Parse args
  const singleFile = parseArg(args, '--file');
  const multiFiles = parseMultiArg(args, '--files');
  const timeout = parseInt(parseArg(args, '--timeout', '600'), 10);
  // Adaptive polling: --min-interval (default 2s), --max-interval (default 15s)
  // Legacy --interval maps to --min-interval for backward compat
  const legacyInterval = parseArg(args, '--interval');
  const minInterval = parseInt(parseArg(args, '--min-interval', legacyInterval || '2'), 10);
  const maxInterval = parseInt(parseArg(args, '--max-interval', '15'), 10);
  const backoffFactor = 1.5;
  let currentInterval = minInterval;
  const logFile = parseArg(args, '--log-file');
  if (logFile) setLogFile(logFile);

  const files = singleFile ? [singleFile] : multiFiles;
  if (files.length === 0) {
    log('Usage:');
    log('  node wait-signal.js --file .commander/{id}/done.json --timeout 600');
    log('  node wait-signal.js --files done-1.json done-2.json --timeout 600');
    process.exit(0);
  }

  // Status file: defaults to same directory as first signal file
  const statusFile = parseArg(args, '--status-file')
    || path.join(path.dirname(files[0]), 'wait-status.json');

  const total = files.length;
  log(`Waiting for ${total} signal file(s)... (timeout: ${timeout}s, adaptive: ${minInterval}s→${maxInterval}s ×${backoffFactor})`);
  log(`Status file: ${statusFile}`);
  files.forEach((f, i) => log(`  [${i + 1}/${total}] ${f}`));

  const startTime = Date.now();
  const completed = new Set();
  const results = {};

  // Write initial status
  writeStatus(statusFile, { status: 'waiting', completed: 0, total, elapsed: 0, pollInterval: currentInterval, results: {} });

  // Record exit signals so we know WHY the process died
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      log(`[EXIT] Received ${sig} after ${elapsed}s — ${completed.size}/${total} completed`);
      writeStatus(statusFile, {
        status: 'killed',
        signal: sig,
        completed: completed.size,
        total,
        elapsed,
        results,
      });
      process.exit(130);
    });
  }
  process.on('uncaughtException', (err) => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    log(`[EXIT] Uncaught exception after ${elapsed}s: ${err.message}`);
    log(err.stack || '');
    writeStatus(statusFile, {
      status: 'crashed',
      error: err.message,
      completed: completed.size,
      total,
      elapsed,
      results,
    });
    process.exit(1);
  });

  let pollCycle = 0;
  while (completed.size < total) {
    pollCycle++;
    log(`[heartbeat] cycle=${pollCycle} elapsed=${Math.floor((Date.now() - startTime) / 1000)}s completed=${completed.size}/${total} interval=${currentInterval}s`);
    // Check timeout
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (elapsed >= timeout) {
      log(`\nTIMEOUT after ${elapsed}s — ${completed.size}/${total} completed`);
      const output = {
        status: 'timeout',
        completed: completed.size,
        total,
        elapsed,
        results,
        missing: files.filter((_, i) => !completed.has(i)),
      };
      writeStatus(statusFile, output);
      log(JSON.stringify(output));
      process.exit(1);
    }

    // Check each file
    let changed = false;
    for (let i = 0; i < files.length; i++) {
      if (completed.has(i)) continue;
      try {
        const content = fs.readFileSync(files[i], 'utf-8').trim();
        const parsed = JSON.parse(content);
        completed.add(i);
        results[files[i]] = parsed;
        changed = true;
        if (parsed.status === 'failed') {
          log(`  ✗ [${completed.size}/${total}] ${files[i]} (${elapsed}s) [FAILED: ${(parsed.errors || []).join('; ')}]`);
        } else {
          log(`  ✓ [${completed.size}/${total}] ${files[i]} (${elapsed}s)`);
        }
      } catch (e) {
        // File doesn't exist yet, or JSON.parse failed (partial write) — retry next poll
        continue;
      }
    }

    // Adaptive backoff: reset on change, grow on idle
    if (changed) {
      currentInterval = minInterval;
    } else {
      currentInterval = Math.min(Math.round(currentInterval * backoffFactor * 10) / 10, maxInterval);
    }

    // Always update status file (keeps elapsed fresh so Commander knows process is alive)
    writeStatus(statusFile, {
      status: completed.size === total ? 'all_done' : (completed.size > 0 ? 'in_progress' : 'waiting'),
      completed: completed.size,
      total,
      elapsed,
      pollInterval: currentInterval,
      results,
    });

    if (completed.size < total) {
      await sleep(currentInterval * 1000);
    }
  }

  const totalElapsed = Math.floor((Date.now() - startTime) / 1000);
  const failedCount = Object.values(results).filter(r => r.status === 'failed').length;

  if (failedCount > 0) {
    log(`\nALL_RECEIVED: ${total}/${total} in ${totalElapsed}s (${failedCount} FAILED)`);
  } else {
    log(`\nALL_DONE: ${total}/${total} in ${totalElapsed}s`);
  }

  // Final status file
  const output = {
    status: failedCount > 0 ? 'completed_with_failures' : 'all_done',
    completed: total,
    total,
    failed: failedCount,
    elapsed: totalElapsed,
    results,
  };
  writeStatus(statusFile, output);
  log(JSON.stringify(output, null, 2));

  // Exit 0=all ok, 1=timeout, 2=some failed
  process.exit(failedCount > 0 ? 2 : 0);
}

main().catch(e => { log('Error:', e.message); process.exit(1); });
