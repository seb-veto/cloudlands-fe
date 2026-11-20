import { EventEmitter } from 'node:events';
import type { App } from 'electron';
import { beforeEach, expect, it, vi } from 'vitest';
import { NodeClient } from '@sentry/node';

import { startErrorReporting } from '../error-reporting';

vi.mock('@sentry/node', () => ({
  NodeClient: vi.fn(),
  defaultStackParser: vi.fn(),
  makeNodeTransport: vi.fn(),
}));

const captureEvent = vi.fn();
const emitter = () => Object.assign(new EventEmitter(), { getVersion: () => '2.357.2' });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(NodeClient).mockImplementation(function () {
    return { init: vi.fn(), captureEvent, flush: vi.fn() } as unknown as NodeClient;
  });
});

it('starts without an outgoing SDK when the DSN is unset or insecure', () => {
  const app = emitter() as unknown as App;
  expect(startErrorReporting(app, undefined)).toBeUndefined();
  expect(startErrorReporting(app, 'http://public@example.invalid/1')).toBeUndefined();
  expect(NodeClient).not.toHaveBeenCalled();
});

it('reports first-party failures without sending the error or page contents', () => {
  const app = emitter();
  const reporter = startErrorReporting(app as unknown as App, 'https://public@example.invalid/1');
  const contents = Object.assign(new EventEmitter(), {
    getType: () => 'window',
    getURL: () => 'app://workspaces/debug?private=PRIVATE_PAGE',
  });
  app.emit('web-contents-created', {}, contents);
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
