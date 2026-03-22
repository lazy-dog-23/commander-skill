#!/usr/bin/env node
/**
 * index.js — Commander 脚本工具集统一入口
 *
 * 用法：
 *   node scripts/index.js <command> [options]
 *
 * 命令：
 *   list                          列出 CDP targets
 *   create  [options]             创建单个子 Agent
 *   batch   [options]             批量创建子 Agent（Map-Reduce）
 *   send    [options]             向已有会话发送消息
 *   wait    [options]             等待信号文件
 *   merge   [options]             合并 Git 分支
 *   template [options]            填充 Prompt 模板
 *   help                          显示帮助
 *
 * 示例：
 *   node scripts/index.js list
 *   node scripts/index.js create --prompt "任务" --workspace "test"
 *   node scripts/index.js batch --prompt-files p1.md p2.md --workspace "test"
 *   node scripts/index.js send --target "会话名" --prompt "消息"
 *   node scripts/index.js wait --file .commander/{taskId}/done.json --timeout 600
 *   node scripts/index.js merge --branches sub-1 sub-2 --target main
 *   node scripts/index.js template --template templates/single-task.md --output .commander/{taskId}/prompt.md --var "KEY=VAL"
 */

const path = require('path');
const { log } = require('./cdp-utils');

const COMMANDS = {
  list:     { script: 'create-agent.js', inject: ['--list'],     desc: '列出 CDP targets' },
  create:   { script: 'create-agent.js', inject: [],             desc: '创建单个子 Agent' },
  batch:    { script: 'create-agent.js', inject: ['--batch'],    desc: '批量创建子 Agent' },
  send:     { script: 'send-to-agent.js', inject: [],            desc: '向已有会话发送消息' },
  wait:     { script: 'wait-signal.js',   inject: [],            desc: '等待信号文件' },
  merge:    { script: 'merge-branches.js', inject: [],           desc: '合并 Git 分支' },
  template: { script: 'fill-template.js',  inject: [],           desc: '填充 Prompt 模板' },
};

function showHelp() {
  log('Commander 脚本工具集\n');
  log('用法: node scripts/index.js <command> [options]\n');
  log('命令:');
  const maxLen = Math.max(...Object.keys(COMMANDS).map(k => k.length));
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    log(`  ${name.padEnd(maxLen + 2)} ${cmd.desc}`);
  }
  log(`  ${'help'.padEnd(maxLen + 2)} 显示此帮助\n`);
  log('示例:');
  log('  node scripts/index.js list');
  log('  node scripts/index.js create --prompt "任务" --workspace "Playground"');
  log('  node scripts/index.js batch --prompt-files p1.md p2.md --workspace "ws"');
  log('  node scripts/index.js wait --file .commander/{id}/done.json --timeout 600');
  log('  node scripts/index.js merge --branches sub-1 sub-2 --target main');
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    showHelp();
    process.exit(0);
  }

  const cmd = COMMANDS[command];
  if (!cmd) {
    log(`未知命令: "${command}"\n`);
    showHelp();
    process.exit(1);
  }

  // Build new argv: [node, target-script, ...injected-flags, ...remaining-args]
  const targetScript = path.join(__dirname, cmd.script);
  const remainingArgs = args.slice(1);
  process.argv = [process.argv[0], targetScript, ...cmd.inject, ...remainingArgs];

  // Load and run the target script
  require(targetScript);
}

main();
