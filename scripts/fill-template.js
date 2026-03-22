/**
 * fill-template.js — Prompt 模板变量替换
 *
 * 读取模板文件，替换 {{VAR}} 占位符，输出到指定文件。
 * Commander 用此脚本生成子 Agent 的 prompt，避免生成大段 boilerplate。
 *
 * 用法：
 *   node fill-template.js --template templates/single-task.md --output .commander/{taskId}/prompt.md \
 *     --var "TASK_GOAL=实现用户登录" \
 *     --var "STEPS=1. 创建 API\n2. 添加验证" \
 *     --var "BRANCH=sub-20260321-1"
 *
 *   # 也可以从 JSON 文件读取变量
 *   node fill-template.js --template templates/single-task.md --output .commander/{taskId}/prompt.md \
 *     --vars-file .commander/{taskId}/vars.json
 */

const fs = require('fs');
const path = require('path');
const { log, parseArg } = require('./cdp-utils');

function main() {
  const args = process.argv.slice(2);

  const templatePath = parseArg(args, '--template');
  const outputPath = parseArg(args, '--output');
  const varsFile = parseArg(args, '--vars-file');
  const strict = args.includes('--strict');

  if (!templatePath || !outputPath) {
    log('Usage:');
    log('  node fill-template.js --template <template.md> --output <output.md> --var "KEY=VALUE" [--var "KEY2=VALUE2"]');
    log('  node fill-template.js --template <template.md> --output <output.md> --vars-file <vars.json>');
    process.exit(0);
  }

  // Resolve template path relative to scripts dir
  const scriptsDir = __dirname;
  const resolvedTemplate = path.isAbsolute(templatePath)
    ? templatePath
    : path.join(scriptsDir, templatePath);

  if (!fs.existsSync(resolvedTemplate)) {
    log('ERROR: Template not found:', resolvedTemplate);
    process.exit(1);
  }

  // Collect variables
  const vars = {};

  // From --vars-file
  if (varsFile) {
    if (!fs.existsSync(varsFile)) {
      log('ERROR: Vars file not found:', varsFile);
      process.exit(1);
    }
    try {
      const jsonVars = JSON.parse(fs.readFileSync(varsFile, 'utf-8'));
      Object.assign(vars, jsonVars);
    } catch (e) {
      log('ERROR: Invalid JSON in vars file:', varsFile, e.message);
      process.exit(1);
    }
  }

  // From --var arguments (can appear multiple times)
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--var' && i + 1 < args.length) {
      const val = args[i + 1];
      const eqIdx = val.indexOf('=');
      if (eqIdx > 0) {
        const key = val.substring(0, eqIdx);
        const value = val.substring(eqIdx + 1)
          .replace(/\\n/g, '\n')  // Support \n in values
          .replace(/\\t/g, '\t');
        vars[key] = value;
      }
      i++; // skip value
    }
  }

  log(`Template: ${resolvedTemplate}`);
  log(`Variables: ${Object.keys(vars).join(', ')}`);

  // Read and substitute
  let content = fs.readFileSync(resolvedTemplate, 'utf-8');

  for (const [key, value] of Object.entries(vars)) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\{\\{${escapedKey}\\}\\}`, 'g');
    content = content.replace(pattern, () => value);  // Function form: prevents $& $' $` special patterns
  }

  // Warn about unreplaced variables
  const unreplaced = content.match(/\{\{[A-Za-z0-9_-]+\}\}/g);
  if (unreplaced) {
    const unique = [...new Set(unreplaced)];
    log(`WARNING: Unreplaced variables: ${unique.join(', ')}`);
    if (strict) {
      log('ERROR: --strict mode enabled, exiting due to unreplaced variables');
      process.exit(1);
    }
  }

  // Write output
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(outputPath, content, 'utf-8');
  log(`Output written to: ${outputPath} (${content.length} chars)`);
}

main();
