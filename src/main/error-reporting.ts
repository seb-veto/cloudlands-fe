import type { App } from 'electron';
import {
  defaultStackParser,
  makeNodeTransport,
  NodeClient,
  type Event,
  type StackFrame,
} from '@sentry/node';

type Failure =
  | 'MainUncaughtException'
  | 'MainUnhandledRejection'
  | 'RendererError'
  | 'RendererCrash'
  | 'HelperCrash';

const INTERNAL_PAGE = /^app:\/\/(?:workspaces|localhost)(?:[/:?#]|$)/;
const APP_SCRIPT =
  /^app:\/\/(?:workspaces|localhost)\/(?:_app\/immutable\/(?:chunks|nodes|entry)\/)?([\w.-]{1,128}\.m?js)(?:[?#]|$)/;
const CRASH_REASONS = new Set([
  'abnormal-exit',
  'crashed',
  'oom',
  'launch-failed',
  'integrity-failure',
]);

export function reportableRendererFrame(source: string, line: number) {
  const filename = APP_SCRIPT.exec(source)?.[1];
  if (!filename || !Number.isSafeInteger(line) || line <= 0) return undefined;
  return { filename, lineno: line, in_app: true };
}

function mainFrames(error: unknown) {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return [];
  return error.stack
    .split('\n')
    .slice(1, 16)
    .reverse()
    .flatMap((line) => {
      const frame = /\/app\.asar\/dist\/main\/([\w./-]{1,160}\.m?js):(\d+):(\d+)\)?$/.exec(line);
      if (!frame || frame[1].includes('..')) return [];
      return [
        { filename: frame[1], lineno: Number(frame[2]), colno: Number(frame[3]), in_app: true },
      ];
    });
}

export function startErrorReporting(app: App, value: string | undefined) {
  const dsn = value?.trim();
  if (!dsn?.startsWith('https://')) return undefined;

  const client = new NodeClient({
    dsn,
    release: `intent-desktop@${app.getVersion()}`,
    integrations: [],
    transport: makeNodeTransport,
    stackParser: defaultStackParser,
    sendClientReports: false,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    sampleRate: 1,
  });
  client.init();

  const capture = (type: Failure, frames: StackFrame[] = [], reason?: string) => {
    const component = type.startsWith('Main')
      ? 'desktop-main'
      : type === 'HelperCrash'
        ? 'desktop-helper'
        : 'desktop-renderer';
    const event: Event = {
      level: 'error',
      platform: 'javascript',
      tags: { component },
      exception: { values: [{ type, stacktrace: frames.length ? { frames } : undefined }] },
    };
    if (reason) {
      event.tags = { ...event.tags, reason };
      event.fingerprint = [type, reason];
    }
    client.captureEvent(event);
  };

  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() === 'webview') return;
    contents.on('console-message', (details) => {
      if (details.level !== 'error' || !INTERNAL_PAGE.test(contents.getURL())) return;
      const frame = reportableRendererFrame(details.sourceId, details.lineNumber);
      capture('RendererError', frame ? [frame] : []);
    });
  });
  app.on('render-process-gone', (_event, contents, details) => {
    if (
      contents.getType() !== 'webview' &&
      INTERNAL_PAGE.test(contents.getURL()) &&
      CRASH_REASONS.has(details.reason)
    ) {
      capture('RendererCrash', [], details.reason);
    }
  });
  app.on('child-process-gone', (_event, details) => {
    if (CRASH_REASONS.has(details.reason)) capture('HelperCrash', [], details.reason);
  });

  return {
    uncaught: (error: unknown) => capture('MainUncaughtException', mainFrames(error)),
    rejected: (reason: unknown) => capture('MainUnhandledRejection', mainFrames(reason)),
    flush: () => client.flush(500),
  };
}
