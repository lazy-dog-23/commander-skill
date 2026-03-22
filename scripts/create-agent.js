/**
 * create-agent.js v7 — Commander Skill 子 Agent 创建脚本
 *
 * 通过 CDP WebSocket 连接 Agent Manager 页面，
 * 点击 "Start conversation" 创建新对话，输入 prompt 并发送。
 *
 * 架构：Manager 是 SPA，CDP WebSocket 在内部导航时保持有效。
 *       不需要 reconnect，不需要 switch-back。
 *
 * 用法：
 *   node create-agent.js --list
 *   node create-agent.js --prompt "任务描述" --workspace "test"
 *   node create-agent.js --prompt-file ".commander/{taskId}/prompt.md" --workspace "test" --result-file ".commander/{taskId}/result.json"
 *
 *   # 批量模式：一次 CDP 连接创建多个 Agent（Map-Reduce 场景）
 *   node create-agent.js --batch --prompt-files ".commander/{taskId}/p1.md" ".commander/{taskId}/p2.md" --workspace "test" --result-file ".commander/{taskId}/batch-result.json"
 */


const fs = require('fs');
const {
  log, setLogFile, sleep, evalJS, connectToManager, waitForChatReady,
  focusChatInput, insertText, clickSend, escapeForJS,
  parseArg, parseMultiArg, writeResultFile,
} = require('./cdp-utils');

/**
 * Core flow: Start conversation → select workspace → wait ready → type → send
 * Reuses an existing CDP WebSocket connection.
 */
async function createOneAgent(ws, prompt, workspace, index, total) {
  const prefix = total > 1 ? `[Agent ${index}/${total}]` : '';
  const escapedWorkspace = escapeForJS(workspace);

  // Step 1: Click "Start conversation"
  log(`${prefix} [1/4] Clicking Start conversation...`);
  const clickResult = await evalJS(ws, `
    (() => {
      const spans = Array.from(document.querySelectorAll('span'));
      const startBtn = spans.find(s => s.textContent.trim() === 'Start conversation');
      if (!startBtn) return 'NOT_FOUND';
      startBtn.click();
      return 'CLICKED';
    })()
  `);
  log(`  Result: ${clickResult}`);
  if (clickResult === 'NOT_FOUND') {
    return { success: false, error: 'start_button_not_found' };
  }
  await sleep(1000);

  // Step 2: Select workspace
  log(`${prefix} [2/4] Selecting workspace: ${workspace}`);
  const wsResult = await evalJS(ws, `
    (() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const wsBtn = buttons.find(b => {
        const cls = b.className || '';
        if (!cls.includes('w-full') || !cls.includes('text-left')) return false;
        const divs = b.querySelectorAll('div.shrink-0, div');
        for (const d of divs) {
          if (d.textContent?.trim() === '${escapedWorkspace}' && d.children.length === 0) return true;
        }
        return false;
      });
      if (!wsBtn) {
        const available = buttons
          .filter(b => (b.className || '').includes('w-full') && (b.className || '').includes('text-left'))
          .map(b => b.textContent?.trim()?.split('\\n')[0])
          .filter(t => t);
        return 'NOT_FOUND. Available: ' + available.join(' | ');
      }
      wsBtn.click();
      return 'SELECTED:${escapedWorkspace}';
    })()
  `);
  log(`  Result: ${wsResult}`);

  await sleep(500);
  log('  Waiting for chat to load...');
  const readyStatus = await waitForChatReady(ws, 8000);
  log(`  Chat ready: ${readyStatus}`);

  if (readyStatus !== 'READY') {
    return { success: false, error: 'chat_not_ready', readyStatus };
  }

  // Step 3: Focus + type
  log(`${prefix} [3/4] Typing prompt...`);
  const focusResult = await focusChatInput(ws);
  log(`  Focus: ${focusResult}`);
  await sleep(300);

  const insertResult = await insertText(ws, prompt);
  log(`  Insert: ${insertResult} (${prompt.length} chars)`);
  if (insertResult === 'VERIFY_FAILED') {
    return { success: false, error: 'insert_text_failed' };
  }
  await sleep(300);

  // Step 4: Send
  log(`${prefix} [4/4] Sending...`);
  const sendResult = await clickSend(ws);
  log(`  Result: ${sendResult}`);

  if (sendResult.startsWith('SENT')) {
    log(`${prefix} ✓ Agent created!`);
    // Capture conversation title from sidebar (active conversation)
    await sleep(1500); // Wait for title to generate
    const convTitle = await evalJS(ws, `
      (() => {
        // Look for the active/current conversation button in sidebar
        const btns = Array.from(document.querySelectorAll('button'));
        const active = btns.find(b => {
          const cls = b.className || '';
          return cls.includes('cursor-pointer') && (cls.includes('bg-') || cls.includes('active'));
        });
        if (active) return active.textContent.trim().substring(0, 80);
        // Fallback: find first conversation button under current workspace
        const convBtns = btns.filter(b => (b.className || '').includes('cursor-pointer'));
        return convBtns.length > 0 ? convBtns[0].textContent.trim().substring(0, 80) : '';
      })()
    `);
    log(`  Conversation title: ${convTitle}`);
    return { success: true, promptLength: prompt.length, sendMethod: sendResult, conversationTitle: convTitle };
  } else {
    return { success: false, error: sendResult };
  }
}

