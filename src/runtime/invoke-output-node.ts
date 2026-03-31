import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import type {
  EdgeRouteHandler,
  NodeRouteHandler,
  RuntimeFunctionOutput,
  RuntimeRequestMeta,
  WaitUntilCollector,
} from './invoke-output-types.js';

type RuntimeConfigRecord = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const require = createRequire(import.meta.url);
const nodeHandlerCache = new Map<string, NodeRouteHandler>();
const nodeHandlerLoadPromises = new Map<string, Promise<NodeRouteHandler>>();
const nodeMiddlewareHandlerCache = new Map<string, EdgeRouteHandler>();
const nodeMiddlewareHandlerLoadPromises = new Map<string, Promise<EdgeRouteHandler>>();

async function loadNodeHandler(output: RuntimeFunctionOutput): Promise<NodeRouteHandler> {
  const normalizedPath = path.resolve(output.filePath);
  const cached = nodeHandlerCache.get(normalizedPath);
  if (cached) {
    return cached;
  }
  const pending = nodeHandlerLoadPromises.get(normalizedPath);
  if (pending) {
    return pending;
  }
  const loadPromise = (async () => {
    const loaded = (await Promise.resolve(require(normalizedPath))) as RuntimeConfigRecord;
    const handlerCandidate =
      typeof loaded.handler === 'function'
        ? loaded.handler
        : loaded.default &&
            isRecord(loaded.default) &&
            typeof loaded.default.handler === 'function'
          ? loaded.default.handler
          : null;
    if (typeof handlerCandidate !== 'function') {
      throw new Error(`[adapter-bun] route output missing handler(): ${normalizedPath}`);
    }
    const handler = handlerCandidate as NodeRouteHandler;
    nodeHandlerCache.set(normalizedPath, handler);
    return handler;
  })();
  nodeHandlerLoadPromises.set(normalizedPath, loadPromise);
  try {
    return await loadPromise;
  } finally {
    nodeHandlerLoadPromises.delete(normalizedPath);
  }
}

async function loadNodeMiddlewareHandler(
  output: RuntimeFunctionOutput
): Promise<EdgeRouteHandler> {
  const normalizedPath = path.resolve(output.filePath);
  const cached = nodeMiddlewareHandlerCache.get(normalizedPath);
  if (cached) {
    return cached;
  }
  const pending = nodeMiddlewareHandlerLoadPromises.get(normalizedPath);
  if (pending) {
    return pending;
  }
  const loadPromise = (async () => {
    const loaded = (await Promise.resolve(require(normalizedPath))) as RuntimeConfigRecord;
    const handlerCandidate =
      typeof loaded.handler === 'function'
        ? loaded.handler
        : loaded.default &&
            isRecord(loaded.default) &&
            typeof loaded.default.handler === 'function'
          ? loaded.default.handler
          : null;
    if (typeof handlerCandidate !== 'function') {
      throw new Error(`[adapter-bun] middleware output missing handler(): ${normalizedPath}`);
    }
    const handler = handlerCandidate as EdgeRouteHandler;
    nodeMiddlewareHandlerCache.set(normalizedPath, handler);
    return handler;
  })();
  nodeMiddlewareHandlerLoadPromises.set(normalizedPath, loadPromise);
  try {
    return await loadPromise;
  } finally {
    nodeMiddlewareHandlerLoadPromises.delete(normalizedPath);
  }
}

async function waitForResponseFinish(res: ServerResponse, timeoutMs: number = 10_000): Promise<void> {
  if (res.writableFinished || res.writableEnded || res.destroyed) {
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      resolve();
    };
    const timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      res.off('finish', finish);
      resolve();
    }, timeoutMs);
    res.once('finish', finish);
  });
}

type InvokeOutput = (
  req: IncomingMessage,
  res: ServerResponse,
  output: RuntimeFunctionOutput,
  requestUrl: URL,
  requestBody: Uint8Array,
  requestMeta?: RuntimeRequestMeta
) => Promise<void>;

interface CreateNodeOutputInvokerOptions {
  canRequestHaveBody: (method: string | undefined) => boolean;
  createWaitUntilCollector: () => WaitUntilCollector;
  getFunctionOutputByPathname: (pathname: string) => RuntimeFunctionOutput | undefined;
  getSingleHeaderValue: (value: string | string[] | undefined) => string | undefined;
  isApiRoutePathname: (pathname: string) => boolean;
  isPossibleServerActionRequest: (req: IncomingMessage) => boolean;
  isReadMethod: (method: string | undefined) => boolean;
}

