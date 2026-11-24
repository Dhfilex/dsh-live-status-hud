import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  apply as applyHost,
  inject as hostInject,
  HTTP_PATH_SNAPSHOT,
  HTTP_PATH_DEBUG,
  LiveStatusTracker,
  translateToolActivity,
  translateThoughtBufferToCuteZh,
} from '../lib/index.js';

test('Host apply() uses DSH 0.2.2-rc.3 webServer.register({ kind, path, handler }), loopback guard, and NEVER hooks tools/pre-execute', () => {
  const registeredEvents = [];
  const registeredRoutes = [];

  const mockCtx = {
    on(eventName) {
      registeredEvents.push(eventName);
      return () => {};
    },
    inject(deps, cb) {
      if (deps.includes('webServer')) {
        cb({
          webServer: {
            register(routeDef) {
              registeredRoutes.push(routeDef);
              return () => {};
            },
          },
        });
      }
      return () => {};
    },
    effect() {
      return () => {};
    },
  };

  applyHost(mockCtx, { locale: 'zh-CN' });

  for (const forbiddenWaterfall of [
    'tools/pre-execute',
    'tools/execute',
    'tools/post-execute',
    'llm/stream',
    'approval/request',
    'agent/pre-step',
    'agent/request-error',
    'agent/turn-stopping',
  ]) {
    assert.equal(registeredEvents.includes(forbiddenWaterfall), false, `Must NEVER hook waterfall event: ${forbiddenWaterfall}`);
  }
  assert.equal(registeredEvents.includes('session/event'), true);
  assert.equal(registeredEvents.includes('assistant/live-chunk'), true);
  assert.equal(registeredEvents.includes('agent/assistant-stream'), true);
  assert.equal(registeredEvents.includes('approval/asked'), true);
  assert.equal(registeredEvents.includes('approval/decided'), true);

  assert.equal(registeredRoutes.length, 3);
  assert.equal(registeredRoutes[0].kind, 'exact');
  assert.equal(registeredRoutes[0].path, HTTP_PATH_SNAPSHOT);
  assert.equal(registeredRoutes[1].kind, 'exact');
  assert.equal(registeredRoutes[1].path, HTTP_PATH_DEBUG);

  // Verify foreign Origin is rejected with 403
  let statusCode = 0;
  registeredRoutes[0].handler(
    { url: '/dsh-live-status-hud/snapshot', headers: { origin: 'https://evil.example.com' } },
    { setHeader() {}, end() {}, set statusCode(v) { statusCode = v; }, get statusCode() { return statusCode; } },
  );
  assert.equal(statusCode, 403);
});

test('Client bundle lib/client.cjs executes in browser VM via window.__ModuleLoader__.load without top-level require/exports', () => {
  const source = fs.readFileSync(new URL('../lib/client.cjs', import.meta.url), 'utf8');
  assert.ok(source.includes('window.__ModuleLoader__.load'));

  let registeredEntry = null;
  const sandboxWindow = {
    __ModuleLoader__: {
      load(entry) {
        registeredEntry = entry;
      },
    },
  };

  // Run inside a clean browser-like VM context with NO global `require` or `exports`!
  vm.runInNewContext(source, { window: sandboxWindow });

  assert.ok(registeredEntry, '__ModuleLoader__.load was not invoked');
  assert.equal(registeredEntry.id, 'dsh-live-status-hud');
  assert.equal(typeof registeredEntry.factory, 'function');

  const mod = registeredEntry.factory((id) => {
    if (id === 'react') {
      return {
        createElement: () => null,
        Fragment: Symbol('Fragment'),
        useState: (v) => [v, () => {}],
        useEffect: () => {},
        useMemo: (fn) => fn(),
        useRef: (v) => ({ current: v }),
      };
    }
    throw new Error(`Unexpected require: ${id}`);
  });

  assert.deepEqual([...mod.inject], ['slots']);
  assert.equal(typeof mod.apply, 'function');

  const injectedSlots = [];
  const registeredSlots = {};
  mod.apply({
    slots: {
      inject(slotName, cb) {
        injectedSlots.push(slotName);
        return cb();
      },
      register(meta, comp) {
        registeredSlots[meta.name] = { meta, comp };
        return () => {};
      },
    },
  });

  assert.ok(injectedSlots.includes('shell.overlay'));
  assert.ok(injectedSlots.includes('settings.section'));
  assert.deepEqual({ ...registeredSlots['shell.overlay'].meta }, { name: 'shell.overlay', id: 'live-status-hud' });
  assert.equal(registeredSlots['settings.section'].meta.id, 'live-status-hud-settings');
  const slotComp = registeredSlots['shell.overlay'].comp;
  assert.equal(typeof slotComp, 'function');

  // Verify LiveStatusOverlay passes a selector function to useSessions(selector) (DSH 0.2.2+ useSyncExternalStoreWithSelector)
  let receivedSelector = null;
  assert.doesNotThrow(() => {
    slotComp({
      useSessions(selector) {
        if (typeof selector !== 'function') {
          throw new TypeError('selector is not a function');
        }
        receivedSelector = selector;
        return selector({ currentSessionId: 's-1', sessions: [{ id: 's-1', status: 'idle' }] });
      },
    });
  });
  assert.equal(typeof receivedSelector, 'function');
});

