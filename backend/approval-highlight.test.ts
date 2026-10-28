import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserLocator, BrowserPage, BrowserSessionContext } from "./browser-launcher";
import {
  highlightApprovalElement,
  type ApprovalHighlightResult,
} from "./approval-highlight";

type CdpCall = {
  readonly method: string;
  readonly params: Record<string, unknown>;
};

type FakeSession = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  detach(): Promise<void>;
};

type FakeContext = BrowserSessionContext & {
  newCDPSession(page: BrowserPage): Promise<unknown>;
};

type HarnessState = {
  cdpSessions: number;
  detachCalls: number;
};

type HarnessOptions = {
  readonly send?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  readonly detachError?: unknown;
};

type FakeHarness = {
  readonly context: FakeContext;
  readonly state: HarnessState;
  readonly calls: CdpCall[];
};

const ROOT_NODE_ID = 7;
const TARGET_NODE_ID = 42;
const SEARCH_ID = "search-1";
const XPATH_SELECTOR = "xpath=/html[1]/body[1]/button[1]";
const XPATH_QUERY = "/html[1]/body[1]/button[1]";

function defaultSend(method: string): Promise<unknown> {
  if (method === "DOM.getDocument") {
    return Promise.resolve({ root: { nodeId: ROOT_NODE_ID } });
  }
  if (method === "DOM.performSearch") {
    return Promise.resolve({ searchId: SEARCH_ID, resultCount: 1 });
  }
  if (method === "DOM.getSearchResults") {
    return Promise.resolve({ nodeIds: [TARGET_NODE_ID] });
  }
  return Promise.resolve({});
}

function createFakeHarness(options: HarnessOptions = {}): FakeHarness {
  const state: HarnessState = { cdpSessions: 0, detachCalls: 0 };
  const calls: CdpCall[] = [];

  const page: BrowserPage = {
    async goto() {
      return undefined;
    },
    url: () => "http://127.0.0.1/",
    locator(): BrowserLocator {
      throw new Error("Unexpected locator call.");
    },
  };

  const session: FakeSession = {
    async send(method, params = {}) {
      calls.push({ method, params });
      return await (options.send ?? defaultSend)(method, params);
    },
    async detach() {
      state.detachCalls += 1;
      if (options.detachError !== undefined) {
        throw options.detachError;
      }
    },
  };

  const context: FakeContext = {
    on: () => undefined,
    pages: () => [page],
    async newPage() {
      throw new Error("Unexpected newPage call.");
    },
    async close() {
      return undefined;
    },
    async newCDPSession() {
      state.cdpSessions += 1;
      return session;
    },
  };

  return { context, state, calls };
}

function callsSince(calls: readonly CdpCall[], index: number): string[] {
  return calls.slice(index).map((call) => call.method);
}

function findCall(calls: readonly CdpCall[], method: string): CdpCall | undefined {
  return calls.find((call) => call.method === method);
}

