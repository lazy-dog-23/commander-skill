/**
 * merge-branches.js — 自动合并 Git 分支
 *
 * 合并多个子 Agent 分支到目标分支，输出结构化结果。
 * 支持冲突检测和回滚。
 *
 * 用法：
 *   node merge-branches.js --branches sub-id-1 sub-id-2 sub-id-3 --target main --result-file .commander/{taskId}/merge.json
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const { log, parseArg, parseMultiArg, writeResultFile } = require('./cdp-utils');

function git(args, cwd) {
  if (typeof args === 'string') args = args.split(' '); // Backward compat, but prefer array
  try {
    const output = execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return { ok: true, output };
  } catch (e) {
    return { ok: false, message: e.stderr?.trim() || e.message, stdout: e.stdout?.trim() };
  }
}

function main() {
  const args = process.argv.slice(2);

  const branches = parseMultiArg(args, '--branches');
  const target = parseArg(args, '--target', 'main');
  const resultFile = parseArg(args, '--result-file');
  const cwd = parseArg(args, '--cwd', process.cwd());

  if (branches.length === 0) {
    log('Usage:');
    log('  node merge-branches.js --branches sub-1 sub-2 --target main --result-file .commander/{id}/merge.json');
    log('  node merge-branches.js --branches sub-1 sub-2 --target main --cwd /path/to/repo');
    process.exit(0);
  }

  log(`Merging ${branches.length} branches into "${target}"`);
  log(`  Repo: ${cwd}`);
  branches.forEach((b, i) => log(`  [${i + 1}] ${b}`));

  // Step 1: Checkout target
  log(`\n[1] Checking out "${target}"...`);
  const checkoutResult = git(['checkout', target], cwd);
  if (!checkoutResult.ok) {
    log(`  ERROR: ${checkoutResult.message}`);
    writeResultFile(resultFile, { success: false, error: 'checkout_failed', target, message: checkoutResult.message });
    process.exit(1);
  }
  log('  OK');

  // Save original HEAD for accurate diff later
  const originalHead = git(['rev-parse', 'HEAD'], cwd);

  // Step 2: Merge each branch
  const merged = [];
  const conflicts = [];
  const failed = [];

  for (let i = 0; i < branches.length; i++) {
    const branch = branches[i];
    log(`\n[${i + 2}] Merging "${branch}"...`);
    const result = git(['merge', branch, '--no-edit'], cwd);
    if (!result.ok) {
      if (result.message.includes('CONFLICT') || result.stdout?.includes('CONFLICT')) {
        log(`  ⚠ CONFLICT — aborting merge for "${branch}"`);
        git(['merge', '--abort'], cwd);
        // Extract conflicting files
        const conflictFiles = (result.stdout || '').match(/CONFLICT.*?: (.+)/g) || [];
        conflicts.push({ branch, files: conflictFiles });
      } else {
        log(`  ✗ Failed: ${result.message}`);
        failed.push({ branch, error: result.message });
        log(`  ⚠ Stopping further merges. Rollback with: git reset --hard ${originalHead.ok ? originalHead.output : 'HEAD'}`);
        break; // Stop merging to prevent inconsistent state
      }
    } else {
      log(`  ✓ Merged`);
      merged.push(branch);
    }
  }

  // Step 3: Summary — use originalHead for accurate diff
  let totalChanged = null;
  if (merged.length > 0 && originalHead.ok) {
    const diffResult = git(['diff', '--stat', originalHead.output, 'HEAD', '--shortstat'], cwd);
    totalChanged = diffResult.ok ? diffResult.output : null;
  }

  log(`\n═══ Merge Summary ═══`);
  log(`  Merged: ${merged.length}/${branches.length}`);
  if (conflicts.length > 0) log(`  Conflicts: ${conflicts.length} (aborted)`);
  if (failed.length > 0) log(`  Failed: ${failed.length}`);
  if (typeof totalChanged === 'string') log(`  Stats: ${totalChanged}`);

  const result = {
    success: conflicts.length === 0 && failed.length === 0,
    target,
    merged,
    conflicts,
    failed,
    total: branches.length,
    stats: typeof totalChanged === 'string' ? totalChanged : null,
  };

  writeResultFile(resultFile, result);

  if (result.success) {
    log('\n✓ All branches merged successfully');
  } else {
    log('\n⚠ Some branches could not be merged');
  }

  process.exit(result.success ? 0 : 1);
}

main();