test('LiveStatusTracker handles DSH 0.2.2-rc.3 approval/request, assistant/live-chunk, >6 steps, and persistent history', () => {
  const tracker = new LiveStatusTracker({ locale: 'zh-CN', persona: 'playful' });
  const sid = 'sess-022';

  tracker.handleEvent({ sessionId: sid, type: 'turn/start', timestamp: 1000 });
  tracker.handleEvent({
    sessionId: sid,
    type: 'assistant/live-chunk',
    data: { kind: 'reasoning', text: 'Let us check index.ts and verify the HTTP route returns real data.' },
    timestamp: 1500,
  });

  for (let i = 1; i <= 8; i++) {
    tracker.handleEvent({
      sessionId: sid,
      type: 'tool/call',
      data: { callId: `c-${i}`, name: 'read_file', arguments: { path: `src/file${i}.ts` } },
      timestamp: 2000 + i * 100,
    });
    tracker.handleEvent({
      sessionId: sid,
      type: 'tool/result',
      data: { callId: `c-${i}`, name: 'read_file' },
      timestamp: 2050 + i * 100,
    });
  }

  tracker.handleEvent({ sessionId: sid, type: 'approval/asked', data: { toolName: 'bash' }, timestamp: 3500 });
  assert.equal(tracker.getSnapshot(sid, 3600)?.phase, 'waiting_approval');

  tracker.handleEvent({ sessionId: sid, type: 'approval/decided', data: { decision: 'allow' }, timestamp: 3800 });
  assert.equal(tracker.getSnapshot(sid, 3900)?.phase, 'thinking');

  tracker.handleEvent({ sessionId: sid, type: 'turn/end', timestamp: 4500 });
  const doneSnap = tracker.getSnapshot(sid, 4600);
  assert.equal(doneSnap?.phase, 'done');
  assert.equal(doneSnap?.recentSteps.length, 8);
  assert.equal(doneSnap?.history.length, 1);
  assert.equal(doneSnap?.history[0].steps.length, 8);
  assert.ok(doneSnap?.thoughtSnippetZh && /[\u4e00-\u9fff]/.test(doneSnap.thoughtSnippetZh));

  const zh = translateThoughtBufferToCuteZh('Keep message short: HTTP route now returns real data.');
  assert.ok(zh.snippetZh && /[\u4e00-\u9fff]/.test(zh.snippetZh));

  // Verify >6 thought lines are preserved (up to 50) without overwriting earlier lines
  const longThought = [
    'Read file1.ts to check imports.',
    'Edit file2.ts to update routes.',
    'Check SQL table schema.',
    'Run git diff to verify changes.',
    'Check security origin header.',
    'Build package with pnpm.',
    'Inspect bubble layout style.',
    'Fix crash bug in test.',
    'Check HTTP snapshot endpoint.',
    'Prepare short reply for user.',
  ].join(' ');
  const longZh = translateThoughtBufferToCuteZh(longThought);
  const lines = longZh.bufferZh.split('\n').filter(Boolean);
  assert.ok(lines.length >= 8, `Expected >=8 (>6) thought lines preserved, got ${lines.length}`);
  const tool = translateToolActivity('bash', { command: 'pnpm test' }, 'zh-CN', 'playful', 1);
  assert.ok(tool.label.includes('运行自动化测试'), `Unexpected bash test label: ${tool.label}`);
  const pwshCopy = translateToolActivity('pwsh', { command: 'Copy-Item lib\\client.cjs dest\\' }, 'zh-CN', 'playful', 2);
  assert.ok(pwshCopy.label.includes('复制文件') && pwshCopy.label.includes('client.cjs'), `Unexpected pwsh label: ${pwshCopy.label}`);
  const pwshDir = translateToolActivity('pwsh', { command: 'Get-ChildItem -File -Filter *.mjs | Select-Object -First 5' }, 'zh-CN', 'playful', 3);
  assert.ok(pwshDir.label.includes('扫描目录文件') && pwshDir.label.includes('*.mjs') && !pwshDir.label.includes('Get-ChildItem'), `Unexpected dir label: ${pwshDir.label}`);
  const pwshHereStr = translateToolActivity('pwsh', { command: "$stamp = Get-Date -Format HHmm\n@'\nGet-Content package.json\n'@" }, 'zh-CN', 'playful', 4);
  assert.ok(!pwshHereStr.label.includes("@'") && !pwshHereStr.label.includes('$stamp') && pwshHereStr.label.includes('读取文件内容') && pwshHereStr.label.includes('package.json'), `Unexpected here-string label: ${pwshHereStr.label}`);
});