function requireHighlighted(result: ApprovalHighlightResult): {
  readonly highlighted: true;
  clear(): Promise<void>;
} {
  if (!result.highlighted) {
    throw new Error(`Expected highlight success, received ${result.reason}.`);
  }
  return result;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("approval highlight", () => {
  it("highlights the first CSS match with its node id and keeps the session open", async () => {
    const harness = createFakeHarness();

    const result = await highlightApprovalElement({
      context: harness.context,
      selector: "#kirim",
    });

    expect(result.highlighted).toBe(true);
    expect(harness.calls.map((call) => call.method)).toEqual([
      "DOM.getDocument",
      "DOM.performSearch",
      "DOM.getSearchResults",
      "Overlay.enable",
      "Overlay.highlightNode",
      "DOM.discardSearchResults",
    ]);
    expect(findCall(harness.calls, "DOM.performSearch")?.params).toEqual({
      query: "#kirim",
    });
    expect(findCall(harness.calls, "Overlay.highlightNode")?.params.nodeId).toBe(
      TARGET_NODE_ID,
    );
    expect(
      findCall(harness.calls, "Overlay.highlightNode")?.params.highlightConfig,
    ).toMatchObject({
      showInfo: true,
      showStyles: true,
      showRulers: true,
      contentColor: { a: expect.any(Number) },
      borderColor: { a: expect.any(Number) },
    });
    expect(
      findCall(harness.calls, "DOM.discardSearchResults")?.params,
    ).toEqual({ searchId: SEARCH_ID });
    expect(harness.state.detachCalls).toBe(0);
  });

  it("strips the xpath prefix, highlights the first match, and discards the search", async () => {
    const harness = createFakeHarness();

    const result = await highlightApprovalElement({
      context: harness.context,
      selector: XPATH_SELECTOR,
    });

    expect(result.highlighted).toBe(true);
    expect(findCall(harness.calls, "DOM.performSearch")?.params).toEqual({
      query: XPATH_QUERY,
    });
    expect(findCall(harness.calls, "DOM.getSearchResults")?.params).toEqual({
      searchId: SEARCH_ID,
      fromIndex: 0,
      toIndex: 1,
    });
    expect(findCall(harness.calls, "Overlay.highlightNode")?.params.nodeId).toBe(
      TARGET_NODE_ID,
    );
    expect(
      findCall(harness.calls, "DOM.discardSearchResults")?.params,
    ).toEqual({ searchId: SEARCH_ID });
    expect(harness.state.detachCalls).toBe(0);
  });

  it("passes the selector as CDP data without evaluating JavaScript", async () => {
    const harness = createFakeHarness();

    await highlightApprovalElement({
      context: harness.context,
      selector: XPATH_SELECTOR,
    });

    expect(
      harness.calls.some((call) => call.method.startsWith("Runtime.")),
    ).toBe(false);
    expect(
      harness.calls.some((call) =>
        JSON.stringify(call.params).includes("function"),
      ),
    ).toBe(false);
  });

  it("returns not_found when an xpath search has no results", async () => {
    const harness = createFakeHarness({
      send: async (method) => {
        if (method === "DOM.getDocument") {
          return { root: { nodeId: ROOT_NODE_ID } };
        }
        if (method === "DOM.performSearch") {
          return { searchId: SEARCH_ID, resultCount: 0 };
        }
        if (method === "DOM.getSearchResults") {
          return { nodeIds: [] };
        }
        return {};
      },
    });

    const result = await highlightApprovalElement({
      context: harness.context,
      selector: "xpath=/html[1]/body[1]/button[9]",
    });

    expect(result).toEqual({ highlighted: false, reason: "not_found" });
    expect(
      findCall(harness.calls, "DOM.discardSearchResults")?.params,
    ).toEqual({ searchId: SEARCH_ID });
    expect(harness.state.detachCalls).toBe(1);
  });

  it("returns not_found when a CSS search has no results", async () => {
    const harness = createFakeHarness({
      send: async (method) => {
        if (method === "DOM.getDocument") {
          return { root: { nodeId: ROOT_NODE_ID } };
        }
        if (method === "DOM.performSearch") {
          return { searchId: SEARCH_ID, resultCount: 0 };
        }
        if (method === "DOM.getSearchResults") {
          return { nodeIds: [] };
        }
        return {};
      },
    });

    const result = await highlightApprovalElement({
      context: harness.context,
      selector: "#missing",
    });

    expect(result).toEqual({ highlighted: false, reason: "not_found" });
    expect(harness.state.detachCalls).toBe(1);
  });

  it("returns overlay_failed when the search rejects", async () => {
    const harness = createFakeHarness({
      send: async (method) => {
        if (method === "DOM.getDocument") {
          return { root: { nodeId: ROOT_NODE_ID } };
        }
        if (method === "DOM.performSearch") {
          throw new Error("CDP command failed.");
        }
        return {};
      },
    });

    const result = await highlightApprovalElement({
      context: harness.context,
      selector: XPATH_SELECTOR,
    });

    expect(result).toEqual({ highlighted: false, reason: "overlay_failed" });
    expect(findCall(harness.calls, "DOM.discardSearchResults")).toBeUndefined();
    expect(harness.state.detachCalls).toBe(1);
  });

  it("returns overlay_failed when reading search results rejects and still discards", async () => {
    const harness = createFakeHarness({
      send: async (method) => {
        if (method === "DOM.getDocument") {
          return { root: { nodeId: ROOT_NODE_ID } };
        }
        if (method === "DOM.performSearch") {
          return { searchId: SEARCH_ID, resultCount: 1 };
        }
        if (method === "DOM.getSearchResults") {
          throw new Error("CDP command failed.");
        }
        return {};
      },
    });

    const result = await highlightApprovalElement({
      context: harness.context,
      selector: XPATH_SELECTOR,
    });

    expect(result).toEqual({ highlighted: false, reason: "overlay_failed" });
    expect(
      findCall(harness.calls, "DOM.discardSearchResults")?.params,
    ).toEqual({ searchId: SEARCH_ID });
    expect(harness.state.detachCalls).toBe(1);
  });

  it("clears the highlight, disables the overlay and detaches the session", async () => {
    const harness = createFakeHarness();
    const result = requireHighlighted(
      await highlightApprovalElement({
        context: harness.context,
        selector: "#kirim",
      }),
    );
    const mark = harness.calls.length;

    await expect(result.clear()).resolves.toBeUndefined();

    expect(callsSince(harness.calls, mark)).toEqual([
      "Overlay.hideHighlight",
      "Overlay.disable",
    ]);
    expect(harness.state.detachCalls).toBe(1);
  });

  it("keeps clear idempotent without sending duplicate commands", async () => {
    const harness = createFakeHarness();
    const result = requireHighlighted(
      await highlightApprovalElement({
        context: harness.context,
        selector: "#kirim",
      }),
    );
    await result.clear();
    const mark = harness.calls.length;

    await expect(result.clear()).resolves.toBeUndefined();

    expect(callsSince(harness.calls, mark)).toEqual([]);
    expect(harness.state.detachCalls).toBe(1);
  });

  it("swallows clear failures and detaches in finally", async () => {
    const harness = createFakeHarness({
      send: async (method) => {
        if (method === "DOM.getDocument") {
          return { root: { nodeId: ROOT_NODE_ID } };
        }
        if (method === "DOM.performSearch") {
          return { searchId: SEARCH_ID, resultCount: 1 };
        }
        if (method === "DOM.getSearchResults") {
          return { nodeIds: [TARGET_NODE_ID] };
        }
        if (method === "Overlay.hideHighlight" || method === "Overlay.disable") {
          throw new Error("Overlay command failed.");
        }
        return {};
      },
      detachError: new Error("Detach failed."),
    });
    const result = requireHighlighted(
      await highlightApprovalElement({
        context: harness.context,
        selector: "#kirim",
      }),
    );

    await expect(result.clear()).resolves.toBeUndefined();

    expect(harness.state.detachCalls).toBe(1);
  });

  it("returns selector_missing without opening a CDP session", async () => {
    const harness = createFakeHarness();

    const blank = await highlightApprovalElement({
      context: harness.context,
      selector: "   ",
    });
    const emptyXPath = await highlightApprovalElement({
      context: harness.context,
      selector: "xpath=   ",
    });

    expect(blank).toEqual({ highlighted: false, reason: "selector_missing" });
    expect(emptyXPath).toEqual({
      highlighted: false,
      reason: "selector_missing",
    });
    expect(harness.state.cdpSessions).toBe(0);
    expect(harness.calls).toEqual([]);
  });

  it("returns timeout when a CDP command exceeds the injected timeout", async () => {
    vi.useFakeTimers();
    const harness = createFakeHarness({
      send: async (method) => {
        if (method === "DOM.getDocument") {
          return { root: { nodeId: ROOT_NODE_ID } };
        }
        if (method === "DOM.performSearch") {
          return { searchId: SEARCH_ID, resultCount: 1 };
        }
        if (method === "DOM.getSearchResults") {
          return { nodeIds: [TARGET_NODE_ID] };
        }
        if (method === "Overlay.highlightNode") {
          return await new Promise<unknown>(() => undefined);
        }
        return {};
      },
    });

    const execution = highlightApprovalElement({
      context: harness.context,
      selector: XPATH_SELECTOR,
      timeoutMs: 500,
    });
    await vi.advanceTimersByTimeAsync(500);
    const result = await execution;

    expect(result).toEqual({ highlighted: false, reason: "timeout" });
    expect(
      findCall(harness.calls, "DOM.discardSearchResults")?.params,
    ).toEqual({ searchId: SEARCH_ID });
    expect(harness.state.detachCalls).toBe(1);
  });

  it("does not leave an unhandled rejection when a send rejects after the timeout", async () => {
    const pending: { reject: ((error: unknown) => void) | null } = {
      reject: null,
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    const harness = createFakeHarness({
      send: async (method) => {
        if (method === "DOM.getDocument") {
          return { root: { nodeId: ROOT_NODE_ID } };
        }
        if (method === "DOM.performSearch") {
          return { searchId: SEARCH_ID, resultCount: 1 };
        }
        if (method === "DOM.getSearchResults") {
          return { nodeIds: [TARGET_NODE_ID] };
        }
        if (method === "Overlay.highlightNode") {
          return await new Promise<unknown>((_resolve, reject) => {
            pending.reject = reject;
          });
        }
        return {};
      },
    });

    try {
      const result = await highlightApprovalElement({
        context: harness.context,
        selector: XPATH_SELECTOR,
        timeoutMs: 5,
      });
      expect(result).toEqual({ highlighted: false, reason: "timeout" });

      const rejectLate = pending.reject;
      expect(rejectLate).not.toBeNull();
      if (rejectLate !== null) {
        rejectLate(new Error("Late CDP rejection."));
      }
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
