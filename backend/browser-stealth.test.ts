import { createContext, runInContext, type Context } from "node:vm";
import { describe, expect, it } from "vitest";
import { createCdpLaunchArguments } from "./browser-launcher";
import {
  buildFingerprintInitScript,
  canvasNoiseOffset,
  createFingerprintProfile,
  installFingerprintHardening,
  type CdpTransport,
  type FingerprintProfile,
} from "./browser-stealth";

const PLAUSIBLE_HARDWARE_CONCURRENCY = [4, 6, 8, 10, 12, 16];

const PAGE_BOOTSTRAP = `
class ImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}
class CanvasRenderingContext2D {
  constructor(canvas) {
    this.canvas = canvas;
  }
  getImageData(sx, sy, sw, sh) {
    const data = new Uint8ClampedArray(sw * sh * 4);
    for (let row = 0; row < sh; row += 1) {
      const from = ((sy + row) * this.canvas.width + sx) * 4;
      data.set(this.canvas._pixels.subarray(from, from + sw * 4), row * sw * 4);
    }
    return new ImageData(data, sw, sh);
  }
  putImageData(image, dx, dy) {
    for (let row = 0; row < image.height; row += 1) {
      const to = ((dy + row) * this.canvas.width + dx) * 4;
      this.canvas._pixels.set(
        image.data.subarray(row * image.width * 4, (row + 1) * image.width * 4),
        to,
      );
    }
  }
  drawImage(source, dx, dy) {
    this.putImageData(
      new ImageData(source._pixels.slice(), source.width, source.height),
      dx,
      dy,
    );
  }
}
class HTMLCanvasElement {
  constructor() {
    this._width = 300;
    this._height = 150;
    this._pixels = new Uint8ClampedArray(this._width * this._height * 4);
  }
  get width() {
    return this._width;
  }
  set width(value) {
    this._width = value;
    this._pixels = new Uint8ClampedArray(this._width * this._height * 4);
  }
  get height() {
    return this._height;
  }
  set height(value) {
    this._height = value;
    this._pixels = new Uint8ClampedArray(this._width * this._height * 4);
  }
  getContext(type) {
    return type === "2d" ? new CanvasRenderingContext2D(this) : null;
  }
  toDataURL(type = "image/png") {
    return "data:" + type + ";base64," + btoa(String.fromCharCode(...this._pixels));
  }
  toBlob(callback, type = "image/png") {
    callback({ type, bytes: this._pixels.slice() });
  }
}
class Navigator {
  get webdriver() {
    return true;
  }
  get hardwareConcurrency() {
    return 2;
  }
}
const paint = (canvas, base) => {
  for (let index = 0; index < canvas._pixels.length; index += 4) {
    const pixel = index / 4;
    canvas._pixels[index] = (base + pixel * 7) % 256;
    canvas._pixels[index + 1] = (base + pixel * 13) % 256;
    canvas._pixels[index + 2] = (base + pixel * 29) % 256;
    canvas._pixels[index + 3] = 255;
  }
};
globalThis.Navigator = Navigator;
globalThis.navigator = new Navigator();
globalThis.HTMLCanvasElement = HTMLCanvasElement;
globalThis.CanvasRenderingContext2D = CanvasRenderingContext2D;
globalThis.ImageData = ImageData;
globalThis.window = globalThis;
globalThis.document = {
  createElement(type) {
    if (type !== "canvas") {
      throw new Error("Unsupported element: " + type);
    }
    return new HTMLCanvasElement();
  },
};
globalThis.__paint = paint;
`;

const CANVAS_PROBE = `(() => {
  const canvas = document.createElement("canvas");
  canvas.width = 8;
  canvas.height = 4;
  __paint(canvas, 11);
  const painted = Array.from(canvas._pixels);
  const context = canvas.getContext("2d");
  const first = canvas.toDataURL("image/png");
  const second = canvas.toDataURL("image/png");
  const jpeg = canvas.toDataURL("image/jpeg");
  let blobType = "";
  let blobLength = 0;
  canvas.toBlob((blob) => {
    blobType = blob.type;
    blobLength = blob.bytes.length;
  }, "image/png");
  const image = context.getImageData(0, 0, 8, 4);
  const repeat = context.getImageData(0, 0, 8, 4);
  const sub = context.getImageData(2, 1, 3, 2);
  return {
    first,
    second,
    jpeg,
    blobType,
    blobLength,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    imageWidth: image.width,
    imageHeight: image.height,
    imageData: Array.from(image.data),
    imageRepeat: Array.from(repeat.data),
    subWidth: sub.width,
    subHeight: sub.height,
    subData: Array.from(sub.data),
    painted,
    sourcePixels: Array.from(canvas._pixels),
  };
})()`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} is not an object.`);
  }
  return value;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`${key} is not a string.`);
  }
  return value;
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number") {
    throw new Error(`${key} is not a number.`);
  }
  return value;
}

function readStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${key} is not a string array.`);
  }
  return value.filter((item): item is string => typeof item === "string");
}

