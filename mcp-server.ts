import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import readline from 'node:readline';

// ─── WebSocket Server (for Chrome extension on ws://127.0.0.1:18765) ───

const WS_PORT = 18765;
let extWs: WebSocket | null = null;
let extTabs: { id: number; url: string; title: string }[] = [];

const healthSvr = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Browser MCP OK');
});

const wss = new WebSocketServer({ server: healthSvr });

wss.on('connection', (ws) => {
  console.error('[ws] Extension connected');
  extWs = ws;
  ws.on('message', (data) => {
    let msg: any;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'ext_ready' || msg.type === 'tabs_update') {
      extTabs = msg.tabs || [];
    } else if (msg.type === 'result' || msg.type === 'error') {
      resolvePending(msg);
    }
  });
  ws.on('close', () => { extWs = null; extTabs = []; });
  ws.on('error', () => { extWs = null; extTabs = []; });
});

healthSvr.listen(WS_PORT, () => {
  console.error(`[ws] Listening on :${WS_PORT}`);
});

// ─── Pending request map ───

const pending = new Map<string, {
  resolve: (v: any) => void;
  reject: (e: any) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

function resolvePending(msg: any) {
  const p = pending.get(msg.id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(msg.id);
  if (msg.type === 'result') p.resolve(msg);
  else p.reject(new Error(
    typeof msg.error === 'string' ? msg.error : msg.error?.message || 'Unknown error',
  ));
}

function sendToExt(tabId: number | undefined, code: string, ms = 30000): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!extWs || extWs.readyState !== WebSocket.OPEN) {
      return reject(new Error('Extension not connected'));
    }
    // Don't require tabId - cmd-based handlers (tabs, cookies) work without it.
    // For JS eval or CDP, tabId is needed. If none provided, try extTabs.
    let tid = tabId;
    if (tid === undefined) {
      const a = extTabs.find(t => t.url && !t.url.startsWith('chrome-extension://'));
      tid = a?.id ?? extTabs[0]?.id;
    }

    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Timeout')); }, ms);
    pending.set(id, { resolve, reject, timer });
    extWs!.send(JSON.stringify({ id, code, tabId: tid }));
  });
}

function cdpCmd(tabId: number | undefined, method: string, params: any = {}): Promise<any> {
  return sendToExt(tabId, JSON.stringify({ cmd: 'cdp', method, params }));
}

function jsEval(tabId: number | undefined, expression: string): Promise<any> {
  return cdpCmd(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
}

// ─── MCP protocol over stdio (JSON-RPC 2.0) ───

const toolsDef = [
  {
    name: 'navigate',
    description: 'Navigate to a URL in the browser',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' }, tabId: { type: 'number' } },
      required: ['url'],
    },
  },
  {
    name: 'snapshot',
    description: 'Get page text content',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number' } },
    },
  },
  {
    name: 'click',
    description: 'Click an element by CSS selector',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' }, tabId: { type: 'number' } },
      required: ['selector'],
    },
  },
  {
    name: 'screenshot',
    description: 'Take screenshot (returns base64 PNG)',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number' } },
    },
  },
  {
    name: 'evaluate',
    description: 'Execute JavaScript in page MAIN world',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string' }, tabId: { type: 'number' } },
      required: ['code'],
    },
  },
  {
    name: 'tabs',
    description: 'List open browser tabs',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'connect',
    description: 'Check if browser extension is connected',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'open_tab',
    description: 'Open a new browser tab with a URL',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' }, active: { type: 'boolean' } },
      required: ['url'],
    },
  },
  {
    name: 'close_tab',
    description: 'Close a browser tab by tabId',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number' } },
      required: ['tabId'],
    },
  },
  {
    name: 'switch_tab',
    description: 'Switch to a specific tab (bring it to front)',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number' } },
      required: ['tabId'],
    },
  },
  {
    name: 'type',
    description: 'Type text into the focused element via CDP Input.insertText',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, tabId: { type: 'number' } },
      required: ['text'],
    },
  },
  {
    name: 'fill',
    description: 'Fill an input/textarea by CSS selector, dispatching input/change events',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' }, value: { type: 'string' }, tabId: { type: 'number' } },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'press_key',
    description: 'Press a keyboard key (e.g. Enter, Escape, Tab, ArrowDown, Backspace)',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' }, tabId: { type: 'number' } },
      required: ['key'],
    },
  },
  {
    name: 'wait_for',
    description: 'Poll for a CSS selector to appear on the page (100ms interval, default 10s timeout)',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' }, timeout: { type: 'number', description: 'Max wait in ms, default 10000' }, tabId: { type: 'number' } },
      required: ['selector'],
    },
  },
];

