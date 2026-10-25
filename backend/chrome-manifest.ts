export type ChromePlatform = "mac-arm64" | "win64";

export type ChromePlatformManifest = {
  readonly url: string;
  readonly sha256: string;
  readonly executableRelativePath: string;
};

export type ChromeManifest = {
  readonly version: string;
  readonly platforms: Readonly<Partial<Record<ChromePlatform, ChromePlatformManifest>>>;
};

export const chromeManifest: ChromeManifest = {
  version: "156.0.8078.47",
  platforms: {
    "mac-arm64": {
      url: "https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.47/mac-arm64/chrome-mac-arm64.zip",
      sha256: "ad7f2b49a4dc679af286b1b1b386670d93ca7868079f69012d21ba0ac8293df3",
      executableRelativePath:
        "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    },
    win64: {
      url: "https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.47/win64/chrome-win64.zip",
      sha256: "a4e0d57245e167e98a9d465af1e3774d2b4ec9f04e483d19bcd97a6f63cf46dd",
      executableRelativePath: "chrome-win64/chrome.exe",
    },
  },
};

export function resolveChromePlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ChromePlatform | null {
  if (platform === "darwin" && arch === "arm64") {
    return "mac-arm64";
  }
  if (platform === "win32" && arch === "x64") {
    return "win64";
  }
  return null;
}
