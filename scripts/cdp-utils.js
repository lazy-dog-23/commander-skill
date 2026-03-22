/**
 * cdp-utils.js — CDP WebSocket 共享工具
 *
 * 提供 fetchJSON, connectWS, sleep, evalJS 等基础能力，
 * 供 create-agent.js 和 send-to-agent.js 共用。
 *
 * 架构说明：
 * - Agent Manager 是一个 SPA（单页应用），CDP target 始终为 title: "Manager"
 * - SPA 内部导航（如选择工作区、切换会话）不会改变 CDP WebSocket 连接
 * - 因此不需要 reconnect，只需在导航后轮询 DOM 就绪状态
 */

// Bypass system proxy to prevent localhost requests from being intercepted
if (!process.env.NO_PROXY) process.env.NO_PROXY = 'localhost,127.0.0.1,::1';

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');

const CDP_HOST = '127.0.0.1';
const CDP_PORT = process.env.CDP_PORT || 9000;
const TMP_DIR = os.tmpdir();

/**
 * Log with immediate flush + optional file dual-write.
 *
 * stdout: fs.writeSync(1, ...) writes directly to stdout fd, bypassing
 * Node.js stream buffer. Ensures output is visible in TTY/sync scenarios.
 *
 * File: When setLogFile() has been called, every log line is also appended
 * to the log file. This is the reliable fallback when command_status
 * returns "No output" for long-running background commands.
 */
let _logFile = null;

function setLogFile(filepath) {
  _logFile = filepath;
  // Ensure directory exists and truncate any existing log
  const dir = require('path').dirname(filepath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filepath, '');
}

function log(...args) {
  const line = args.join(' ') + '\n';
  try { fs.writeSync(1, line); } catch (e) { /* EPIPE or closed fd */ }
  if (_logFile) {
    try { fs.appendFileSync(_logFile, line); } catch (e) { /* ignore */ }
  }
}