function readNumberArray(record: Record<string, unknown>, key: string): number[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number")) {
    throw new Error(`${key} is not a number array.`);
  }
  return value.filter((item): item is number => typeof item === "number");
}

function createPageContext(): Context {
  const btoa = (value: string): string => Buffer.from(value, "binary").toString("base64");
  const context = createContext({ btoa });
  runInContext(PAGE_BOOTSTRAP, context);
  return context;
}

function runInitScript(
  profile: FingerprintProfile,
  context: Context = createPageContext(),
): Context {
  runInContext(buildFingerprintInitScript(profile), context);
  return context;
}

function evaluate(context: Context, expression: string): unknown {
  return runInContext(expression, context);
}

function readMethodMetadata(
  context: Context,
  owner: string,
  key: string,
): Record<string, unknown> {
  const value = evaluate(
    context,
    `(() => {
      const descriptor = Object.getOwnPropertyDescriptor(${owner}, "${key}");
      const fn = descriptor.value;
      return {
        name: fn.name,
        length: fn.length,
        source: fn.toString(),
        callSource: Function.prototype.toString.call(fn),
        ownProperties: Object.getOwnPropertyNames(fn),
        writable: descriptor.writable,
        enumerable: descriptor.enumerable,
        configurable: descriptor.configurable,
      };
    })()`,
  );
  return readRecord(value, `${owner}.${key}`);
}

