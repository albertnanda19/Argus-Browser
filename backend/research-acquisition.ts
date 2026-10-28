import type { BrowserPage, BrowserSessionContext } from "./browser-launcher";
import type { ResearchPageArtifact, ResearchPageLink } from "./research-extract";

export type ResearchSourceClass =
  | "website"
  | "github"
  | "linkedin"
  | "social"
  | "academic";

export type ResearchDiscoveryStatus = "visited" | "skipped" | "failed";

export type ResearchAcquisitionOptions = {
  targetName: string;
  organization: string | null;
  searchBaseUrl?: string;
  wait?: () => Promise<void>;
};

export type ResearchDiscovery = {
  query: string;
  rank: number;
  title: string;
  resultUrl: string;
  finalUrl: string | null;
  sourceClass: ResearchSourceClass;
  status: ResearchDiscoveryStatus;
  reason: string | null;
};

export type ResearchAcquisitionResult = {
  pages: ResearchPageArtifact[];
  discoveries: ResearchDiscovery[];
  searchFailures: Array<{ query: string; reason: string }>;
};

type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

type SearchSnapshot = {
  results: SearchResult[];
  hasCaptcha: boolean;
};

type PageSnapshot = {
  contentType: string;
  text: string;
  links: ResearchPageLink[];
  jsonLd: unknown[];
};

type Candidate = {
  query: string;
  queryIndex: number;
  rank: number;
  title: string;
  snippet: string;
  resultUrl: string;
  sourceClass: ResearchSourceClass;
  score: number;
};

type PageOutcome = {
  artifact: ResearchPageArtifact | null;
  finalUrl: string | null;
  status: ResearchDiscoveryStatus;
  reason: string | null;
};

const SEARCH_BASE_URL = "https://www.google.com";
const MAX_QUERIES = 3;
const MAX_RESULTS_PER_QUERY = 10;
const MAX_VISITED_PAGES = 12;
const SEARCH_TIMEOUT_MS = 20_000;
const PAGE_TIMEOUT_MS = 15_000;
const NETWORK_IDLE_TIMEOUT_MS = 2_000;
const MAX_TEXT_CHARS = 2_000_000;
const MAX_LINKS = 2_000;
const MAX_LINK_CONTEXT_CHARS = 400;
const MAX_JSONLD_NODES = 500;
const MAX_SNIPPET_CHARS = 1_000;

const CONSENT_REASON = "Google meminta persetujuan.";
const VERIFICATION_REASON = "Google meminta verifikasi manusia.";
const SEARCH_OPEN_REASON = "Pencarian tidak dapat dibuka.";
const NO_RESULTS_REASON = "Tidak ada hasil organik.";
const LOGIN_REASON = "Halaman meminta login.";
const NON_HTML_REASON = "Halaman bukan HTML.";
const PAGE_TIMEOUT_REASON = "Halaman tidak merespons dalam batas waktu.";
const PAGE_FAILED_REASON = "Halaman gagal dibuka.";
const EMPTY_PAGE_REASON = "Halaman kosong.";
const INVALID_TARGET_REASON = "Nama target wajib diisi.";
const INVALID_SEARCH_BASE_REASON = "Alamat pencarian tidak valid.";
const EVALUATE_UNSUPPORTED_REASON = "Browser tidak mendukung evaluasi halaman.";

const SOCIAL_HOSTS: readonly string[] = [
  "x.com",
  "twitter.com",
  "instagram.com",
  "facebook.com",
  "tiktok.com",
  "youtube.com",
];