function fetchJSON(u) {
  return new Promise((r, j) => {
    const req = http.get(u, { timeout: 5000 }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return j(new Error(`fetchJSON ${u} returned HTTP ${res.statusCode}`));
      }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { r(JSON.parse(d)); }
        catch (e) { j(new Error(`fetchJSON: invalid JSON from ${u} — ${d.substring(0, 200)}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(); j(new Error(`fetchJSON: timeout after 5s for ${u}`)); });
    req.on('error', j);
  });
}

function connectWS(wsUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    const s = net.createConnection({ host: url.hostname, port: url.port || 80 }, () => {
      s.write(`GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    // Connection timeout — prevent infinite hang if CDP doesn't respond
    s.setTimeout(10000, () => { s.destroy(); reject(new Error('WebSocket connection timeout (10s)')); });
    let hd = false, buf = Buffer.alloc(0), mid = 1, cbs = {};
    s.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (!hd) {
        const h = buf.indexOf('\r\n\r\n');
        if (h !== -1) {
          hd = true; buf = buf.slice(h + 4);
          s.setTimeout(0); // Clear connection timeout after successful handshake
          s.removeListener('error', reject); // Prevent stale reject calls
          resolve({
            send(method, params = {}) {
              return new Promise((res, rej) => {
                const id = mid++;
                cbs[id] = { resolve: res, reject: rej, timer: null };
                const msg = Buffer.from(JSON.stringify({ id, method, params }));
                const mask = crypto.randomBytes(4);
                let hdr;
                if (msg.length < 126) { hdr = Buffer.alloc(6); hdr[0] = 0x81; hdr[1] = 0x80 | msg.length; mask.copy(hdr, 2); }
                else if (msg.length <= 65535) { hdr = Buffer.alloc(8); hdr[0] = 0x81; hdr[1] = 0x80 | 126; hdr.writeUInt16BE(msg.length, 2); mask.copy(hdr, 4); }
                else { hdr = Buffer.alloc(14); hdr[0] = 0x81; hdr[1] = 0x80 | 127; hdr.writeBigUInt64BE(BigInt(msg.length), 2); mask.copy(hdr, 10); }
                const masked = Buffer.alloc(msg.length);
                for (let i = 0; i < msg.length; i++) masked[i] = msg[i] ^ mask[i % 4];
                s.write(Buffer.concat([hdr, masked]));
                const timer = setTimeout(() => { if (cbs[id]) { delete cbs[id]; rej(new Error('Timeout')); } }, 10000);
                cbs[id].timer = timer;
              });
            },
            close() { s.end(); }
          });
        }
      } else {
        while (buf.length > 2) {
          const sb = buf[1] & 0x7f;
          let pl, hl;
          if (sb < 126) { pl = sb; hl = 2; }
          else if (sb === 126) { if (buf.length < 4) break; pl = buf.readUInt16BE(2); hl = 4; }
          else { if (buf.length < 10) break; pl = Number(buf.readBigUInt64BE(2)); hl = 10; }
          if (buf.length < hl + pl) break;
          try {
            const m = JSON.parse(buf.slice(hl, hl + pl).toString());
            if (m.id && cbs[m.id]) { clearTimeout(cbs[m.id].timer); m.error ? cbs[m.id].reject(new Error(m.error.message)) : cbs[m.id].resolve(m.result); delete cbs[m.id]; }
          } catch (e) {}
          buf = buf.slice(hl + pl);
        }
      }
    });
    s.on('error', reject);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function evalJS(ws, expr) {
  const r = await ws.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  return r.result?.value;
}

/**
 * Connect to the Agent Manager page via CDP.
 * @returns {{ ws, mgr }}
 */
async function connectToManager() {
  const ts = await fetchJSON(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const mgr = ts.find(t => t.type === 'page' && t.title === 'Manager');
  if (!mgr) throw new Error('Manager page not found. Available: ' + ts.filter(t => t.type === 'page').map(t => t.title).join(', '));
  const ws = await connectWS(mgr.webSocketDebuggerUrl);
  return { ws, mgr };
}

/**
 * Wait for the chat input to be ready on the current page.
 * Polls contenteditable element until it exists and is visible.
 * Use this INSTEAD of reconnectToManager after SPA navigation.
 *
 * @param {object} ws - existing CDP WebSocket (stays valid during SPA navigation)
 * @param {number} maxWaitMs - maximum wait time (default 8s)
 * @returns {string} 'READY', 'NO_INPUT', or 'TIMEOUT'
 */
async function waitForChatReady(ws, maxWaitMs = 8000) {
  const polls = Math.ceil(maxWaitMs / 500);
  for (let i = 0; i < polls; i++) {
    try {
      const status = await evalJS(ws, `
        (() => {
          const ci = document.querySelector('[contenteditable][role="textbox"]');
          if (!ci) return 'NO_INPUT';
          if (ci.offsetHeight <= 0) return 'NOT_VISIBLE';
          return 'READY';
        })()
      `);
      if (status === 'READY') return 'READY';
    } catch (e) {
      // WS might break during navigation — rare but possible
      log(`  waitForChatReady: poll ${i + 1} error: ${e.message}`);
    }
    await sleep(500);
  }
  return 'TIMEOUT';
}

/**
 * Focus the chat input and clear existing content.
 * @returns {string} 'FOCUSED' or 'NO_INPUT'
 */
async function focusChatInput(ws) {
  return await evalJS(ws, `
    (() => {
      const ci = document.querySelector('[contenteditable][role="textbox"]');
      if (!ci) return 'NO_INPUT';
      ci.focus();
      ci.innerHTML = '';
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(ci);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch(e) {}
      return 'FOCUSED';
    })()
  `);
}

/**
 * Type text into focused input via CDP, then verify it was inserted.
 * Retries up to 3 times if verification fails.
 * @returns {string} 'OK' or 'VERIFY_FAILED'
 */
async function insertText(ws, text) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await ws.send('Input.insertText', { text });
    await sleep(300);

    // Verify text was actually inserted
    const actualLen = await evalJS(ws, `
      (() => {
        const ci = document.querySelector('[contenteditable][role="textbox"]');
        return ci ? ci.textContent.length : 0;
      })()
    `);

    if (actualLen && actualLen > 0) return 'OK';

    log(`  insertText attempt ${attempt + 1} failed (len=${actualLen}), retrying...`);
    await focusChatInput(ws);
    await sleep(500);
  }
  return 'VERIFY_FAILED';
}

/**
 * Click the "Send" button, or fall back to Enter key.
 * @returns {string} 'SENT_BUTTON', 'SENT_ENTER', or error string
 */
async function clickSend(ws) {
  const btnResult = await evalJS(ws, `
    (() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const sendBtn = btns.find(b => b.textContent.trim() === 'Send');
      if (sendBtn && !sendBtn.disabled) { sendBtn.click(); return 'SENT_BUTTON'; }
      return 'NO_TEXT_BUTTON';
    })()
  `);
  if (btnResult === 'SENT_BUTTON') return 'SENT_BUTTON';

  try {
    await ws.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await ws.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    return 'SENT_ENTER';
  } catch (e) {
    return 'ENTER_FAILED:' + e.message;
  }
}

/**
 * Find and click a conversation by name in the sidebar.
 * 3-level: direct match → expand workspace → expand "See all"
 *
 * @param {object} ws - CDP WebSocket
 * @param {string} target - conversation name to match
 * @param {string} workspace - workspace name for scoping
 * @param {object} [options] - additional options
 * @param {boolean} [options.skipActive=true] - skip active conversation (true for create, false for send)
 * @returns {string} 'FOUND:...', 'ALREADY_ACTIVE:...', or 'NOT_FOUND'
 */
async function findAndClickConversation(ws, target, workspace, options = {}) {
  const { skipActive = true } = options;
  const escaped = escapeForJS(target);

  const search = async () => {
    return await evalJS(ws, `
      (() => {
        const btns = Array.from(document.querySelectorAll('button'));

        // First pass: check if target is ALREADY the active conversation
        const active = btns.find(b => {
          const cls = b.className || '';
          if (!cls.includes('cursor-pointer')) return false;
          const isActive = cls.includes('bg-sidebar-accent') || cls.includes('bg-accent') || b.getAttribute('aria-current') === 'true';
          if (!isActive) return false;
          const text = b.textContent.trim();
          return text.startsWith('${escaped}') || text.includes('${escaped}');
        });
        if (active && !${skipActive}) {
          return 'ALREADY_ACTIVE:' + active.textContent.trim().substring(0, 40);
        }

        // Second pass: search non-active conversations (or all if skipActive=false)
        const matches = btns.filter(b => {
          const cls = b.className || '';
          if (!cls.includes('cursor-pointer')) return false;
          if (${skipActive}) {
            // Skip active conversation (create mode: avoid clicking self)
            if (cls.includes('bg-sidebar-accent') || cls.includes('bg-accent') || b.getAttribute('aria-current') === 'true') return false;
          }
          const text = b.textContent.trim();
          return text.startsWith('${escaped}') || text.includes('${escaped}');
        });
        if (matches.length === 0) return 'NOT_FOUND';
        // Pick best match: shortest text = most precise (avoids prefix collisions)
        matches.sort((a, b) => a.textContent.trim().length - b.textContent.trim().length);
        const best = matches[0];
        best.click();
        return 'FOUND:' + best.textContent.trim().substring(0, 40) + (matches.length > 1 ? ' (' + matches.length + ' matches, picked shortest)' : '');
      })()
    `);
  };

  let found = await search();
  if (found.startsWith('FOUND') || found.startsWith('ALREADY_ACTIVE')) return found;

  if (workspace) {
    const escapedWS = escapeForJS(workspace);
    await evalJS(ws, `
      (() => {
        const btns = Array.from(document.querySelectorAll('button[class*="cursor"]'));
        const wsBtn = btns.find(b => b.textContent.trim().startsWith('${escapedWS}'));
        if (wsBtn) { wsBtn.click(); return 'EXPANDED'; }
        return 'WS_NOT_FOUND';
      })()
    `);
    await sleep(500);
    found = await search();
    if (found.startsWith('FOUND') || found.startsWith('ALREADY_ACTIVE')) return found;
  }

  const seeAllResult = await evalJS(ws, `
    (() => {
      const seeAlls = Array.from(document.querySelectorAll('span[role="button"]'))
        .filter(s => s.textContent.trim().startsWith('See all'));
      if (seeAlls.length > 0) { seeAlls.forEach(s => s.click()); return 'SEE_ALL:' + seeAlls.length; }
      return 'NO_SEE_ALL';
    })()
  `);
  if (seeAllResult.startsWith('SEE_ALL')) {
    await sleep(1000);
    found = await search();
    if (found.startsWith('FOUND') || found.startsWith('ALREADY_ACTIVE')) return found;
  }

  return 'NOT_FOUND';
}

function escapeForJS(str) {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')        // Block ${} template injection
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\0/g, '\\0')        // Null byte
    .replace(/\u2028/g, '\\u2028') // Unicode line separator
    .replace(/\u2029/g, '\\u2029'); // Unicode paragraph separator
}

function parseArg(args, name, defaultVal = null) {
  const idx = args.indexOf(name);
  return (idx !== -1 && idx + 1 < args.length) ? args[idx + 1] : defaultVal;
}

/**
 * Parse all values following a flag until next -- flag or end of args.
 * Used for multi-value flags like --prompt-files, --branches, --files.
 */
function parseMultiArg(args, name) {
  const idx = args.indexOf(name);
  if (idx === -1) return [];
  const values = [];
  for (let i = idx + 1; i < args.length; i++) {
    if (args[i].startsWith('--')) break;
    values.push(args[i]);
  }
  return values;
}

function writeResultFile(filepath, data) {
  if (filepath) {
    const p = require('path');
    const dir = p.dirname(filepath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Atomic write: write to .tmp then rename
    const tmp = filepath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filepath);
    log('Result written to:', filepath);
  }
}

module.exports = {
  CDP_HOST, CDP_PORT, TMP_DIR, log, setLogFile,
  fetchJSON, connectWS, sleep, evalJS,
  connectToManager, waitForChatReady,
  focusChatInput, insertText, clickSend,
  findAndClickConversation, escapeForJS,
  parseArg, parseMultiArg, writeResultFile,
};