test('HTTP snapshot endpoint returns 304 Not Modified when client rev matches unchanged state', () => {
  const routes = {};
  let sessionListener = null;
  applyHost({
    on(evt, fn) { if (evt === 'session/event') sessionListener = fn; return () => {}; },
    inject(deps, cb) {
      if (deps.includes('webServer')) {
        cb({ webServer: { register(r) { routes[r.path] = r.handler; return () => {}; } } });
      }
      return () => {};
    },
    effect() { return () => {}; },
  });

  sessionListener({ id: 's-304' }, { type: 'turn/start', data: {} });

  let body1 = '';
  let code1 = 0;
  routes[HTTP_PATH_SNAPSHOT](
    { url: '/dsh-live-status-hud/snapshot?sessionId=s-304' },
    { setHeader() {}, end(b) { body1 = b || ''; }, set statusCode(v) { code1 = v; }, get statusCode() { return code1; } },
  );
  assert.equal(code1, 200);
  const parsed = JSON.parse(body1);
  assert.ok(parsed.status.rev > 0);

  let code2 = 0;
  routes[HTTP_PATH_SNAPSHOT](
    { url: `/dsh-live-status-hud/snapshot?sessionId=s-304&rev=${parsed.status.rev}` },
    { setHeader() {}, end() {}, set statusCode(v) { code2 = v; }, get statusCode() { return code2; } },
  );
  assert.equal(code2, 304);
});

test('Host meets strict Cordis activation contract: inject is [] and apply() never mutates ctx properties', () => {
  assert.ok(Array.isArray(hostInject), 'inject must be an array, never { optional: [...] }');
  assert.deepEqual(hostInject, []);

  const strictCtx = new Proxy(
    {
      on() { return () => {}; },
      inject() { return () => {}; },
      effect() { return () => {}; },
    },
    {
      set(_target, prop) {
        throw new Error(`cannot set property "${String(prop)}" without provide`);
      },
    },
  );

  // Must NOT throw on Cordis set-trap!
  assert.doesNotThrow(() => applyHost(strictCtx, { locale: 'zh-CN' }));
});