const TRACKING_PARAMETERS: ReadonlySet<string> = new Set(["gclid", "fbclid"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function noopWait(): Promise<void> {
  return Promise.resolve();
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((token) => token.length > 0);
}

function countToken(haystackTokens: readonly string[], token: string): number {
  return haystackTokens.filter((candidate) => candidate === token).length;
}

function scoreCandidate(
  nameTokens: readonly string[],
  organizationTokens: readonly string[],
  title: string,
  snippet: string,
): number {
  const haystackTokens = tokenize(`${title} ${snippet}`);
  let score = 0;

  for (const token of nameTokens) {
    score += countToken(haystackTokens, token);
  }
  for (const token of organizationTokens) {
    score += 2 * countToken(haystackTokens, token);
  }

  return score;
}

function buildQueries(targetName: string, organization: string | null): string[] {
  const identity =
    organization === null
      ? `"${targetName}"`
      : `"${targetName}" "${organization}"`;

  return [
    identity,
    `"${targetName}" (whatsapp OR wa.me OR "nomor telepon" OR email)`,
    `"${targetName}" (site:linkedin.com/in OR site:github.com OR site:scholar.google.com OR site:researchgate.net OR site:instagram.com)`,
  ];
}

function normalizeSearchBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (parseHttpUrl(trimmed) === null) {
    throw new Error(INVALID_SEARCH_BASE_REASON);
  }

  return trimmed;
}

function buildSearchUrl(searchBaseUrl: string, query: string): string {
  return `${searchBaseUrl}/search?q=${encodeURIComponent(query)}&hl=id&num=10`;
}

function parseHttpUrl(value: string, base?: string): URL | null {
  try {
    const url = base === undefined ? new URL(value) : new URL(value, base);

    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function isGoogleRedirectHost(host: string): boolean {
  return host === "google.com" || host.endsWith(".google.com");
}

function resolveResultUrl(raw: string, base: string): URL | null {
  const resolved = parseHttpUrl(raw, base);
  if (resolved === null) {
    return null;
  }
  const isRedirect =
    resolved.pathname === "/url" &&
    (isGoogleRedirectHost(resolved.hostname.toLowerCase()) ||
      raw.trimStart().startsWith("/url"));
  if (isRedirect) {
    const target = resolved.searchParams.get("q");

    return target === null ? null : parseHttpUrl(target);
  }

  return resolved;
}

function isExcludedGoogleHost(host: string): boolean {
  return (
    host === "google.com" ||
    host === "www.google.com" ||
    host === "gstatic.com" ||
    host === "www.gstatic.com" ||
    host === "accounts.google.com" ||
    host === "consent.google.com"
  );
}

function isTrackingParameter(name: string): boolean {
  return name.startsWith("utm_") || TRACKING_PARAMETERS.has(name);
}

function normalizeResultUrl(url: URL): string {
  const parameters = new URLSearchParams(url.search);
  for (const name of [...parameters.keys()]) {
    if (isTrackingParameter(name)) {
      parameters.delete(name);
    }
  }
  const path = url.pathname.replace(/\/+$/, "");
  const query = parameters.toString();
  const suffix = query.length > 0 ? `?${query}` : "";

  return `${url.protocol}//${url.host.toLowerCase()}${path}${suffix}`;
}

function resolveFinalUrl(value: string): string | null {
  if (parseHttpUrl(value) === null) {
    return null;
  }
  const hashIndex = value.indexOf("#");

  return hashIndex === -1 ? value : value.slice(0, hashIndex);
}

function isConsentUrl(value: string): boolean {
  const url = parseHttpUrl(value);

  return url !== null && url.hostname.toLowerCase() === "consent.google.com";
}

function isVerificationUrl(value: string): boolean {
  return value.includes("/sorry/");
}

function matchesHost(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function classifySource(host: string): ResearchSourceClass {
  if (matchesHost(host, "linkedin.com")) {
    return "linkedin";
  }
  if (matchesHost(host, "github.com")) {
    return "github";
  }
  if (
    matchesHost(host, "scholar.google.com") ||
    matchesHost(host, "researchgate.net") ||
    matchesHost(host, "orcid.org") ||
    matchesHost(host, "arxiv.org") ||
    host.endsWith(".edu")
  ) {
    return "academic";
  }
  if (SOCIAL_HOSTS.some((domain) => matchesHost(host, domain))) {
    return "social";
  }

  return "website";
}

function isLoginUrl(value: string): boolean {
  const url = parseHttpUrl(value);
  if (url === null) {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (host === "accounts.google.com" || host.startsWith("login.")) {
    return true;
  }
  if (matchesHost(host, "linkedin.com")) {
    return (
      path === "/login" ||
      path.startsWith("/login/") ||
      path === "/authwall" ||
      path.startsWith("/authwall/")
    );
  }

  return false;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function readGoogleResults(): { results: SearchResult[]; hasCaptcha: boolean } {
  const results: SearchResult[] = [];
  const hasCaptcha = document.querySelector("#captcha-form, #recaptcha") !== null;
  const scope = document.querySelector("#rso") ?? document.querySelector("#search");
  if (scope === null) {
    return { results, hasCaptcha };
  }

  const anchors = Array.from(scope.querySelectorAll("a[href]"));
  const titledAnchors = anchors.filter((anchor) => anchor.querySelector("h3") !== null);
  const candidates = titledAnchors.length > 0 ? titledAnchors : anchors;

  for (const anchor of candidates) {
    if (results.length >= 10) {
      break;
    }
    if (anchor.closest("[data-text-ad]") !== null) {
      continue;
    }
    const href = (anchor.getAttribute("href") ?? "").trim();
    if (href.length === 0 || href.startsWith("#")) {
      continue;
    }
    const heading = anchor.querySelector("h3");
    const title = (heading?.textContent ?? anchor.textContent ?? "").trim();
    if (title.length === 0) {
      continue;
    }
    const block = anchor.closest("div.g, div[data-hveid]") ?? anchor.parentElement;
    const snippet = (block?.textContent ?? "")
      .replace(title, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1_000);
    results.push({ title, url: href, snippet });
  }

  return { results, hasCaptcha };
}

function readPageSnapshot(): PageSnapshot {
  const text = (document.body?.innerText ?? "").slice(0, 2_000_000);
  const links: ResearchPageLink[] = [];

  for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
    if (links.length >= 2_000) {
      break;
    }
    const href = (anchor.getAttribute("href") ?? "").trim();
    if (href.length === 0) {
      continue;
    }
    const block = anchor.closest("p, li, article, section") ?? anchor.parentElement;
    const context = (block?.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 400);
    links.push({
      href,
      text: (anchor.textContent ?? "").trim(),
      context,
    });
  }

  const jsonLd: unknown[] = [];
  for (const script of Array.from(
    document.querySelectorAll('script[type="application/ld+json"]'),
  )) {
    if (jsonLd.length >= 500) {
      break;
    }
    try {
      jsonLd.push(JSON.parse(script.textContent ?? ""));
    } catch {
      continue;
    }
  }

  return { contentType: document.contentType, text, links, jsonLd };
}

function parseSearchSnapshot(value: unknown): SearchSnapshot | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.results) ||
    typeof value.hasCaptcha !== "boolean"
  ) {
    return null;
  }

  const results: SearchResult[] = [];
  for (const item of value.results) {
    if (!isRecord(item)) {
      continue;
    }
    const title = item.title;
    const url = item.url;
    const snippet = item.snippet;
    if (
      typeof title !== "string" ||
      typeof url !== "string" ||
      title.length === 0 ||
      url.length === 0
    ) {
      continue;
    }
    results.push({
      title,
      url,
      snippet:
        typeof snippet === "string" ? snippet.slice(0, MAX_SNIPPET_CHARS) : "",
    });
  }

  return { results, hasCaptcha: value.hasCaptcha };
}

function parsePageSnapshot(value: unknown): PageSnapshot | null {
  if (
    !isRecord(value) ||
    typeof value.contentType !== "string" ||
    typeof value.text !== "string" ||
    !Array.isArray(value.links) ||
    !Array.isArray(value.jsonLd)
  ) {
    return null;
  }

  const links: ResearchPageLink[] = [];
  for (const item of value.links) {
    if (links.length >= MAX_LINKS) {
      break;
    }
    if (!isRecord(item)) {
      continue;
    }
    const href = item.href;
    const text = item.text;
    const context = item.context;
    if (
      typeof href !== "string" ||
      typeof text !== "string" ||
      typeof context !== "string"
    ) {
      continue;
    }
    links.push({
      href,
      text,
      context: context.slice(0, MAX_LINK_CONTEXT_CHARS),
    });
  }

  return {
    contentType: value.contentType,
    text: value.text.slice(0, MAX_TEXT_CHARS),
    links,
    jsonLd: value.jsonLd.slice(0, MAX_JSONLD_NODES),
  };
}

async function evaluatePage(
  page: BrowserPage,
  pageFunction: () => unknown,
): Promise<unknown> {
  const evaluate = page.evaluate;
  if (evaluate === undefined) {
    throw new Error(EVALUATE_UNSUPPORTED_REASON);
  }

  return await evaluate.call(page, pageFunction);
}

async function visitPage(
  page: BrowserPage,
  url: string,
  wait: () => Promise<void>,
): Promise<PageOutcome> {
  await wait();

  try {
    await page.goto(url, { timeout: PAGE_TIMEOUT_MS, waitUntil: "domcontentloaded" });
  } catch (error) {
    return {
      artifact: null,
      finalUrl: null,
      status: "failed",
      reason: isTimeoutError(error) ? PAGE_TIMEOUT_REASON : PAGE_FAILED_REASON,
    };
  }

  const waitForLoadState = page.waitForLoadState;
  if (waitForLoadState !== undefined) {
    await waitForLoadState
      .call(page, "networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS })
      .catch(() => undefined);
  }

  const finalUrl = resolveFinalUrl(page.url());
  if (finalUrl === null) {
    return {
      artifact: null,
      finalUrl: null,
      status: "failed",
      reason: PAGE_FAILED_REASON,
    };
  }

  if (isLoginUrl(finalUrl)) {
    return { artifact: null, finalUrl, status: "skipped", reason: LOGIN_REASON };
  }

  const parsedFinalUrl = parseHttpUrl(finalUrl);
  if (
    parsedFinalUrl === null ||
    isExcludedGoogleHost(parsedFinalUrl.hostname.toLowerCase())
  ) {
    return {
      artifact: null,
      finalUrl,
      status: "failed",
      reason: PAGE_FAILED_REASON,
    };
  }

  let snapshot: PageSnapshot | null;
  try {
    snapshot = parsePageSnapshot(await evaluatePage(page, readPageSnapshot));
  } catch {
    return {
      artifact: null,
      finalUrl,
      status: "failed",
      reason: PAGE_FAILED_REASON,
    };
  }

  if (snapshot === null) {
    return {
      artifact: null,
      finalUrl,
      status: "failed",
      reason: PAGE_FAILED_REASON,
    };
  }

  const contentType = snapshot.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (contentType !== "text/html") {
    return { artifact: null, finalUrl, status: "skipped", reason: NON_HTML_REASON };
  }

  if (
    snapshot.text.trim().length === 0 &&
    snapshot.links.length === 0 &&
    snapshot.jsonLd.length === 0
  ) {
    return { artifact: null, finalUrl, status: "skipped", reason: EMPTY_PAGE_REASON };
  }

  return {
    artifact: {
      sourceUrl: finalUrl,
      text: snapshot.text,
      links: snapshot.links,
      jsonLd: snapshot.jsonLd,
    },
    finalUrl,
    status: "visited",
    reason: null,
  };
}

function toDiscovery(candidate: Candidate, outcome: PageOutcome): ResearchDiscovery {
  return {
    query: candidate.query,
    rank: candidate.rank,
    title: candidate.title,
    resultUrl: candidate.resultUrl,
    finalUrl: outcome.finalUrl,
    sourceClass: candidate.sourceClass,
    status: outcome.status,
    reason: outcome.reason,
  };
}

function skippedDiscovery(candidate: Candidate): ResearchDiscovery {
  return {
    query: candidate.query,
    rank: candidate.rank,
    title: candidate.title,
    resultUrl: candidate.resultUrl,
    finalUrl: null,
    sourceClass: candidate.sourceClass,
    status: "skipped",
    reason: null,
  };
}

export async function acquireResearchPages(
  context: BrowserSessionContext,
  options: ResearchAcquisitionOptions,
): Promise<ResearchAcquisitionResult> {
  const targetName = options.targetName.trim();
  if (targetName.length === 0) {
    throw new Error(INVALID_TARGET_REASON);
  }

  const organization =
    options.organization === null ? null : options.organization.trim();
  const normalizedOrganization =
    organization !== null && organization.length > 0 ? organization : null;
  const searchBaseUrl = normalizeSearchBaseUrl(
    options.searchBaseUrl ?? SEARCH_BASE_URL,
  );
  const wait = options.wait ?? noopWait;
  const page = context.pages().at(-1) ?? (await context.newPage());
  if (page.evaluate === undefined) {
    throw new Error(EVALUATE_UNSUPPORTED_REASON);
  }

  const queries = buildQueries(targetName, normalizedOrganization).slice(
    0,
    MAX_QUERIES,
  );
  const nameTokens = tokenize(targetName);
  const organizationTokens =
    normalizedOrganization === null ? [] : tokenize(normalizedOrganization);
  const candidates: Candidate[] = [];
  const searchFailures: ResearchAcquisitionResult["searchFailures"] = [];

  for (const [queryIndex, query] of queries.entries()) {
    const searchUrl = buildSearchUrl(searchBaseUrl, query);
    await wait();

    try {
      await page.goto(searchUrl, {
        timeout: SEARCH_TIMEOUT_MS,
        waitUntil: "domcontentloaded",
      });
    } catch {
      searchFailures.push({ query, reason: SEARCH_OPEN_REASON });
      continue;
    }

    const searchFinalUrl = page.url();
    if (isConsentUrl(searchFinalUrl)) {
      searchFailures.push({ query, reason: CONSENT_REASON });
      continue;
    }
    if (isVerificationUrl(searchFinalUrl)) {
      searchFailures.push({ query, reason: VERIFICATION_REASON });
      continue;
    }

    let snapshot: SearchSnapshot | null;
    try {
      snapshot = parseSearchSnapshot(await evaluatePage(page, readGoogleResults));
    } catch {
      searchFailures.push({ query, reason: SEARCH_OPEN_REASON });
      continue;
    }

    if (snapshot === null) {
      searchFailures.push({ query, reason: SEARCH_OPEN_REASON });
      continue;
    }
    if (snapshot.hasCaptcha) {
      searchFailures.push({ query, reason: VERIFICATION_REASON });
      continue;
    }

    let organicCount = 0;
    const results = snapshot.results.slice(0, MAX_RESULTS_PER_QUERY);
    const hasConsentResult = results.some((item) => {
      const resolved = resolveResultUrl(item.url, searchUrl);

      return (
        resolved !== null &&
        resolved.hostname.toLowerCase() === "consent.google.com"
      );
    });
    if (hasConsentResult) {
      searchFailures.push({ query, reason: CONSENT_REASON });
      continue;
    }

    for (const [resultIndex, item] of results.entries()) {
      const resolved = resolveResultUrl(item.url, searchUrl);
      if (resolved === null) {
        continue;
      }
      const host = resolved.hostname.toLowerCase();
      if (isExcludedGoogleHost(host)) {
        continue;
      }
      candidates.push({
        query,
        queryIndex,
        rank: resultIndex + 1,
        title: item.title,
        snippet: item.snippet,
        resultUrl: normalizeResultUrl(resolved),
        sourceClass: classifySource(host),
        score: scoreCandidate(
          nameTokens,
          organizationTokens,
          item.title,
          item.snippet,
        ),
      });
      organicCount += 1;
    }

    if (organicCount === 0) {
      searchFailures.push({ query, reason: NO_RESULTS_REASON });
    }
  }

  candidates.sort(
    (left, right) =>
      right.score - left.score ||
      left.queryIndex - right.queryIndex ||
      left.rank - right.rank,
  );

  const pages: ResearchPageArtifact[] = [];
  const discoveries: ResearchDiscovery[] = [];
  const seenUrls = new Set<string>();
  let visitedCount = 0;

  for (const candidate of candidates) {
    if (seenUrls.has(candidate.resultUrl)) {
      discoveries.push(skippedDiscovery(candidate));
      continue;
    }
    seenUrls.add(candidate.resultUrl);

    if (visitedCount >= MAX_VISITED_PAGES) {
      discoveries.push(skippedDiscovery(candidate));
      continue;
    }
    visitedCount += 1;

    const outcome = await visitPage(page, candidate.resultUrl, wait);
    if (outcome.artifact !== null) {
      pages.push(outcome.artifact);
    }
    discoveries.push(toDiscovery(candidate, outcome));
  }

  return { pages, discoveries, searchFailures };
}
