import { describe, expect, it } from "vitest";
import type { Session } from "../shared/session";
import {
  findActiveSession,
  isSessionActive,
  nextSessionPollDelay,
  shortSessionId,
} from "./cockpit-state";

function createSession(
  overrides: Pick<Session, "id" | "profileId" | "status">,
): Session {
  return {
    startedAt: "2026-10-28T00:00:00.000Z",
    endedAt: null,
    pid: null,
    ...overrides,
  };
}

describe("findActiveSession", () => {
  it("returns the active session for the selected profile", () => {
    const sessions = [
      createSession({
        id: "s_1111111111111111",
        profileId: "p_1111111111111111",
        status: "starting",
      }),
      createSession({
        id: "s_2222222222222222",
        profileId: "p_2222222222222222",
        status: "ready",
      }),
    ];

    expect(
      findActiveSession(sessions, "p_2222222222222222")?.id,
    ).toBe("s_2222222222222222");
  });

  it("ignores closed and error sessions", () => {
    const sessions = [
      createSession({
        id: "s_1111111111111111",
        profileId: "p_1111111111111111",
        status: "closed",
      }),
      createSession({
        id: "s_2222222222222222",
        profileId: "p_1111111111111111",
        status: "error",
      }),
    ];

    expect(findActiveSession(sessions, "p_1111111111111111")).toBeNull();
  });

  it("returns the active session even when a closed session comes first", () => {
    const sessions = [
      createSession({
        id: "s_1111111111111111",
        profileId: "p_1111111111111111",
        status: "closed",
      }),
      createSession({
        id: "s_2222222222222222",
        profileId: "p_1111111111111111",
        status: "ready",
      }),
    ];

    expect(findActiveSession(sessions, "p_1111111111111111")?.id).toBe(
      "s_2222222222222222",
    );
  });

  it("ignores sessions belonging to other profiles", () => {
    const sessions = [
      createSession({
        id: "s_1111111111111111",
        profileId: "p_1111111111111111",
        status: "busy",
      }),
    ];

    expect(findActiveSession(sessions, "p_2222222222222222")).toBeNull();
  });

  it("returns null when there are no sessions", () => {
    expect(findActiveSession([], "p_1111111111111111")).toBeNull();
  });
});

describe("isSessionActive", () => {
  it("treats starting, ready, busy, and closing as active", () => {
    expect(isSessionActive("starting")).toBe(true);
    expect(isSessionActive("ready")).toBe(true);
    expect(isSessionActive("busy")).toBe(true);
    expect(isSessionActive("closing")).toBe(true);
  });

  it("treats closed and error as inactive", () => {
    expect(isSessionActive("closed")).toBe(false);
    expect(isSessionActive("error")).toBe(false);
  });
});

describe("nextSessionPollDelay", () => {
  it("polls starting and closing every second", () => {
    expect(nextSessionPollDelay("starting")).toBe(1000);
    expect(nextSessionPollDelay("closing")).toBe(1000);
  });

  it("polls busy every two seconds", () => {
    expect(nextSessionPollDelay("busy")).toBe(2000);
  });

  it("stops polling on ready, closed, and error", () => {
    expect(nextSessionPollDelay("ready")).toBeNull();
    expect(nextSessionPollDelay("closed")).toBeNull();
    expect(nextSessionPollDelay("error")).toBeNull();
  });
});

describe("shortSessionId", () => {
  it("keeps the prefix and the first eight hexadecimal characters", () => {
    expect(shortSessionId("s_8b7b7d48683fcfa4")).toBe("s_8b7b7d48");
  });
});
