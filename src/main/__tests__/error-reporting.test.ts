import { EventEmitter } from 'node:events';
import type { App } from 'electron';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NodeClient } from '@sentry/node';

import { startErrorReporting } from '../error-reporting';

vi.mock('@sentry/node', () => ({
  NodeClient: vi.fn(),
  defaultStackParser: vi.fn(),
  makeNodeTransport: vi.fn(),
}));

const captureEvent = vi.fn();
const emitter = () => Object.assign(new EventEmitter(), { getVersion: () => '2.357.2' });
const renderer = (app: EventEmitter, url = 'app://workspaces/debug?private=PRIVATE_PAGE') => {
  const contents = Object.assign(new EventEmitter(), {
    getType: () => 'window',
    getURL: () => url,
  });
  app.emit('web-contents-created', {}, contents);
  return contents;
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(NodeClient).mockImplementation(function () {
    return { init: vi.fn(), captureEvent, flush: vi.fn() } as unknown as NodeClient;
  });
});

afterEach(() => vi.useRealTimers());

it('starts without an outgoing SDK when the DSN is unset or insecure', () => {
  const app = emitter() as unknown as App;
  expect(startErrorReporting(app, undefined)).toBeUndefined();
  expect(startErrorReporting(app, 'http://public@example.invalid/1')).toBeUndefined();
  expect(NodeClient).not.toHaveBeenCalled();
});

it('reports first-party failures without sending the error or page contents', () => {
  const app = emitter();
  const reporter = startErrorReporting(app as unknown as App, 'https://public@example.invalid/1');
  const contents = renderer(app);
  contents.emit('console-message', {
    level: 'error',
    message: 'PRIVATE_PROMPT',
    sourceId: 'app://workspaces/_app/immutable/chunks/app.js?token=PRIVATE_QUERY',
    lineNumber: 17,
  });
  const error = new Error('PRIVATE_ERROR');
  error.stack =
    'Error: PRIVATE_ERROR\n    at crash (/Users/PRIVATE_HOME/Intent.app/Resources/app.asar/dist/main/index.js:42:7)';
  reporter?.uncaught(error);
  app.emit('render-process-gone', {}, contents, { reason: 'clean-exit' });
  app.emit('render-process-gone', {}, contents, { reason: 'oom' });

  expect(captureEvent.mock.calls).toHaveLength(3);
  const serialized = JSON.stringify(captureEvent.mock.calls);
  expect(serialized).not.toContain('PRIVATE_');
  expect(serialized).toContain('app.js');
  expect(serialized).toContain('index.js');
  expect(serialized).toContain('RendererCrash');
});

it('bounds repeated backend errors across windows and keeps their safe messages and stack', () => {
  vi.useFakeTimers({ toFake: ['performance'] });
  const app = emitter();
  startErrorReporting(app as unknown as App, 'https://public@example.invalid/1');
  const windows = [renderer(app), renderer(app)];
  const sourceId = 'app://workspaces/app/immutable/chunks/logger.js';
  const details = (message: string) => ({ level: 'error', sourceId, lineNumber: 1, message });
  const refused = 'connect ECONNREFUSED 127.0.0.1:5181';
  const message = (error: string) =>
    'Subscription failed ' +
    JSON.stringify({
      error: {
        message: error,
        stack: [
          'BackendError: ' + error,
          '    at request (app://workspaces/app/immutable/chunks/backend.js:2:57)',
          '    at async refresh (app://workspaces/app/immutable/nodes/workspace.js:3:19)',
          '    at private (/Users/PRIVATE_HOME/private.js:1:2)',
        ].join('\n'),
      },
    });
  for (let i = 0; i < 84; i++) {
    const error = i < 17 ? 'Daemon not ready' : refused;
    windows[i % 2].emit('console-message', details(message(error)));
    vi.advanceTimersByTime(400);
  }

  expect(captureEvent.mock.calls).toHaveLength(2);
  expect(captureEvent.mock.calls[0][0]).toMatchObject({
    tags: { reason: 'daemon-not-ready' },
    exception: {
      values: [
        {
          type: 'RendererError',
          value: 'Daemon not ready',
          stacktrace: {
            frames: [
              { filename: 'app/immutable/nodes/workspace.js', lineno: 3, colno: 19 },
              { filename: 'app/immutable/chunks/backend.js', lineno: 2, colno: 57 },
            ],
          },
        },
      ],
    },
  });
  expect(captureEvent.mock.calls[1][0].exception.values[0].value).toBe(
    'Backend connection refused (ECONNREFUSED)',
  );
  expect(JSON.stringify(captureEvent.mock.calls)).not.toMatch(/127\.0\.0\.1|PRIVATE_HOME/);

  vi.advanceTimersByTime(60_000);
  windows[0].emit('console-message', details(message(refused)));
  expect(captureEvent.mock.calls).toHaveLength(3);
});

it('keeps the first-party console location and omits unrelated origins and raw error text', () => {
  const app = emitter();
  startErrorReporting(app as unknown as App, 'https://public@example.invalid/1');
  const details = {
    level: 'error',
    message: 'Uncaught TypeError: PRIVATE_TEXT',
    sourceId: 'app://workspaces/app/immutable/chunks/view.js',
    lineNumber: 11,
  };
  renderer(app, 'https://example.test').emit('console-message', details);
  const contents = renderer(app);
  contents.emit('console-message', { ...details, sourceId: 'https://example.test/view.js' });
  contents.emit('console-message', details);

  expect(captureEvent.mock.calls).toHaveLength(1);
  expect(captureEvent.mock.calls[0][0].exception.values[0]).toMatchObject({
    type: 'RendererError',
    value: 'Renderer TypeError',
    stacktrace: { frames: [{ filename: 'app/immutable/chunks/view.js', lineno: 11 }] },
  });
  expect(JSON.stringify(captureEvent.mock.calls)).not.toContain('PRIVATE_TEXT');
});