test('LiveStatusTracker builds chronological visual timeline (thought -> tool -> approval -> done) and phaseDurations', () => {
  const tracker = new LiveStatusTracker({ locale: 'zh-CN', persona: 'playful' });
  const sid = 'sess-timeline';

  tracker.handleEvent({ sessionId: sid, type: 'turn/start', timestamp: 1000 });
  tracker.handleEvent({
    sessionId: sid,
    type: 'assistant/live-chunk',
    data: { kind: 'reasoning', text: 'Let me inspect index.ts first.' },
    timestamp: 1500,
  });
  tracker.handleEvent({
    sessionId: sid,
    type: 'tool/call',
    data: { callId: 't1', name: 'read_file', arguments: { path: 'src/index.ts' } },
    timestamp: 2500,
  });
  tracker.handleEvent({
    sessionId: sid,
    type: 'tool/result',
    data: { callId: 't1', name: 'read_file' },
    timestamp: 3700,
  });
  tracker.handleEvent({
    sessionId: sid,
    type: 'approval/asked',
    data: { toolName: 'bash' },
    timestamp: 4000,
  });
  tracker.handleEvent({
    sessionId: sid,
    type: 'approval/decided',
    data: { decision: 'allow' },
    timestamp: 5000,
  });
  tracker.handleEvent({ sessionId: sid, type: 'turn/end', timestamp: 5500 });

  const snap = tracker.getSnapshot(sid, 5600);
  const kinds = snap.timeline.map((n) => n.kind);
  assert.deepEqual(kinds, ['thought', 'tool', 'approval', 'done']);
  assert.equal(snap.phaseDurations.thinkingMs, 2300);
  assert.equal(snap.phaseDurations.toolMs, 1200);
  assert.equal(snap.phaseDurations.approvalMs, 1000);
  assert.equal(snap.history.length, 1);
  assert.equal(snap.history[0].timeline.length, 4);
});