function extData(r: any): any {
  return r?.result;
}

async function handleTool(name: string, args: any): Promise<any> {
  const tabId = args?.tabId as number | undefined;

  try {
    switch (name) {
      case 'connect':
        return {
          content: [{
            type: 'text',
            text: extWs
              ? `Connected. Tabs: ${extTabs.length}`
              : 'Not connected. Load extension in Chrome.',
          }],
        };

      case 'tabs': {
        const r = await sendToExt(tabId, JSON.stringify({ cmd: 'tabs' }));
        return { content: [{ type: 'text', text: JSON.stringify(extData(r), null, 2) }] };
      }

      case 'navigate': {
        const url = args!.url as string;
        const r = await cdpCmd(tabId, 'Page.navigate', { url });
        const d = extData(r);
        return { content: [{ type: 'text', text: d?.result?.url ? `Navigated to ${url}` : JSON.stringify(d) }] };
      }

      case 'snapshot': {
        const r = await jsEval(tabId, `(()=>{const L=[];L.push('Title: '+document.title);L.push('URL: '+location.href);document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,a,button,input,textarea,select,label,li,td,th,option,[role]').forEach(el=>{const r=el.getBoundingClientRect();if(r.width===0&&r.height===0)return;const t=el.tagName.toLowerCase();let s='  '+t;if(el.id)s+='#'+el.id;if(el.className&&typeof el.className==='string'){const c=el.className.trim().split(/\s+/).slice(0,2).join('.');if(c)s+='.'+c}const role=el.getAttribute('role');if(role)s+='[role='+role+']';if(el.href)s+=' -> '+el.href;if(el.type)s+=' type='+el.type;if(el.name)s+=' name='+el.name;if(el.placeholder)s+=' ph='+el.placeholder;const v=el.value;if(v!==undefined&&v!==null)s+=' val='+String(v).slice(0,30);if(el.checked)s+=' CHECKED';if(el.disabled)s+=' DISABLED';const tx=(el.textContent||'').trim().slice(0,80);if(tx)s+=' "'+tx.replace(/"/g,'\\\\"')+'"';L.push(s)});return L.join(String.fromCharCode(10))})()`);
        const d = extData(r);
        const txt = d?.result?.value ?? '';
        return { content: [{ type: 'text', text: String(txt) }] };
      }

      case 'click': {
        const sel = args!.selector as string;
        const r = await jsEval(tabId, `(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)throw new Error('Not found');el.scrollIntoView({block:'center'});el.click();return 'clicked';})()`);
        const d = extData(r);
        const txt = d?.result?.value ?? d?.exceptionDetails?.exception?.description ?? JSON.stringify(d);
        return { content: [{ type: 'text', text: String(txt) }] };
      }

      case 'screenshot': {
        const format = (args?.format as string) || 'png';
        let r = await cdpCmd(tabId, 'Page.captureScreenshot', { format, fromSurface: true });
        let d = extData(r);
        let b64: string = d?.data;
        if (b64 && format === 'png' && b64.length > 500000) {
          r = await cdpCmd(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: 60, fromSurface: true });
          d = extData(r);
          b64 = d?.data;
          if (b64) return { content: [{ type: 'image', data: b64, mimeType: 'image/jpeg' }] };
        }
        if (b64) return { content: [{ type: 'image', data: b64, mimeType: 'image/' + format }] };
        return { content: [{ type: 'text', text: JSON.stringify(d) }] };
      }

      case 'evaluate': {
        const code = args!.code as string;
        const r = await jsEval(tabId, code);
        const d = extData(r);
        const txt = d?.result?.value !== undefined ? JSON.stringify(d.result.value) : (d?.exceptionDetails?.exception?.description ?? JSON.stringify(d));
        return { content: [{ type: 'text', text: txt }] };
      }

      case 'open_tab': {
        const url = args!.url as string;
        const active = args?.active ?? true;
        const r = await sendToExt(undefined, JSON.stringify({ cmd: 'tabs', method: 'create', url, active }));
        const d = extData(r);
        return { content: [{ type: 'text', text: JSON.stringify(d) }] };
      }

      case 'close_tab': {
        const closeTabId = args!.tabId as number;
        const r = await sendToExt(undefined, JSON.stringify({ cmd: 'tabs', method: 'close', tabId: closeTabId }));
        const d = extData(r);
        return { content: [{ type: 'text', text: JSON.stringify(d) }] };
      }

      case 'switch_tab': {
        const switchTabId = args!.tabId as number;
        const r = await sendToExt(undefined, JSON.stringify({ cmd: 'tabs', method: 'switch', tabId: switchTabId }));
        const d = extData(r);
        return { content: [{ type: 'text', text: JSON.stringify(d) }] };
      }

      case 'type': {
        const text = args!.text as string;
        await cdpCmd(tabId, 'Input.insertText', { text });
        return { content: [{ type: 'text', text: 'typed' }] };
      }

      case 'fill': {
        const sel = args!.selector as string;
        const val = args!.value as string;
        const r = await jsEval(tabId, `(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)throw new Error('Element not found');const tag=el.tagName;const proto=tag==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;if(setter)setter.call(el,${JSON.stringify(val)});else el.value=${JSON.stringify(val)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return 'filled'})()`);
        const d = extData(r);
        const txt = d?.result?.value ?? d?.exceptionDetails?.exception?.description ?? JSON.stringify(d);
        return { content: [{ type: 'text', text: String(txt) }] };
      }

      case 'press_key': {
        const key = args!.key as string;
        await cdpCmd(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key });
        if (key.length === 1) {
          await cdpCmd(tabId, 'Input.dispatchKeyEvent', { type: 'char', text: key });
        }
        await cdpCmd(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key });
        return { content: [{ type: 'text', text: 'pressed ' + key }] };
      }

      case 'wait_for': {
        const sel = args!.selector as string;
        const timeout = (args?.timeout as number) || 10000;
        const start = Date.now();
        while (Date.now() - start < timeout) {
          const r = await jsEval(tabId, `!!document.querySelector(${JSON.stringify(sel)})`);
          const d = extData(r);
          if (d?.result?.value) return { content: [{ type: 'text', text: 'Found: ' + sel }] };
          await new Promise(r => setTimeout(r, 100));
        }
        return { content: [{ type: 'text', text: 'Timeout waiting for: ' + sel }], isError: true };
      }

      default:
        return { content: [{ type: 'text', text: 'Unknown tool' }], isError: true };
    }
  } catch (e: any) {
    return { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true };
  }
}

