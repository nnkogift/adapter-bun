import type { IncomingMessage, ServerResponse } from 'node:http';
import { responseToMiddlewareResult } from '@next/routing';
import { createEdgeOutputInvoker } from './invoke-output-edge.js';
import { createNodeOutputInvoker } from './invoke-output-node.js';
import type {
  AppendMutableHeader,
  RuntimeBuildConfig,
  RuntimeFunctionOutput,
  RuntimeNextConfig,
  RuntimePrerenderManifest,
  RuntimeRequestMeta,
  RuntimeRequiredServerFilesConfig,
  WaitUntilCollector,
  WriteFetchResponse,
} from './invoke-output-types.js';

interface CreateInvokeOutputOptions {
  appendMutableHeader: AppendMutableHeader;
  buildId: string;
  canRequestHaveBody: (method: string | undefined) => boolean;
  getFunctionOutputByPathname: (pathname: string) => RuntimeFunctionOutput | undefined;
  getSingleHeaderValue: (value: string | string[] | undefined) => string | undefined;
  isApiRoutePathname: (pathname: string) => boolean;
  isPossibleServerActionRequest: (req: IncomingMessage) => boolean;
  isReadMethod: (method: string | undefined) => boolean;
  manifestBuild?: RuntimeBuildConfig;
  manifestDistDir: string | null;
  prerenderManifest: RuntimePrerenderManifest;
  requiredServerFilesConfig: RuntimeRequiredServerFilesConfig;
  runtimeNextConfig: RuntimeNextConfig;
  writeFetchResponse: WriteFetchResponse;
}

function createWaitUntilCollector(): WaitUntilCollector {
  const pending: Promise<void>[] = [];
  return {
    waitUntil(prom) {
      pending.push(
        Promise.resolve(prom).catch((error) => {
          console.error('[adapter-bun] waitUntil task failed:', error);
        })
      );
    },
    async drain() {
      await Promise.allSettled(pending);
    },
  };
}

export function createInvokeOutput(options: CreateInvokeOutputOptions): {
  invokeFunctionOutput: (
    req: IncomingMessage,
    res: ServerResponse,
    output: RuntimeFunctionOutput,
    requestUrl: URL,
    requestBody: Uint8Array,
    requestMeta?: RuntimeRequestMeta
  ) => Promise<void>;
  invokeMiddleware: (
    middleware: RuntimeFunctionOutput,
    requestUrl: URL,
    method: string | undefined,
    headers: Headers,
    requestBody: ReadableStream<Uint8Array>
  ) => Promise<{
    middlewareResult: ReturnType<typeof responseToMiddlewareResult>;
    response: Response;
  }>;
} {
  const {
    appendMutableHeader,
    buildId,
    canRequestHaveBody,
    getFunctionOutputByPathname,
    getSingleHeaderValue,
    isApiRoutePathname,
    isPossibleServerActionRequest,
    isReadMethod,
    manifestBuild,
    manifestDistDir,
    prerenderManifest,
    requiredServerFilesConfig,
    runtimeNextConfig,
    writeFetchResponse,
  } = options;

  const nodeInvoker = createNodeOutputInvoker({
    canRequestHaveBody,
    createWaitUntilCollector,
    getFunctionOutputByPathname,
    getSingleHeaderValue,
    isApiRoutePathname,
    isPossibleServerActionRequest,
    isReadMethod,
  });
  const edgeInvoker = createEdgeOutputInvoker({
    appendMutableHeader,
    buildId,
    canRequestHaveBody,
    createWaitUntilCollector,
    isReadMethod,
    manifestBuild,
    manifestDistDir,
    prerenderManifest,
    requiredServerFilesConfig,
    runtimeNextConfig,
    writeFetchResponse,
  });

  async function invokeFunctionOutput(
    req: IncomingMessage,
    res: ServerResponse,
    output: RuntimeFunctionOutput,
    requestUrl: URL,
    requestBody: Uint8Array,
    requestMeta?: RuntimeRequestMeta
  ): Promise<void> {
    const isErrorDocumentOutput = /(?:^|\/)(?:_error|404|500)$/.test(output.pathname);
    if (isErrorDocumentOutput) {
      // Next's error render path can close sockets internally without an explicit
      // connection header, which leads keep-alive clients to reuse a dead socket.
      // Mark error document responses as non-keepalive to keep client pools in sync.
      res.shouldKeepAlive = false;
      if (!res.headersSent) {
        res.setHeader('connection', 'close');
      }
    }
    if (!isReadMethod(req.method)) {
      // Non-read requests (actions/revalidation/posts) have been the primary
      // source of pooled-socket resets in deploy-mode tests. Close after write
      // so subsequent client requests open a fresh socket.
      res.shouldKeepAlive = false;
      if (!res.headersSent) {
        res.setHeader('connection', 'close');
      }
    }
    if (isApiRoutePathname(output.pathname)) {
      // API handlers can end the underlying socket without an explicit close
      // signal on some runtimes. Avoid pooled socket reuse between API calls.
      res.shouldKeepAlive = false;
      if (!res.headersSent) {
        res.setHeader('connection', 'close');
      }
    }
    if (output.runtime === 'edge') {
      // Edge handlers can terminate their underlying socket immediately after
      // writing the response, even when no explicit close header is set.
      // Advertise close so keep-alive clients do not reuse stale sockets.
      res.shouldKeepAlive = false;
      if (!res.headersSent) {
        res.setHeader('connection', 'close');
      }
      await edgeInvoker.invokeEdgeFunctionOutput(
        req,
        res,
        output,
        requestUrl,
        requestBody,
        requestMeta
      );
      return;
    }
    await nodeInvoker.invokeNodeFunctionOutput(
      req,
      res,
      output,
      requestUrl,
      requestBody,
      invokeFunctionOutput,
      requestMeta
    );
  }

  async function invokeMiddleware(
    middleware: RuntimeFunctionOutput,
    requestUrl: URL,
    method: string | undefined,
    headers: Headers,
    requestBody: ReadableStream<Uint8Array>
  ): Promise<{
    middlewareResult: ReturnType<typeof responseToMiddlewareResult>;
    response: Response;
  }> {
    const response =
      middleware.runtime === 'edge'
        ? await edgeInvoker.invokeEdgeMiddleware(
            middleware,
            requestUrl,
            method,
            headers,
            requestBody
          )
        : await nodeInvoker.invokeNodeMiddleware(
            middleware,
            requestUrl,
            method,
            headers,
            requestBody
          );
    return {
      middlewareResult: responseToMiddlewareResult(response, headers, requestUrl),
      response,
    };
  }

  return {
    invokeFunctionOutput,
    invokeMiddleware,
  };
}
