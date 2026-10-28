import { describe, expect, it } from "vitest";
import type { AgentStep } from "../shared/agent-step";
import type { SessionStatus } from "../shared/session";
import {
  formatStepDuration,
  sanitizePageUrl,
  selectCurrentStep,
  shouldPollThumbnail,
} from "./task-panel-state";

function createStep(index: number, url: string, durationMs: number): AgentStep {
  return {
    id: `st_${String(index).padStart(16, "0")}`,
    taskId: "t_1111111111111111",
    index,
    action: "click",
    target: `Target ${index}`,
    result: {
      status: "done",
      url,
      pageChanged: true,
      verification: null,
    },
    durationMs,
  };
}

describe("selectCurrentStep", () => {
  it("uses the highest cached step when there is no overlay", () => {
    const steps = [
      createStep(2, "https://example.com/dua?token=abc#hasil", 2500),
      createStep(1, "https://example.com/satu", 10),
    ];

    expect(selectCurrentStep(steps, undefined)).toEqual({
      index: 2,
      action: "click",
      target: "Target 2",
      status: "done",
      durationMs: 2500,
      url: "https://example.com/dua?token=abc#hasil",
    });
  });

  it("prefers a live overlay step with a greater index", () => {
    const steps = [createStep(2, "https://example.com/dua", 2500)];

    expect(
      selectCurrentStep(steps, {
        index: 3,
        action: "type",
        target: "Kolom nama",
        url: "https://example.com/tiga",
        status: "failed",
      }),
    ).toEqual({
      index: 3,
      action: "type",
      target: "Kolom nama",
      status: "failed",
      durationMs: null,
      url: "https://example.com/tiga",
    });
  });

  it("prefers the live overlay at the same index and keeps the cached duration", () => {
    const steps = [createStep(2, "https://example.com/dua", 2500)];

    expect(
      selectCurrentStep(steps, {
        index: 2,
        action: "type",
        target: "Kolom nama",
        url: "https://example.com/dua",
        status: "done",
      }),
    ).toEqual({
      index: 2,
      action: "type",
      target: "Kolom nama",
      status: "done",
      durationMs: 2500,
      url: "https://example.com/dua",
    });
  });

  it("keeps the cached step when the overlay is older", () => {
    const steps = [createStep(3, "https://example.com/tiga", 30)];

    expect(
      selectCurrentStep(steps, {
        index: 2,
        action: "type",
        target: "Kolom nama",
        url: "https://example.com/dua",
        status: "done",
      }),
    ).toMatchObject({ index: 3, url: "https://example.com/tiga" });
  });

  it("returns null when neither source has a step", () => {
    expect(selectCurrentStep([], undefined)).toBeNull();
  });
});

describe("sanitizePageUrl", () => {
  it("keeps origin and pathname without query or hash", () => {
    expect(
      sanitizePageUrl("https://example.com/halaman/data?token=abc#bagian"),
    ).toBe("https://example.com/halaman/data");
    expect(sanitizePageUrl("http://127.0.0.1:8080/a/b?x=1")).toBe(
      "http://127.0.0.1:8080/a/b",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizePageUrl("  https://example.com/halaman  ")).toBe(
      "https://example.com/halaman",
    );
  });

  it("shows non-http URLs without query or hash", () => {
    expect(sanitizePageUrl("about:blank")).toBe("about:blank");
    expect(sanitizePageUrl("file:///Users/a/halaman.html?x=1#y")).toBe(
      "file:///Users/a/halaman.html",
    );
  });

  it("shows unparseable URLs as they are", () => {
    expect(sanitizePageUrl("bukan url")).toBe("bukan url");
  });

  it("returns null for an empty URL", () => {
    expect(sanitizePageUrl("")).toBeNull();
    expect(sanitizePageUrl("   ")).toBeNull();
  });
});

describe("shouldPollThumbnail", () => {
  const cases: ReadonlyArray<{
    readonly status: SessionStatus | null;
    readonly visibility: DocumentVisibilityState;
    readonly expected: boolean;
  }> = [
    { status: "ready", visibility: "visible", expected: true },
    { status: "busy", visibility: "visible", expected: true },
    { status: "ready", visibility: "hidden", expected: false },
    { status: "busy", visibility: "hidden", expected: false },
    { status: "starting", visibility: "visible", expected: false },
    { status: "closing", visibility: "visible", expected: false },
    { status: "closed", visibility: "visible", expected: false },
    { status: "error", visibility: "visible", expected: false },
    { status: null, visibility: "visible", expected: false },
  ];

  it("polls only while the session is ready or busy and the tab is visible", () => {
    for (const testCase of cases) {
      expect(
        shouldPollThumbnail(testCase.status, testCase.visibility),
      ).toBe(testCase.expected);
    }
  });
});

describe("formatStepDuration", () => {
  it("uses milliseconds below one second", () => {
    expect(formatStepDuration(0)).toBe("0 ms");
    expect(formatStepDuration(999)).toBe("999 ms");
  });

  it("uses Indonesian seconds from one second up", () => {
    expect(formatStepDuration(1000)).toBe("1 dtk");
    expect(formatStepDuration(1200)).toBe("1,2 dtk");
    expect(formatStepDuration(65000)).toBe("65 dtk");
  });
});