// ─── Read JSON-RPC from stdin ───

const rl = readline.createInterface({ input: process.stdin });
let initialized = false;

function respond(id: any, result: any, err?: any) {
  const msg: any = { jsonrpc: '2.0' };
  if (id !== undefined && id !== null) msg.id = id;
  if (err) {
    msg.error = { code: -32603, message: err.message || String(err) };
  } else {
    msg.result = result;
  }
  process.stdout.write(JSON.stringify(msg) + '\n');
}

rl.on('line', async (line) => {
  let req: any;
  try { req = JSON.parse(line); } catch { return; }

  // Notifications (no id)
  if (req.method === 'notifications/initialized') {
    initialized = true;
    return;
  }
  if (req.method === 'notifications/cancelled') return;

  const id = req.id;

  try {
    switch (req.method) {
      case 'initialize': {
        respond(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'browser-mcp', version: '1.0.0' },
        });
        break;
      }

      case 'tools/list': {
        respond(id, { tools: toolsDef });
        break;
      }

      case 'tools/call': {
        const { name, arguments: args } = req.params;
        const result = await handleTool(name, args);
        respond(id, result);
        break;
      }

      default:
        respond(id, null, new Error(`Unknown method: ${req.method}`));
    }
  } catch (e: any) {
    respond(id, null, e);
  }
});

process.stderr.write('Browser MCP server ready (raw stdio)\n');
