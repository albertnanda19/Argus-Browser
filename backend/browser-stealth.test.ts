import { describe, expect, it } from "vitest";
import { createCdpLaunchArguments } from "./browser-launcher";
import {
  buildFingerprintInitScript,
  canvasNoiseOffset,
  createFingerprintProfile,
  installFingerprintHardening,
  type CdpTransport,
} from "./browser-stealth";

const PLAUSIBLE_HARDWARE_CONCURRENCY = [4, 6, 8, 10, 12, 16];

type SentCommand = {
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId?: string;
};

function isSentCommand(value: unknown): value is SentCommand {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "number" &&
    "method" in value &&
    typeof value.method === "string" &&
    "params" in value &&
    typeof value.params === "object" &&
    value.params !== null
  );
}

function createFakeTransport(options: { readonly attach?: boolean } = {}) {
  const commands: SentCommand[] = [];
  let onMessage: (message: unknown) => void = () => undefined;
  let isClosed = false;

  const transport: CdpTransport = {
    send(message) {
      if (!isSentCommand(message)) {
        throw new Error("Unexpected CDP command shape.");
      }
      commands.push(message);
      const reply = (result: unknown): void => {
        onMessage({ id: message.id, result });
      };

      if (message.method === "Target.getTargets") {
        reply({ targetInfos: [{ type: "page", targetId: "target-1" }] });
        return;
      }

      if (message.method === "Target.setAutoAttach") {
        reply({});
        if (message.params.autoAttach === true && options.attach !== false) {
          onMessage({
            method: "Target.attachedToTarget",
            params: {
              sessionId: "session-1",
              targetInfo: { type: "page", targetId: "target-1" },
              waitingForDebugger: false,
            },
          });
        }
        return;
      }

      reply({ identifier: "script-1" });
    },
    close() {
      isClosed = true;
    },
    onMessage(listener) {
      onMessage = listener;
    },
    onClose() {},
  };

  return {
    transport,
    commands,
    get isClosed() {
      return isClosed;
    },
  };
}

describe("createFingerprintProfile", () => {
  it("derives the same fingerprint for the same profile", () => {
    const first = createFingerprintProfile("p_aaaaaaaaaaaaaaaa");
    const second = createFingerprintProfile("p_aaaaaaaaaaaaaaaa");

    expect(second).toEqual(first);
  });

  it("derives a different fingerprint for a different profile", () => {
    const first = createFingerprintProfile("p_aaaaaaaaaaaaaaaa");
    const second = createFingerprintProfile("p_bbbbbbbbbbbbbbbb");

    expect(second).not.toEqual(first);
  });

  it("chooses hardwareConcurrency from a plausible set", () => {
    for (const key of ["p_a", "p_b", "p_c", "p_d", "p_e", "p_f", "p_g", "p_h"]) {
      expect(PLAUSIBLE_HARDWARE_CONCURRENCY).toContain(
        createFingerprintProfile(key).hardwareConcurrency,
      );
    }
  });
});

describe("canvasNoiseOffset", () => {
  it("is deterministic and stays within one channel step", () => {
    const first = canvasNoiseOffset(42, 1234);

    expect(canvasNoiseOffset(42, 1234)).toBe(first);
    expect(first).toBeGreaterThanOrEqual(-1);
    expect(first).toBeLessThanOrEqual(1);
  });

  it("changes with the seed", () => {
    const first = Array.from({ length: 16 }, (_, index) => canvasNoiseOffset(index, 1));
    const second = Array.from({ length: 16 }, (_, index) => canvasNoiseOffset(index, 2));

    expect(second).not.toEqual(first);
  });
});

describe("buildFingerprintInitScript", () => {
  it("embeds the profile values and patches every required surface", () => {
    const profile = createFingerprintProfile("p_aaaaaaaaaaaaaaaa");
    const script = buildFingerprintInitScript(profile);

    expect(script).toContain(String(profile.hardwareConcurrency));
    expect(script).toContain(String(profile.canvasNoiseSeed));
    expect(script).toContain("webdriver");
    expect(script).toContain("hardwareConcurrency");
    expect(script).toContain("toDataURL");
    expect(script).toContain("getImageData");
    expect(buildFingerprintInitScript(profile)).toBe(script);
  });

  it("differs for different profiles", () => {
    expect(buildFingerprintInitScript(createFingerprintProfile("p_a"))).not.toBe(
      buildFingerprintInitScript(createFingerprintProfile("p_b")),
    );
  });
});

describe("installFingerprintHardening", () => {
  it("enables the page domain before injecting and resuming the target", async () => {
    const fake = createFakeTransport();
    const profile = createFingerprintProfile("p_aaaaaaaaaaaaaaaa");

    const hardening = await installFingerprintHardening(
      { cdpUrl: "http://127.0.0.1:54321", profile },
      {
        fetchVersion: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:54321/devtools/browser" }),
        connect: async () => fake.transport,
      },
    );
    await hardening.close();

    const methods = fake.commands.map((command) => command.method);
    const enableIndex = methods.indexOf("Page.enable");
    const injectIndex = methods.indexOf("Page.addScriptToEvaluateOnNewDocument");
    const resumeIndex = methods.indexOf("Runtime.runIfWaitingForDebugger");

    expect(methods).toContain("Target.getTargets");
    expect(methods).toContain("Target.setAutoAttach");
    expect(enableIndex).toBeGreaterThan(-1);
    expect(injectIndex).toBeGreaterThan(enableIndex);
    expect(resumeIndex).toBeGreaterThan(injectIndex);

    const injection = fake.commands.find(
      (command) => command.method === "Page.addScriptToEvaluateOnNewDocument",
    );
    expect(injection?.sessionId).toBe("session-1");
    expect(injection?.params.runImmediately).toBe(true);
    expect(String(injection?.params.source)).toContain(
      String(profile.hardwareConcurrency),
    );
    expect(fake.isClosed).toBe(true);
  });

  it("fails closed and closes the transport when an existing page never attaches", async () => {
    const fake = createFakeTransport({ attach: false });

    await expect(
      installFingerprintHardening(
        { cdpUrl: "http://127.0.0.1:54321", profile: createFingerprintProfile("p_a") },
        {
          fetchVersion: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:54321/devtools/browser" }),
          connect: async () => fake.transport,
          targetAttachTimeoutMs: 25,
        },
      ),
    ).rejects.toThrow(/attach/i);

    expect(fake.isClosed).toBe(true);
  });
});

describe("createCdpLaunchArguments", () => {
  it("never relies on --enable-automation", () => {
    const launchArguments = createCdpLaunchArguments(54321);

    expect(launchArguments.args).not.toContain("--enable-automation");
    expect(launchArguments.ignoreDefaultArgs).toContain("--enable-automation");
  });
});