export function createNodeOutputInvoker(options: CreateNodeOutputInvokerOptions): {
  invokeNodeFunctionOutput: (
    req: IncomingMessage,
    res: ServerResponse,
    output: RuntimeFunctionOutput,
    requestUrl: URL,
    requestBody: Uint8Array,
    invokeOutput: InvokeOutput,
    requestMeta?: RuntimeRequestMeta
  ) => Promise<void>;
  invokeNodeMiddleware: (
    middleware: RuntimeFunctionOutput,
    requestUrl: URL,
    method: string | undefined,
    headers: Headers,
    requestBody: ReadableStream<Uint8Array>
  ) => Promise<Response>;
} {
  const {
    canRequestHaveBody,
    createWaitUntilCollector,
    getFunctionOutputByPathname,
    getSingleHeaderValue,
    isApiRoutePathname,
    isPossibleServerActionRequest,
    isReadMethod,
  } = options;

  async function invokeNodeFunctionOutput(
    req: IncomingMessage,
    res: ServerResponse,
    output: RuntimeFunctionOutput,
    requestUrl: URL,
    requestBody: Uint8Array,
    invokeOutput: InvokeOutput,
    requestMeta?: RuntimeRequestMeta
  ): Promise<void> {
    const nodeHandler = await loadNodeHandler(output);
    const waitUntil = createWaitUntilCollector();
    const normalizedOutputFilePath = output.filePath.replace(/\\/g, '/');
    const isAppOutput =
      normalizedOutputFilePath.includes('/server/app/') ||
      output.sourcePage.endsWith('/page') ||
      (output.sourcePage.endsWith('/route') && !output.sourcePage.startsWith('/api/'));
    const isAppRouteHandlerOutput = output.sourcePage.endsWith('/route');
    const isNextDataRequest =
      getSingleHeaderValue(req.headers['x-nextjs-data']) === '1' ||
      requestUrl.pathname.includes('/_next/data/');
    const shouldFallbackToErrorPage =
      isReadMethod(req.method) &&
      !isApiRoutePathname(output.pathname) &&
      output.pathname !== '/_error' &&
      !isAppOutput &&
      !isAppRouteHandlerOutput &&
      !isNextDataRequest;
    let suppressedNotFoundResponse = false;
    let restoreNotFoundFallbackPatch: (() => void) | null = null;
    const isActionRequest = isPossibleServerActionRequest(req);
    if (shouldFallbackToErrorPage) {
      const mutableRes = res as any;
      const originalWrite = res.write.bind(res) as (...args: unknown[]) => boolean;
      const originalEnd = res.end.bind(res) as (...args: unknown[]) => ServerResponse;
      const shouldCaptureNotFoundResponse = (): boolean =>
        res.statusCode === 404 && !res.hasHeader('content-type');
      const consumeChunk = (chunk: unknown): void => {
        if (chunk === undefined || chunk === null) {
          return;
        }
        if (Buffer.isBuffer(chunk)) {
          return;
        }
        if (chunk instanceof Uint8Array) {
          return;
        }
        if (typeof chunk === 'string') {
          return;
        }
      };
      mutableRes.write = (...args: unknown[]) => {
        if (shouldCaptureNotFoundResponse()) {
          consumeChunk(args[0]);
          return true;
        }
        return originalWrite(...args);
      };
      mutableRes.end = (...args: unknown[]) => {
        if (shouldCaptureNotFoundResponse()) {
          consumeChunk(args[0]);
          suppressedNotFoundResponse = true;
          return res;
        }
        return originalEnd(...args);
      };
      restoreNotFoundFallbackPatch = () => {
        mutableRes.write = originalWrite;
        mutableRes.end = originalEnd;
      };
    }
    // Keep action responses streaming-capable. Buffering res.write() breaks
    // streamed server action payloads (for example ReadableStream responses).
    const shouldWaitForFinish = isActionRequest;
    await nodeHandler(req, res, {
      waitUntil: waitUntil.waitUntil,
      ...(requestMeta ? { requestMeta } : {}),
    });
    if (restoreNotFoundFallbackPatch) {
      restoreNotFoundFallbackPatch();
    }
    if (suppressedNotFoundResponse) {
      const errorOutput = getFunctionOutputByPathname('/_error');
      if (errorOutput) {
        if (!res.headersSent) {
          res.statusCode = 404;
        }
        await invokeOutput(req, res, errorOutput, requestUrl, requestBody);
        void waitUntil.drain();
        return;
      }
      if (!res.headersSent) {
        res.statusCode = 404;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
      }
      res.end('Not Found');
      void waitUntil.drain();
      return;
    }
    if (shouldWaitForFinish) {
      await waitForResponseFinish(res);
    }
    void waitUntil.drain();
  }

  async function invokeNodeMiddleware(
    middleware: RuntimeFunctionOutput,
    requestUrl: URL,
    method: string | undefined,
    headers: Headers,
    requestBody: ReadableStream<Uint8Array>
  ): Promise<Response> {
    const waitUntil = createWaitUntilCollector();
    const handler = await loadNodeMiddlewareHandler(middleware);
    const requestInit: RequestInit & { duplex?: 'half' } = {
      method: method || 'GET',
      headers,
    };
    if (canRequestHaveBody(method)) {
      requestInit.body = requestBody;
      requestInit.duplex = 'half';
    }
    const middlewareRequest = new Request(requestUrl.toString(), requestInit);
    const response = await handler(middlewareRequest, {
      waitUntil: waitUntil.waitUntil,
    });
    void waitUntil.drain();
    return response;
  }

  return {
    invokeNodeFunctionOutput,
    invokeNodeMiddleware,
  };
}
