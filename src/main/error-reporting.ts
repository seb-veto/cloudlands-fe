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
  /^app:\/\/(?:workspaces|localhost)\/((?:_?app\/immutable\/(?:chunks|nodes|entry)\/)?[\w.-]{1,128}\.m?js)(?:[?#]|$)/;
const PRELOAD_SCRIPT = /\/app\.asar\/dist\/(preload-build\/preload\/index\.js)$/;
const RENDERER_REPORT_INTERVAL_MS = 60_000;
const CRASH_REASONS = new Set([
  'abnormal-exit',
  'crashed',
  'oom',
  'launch-failed',
  'integrity-failure',
]);

function reportableRendererFrame(
  source: string,
  line: number,
  column?: number,
): StackFrame | undefined {
  const filename = APP_SCRIPT.exec(source)?.[1] ?? PRELOAD_SCRIPT.exec(source)?.[1];
  if (!filename || !Number.isSafeInteger(line) || line <= 0) return undefined;
  return {
    filename,
    lineno: line,
    colno: column !== undefined && Number.isSafeInteger(column) && column > 0 ? column : undefined,
    in_app: true,
  };
}

function rendererFrames(message: string, source: string, line: number): StackFrame[] {
  // Renderer logs can carry a V8 stack directly or inside JSON-serialized context.
  const stack = message
    .replaceAll('\\n', '\n')
    .split('\n')
    .flatMap((entry) => {
      const frame = /^\s*at (?:[^()]*? \()?(app:\/\/[^\s()]+):(\d+):(\d+)\)?(?:["\s]|$)/.exec(
        entry,
      );
      if (!frame) return [];
      const location = reportableRendererFrame(frame[1], Number(frame[2]), Number(frame[3]));
      return location ? [location] : [];
    });
  if (stack.length) return stack.slice(0, 15).reverse();
  const location = reportableRendererFrame(source, line);
  return location ? [location] : [];
}

function rendererDiagnostic(message: string) {
  // Console text can contain prompts, credentials, paths and remote endpoints.
  // Only fixed diagnostic text leaves the process.
  if (/(?:^|BackendError: |"message":")Daemon not ready(?=["\s]|$)/.test(message)) {
    return { value: 'Daemon not ready', reason: 'daemon-not-ready' };
  }
  if (/(?:^|BackendError: |"message":")connect ECONNREFUSED(?=\s|$)/.test(message)) {
    return {
      value: 'Backend connection refused (ECONNREFUSED)',
      reason: 'backend-connection-refused',
    };
  }
  if (
    message.includes('"message":"Provider discovery requires an admitted host owner or member"')
  ) {
    return {
      value: 'Provider discovery requires an admitted host owner or member',
      reason: 'provider-discovery-not-admitted',
    };
  }
  if (message.includes('Error: Dock context requires its live main document')) {
    return {
      value: 'Dock context requires its live main document',
      reason: 'dock-context-not-ready',
    };
  }
  const type =
    /^(?:Uncaught (?:\(in promise\) )?)?(TypeError|ReferenceError|RangeError|SyntaxError|URIError|Error):/.exec(
      message,
    )?.[1];
  return { value: type ? 'Renderer ' + type : 'Renderer console error' };
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

  const capture = (type: Failure, frames: StackFrame[] = [], reason?: string, value?: string) => {
    const component = type.startsWith('Main')
      ? 'desktop-main'
      : type === 'HelperCrash'
        ? 'desktop-helper'
        : 'desktop-renderer';
    const event: Event = {
      level: 'error',
      platform: 'javascript',
      tags: { component },
      exception: { values: [{ type, value, stacktrace: frames.length ? { frames } : undefined }] },
    };
    if (reason) {
      event.tags = { ...event.tags, reason };
      event.fingerprint = [type, reason];
    }
    client.captureEvent(event);
  };

  const lastRendererReport = new Map<string, number>();
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() === 'webview') return;
    contents.on('console-message', (details) => {
      if (details.level !== 'error' || !INTERNAL_PAGE.test(contents.getURL())) return;
      const message = details.message.slice(0, 16_384);
      const { reason, value } = rendererDiagnostic(message);
      const now = performance.now();
      const last = reason === undefined ? undefined : lastRendererReport.get(reason);
      if (last !== undefined && now - last < RENDERER_REPORT_INTERVAL_MS) return;
      const frames = rendererFrames(message, details.sourceId, details.lineNumber);
      if (!frames.length) return;
      // Each window's startup and reconnect retries can log the same known
      // failure. Keep one report per cause per minute across all windows.
      if (reason) lastRendererReport.set(reason, now);
      capture('RendererError', frames, reason, value);
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