function expectNativeMethod(
  context: Context,
  owner: string,
  key: string,
  length: number,
  enumerable: boolean,
): void {
  const metadata = readMethodMetadata(context, owner, key);
  const nativeSource = `function ${key}() { [native code] }`;

  expect(readString(metadata, "name")).toBe(key);
  expect(readNumber(metadata, "length")).toBe(length);
  expect(readString(metadata, "source")).toBe(nativeSource);
  expect(readString(metadata, "callSource")).toBe(nativeSource);
  expect(readStringArray(metadata, "ownProperties").sort()).toEqual(["length", "name"]);
  expect(metadata.writable).toBe(true);
  expect(metadata.enumerable).toBe(enumerable);
  expect(metadata.configurable).toBe(true);
}

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
  it("does not add an Argus marker or touch navigator", () => {
    const profile = createFingerprintProfile("p_aaaaaaaaaaaaaaaa");
    const script = buildFingerprintInitScript(profile);
    const context = createPageContext();

    runInContext(
      'globalThis.__webdriverGetter = Object.getOwnPropertyDescriptor(Navigator.prototype, "webdriver").get;',
      context,
    );
    runInContext(
      'globalThis.__hardwareConcurrencyGetter = Object.getOwnPropertyDescriptor(Navigator.prototype, "hardwareConcurrency").get;',
      context,
    );
    runInContext(script, context);

    const artifacts = evaluate(
      context,
      'Reflect.ownKeys(globalThis).map((key) => String(key)).filter((key) => key.toLowerCase().includes("argus"))',
    );

    expect(script.toLowerCase()).not.toContain("argus");
    expect(script).not.toContain("Symbol.for");
    expect(script).not.toContain("navigator");
    expect(artifacts).toEqual([]);
    expect(
      evaluate(
        context,
        'Object.getOwnPropertyDescriptor(Navigator.prototype, "webdriver").get === globalThis.__webdriverGetter',
      ),
    ).toBe(true);
    expect(
      evaluate(
        context,
        'Object.getOwnPropertyDescriptor(Navigator.prototype, "hardwareConcurrency").get === globalThis.__hardwareConcurrencyGetter',
      ),
    ).toBe(true);
    expect(evaluate(context, "navigator.webdriver")).toBe(true);
  });

  it("presents every patched function as native", () => {
    const context = runInitScript(createFingerprintProfile("p_aaaaaaaaaaaaaaaa"));

    expectNativeMethod(context, "HTMLCanvasElement.prototype", "toDataURL", 0, true);
    expectNativeMethod(context, "HTMLCanvasElement.prototype", "toBlob", 1, true);
    expectNativeMethod(
      context,
      "CanvasRenderingContext2D.prototype",
      "getImageData",
      4,
      true,
    );
    expectNativeMethod(context, "Function.prototype", "toString", 0, false);
  });

  it("keeps canvas noise deterministic, native-shaped, and consistent", () => {
    const profile = createFingerprintProfile("p_aaaaaaaaaaaaaaaa");
    const context = runInitScript(profile);
    const probe = readRecord(evaluate(context, CANVAS_PROBE), "canvas probe");
    const first = readString(probe, "first");
    const imageData = readNumberArray(probe, "imageData");

    expect(readString(probe, "second")).toBe(first);
    expect(first.startsWith("data:image/png;base64,")).toBe(true);
    expect(readString(probe, "jpeg").startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(readString(probe, "blobType")).toBe("image/png");
    expect(readNumber(probe, "blobLength")).toBe(8 * 4 * 4);
    expect(readNumber(probe, "canvasWidth")).toBe(8);
    expect(readNumber(probe, "canvasHeight")).toBe(4);
    expect(readNumber(probe, "imageWidth")).toBe(8);
    expect(readNumber(probe, "imageHeight")).toBe(4);
    expect(readNumberArray(probe, "imageRepeat")).toEqual(imageData);

    const decoded = Array.from(
      Buffer.from(first.slice("data:image/png;base64,".length), "base64"),
    );
    expect(decoded).toEqual(imageData);

    const painted = readNumberArray(probe, "painted");
    expect(readNumberArray(probe, "sourcePixels")).toEqual(painted);
    expect(imageData).not.toEqual(painted);

    const subData = readNumberArray(probe, "subData");
    const subWidth = readNumber(probe, "subWidth");
    const subHeight = readNumber(probe, "subHeight");
    for (let y = 0; y < subHeight; y += 1) {
      for (let x = 0; x < subWidth; x += 1) {
        const subIndex = (y * subWidth + x) * 4;
        const fullIndex = ((1 + y) * 8 + (2 + x)) * 4;
        expect(subData.slice(subIndex, subIndex + 4)).toEqual(
          imageData.slice(fullIndex, fullIndex + 4),
        );
      }
    }
  });

  it("is stable for one profile and different for another", () => {
    const profile = createFingerprintProfile("p_aaaaaaaaaaaaaaaa");
    const first = readString(
      readRecord(evaluate(runInitScript(profile), CANVAS_PROBE), "canvas probe"),
      "first",
    );
    const repeated = readString(
      readRecord(evaluate(runInitScript(profile), CANVAS_PROBE), "canvas probe"),
      "first",
    );
    const other = readString(
      readRecord(
        evaluate(runInitScript(createFingerprintProfile("p_bbbbbbbbbbbbbbbb")), CANVAS_PROBE),
        "canvas probe",
      ),
      "first",
    );

    expect(repeated).toBe(first);
    expect(other).not.toBe(first);
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
    const automationIndex = methods.indexOf("Emulation.setAutomationOverride");
    const hardwareIndex = methods.indexOf("Emulation.setHardwareConcurrencyOverride");
    const enableIndex = methods.indexOf("Page.enable");
    const injectIndex = methods.indexOf("Page.addScriptToEvaluateOnNewDocument");
    const resumeIndex = methods.indexOf("Runtime.runIfWaitingForDebugger");

    expect(methods).toContain("Target.getTargets");
    expect(methods).toContain("Target.setAutoAttach");
    expect(automationIndex).toBeGreaterThan(-1);
    expect(hardwareIndex).toBeGreaterThan(automationIndex);
    expect(enableIndex).toBeGreaterThan(hardwareIndex);
    expect(injectIndex).toBeGreaterThan(enableIndex);
    expect(resumeIndex).toBeGreaterThan(injectIndex);

    const automation = fake.commands.find(
      (command) => command.method === "Emulation.setAutomationOverride",
    );
    expect(automation?.sessionId).toBe("session-1");
    expect(automation?.params).toEqual({ enabled: false });

    const hardware = fake.commands.find(
      (command) => command.method === "Emulation.setHardwareConcurrencyOverride",
    );
    expect(hardware?.sessionId).toBe("session-1");
    expect(hardware?.params).toEqual({
      hardwareConcurrency: profile.hardwareConcurrency,
    });

    const injection = fake.commands.find(
      (command) => command.method === "Page.addScriptToEvaluateOnNewDocument",
    );
    expect(injection?.sessionId).toBe("session-1");
    expect(injection?.params.runImmediately).toBe(true);
    expect(String(injection?.params.source)).toContain(
      String(profile.canvasNoiseSeed),
    );
    expect(String(injection?.params.source).toLowerCase()).not.toContain("argus");
    expect(String(injection?.params.source)).not.toContain("navigator");
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
    expect(launchArguments.args).toContain(
      "--disable-blink-features=AutomationControlled",
    );
    expect(launchArguments.ignoreDefaultArgs).toContain("--enable-automation");
  });
});