test('Optional aiSummary is OFF by default and summarizes complex pwsh commands asynchronously when enabled', async () => {
  let fetchCalls = 0;
  const mockFetch = async () => {
    fetchCalls += 1;
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: '覆盖插件脚本到桌面目录' } }] };
      },
    };
  };

  // 1. Default OFF -> zero LLM requests
  const offTracker = new LiveStatusTracker({
    aiSummary: { enabled: false, apiKey: 'sk-test' },
    fetchImpl: mockFetch,
  });
  offTracker.handleEvent({
    sessionId: 's-off',
    type: 'tool/call',
    data: { callId: 'c1', name: 'pwsh', arguments: { command: 'Copy-Item lib\\* C:\\dest\\' } },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fetchCalls, 0);

  // 2. User flips toggle ON -> summarizes once and caches repeated command
  offTracker.setAiSummaryEnabled(true);
  offTracker.handleEvent({
    sessionId: 's-on',
    type: 'tool/call',
    data: { callId: 'c2', name: 'pwsh', arguments: { command: 'Copy-Item lib\\* C:\\dest\\' } },
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fetchCalls, 1);
  const snap = offTracker.getSnapshot('s-on');
  assert.equal(snap.timeline[0].title, '✨ 覆盖插件脚本到桌面目录');

  // 3. Same command hits LRU cache (still 1 call total)
  offTracker.handleEvent({
    sessionId: 's-on-2',
    type: 'tool/call',
    data: { callId: 'c3', name: 'pwsh', arguments: { command: 'Copy-Item lib\\* C:\\dest\\' } },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fetchCalls, 1);
  assert.equal(offTracker.getSnapshot('s-on-2').timeline[0].title, '✨ 覆盖插件脚本到桌面目录');
});


test('AI Summary reuses DSH internal ctx.llm channel with zero manual apiKey configuration', async () => {
  const routes = {};
  let sessionListener = null;

  applyHost({
    on(evt, fn) { if (evt === 'session/event') sessionListener = fn; return () => {}; },
    inject(deps, cb) {
      if (deps.includes('webServer')) {
        cb({ webServer: { register(r) { routes[r.path] = r.handler; return () => {}; } } });
      }
      if (deps.includes('llm')) {
        cb({
          llm: {
            async listModels(provider) {
              if (!provider) throw new TypeError('provider is required');
              if (provider === 'deepseek-account') return [{ id: 'deepseek-flash', provider: 'deepseek-account' }];
              return [];
            },
            async *stream(opts) {
              assert.equal(opts.provider, 'deepseek-account');
              assert.equal(opts.model, 'deepseek-flash');
              yield { type: 'text-delta', index: 0, text: '检查插件配置并重启' };
              yield { type: 'finish', reason: { kind: 'stop' } };
            },
          },
        });
      }
      return () => {};
    },
    effect() { return () => {}; },
  });

  // Turn AI summary ON via /settings
  let settingsBody = '';
  routes['/dsh-live-status-hud/settings'](
    { url: '/dsh-live-status-hud/settings?aiSummary=1' },
    { setHeader() {}, end(b) { settingsBody = b || ''; } },
  );
  const settingsJson = JSON.parse(settingsBody);
  assert.equal(settingsJson.aiSummary.enabled, true);
  assert.equal(settingsJson.aiSummary.configured, true);
  assert.equal(settingsJson.aiSummary.viaDsh, true);

  sessionListener({ id: 's-dsh-llm' }, {
    type: 'tool/call',
    data: { callId: 'c-llm', name: 'pwsh', arguments: { command: 'Get-Content cordis.patch.yml' } },
  });
  await new Promise((r) => setTimeout(r, 30));

  let snapBody = '';
  routes[HTTP_PATH_SNAPSHOT](
    { url: '/dsh-live-status-hud/snapshot?sessionId=s-dsh-llm' },
    { setHeader() {}, end(b) { snapBody = b || ''; } },
  );
  const snapJson = JSON.parse(snapBody);
  assert.equal(snapJson.status.timeline[0].title, '✨ 检查插件配置并重启');
});


test('LiveStatusTracker parses JSON-stringified tool/call arguments (DSH 0.2.2) into rich expandable detail', () => {
  const tracker = new LiveStatusTracker({ locale: 'zh-CN', persona: 'playful' });
  const sid = 'sess-json-args';

  tracker.handleEvent({
    sessionId: sid,
    type: 'tool/call',
    data: {
      callId: 'w1',
      name: 'write',
      arguments: JSON.stringify({ path: 'src/demo.ts', content: 'export const ok = true;' }),
    },
    timestamp: 1000,
  });
  tracker.handleEvent({
    sessionId: sid,
    type: 'tool/call',
    data: {
      callId: 'p1',
      name: 'pwsh',
      arguments: JSON.stringify({ command: 'Copy-Item lib\\index.js dest\\', description: '覆盖主机脚本' }),
    },
    timestamp: 1200,
  });

  const snap = tracker.getSnapshot(sid, 1300);
  assert.equal(snap.timeline.length, 2);
  assert.ok(snap.timeline[0].title.includes('demo.ts'), `Expected filename in write title, got: ${snap.timeline[0].title}`);
  assert.ok(snap.timeline[0].detail.includes('src/demo.ts') && snap.timeline[0].detail.includes('export const ok = true;'));
  assert.equal(snap.timeline[1].title, '覆盖主机脚本');
  assert.ok(snap.timeline[1].detail.includes('Copy-Item lib\\index.js dest\\'));
});


test('Host supports live persona switching (playful / concise / geek) via /settings route', () => {
  const tracker = new LiveStatusTracker({ locale: 'zh-CN', persona: 'playful' });
  tracker.handleEvent({ sessionId: 's-p', type: 'turn/start', timestamp: 1000 });
  tracker.setPersona('geek');
  const snap = tracker.getSnapshot('s-p', 1100);
  assert.ok(snap.headline.startsWith('[THINK]'), `Expected geek headline, got: ${snap.headline}`);
});


test('Security: resolveAiCredentials NEVER sends OPENAI_API_KEY to DeepSeek API', () => {
  const prevOpenAi = process.env.OPENAI_API_KEY;
  const prevDeepSeek = process.env.DEEPSEEK_API_KEY;
  try {
    delete process.env.DEEPSEEK_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-openai-should-never-leak';
    const tracker = new LiveStatusTracker({});
    const creds = tracker.resolveAiCredentials();
    assert.equal(creds.apiKey, '');
    assert.equal(creds.configured, false);
  } finally {
    if (prevOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenAi;
    if (prevDeepSeek === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = prevDeepSeek;
  }
});
