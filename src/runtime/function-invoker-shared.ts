import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BunDeploymentManifest, BunFunctionArtifact } from '../types.ts';

export type LambdaLikeResult = {
  statusCode?: number;
  headers?: Record<string, string | number | boolean | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
};

export type ArtifactRouteHandler = (...args: unknown[]) => unknown;

export type LoadedModule = Record<string, unknown>;

export interface CreateFunctionArtifactInvokerOptions {
  manifest: BunDeploymentManifest;
  adapterDir: string;
  loadModule?: (entrypointPath: string) => Promise<LoadedModule>;
  incrementalCache?: unknown;
}

export function resolveInside(baseDir: string, relativePath: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, relativePath);
  const prefix = `${resolvedBase}${path.sep}`;

  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(prefix)) {
    throw new Error(`Resolved path escapes base directory: "${relativePath}"`);
  }

  return resolvedTarget;
}

export function toResponseFromLambdaLike(result: LambdaLikeResult): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(result.headers ?? {})) {
    if (value === undefined) continue;
    headers.set(key, String(value));
  }

  const body =
    typeof result.body === 'string'
      ? result.isBase64Encoded
        ? Buffer.from(result.body, 'base64')
        : result.body
      : null;

  return new Response(body, {
    status: result.statusCode ?? 200,
    headers,
  });
}

export function asResponse(value: Response | LambdaLikeResult): Response {
  if (value instanceof Response) {
    return value;
  }
  return toResponseFromLambdaLike(value);
}

export function resolveRouteHandlerExport(module: LoadedModule): ArtifactRouteHandler {
  if (typeof module.handler === 'function') {
    return module.handler as ArtifactRouteHandler;
  }

  if (typeof module.default === 'function') {
    return module.default as ArtifactRouteHandler;
  }

  if (module.default && typeof module.default === 'object') {
    const nested = module.default as Record<string, unknown>;
    if (typeof nested.handler === 'function') {
      return nested.handler as ArtifactRouteHandler;
    }
    if (typeof nested.fetch === 'function') {
      return nested.fetch as ArtifactRouteHandler;
    }
  }

  if (typeof module.fetch === 'function') {
    return module.fetch as ArtifactRouteHandler;
  }

  throw new Error(
    'Function module does not export a supported handler (expected one of: handler, default, default.handler, fetch)'
  );
}

export function defaultLoadModule(entrypointPath: string): Promise<LoadedModule> {
  return import(pathToFileURL(entrypointPath).href) as Promise<LoadedModule>;
}

export function findEntrypointRelativePath(output: BunFunctionArtifact): string {
  const entrypoint = output.files.find((file) => file.kind === 'entrypoint');
  if (!entrypoint) {
    throw new Error(`Function output "${output.id}" is missing an entrypoint file`);
  }
  return entrypoint.relativePath;
}

export function resolveOutputEntrypointPath(
  output: BunFunctionArtifact,
  adapterDir: string,
  functionRoot: string
): string {
  const relativeEntrypointPath = findEntrypointRelativePath(output);
  return resolveInside(
    adapterDir,
    path.join(functionRoot, relativeEntrypointPath)
  );
}

export function resolveOutputFilePath(
  output: BunFunctionArtifact,
  fileRelativePath: string,
  adapterDir: string,
  functionRoot: string
): string {
  return resolveInside(
    adapterDir,
    path.join(functionRoot, fileRelativePath)
  );
}