async function main() {
  const args = process.argv.slice(2);

  // --list mode
  if (args.includes('--list')) {
    const { fetchJSON, CDP_HOST, CDP_PORT } = require('./cdp-utils');
    const ts = await fetchJSON(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
    log('Available targets:');
    ts.filter(t => t.type === 'page').forEach(t => log(`  - [${t.type}] ${t.title}`));
    process.exit(0);
  }

  // Enable log file if specified
  const logFile = parseArg(args, '--log-file');
  if (logFile) setLogFile(logFile);

  const workspace = parseArg(args, '--workspace', 'Playground');
  const resultFile = parseArg(args, '--result-file');
  const isBatch = args.includes('--batch');

  // ── Batch mode ──
  if (isBatch) {
    const promptFiles = parseMultiArg(args, '--prompt-files');
    if (promptFiles.length === 0) {
      log('ERROR: --batch requires --prompt-files <file1> <file2> ...');
      process.exit(1);
    }

    // Validate all files exist before starting
    for (const f of promptFiles) {
      if (!fs.existsSync(f)) { log('ERROR: Prompt file not found:', f); process.exit(1); }
    }

    const prompts = promptFiles.map(f => ({
      file: f,
      content: fs.readFileSync(f, 'utf-8').trim(),
    }));
    log(`Batch mode: ${prompts.length} agents to create`);
    prompts.forEach((p, i) => log(`  [${i + 1}] ${p.file} (${p.content.length} chars)`));

    // Increase timeout for batch: 30s per agent + 15s base
    const batchTimeout = 15000 + prompts.length * 30000;
    setTimeout(() => { log('\nTimeout — exiting'); process.exit(1); }, batchTimeout);

    // Single CDP connection for all
    log('\nConnecting to Agent Manager...');
    const { ws } = await connectToManager();
    log('  Connected\n');

    const results = [];
    for (let i = 0; i < prompts.length; i++) {
      log(`\n═══ Creating Agent ${i + 1}/${prompts.length} ═══`);
      const result = await createOneAgent(ws, prompts[i].content, workspace, i + 1, prompts.length);
      result.promptFile = prompts[i].file;
      result.workspace = workspace;
      result.timestamp = new Date().toISOString();
      results.push(result);

      if (!result.success) {
        log(`\n⚠ Agent ${i + 1} failed: ${result.error}`);
      }

      // Navigate back to Manager for next agent creation
      if (i < prompts.length - 1) {
        log('  Navigating back to Manager...');
        // Click "Start conversation" or the "+" button to return to manager view
        const navResult = await evalJS(ws, `
          (() => {
            // Try clicking "Start conversation" link/button
            const spans = Array.from(document.querySelectorAll('span, a, button'));
            const startBtn = spans.find(s => s.textContent.trim() === 'Start conversation');
            if (startBtn) { startBtn.click(); return 'CLICKED_START'; }
            // Try clicking the "+" new conversation button
            const plusBtn = spans.find(s => s.textContent.trim() === '+' || s.getAttribute('aria-label')?.includes('New'));
            if (plusBtn) { plusBtn.click(); return 'CLICKED_PLUS'; }
            return 'NO_NAV_BUTTON';
          })()
        `);
        log('  Nav result:', navResult);
        if (navResult === 'NO_NAV_BUTTON') {
          log('  ✗ Cannot navigate back to Manager — aborting remaining agents to prevent silent misroute');
          results.push(...prompts.slice(i + 1).map(p => ({
            success: false, error: 'aborted_no_nav_button', promptFile: p.file, workspace, timestamp: new Date().toISOString(),
          })));
          break;
        }
        // Simple delay for page transition — createOneAgent handles its own readiness checks
        await sleep(2000);
      }
    }

    const succeeded = results.filter(r => r.success).length;
    log(`\n═══ Batch complete: ${succeeded}/${prompts.length} succeeded ═══`);
    writeResultFile(resultFile, { batch: true, total: prompts.length, succeeded, results });

    ws.close();
    process.exit(succeeded === prompts.length ? 0 : 1);
  }

  // ── Single mode ──
  setTimeout(() => { log('\nTimeout — exiting'); process.exit(1); }, 45000);

  const promptFile = parseArg(args, '--prompt-file');
  const promptText = parseArg(args, '--prompt');

  let prompt;
  if (promptFile) {
    if (!fs.existsSync(promptFile)) { log('ERROR: Prompt file not found:', promptFile); process.exit(1); }
    prompt = fs.readFileSync(promptFile, 'utf-8').trim();
    log('Prompt loaded from file:', promptFile, `(${prompt.length} chars)`);
  } else if (promptText) {
    prompt = promptText;
  } else {
    log('Usage:');
    log('  node create-agent.js --list');
    log('  node create-agent.js --prompt "task" --workspace "Playground"');
    log('  node create-agent.js --prompt-file ".commander/{id}/prompt.md" --workspace "Playground" --result-file ".commander/{id}/result.json"');
    log('');
    log('Batch mode (Map-Reduce):');
    log('  node create-agent.js --batch --prompt-files ".commander/{id}/p1.md" ".commander/{id}/p2.md" --workspace "Playground" --result-file ".commander/{id}/batch.json"');
    process.exit(0);
  }

  log('Connecting to Agent Manager...');
  const { ws } = await connectToManager();
  log('  Connected');

  const result = await createOneAgent(ws, prompt, workspace, 1, 1);
  result.workspace = workspace;
  result.timestamp = new Date().toISOString();

  if (result.success) {
    log('\nSub-Agent created successfully!');
  } else {
    log('\nFailed:', result.error);
  }

  writeResultFile(resultFile, result);
  ws.close();
  process.exit(result.success ? 0 : 1);
}

main().catch(e => { log('Error:', e.message); process.exit(1); });
