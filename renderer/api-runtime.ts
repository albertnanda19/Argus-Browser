import {
  ArgusApiError,
  createArgusClient,
  type ArgusClient,
} from "../shared/client";
import type { ApiInfo } from "../shared/contracts";
import { texts } from "./texts";

let nextRuntimeId = 1;

export type ArgusRuntime = {
  readonly id: number;
  readonly client: ArgusClient;
  run<T>(
    timeoutMs: number,
    operation: (client: ArgusClient) => Promise<T>,
  ): Promise<T>;
  dispose(): void;
};

function runOperation<T>(
  client: ArgusClient,
  timeoutMs: number,
  operation: (activeClient: ArgusClient) => Promise<T>,
): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new ArgusApiError(texts.api.unreachable, 0, null));
    };

    timeoutSignal.addEventListener("abort", onAbort, { once: true });
    operation(client).then(
      (value) => {
        timeoutSignal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        timeoutSignal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function createArgusRuntime(apiInfo: ApiInfo): ArgusRuntime {
  const controller = new AbortController();
  const baseFetch: typeof globalThis.fetch = globalThis.fetch;
  const client = createArgusClient({
    api: apiInfo,
    fetch: (input, init) => {
      const signal = init?.signal ?? null;
      return baseFetch(input, {
        ...init,
        signal:
          signal === null
            ? controller.signal
            : AbortSignal.any([controller.signal, signal]),
      });
    },
  });

  return {
    id: nextRuntimeId++,
    client,
    run: (timeoutMs, operation) =>
      runOperation(client, timeoutMs, operation),
    dispose: () => controller.abort(),
  };
}
