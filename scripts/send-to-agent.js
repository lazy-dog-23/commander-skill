/**
 * send-to-agent.js v3 — 向已有会话发送消息
 *
 * 通过 CDP WebSocket 连接 Agent Manager 页面，
 * 找到指定名称的会话，输入消息并发送。
 *
 * 架构：Manager 是 SPA，点击侧边栏会话后 WS 保持有效。
 *
 * 用法：
 *   node send-to-agent.js --target "会话名称" --prompt "消息内容"
 *   node send-to-agent.js --target "会话名称" --prompt-file ".commander/{id}/msg.md"
 *   node send-to-agent.js --target "会话名称" --workspace "工作区" --prompt "消息"
 */

const fs = require('fs');
const {
  log, sleep, evalJS, connectToManager, waitForChatReady,
  focusChatInput, insertText, clickSend,
  findAndClickConversation,
  parseArg, writeResultFile,
} = require('./cdp-utils');

async function main() {
  const args = process.argv.slice(2);

  const timeoutSec = parseInt(parseArg(args, '--timeout', '60'), 10);
  setTimeout(() => { log(`\nTimeout after ${timeoutSec}s — exiting`); process.exit(1); }, timeoutSec * 1000);

  const target = parseArg(args, '--target');
  if (!target) {
    log('Usage:');
    log('  node send-to-agent.js --target "会话名称" --prompt "消息"');
    log('  node send-to-agent.js --target "会话名称" --prompt-file ".commander/{id}/msg.md"');
    log('  node send-to-agent.js --target "会话名称" --workspace "工作区" --prompt "消息"');
    process.exit(0);
  }

  const promptFile = parseArg(args, '--prompt-file');
  const promptText = parseArg(args, '--prompt');
  const workspace = parseArg(args, '--workspace');
  const resultFile = parseArg(args, '--result-file');

  let prompt;
  if (promptFile) {
    if (!fs.existsSync(promptFile)) { log('ERROR: File not found:', promptFile); process.exit(1); }
    prompt = fs.readFileSync(promptFile, 'utf-8').trim();
    log('Prompt loaded from file:', promptFile, `(${prompt.length} chars)`);
  } else if (promptText) {
    prompt = promptText;
  } else {
    log('ERROR: --prompt or --prompt-file required');
    process.exit(1);
  }

  const writeResult = (data) => writeResultFile(resultFile, data);

  // [1/4] Connect
  log('[1/4] Connecting to Agent Manager...');
  const { ws } = await connectToManager();
  log('  Connected');

  // [2/4] Find conversation → click it (SPA navigates, same WS)
  log(`[2/4] Finding conversation: "${target}"`);
  const found = await findAndClickConversation(ws, target, workspace, { skipActive: false });
  log('  Result:', found);

  if (found.startsWith('ALREADY_ACTIVE')) {
    log('  Target is already the active conversation — skipping click');
  } else if (found.startsWith('FOUND')) {
    log('  Clicked conversation, waiting for chat to load...');
    const readyStatus = await waitForChatReady(ws, 8000);
    log('  Chat ready:', readyStatus);
    if (readyStatus !== 'READY') {
      log('ERROR: Chat input not ready');
      writeResult({ success: false, error: 'chat_not_ready', target });
      ws.close(); process.exit(1);
    }
  } else {
    log('  ERROR: Conversation not found');
    writeResult({ success: false, error: 'conversation_not_found', target });
    ws.close();
    process.exit(1);
  }

  // [3/4] Focus + type
  log('[3/4] Typing message...');
  const focusResult = await focusChatInput(ws);
  log('  Focus:', focusResult);
  await sleep(300);

  const insertResult = await insertText(ws, prompt);
  log('  Insert:', insertResult, `(${prompt.length} chars)`);
  if (insertResult === 'VERIFY_FAILED') {
    log('ERROR: Text insertion failed after 3 retries');
    writeResult({ success: false, error: 'insert_text_failed', target });
    ws.close(); process.exit(1);
  }
  await sleep(300);

  // [4/4] Send
  log('[4/4] Sending message...');
  const sendResult = await clickSend(ws);
  log('  Result:', sendResult);

  if (sendResult.startsWith('SENT')) {
    log('\nMessage sent successfully!');
    writeResult({ success: true, target, promptLength: prompt.length, timestamp: new Date().toISOString() });
  } else {
    log('\nSend failed:', sendResult);
    writeResult({ success: false, error: sendResult, target, timestamp: new Date().toISOString() });
  }

  // 不做 switch-back — Manager 留在目标会话页面

  ws.close();
  process.exit(sendResult.startsWith('SENT') ? 0 : 1);
}

main().catch(e => { log('Error:', e.message); process.exit(1); });
