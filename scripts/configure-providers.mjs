import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_SECRETS_PATH = join(WORKSPACE_ROOT, ".secrets.env");

const PROVIDERS = [
  {
    id: "gemini",
    keyEnvs: ["ARGUS_E2E_GEMINI_API_KEYS"],
    modelEnv: "ARGUS_GEMINI_MODEL",
    defaultModel: "gemini-2.5-flash",
  },
  {
    id: "openrouter",
    keyEnvs: ["ARGUS_E2E_OPENROUTER_API_KEY"],
    modelEnv: "ARGUS_OPENROUTER_MODEL",
    defaultModel: "nvidia/nemotron-3.5-super-vl:free",
  },
  {
    id: "groq",
    keyEnvs: ["ARGUS_E2E_GROK_API_KEYS", "ARGUS_E2E_GROQ_API_KEYS"],
    modelEnv: "ARGUS_GROQ_MODEL",
    defaultModel: "qwen/qwen3.8-27b",
  },
];

const HEALTH_TIMEOUT_MS = 5_000;
const PROVIDERS_TIMEOUT_MS = 10_000;
const PUT_TIMEOUT_MS = 360_000;

export function parseEnvFile(contents) {
  const values = new Map();

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) {
      continue;
    }

    let value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      const commentAt = value.indexOf(" #");
      if (commentAt >= 0) {
        value = value.slice(0, commentAt).trim();
      }
    }

    values.set(match[1], value);
  }

  return values;
}

export function parseKeys(value) {
  if (typeof value !== "string") {
    return [];
  }

  return [...new Set(value.split(",").map((key) => key.trim()).filter((key) => key.length > 0))];
}

