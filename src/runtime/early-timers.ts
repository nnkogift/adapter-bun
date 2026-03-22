import { createRequire } from 'node:module';

type PatchedSetTimeout = typeof setTimeout & {
  __adapterBunEarlyPatched?: boolean;
};

type PatchedSetImmediate = ((...immediateArgs: unknown[]) => unknown) & {
  __adapterBunPatched?: boolean;
};

const ENABLE_DEBUG_TIMERS = process.env.ADAPTER_BUN_DEBUG_TIMERS === '1';

function patchSetTimeoutForBunEarly(): void {
  if (process.env.ADAPTER_BUN_DISABLE_EARLY_TIMERS === '1') {
    if (ENABLE_DEBUG_TIMERS) {
      console.log('[adapter-bun][timers] early setTimeout patch disabled');
    }
    return;
  }
  if (typeof process.versions?.bun !== 'string') {
    if (ENABLE_DEBUG_TIMERS) {
      console.log('[adapter-bun][timers] early setTimeout patch skipped: not bun');
    }
    return;
  }

  const currentSetTimeout = globalThis.setTimeout as PatchedSetTimeout;
  if (currentSetTimeout.__adapterBunEarlyPatched) {
    if (ENABLE_DEBUG_TIMERS) {
      console.log('[adapter-bun][timers] early setTimeout patch skipped: already patched');
    }
    return;
  }

  const originalSetTimeout = currentSetTimeout.bind(globalThis);
  const ensureIdleStart = (timer: ReturnType<typeof setTimeout>) => {
    if (timer && typeof timer === 'object') {
      const existingIdleStart = (timer as { _idleStart?: unknown })._idleStart;
      if (typeof existingIdleStart !== 'number') {
        try {
          Object.defineProperty(timer, '_idleStart', {
            configurable: true,
            enumerable: false,
            writable: true,
            value: Date.now(),
          });
        } catch {
          // Ignore environments where timer handles are non-extensible.
        }
      }
    }

    return timer;
  };

  const patchedSetTimeout = ((
    handler: ((...cbArgs: unknown[]) => void) | string,
    timeout?: number,
    ...args: unknown[]
  ) => {
    const timer = (originalSetTimeout as unknown as (
      ...timeoutArgs: unknown[]
    ) => ReturnType<typeof setTimeout>)(
      handler as unknown,
      timeout as unknown,
      ...args
    );

    return ensureIdleStart(timer);
  }) as PatchedSetTimeout;

  patchedSetTimeout.__adapterBunEarlyPatched = true;
  globalThis.setTimeout = patchedSetTimeout;
  if (ENABLE_DEBUG_TIMERS) {
    console.log('[adapter-bun][timers] early setTimeout patch applied');
  }

  try {
    const require = createRequire(import.meta.url);
    const timers = require('node:timers') as {
      setTimeout?: typeof setTimeout;
    };
    if (timers && typeof timers.setTimeout === 'function') {
      timers.setTimeout = patchedSetTimeout as typeof setTimeout;
    }
  } catch {
    // Best effort.
  }

  // Keep timer patching minimal here. We only normalize `_idleStart` so Next's
  // timer checks can run against Bun timer handles.
}

function patchSetImmediateForBunEarly(): void {
  if (process.env.ADAPTER_BUN_PATCH_SETIMMEDIATE !== '1') {
    return;
  }
  if (typeof process.versions?.bun !== 'string') {
    return;
  }
  if (typeof globalThis.setImmediate !== 'function') {
    return;
  }

  const currentSetImmediate = globalThis.setImmediate as PatchedSetImmediate;
  if (currentSetImmediate.__adapterBunPatched) {
    if (ENABLE_DEBUG_TIMERS) {
      console.log('[adapter-bun][timers] early setImmediate patch skipped: already patched');
    }
    return;
  }

  const originalSetTimeout = globalThis.setTimeout.bind(globalThis);
  const originalClearTimeout = globalThis.clearTimeout.bind(globalThis);

  const patchedSetImmediate = ((
    callback: ((...cbArgs: unknown[]) => void) | string,
    ...args: unknown[]
  ) => {
    return originalSetTimeout(() => {
      if (typeof callback === 'function') {
        callback(...args);
      }
    }, 0);
  }) as PatchedSetImmediate;
  patchedSetImmediate.__adapterBunPatched = true;

  const patchedClearImmediate = ((immediateId: unknown) => {
    originalClearTimeout(immediateId as ReturnType<typeof setTimeout>);
  }) as typeof clearImmediate;

  globalThis.setImmediate = patchedSetImmediate as unknown as typeof setImmediate;
  globalThis.clearImmediate = patchedClearImmediate;
  if (ENABLE_DEBUG_TIMERS) {
    console.log('[adapter-bun][timers] early setImmediate patch applied');
  }

  try {
    const require = createRequire(import.meta.url);
    const timers = require('node:timers') as {
      setImmediate?: typeof setImmediate;
      clearImmediate?: typeof clearImmediate;
    };
    if (timers && typeof timers.setImmediate === 'function') {
      timers.setImmediate = patchedSetImmediate as typeof setImmediate;
    }
    if (timers && typeof timers.clearImmediate === 'function') {
      timers.clearImmediate = patchedClearImmediate as typeof clearImmediate;
    }
  } catch {
    // Best effort.
  }
}

patchSetTimeoutForBunEarly();
patchSetImmediateForBunEarly();
