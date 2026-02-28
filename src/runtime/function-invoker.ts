import type { BunFunctionArtifact } from '../types.ts';
import type { FunctionRouteDispatchContext, RouterRuntimeHandlers } from './types.ts';
import {
  createNodeFunctionArtifactInvoker,
  createNodeMiddlewareInvoker,
} from './function-invoker-node.ts';
import type { CreateFunctionArtifactInvokerOptions } from './function-invoker-shared.ts';

type EdgeInvokerFactory = (
  options: CreateFunctionArtifactInvokerOptions
) => RouterRuntimeHandlers['invokeFunction'];

type EdgeMiddlewareInvokerFactory = (
  options: CreateFunctionArtifactInvokerOptions
) => RouterRuntimeHandlers['invokeMiddleware'] | null;

let edgeModulePromise: Promise<{
  createEdgeFunctionArtifactInvoker: EdgeInvokerFactory;
  createEdgeMiddlewareInvoker: EdgeMiddlewareInvokerFactory;
}> | undefined;

async function loadEdgeModule() {
  if (!edgeModulePromise) {
    edgeModulePromise = import('./function-invoker-edge.ts').then((module) => ({
      createEdgeFunctionArtifactInvoker: module.createEdgeFunctionArtifactInvoker,
      createEdgeMiddlewareInvoker: module.createEdgeMiddlewareInvoker,
    }));
  }
  return edgeModulePromise;
}

async function loadEdgeInvokerFactory(): Promise<EdgeInvokerFactory> {
  const mod = await loadEdgeModule();
  return mod.createEdgeFunctionArtifactInvoker;
}

function resolveOutputById(
  functionMap: BunFunctionArtifact[]
): Map<string, BunFunctionArtifact> {
  const outputById = new Map<string, BunFunctionArtifact>();
  for (const output of functionMap) {
    outputById.set(output.id, output);
  }
  return outputById;
}

export function createFunctionArtifactInvoker(
  options: CreateFunctionArtifactInvokerOptions
): RouterRuntimeHandlers['invokeFunction'] {
  const outputById = resolveOutputById(options.manifest.functionMap);
  const invokeNode = createNodeFunctionArtifactInvoker(options);
  let invokeEdgePromise: Promise<RouterRuntimeHandlers['invokeFunction']> | undefined;

  return async (ctx: FunctionRouteDispatchContext): Promise<Response> => {
    const output = outputById.get(ctx.output.id);
    if (!output) {
      throw new Error(`Unknown function output id "${ctx.output.id}"`);
    }

    if (output.runtime === 'nodejs') {
      return invokeNode(ctx);
    }

    if (output.runtime === 'edge') {
      invokeEdgePromise ??= loadEdgeInvokerFactory().then((factory) =>
        factory(options)
      );
      const invokeEdge = await invokeEdgePromise;
      return invokeEdge(ctx);
    }

    throw new Error(`Unsupported runtime "${output.runtime}" for output "${output.id}"`);
  };
}

export async function createMiddlewareInvoker(
  options: CreateFunctionArtifactInvokerOptions
): Promise<RouterRuntimeHandlers['invokeMiddleware'] | undefined> {
  if (!options.manifest.runtime?.middlewareOutputId) {
    return undefined;
  }

  // Try edge middleware first (most common)
  const mod = await loadEdgeModule();
  const edgeMiddleware = mod.createEdgeMiddlewareInvoker(options);
  if (edgeMiddleware) {
    return edgeMiddleware;
  }

  // Fall back to Node.js middleware
  return createNodeMiddlewareInvoker(options) ?? undefined;
}

export type { CreateFunctionArtifactInvokerOptions } from './function-invoker-shared.ts';