export function providerKeyId(value) {
  return `k_${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

export function resolveModel(envName, defaultModel, env = process.env) {
  const value = env[envName];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : defaultModel;
}

function firstValue(values, names) {
  for (const name of names) {
    if (values.has(name)) {
      return values.get(name) ?? "";
    }
  }

  return "";
}

function buildProviders(secrets) {
  return PROVIDERS.map((provider) => ({
    id: provider.id,
    model: resolveModel(provider.modelEnv, provider.defaultModel),
    keys: parseKeys(firstValue(secrets, provider.keyEnvs)),
  }));
}

async function readSecrets(file) {
  const info = await stat(file);
  const mode = info.mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(`permission harus 600, saat ini ${mode.toString(8)}.`);
  }

  return parseEnvFile(await readFile(file, "utf8"));
}

function printDryRun(providers) {
  console.log("Mode dry-run: tanpa jaringan dan tanpa membaca api.json.");

  let failed = false;
  for (const provider of providers) {
    if (provider.keys.length > 20) {
      console.error(`[${provider.id}] terlalu banyak key: ${provider.keys.length} (maksimum 20).`);
      failed = true;
      continue;
    }

    console.log(`[${provider.id}] ${provider.model} · ${provider.keys.length} key`);
    for (const key of provider.keys) {
      console.log(`  ${providerKeyId(key)}`);
    }
  }

  return failed ? 1 : 0;
}

function resolveAppDataDir(env) {
  if (env.ARGUS_APP_DATA_DIR) {
    return env.ARGUS_APP_DATA_DIR;
  }

  if (process.platform === "win32") {
    if (!env.APPDATA) {
      throw new Error("APPDATA is not set.");
    }
    return join(env.APPDATA, "Argus");
  }

  return join(homedir(), "Library", "Application Support", "Argus");
}

async function readApiInfo(appDataDir) {
  const contents = await readFile(join(appDataDir, "api.json"), "utf8");
  const value = JSON.parse(contents);

  if (
    value === null ||
    typeof value !== "object" ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535 ||
    typeof value.token !== "string" ||
    value.token.length === 0
  ) {
    throw new Error("api.json is invalid.");
  }

  return { port: value.port, token: value.token };
}

async function requestJson(url, token, options = {}, timeoutMs = PROVIDERS_TIMEOUT_MS) {
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    return { response, payload };
  } catch {
    return null;
  }
}

function problemDetail(payload, fallback) {
  if (
    payload !== null &&
    typeof payload === "object" &&
    typeof payload.detail === "string" &&
    payload.detail.trim().length > 0
  ) {
    return payload.detail.trim();
  }

  return fallback;
}

function sanitize(value, secrets) {
  let text = String(value);
  for (const secret of secrets) {
    if (secret.length > 0) {
      text = text.split(secret).join("[disembunyikan]");
    }
  }

  return text;
}

function printProvider(config, fallback) {
  console.log(`[${config.provider ?? fallback.id}] ${config.model ?? fallback.model} · ${config.keys.length} key`);
  for (const key of config.keys) {
    console.log(`  ${key.id}  ${key.status}  ${key.cooldownUntil ?? "-"}`);
  }
}

async function configure(providers) {
  let api;
  try {
    api = await readApiInfo(resolveAppDataDir(process.env));
  } catch {
    console.error("Aplikasi Argus tidak berjalan.");
    return 1;
  }

  const base = `http://127.0.0.1:${api.port}/v1`;
  const health = await requestJson(`${base}/health`, api.token, {}, HEALTH_TIMEOUT_MS);
  if (health === null || !health.response.ok) {
    console.error("Aplikasi Argus tidak berjalan.");
    return 1;
  }

  console.log("Aplikasi Argus berjalan.");

  const initial = await requestJson(`${base}/providers`, api.token);
  const initialProvider =
    initial !== null && initial.response.ok && typeof initial.payload?.data?.provider === "string"
      ? initial.payload.data.provider
      : null;
  const providersWithActiveLast =
    initialProvider === null
      ? providers
      : [...providers].sort(
          (left, right) => Number(left.id === initialProvider) - Number(right.id === initialProvider),
        );

  const redactions = [...providers.flatMap((provider) => provider.keys), api.token];
  let failures = 0;
  let activeProvider = null;

  for (const provider of providersWithActiveLast) {
    if (provider.keys.length > 20) {
      console.error(`[${provider.id}] terlalu banyak key: ${provider.keys.length} (maksimum 20).`);
      failures += 1;
      continue;
    }

    const put = await requestJson(
      `${base}/providers`,
      api.token,
      {
        method: "PUT",
        body: JSON.stringify({
          provider: provider.id,
          model: provider.model,
          apiKeys: provider.keys,
        }),
      },
      PUT_TIMEOUT_MS,
    );

    if (put === null || !put.response.ok) {
      const detail =
        put === null
          ? "Argus tidak dapat dihubungi."
          : sanitize(problemDetail(put.payload, `HTTP ${put.response.status}`), redactions);
      console.error(`[${provider.id}] gagal: ${detail}`);
      failures += 1;
      continue;
    }

    const current = await requestJson(`${base}/providers`, api.token);
    const config = current?.payload?.data;
    if (current === null || !current.response.ok || config === null || typeof config !== "object" || !Array.isArray(config.keys)) {
      const detail =
        current === null
          ? "Argus tidak dapat dihubungi."
          : sanitize(problemDetail(current.payload, `HTTP ${current.response.status}`), redactions);
      console.error(`[${provider.id}] gagal: ${detail}`);
      failures += 1;
      continue;
    }

    printProvider(config, provider);
    activeProvider = config.provider;
  }

  if (failures > 0) {
    console.error(`Selesai dengan ${failures} kegagalan.`);
    return 1;
  }

  console.log(`Selesai: ${providers.length} provider dikonfigurasi.`);
  if (activeProvider !== null) {
    console.log(`Provider aktif: ${activeProvider}.`);
  }

  return 0;
}

async function main(args) {
  if (args.some((arg) => arg !== "--dry-run")) {
    console.error("Argumen tidak dikenal. Gunakan --dry-run.");
    return 1;
  }

  const dryRun = args.includes("--dry-run");
  const secretsPath = resolve(process.env.ARGUS_SECRETS_FILE ?? DEFAULT_SECRETS_PATH);

  let secrets;
  try {
    secrets = await readSecrets(secretsPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "kesalahan tidak dikenal.";
    console.error(`Tidak dapat membaca ${secretsPath}: ${detail}`);
    return 1;
  }

  const providers = buildProviders(secrets);
  const configured = providers.filter((provider) => provider.keys.length > 0);

  if (configured.length === 0) {
    console.error("Tidak ada key provider di .secrets.env.");
    return 1;
  }

  return dryRun ? printDryRun(providers) : configure(configured);
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.error("Skrip gagal dijalankan.");
      process.exitCode = 1;
    });
}
