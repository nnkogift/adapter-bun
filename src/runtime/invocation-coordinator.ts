let activeNodeInvocationCount = 0;
let edgeInvocationActive = false;
let waiters: Array<() => void> = [];

function notifyWaiters(): void {
  const pending = waiters;
  waiters = [];
  for (const resolve of pending) {
    resolve();
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  while (!condition()) {
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
  }
}

export async function withNodeRuntimeInvocation<T>(
  run: () => Promise<T>
): Promise<T> {
  await waitFor(() => !edgeInvocationActive);
  activeNodeInvocationCount += 1;
  try {
    return await run();
  } finally {
    activeNodeInvocationCount -= 1;
    notifyWaiters();
  }
}

export async function withEdgeRuntimeInvocation<T>(
  run: () => Promise<T>
): Promise<T> {
  await waitFor(() => !edgeInvocationActive && activeNodeInvocationCount === 0);
  edgeInvocationActive = true;
  try {
    return await run();
  } finally {
    edgeInvocationActive = false;
    notifyWaiters();
  }
}
