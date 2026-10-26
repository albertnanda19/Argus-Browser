export type AgentAction = {
  readonly selector: string;
  readonly description: string;
  readonly method?: string;
  readonly arguments?: readonly string[];
};

export type AgentActSummary = {
  readonly success: boolean;
  readonly actionCount: number;
};

export type StagehandRuntimeOptions = {
  readonly cdpUrl: string;
  readonly modelName: string;
  readonly apiKey: string;
};

export type StagehandExtractOptions = {
  readonly timeoutMs: number;
  readonly screenshot: boolean;
};

export type StagehandPagePrepareOptions = {
  readonly probeTimeoutMs: number;
  readonly reloadTimeoutMs: number;
};

export type StagehandPagePreparation = {
  readonly ready: boolean;
  readonly reloaded: boolean;
};

export type StagehandRuntime = {
  snapshot(timeoutMs: number): Promise<string>;
  observe(instruction: string, timeoutMs: number): Promise<readonly AgentAction[]>;
  act(input: string | AgentAction, timeoutMs: number): Promise<AgentActSummary>;
  extract(instruction: string, options: StagehandExtractOptions): Promise<unknown>;
  preparePage(options: StagehandPagePrepareOptions): Promise<StagehandPagePreparation>;
  close(): Promise<void>;
};

export type StagehandRuntimeFactory = (
  options: StagehandRuntimeOptions,
) => Promise<StagehandRuntime>;

type RawAction = {
  readonly selector: string;
  readonly description: string;
  readonly method?: string;
  readonly arguments?: string[];
};

function toAgentAction(action: RawAction): AgentAction {
  return {
    selector: action.selector,
    description: action.description,
    ...(action.method === undefined ? {} : { method: action.method }),
    ...(action.arguments === undefined ? {} : { arguments: [...action.arguments] }),
  };
}

function toRawAction(action: AgentAction) {
  return {
    selector: action.selector,
    description: action.description,
    ...(action.method === undefined ? {} : { method: action.method }),
    ...(action.arguments === undefined ? {} : { arguments: [...action.arguments] }),
  };
}

export type LocatorWorldPage = {
  readonly locator: (selector: string) => {
    readonly count: (options: { readonly timeout: number }) => Promise<number>;
  };
  readonly reload: (options: {
    readonly waitUntil: "domcontentloaded";
    readonly timeout: number;
  }) => Promise<unknown>;
};

function withPreparationTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error("Page preparation step timed out."));
    }, timeoutMs);
    timer.unref?.();

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

export async function probeLocatorWorld(
  page: LocatorWorldPage,
  timeoutMs: number,
): Promise<boolean> {
  try {
    await withPreparationTimeout(
      page.locator("body").count({ timeout: timeoutMs }),
      timeoutMs,
    );
    return true;
  } catch {
    return false;
  }
}

export async function prepareStagehandPage(
  page: LocatorWorldPage,
  options: StagehandPagePrepareOptions,
): Promise<StagehandPagePreparation> {
  if (await probeLocatorWorld(page, options.probeTimeoutMs)) {
    return { ready: true, reloaded: false };
  }

  try {
    await withPreparationTimeout(
      page.reload({
        waitUntil: "domcontentloaded",
        timeout: options.reloadTimeoutMs,
      }),
      options.reloadTimeoutMs,
    );
  } catch {
    return { ready: false, reloaded: true };
  }

  return {
    ready: await probeLocatorWorld(page, options.probeTimeoutMs),
    reloaded: true,
  };
}

export function unwrapExtractionResult(data: unknown): unknown {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return data;
  }

  const keys = Object.keys(data);
  if (keys.length !== 1 || keys[0] !== "extraction" || !("extraction" in data)) {
    return data;
  }

  return typeof data.extraction === "string" ? data.extraction : data;
}

function toStagehandModelName(value: string): `google/${string}` {
  const prefix = "google/";
  if (!value.startsWith(prefix) || value.length === prefix.length) {
    throw new Error("The Stagehand runtime only supports Google model names.");
  }
  return `google/${value.slice(prefix.length)}`;
}

export const createStagehandRuntime: StagehandRuntimeFactory = async (options) => {
  const { localBrowser, Stagehand } = await import("@browserbasehq/stagehand");
  const browser = await localBrowser.connect({ cdpUrl: options.cdpUrl });
  const stagehand = await Stagehand.create({
    browser,
    model: {
      modelName: toStagehandModelName(options.modelName),
      apiKey: options.apiKey,
    },
    logging: { level: "off" },
  });

  const resolvePage = async () => {
    const pages = await stagehand.browser.context.pages();
    return pages.at(-1) ?? (await stagehand.browser.context.newPage("about:blank"));
  };

  return {
    async snapshot(timeoutMs) {
      const page = await resolvePage();
      const result = await page.snapshot({ timeout: timeoutMs });
      return result.formattedTree;
    },
    async observe(instruction, timeoutMs) {
      const page = await resolvePage();
      const result = await stagehand.observe(instruction, { page, timeout: timeoutMs });
      return result.data.map(toAgentAction);
    },
    async act(input, timeoutMs) {
      const page = await resolvePage();
      const result =
        typeof input === "string"
          ? await stagehand.act(input, { page, timeout: timeoutMs })
          : await stagehand.act(toRawAction(input), { page, timeout: timeoutMs });
      return {
        success: result.data.success,
        actionCount: result.data.actions.length,
      };
    },
    async extract(instruction, extractOptions) {
      const page = await resolvePage();
      const result = await stagehand.extract(instruction, {
        page,
        timeout: extractOptions.timeoutMs,
        ...(extractOptions.screenshot ? { screenshot: true } : {}),
      });
      return unwrapExtractionResult(result.data);
    },
    async preparePage(prepareOptions) {
      const page = await resolvePage();
      return await prepareStagehandPage(page, prepareOptions);
    },
    async close() {
      await stagehand.close();
    },
  };
};
