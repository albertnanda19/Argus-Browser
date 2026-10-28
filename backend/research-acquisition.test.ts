import { describe, expect, it, vi } from "vitest";
import type { BrowserPage, BrowserSessionContext } from "./browser-launcher";
import {
  acquireResearchPages,
  type ResearchAcquisitionOptions,
  type ResearchDiscovery,
} from "./research-acquisition";

type SearchHit = {
  title: string;
  url: string;
  snippet?: string;
};

type SearchBehavior = {
  hits?: SearchHit[];
  hasCaptcha?: boolean;
  finalUrl?: string;
  gotoError?: Error;
  evaluateError?: Error;
};

type SnapshotInput = {
  contentType?: string;
  text?: string;
  links?: Array<{ href: string; text: string; context: string }>;
  jsonLd?: unknown[];
};

type PageBehavior = {
  finalUrl?: string;
  snapshot?: SnapshotInput;
  gotoError?: Error;
  evaluateError?: Error;
  waitForLoadStateError?: Error;
};

type HarnessOptions = {
  searchBaseUrl?: string;
  search?: (query: string) => SearchBehavior;
  pages?: Record<string, PageBehavior>;
  defaultPage?: PageBehavior;
  omitEvaluate?: boolean;
};

const DEFAULT_SEARCH_BASE_URL = "https://search.test";

function createHarness(options: HarnessOptions = {}) {
  const events: string[] = [];
  const requests: string[] = [];
  let currentPageBehavior: PageBehavior | null = null;
  let currentSearchBehavior: SearchBehavior | null = null;
  let currentUrl = "about:blank";

  const page: BrowserPage = {
    async goto(url) {
      events.push(`goto:${url}`);
      requests.push(url);
      const target = new URL(url);
      if (target.pathname === "/search") {
        currentSearchBehavior =
          options.search?.(target.searchParams.get("q") ?? "") ?? {};
        currentPageBehavior = null;
        if (currentSearchBehavior.gotoError !== undefined) {
          throw currentSearchBehavior.gotoError;
        }
        currentUrl = currentSearchBehavior.finalUrl ?? url;
        return null;
      }

      currentPageBehavior = options.pages?.[url] ?? options.defaultPage ?? {};
      currentSearchBehavior = null;
      if (currentPageBehavior.gotoError !== undefined) {
        throw currentPageBehavior.gotoError;
      }
      currentUrl = currentPageBehavior.finalUrl ?? url;
      return null;
    },
    url: () => currentUrl,
    locator() {
      throw new Error("Locator must not be used.");
    },
    async evaluate() {
      if (currentSearchBehavior !== null) {
        if (currentSearchBehavior.evaluateError !== undefined) {
          throw currentSearchBehavior.evaluateError;
        }
        return {
          results: (currentSearchBehavior.hits ?? []).map((hit) => ({
            title: hit.title,
            url: hit.url,
            snippet: hit.snippet ?? "",
          })),
          hasCaptcha: currentSearchBehavior.hasCaptcha ?? false,
        };
      }

      if (currentPageBehavior === null) {
        throw new Error("No page has been opened.");
      }
      if (currentPageBehavior.evaluateError !== undefined) {
        throw currentPageBehavior.evaluateError;
      }
      const snapshot = currentPageBehavior.snapshot ?? {};
      return {
        contentType: snapshot.contentType ?? "text/html",
        text: snapshot.text ?? "Budi Santoso profile",
        links: snapshot.links ?? [],
        jsonLd: snapshot.jsonLd ?? [],
      };
    },
    async waitForLoadState() {
      if (currentPageBehavior?.waitForLoadStateError !== undefined) {
        throw currentPageBehavior.waitForLoadStateError;
      }
    },
  };

  if (options.omitEvaluate === true) {
    delete page.evaluate;
  }

  const context: BrowserSessionContext = {
    async close() {
      return undefined;
    },
    on() {
      return undefined;
    },
    pages: () => [page],
    async newPage() {
      return page;
    },
  };

  const wait = vi.fn(async () => {
    events.push("wait");
  });

  const acquire = (overrides: Partial<ResearchAcquisitionOptions> = {}) =>
    acquireResearchPages(context, {
      targetName: "Budi Santoso",
      organization: "PT Contoh",
      searchBaseUrl: options.searchBaseUrl ?? DEFAULT_SEARCH_BASE_URL,
      wait,
      ...overrides,
    });

  return { acquire, context, events, page, requests, wait };
}

function searchRequests(requests: readonly string[]): URL[] {
  return requests
    .map((request) => new URL(request))
    .filter((url) => url.pathname === "/search");
}

function pageRequests(requests: readonly string[]): string[] {
  return requests.filter((request) => new URL(request).pathname !== "/search");
}

function visitedDiscoveries(discoveries: readonly ResearchDiscovery[]): ResearchDiscovery[] {
  return discoveries.filter((discovery) => discovery.status === "visited");
}

describe("research acquisition queries", () => {
  it("builds exactly three encoded Google queries with Indonesian results", async () => {
    const harness = createHarness();

    const result = await harness.acquire();

    const searches = searchRequests(harness.requests);
    expect(searches).toHaveLength(3);
    expect(searches.map((url) => url.searchParams.get("q"))).toEqual([
      '"Budi Santoso" "PT Contoh"',
      '"Budi Santoso" (whatsapp OR wa.me OR "nomor telepon" OR email)',
      '"Budi Santoso" (site:linkedin.com/in OR site:github.com OR site:scholar.google.com OR site:researchgate.net OR site:instagram.com)',
    ]);
    for (const search of searches) {
      expect(search.origin).toBe(DEFAULT_SEARCH_BASE_URL);
      expect(search.pathname).toBe("/search");
      expect(search.searchParams.get("hl")).toBe("id");
      expect(search.searchParams.get("num")).toBe("10");
    }
    expect(searches[0]?.search).toContain("%22Budi%20Santoso%22");
    expect(result.searchFailures).toEqual([
      { query: '"Budi Santoso" "PT Contoh"', reason: "Tidak ada hasil organik." },
      {
        query: '"Budi Santoso" (whatsapp OR wa.me OR "nomor telepon" OR email)',
        reason: "Tidak ada hasil organik.",
      },
      {
        query:
          '"Budi Santoso" (site:linkedin.com/in OR site:github.com OR site:scholar.google.com OR site:researchgate.net OR site:instagram.com)',
        reason: "Tidak ada hasil organik.",
      },
    ]);
  });

  it("uses only the quoted name for the identity query when organization is null", async () => {
    const harness = createHarness();

    await harness.acquire({ organization: null });

    const searches = searchRequests(harness.requests);
    expect(searches[0]?.searchParams.get("q")).toBe('"Budi Santoso"');
  });

  it("normalizes a search base URL with a trailing slash", async () => {
    const harness = createHarness({ searchBaseUrl: "https://search.test/" });

    await harness.acquire();

    const searches = searchRequests(harness.requests);
    expect(searches).toHaveLength(3);
    for (const search of searches) {
      expect(search.pathname).toBe("/search");
    }
  });
});

describe("research acquisition result extraction", () => {
  it("resolves Google redirects and drops ads, Google hosts, and duplicates", async () => {
    const harness = createHarness({
      search: (query) => {
        if (query === '"Budi Santoso" "PT Contoh"') {
          return {
            hits: [
              {
                title: "Budi Santoso profil",
                url: "/url?q=https://example.test/budi&sa=U",
              },
              {
                title: "Google internal",
                url: "https://www.google.com/preferences",
              },
              {
                title: "Gstatic",
                url: "https://www.gstatic.com/logo.png",
              },
              {
                title: "Duplicate",
                url: "https://example.test/budi#team",
              },
            ],
          };
        }
        if (query.includes("whatsapp")) {
          return {
            hits: [
              {
                title: "Budi Santoso kontak",
                url: "https://example.test/budi/",
              },
            ],
          };
        }
        return { hits: [] };
      },
      pages: {
        "https://example.test/budi": {
          snapshot: { text: "Budi Santoso" },
        },
      },
    });

    const result = await harness.acquire();

    expect(pageRequests(harness.requests)).toEqual(["https://example.test/budi"]);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.sourceUrl).toBe("https://example.test/budi");
    expect(result.discoveries.filter((item) => item.status === "skipped")).toEqual([
      {
        query: '"Budi Santoso" (whatsapp OR wa.me OR "nomor telepon" OR email)',
        rank: 1,
        title: "Budi Santoso kontak",
        resultUrl: "https://example.test/budi",
        finalUrl: null,
        sourceClass: "website",
        status: "skipped",
        reason: null,
      },
      {
        query: '"Budi Santoso" "PT Contoh"',
        rank: 4,
        title: "Duplicate",
        resultUrl: "https://example.test/budi",
        finalUrl: null,
        sourceClass: "website",
        status: "skipped",
        reason: null,
      },
    ]);
  });

  it("ranks matches by name tokens, organization weight, query order, and rank", async () => {
    const harness = createHarness({
      search: (query) => {
        if (query === '"Budi Santoso" "PT Contoh"') {
          return {
            hits: [
              { title: "Profil umum", url: "https://example.test/a" },
              {
                title: "Budi Santoso",
                url: "https://example.test/b",
                snippet: "PT Contoh",
              },
            ],
          };
        }
        if (query.includes("whatsapp")) {
          return {
            hits: [{ title: "Kontak", url: "https://example.test/c" }],
          };
        }
        return {
          hits: [{ title: "Budi", url: "https://example.test/d" }],
        };
      },
    });

    const result = await harness.acquire();

    expect(result.pages.map((page) => page.sourceUrl)).toEqual([
      "https://example.test/b",
      "https://example.test/d",
      "https://example.test/a",
      "https://example.test/c",
    ]);
  });

  it("assigns a source class from the result host", async () => {
    const harness = createHarness({
      search: (query) => {
        if (query !== '"Budi Santoso" "PT Contoh"') {
          return { hits: [] };
        }
        return {
          hits: [
            { title: "LinkedIn", url: "https://www.linkedin.com/in/budi" },
            { title: "GitHub", url: "https://github.com/budi" },
            { title: "Scholar", url: "https://scholar.google.com/citations?user=1" },
            { title: "Instagram", url: "https://instagram.com/budi" },
            { title: "Website", url: "https://budi.test" },
            { title: "Edu", url: "https://cs.mit.edu/~budi" },
          ],
        };
      },
    });

    const result = await harness.acquire();

    expect(
      result.discoveries.map((discovery) => [
        discovery.resultUrl,
        discovery.sourceClass,
      ]),
    ).toEqual([
      ["https://www.linkedin.com/in/budi", "linkedin"],
      ["https://github.com/budi", "github"],
      ["https://scholar.google.com/citations?user=1", "academic"],
      ["https://instagram.com/budi", "social"],
      ["https://budi.test", "website"],
      ["https://cs.mit.edu/~budi", "academic"],
    ]);
  });
});

describe("research acquisition limits", () => {
  it("takes at most ten results per query and visits at most twelve pages", async () => {
    const harness = createHarness({
      search: (query) => {
        const queryIndex = query.includes("whatsapp")
          ? 2
          : query.includes("site:")
            ? 3
            : 1;
        return {
          hits: Array.from({ length: 15 }, (_value, index) => ({
            title: `Result ${queryIndex}-${index + 1}`,
            url: `https://example.test/${queryIndex}/${index + 1}`,
          })),
        };
      },
    });

    const result = await harness.acquire();

    expect(searchRequests(harness.requests)).toHaveLength(3);
    expect(pageRequests(harness.requests)).toHaveLength(12);
    expect(result.pages).toHaveLength(12);
    expect(visitedDiscoveries(result.discoveries)).toHaveLength(12);
    expect(result.discoveries).toHaveLength(30);
    expect(result.discoveries.filter((item) => item.status === "skipped")).toHaveLength(
      18,
    );
  });

  it("calls wait before every search and page navigation", async () => {
    const harness = createHarness({
      search: () => ({
        hits: [{ title: "Satu", url: "https://example.test/one" }],
      }),
    });

    await harness.acquire();

    expect(harness.wait).toHaveBeenCalledTimes(harness.requests.length);
    expect(harness.events).toEqual(
      harness.requests.flatMap((request) => ["wait", `goto:${request}`]),
    );
  });
});

describe("research acquisition page artifacts", () => {
  it("collects text, links with context, JSON-LD, and the redirected final URL", async () => {
    const harness = createHarness({
      search: () => ({
        hits: [{ title: "Budi Santoso", url: "https://example.test/start" }],
      }),
      pages: {
        "https://example.test/start": {
          finalUrl: "https://example.test/profile#kontak",
          snapshot: {
            text: "Budi Santoso — kontak",
            links: [
              { href: "mailto:budi@example.test", text: "Email", context: "Hubungi Budi" },
              { href: "tel:+628123456789", text: "Telepon", context: "Nomor Budi" },
            ],
            jsonLd: [{ "@type": "Person", name: "Budi Santoso" }],
          },
        },
      },
    });

    const result = await harness.acquire();

    expect(result.pages).toEqual([
      {
        sourceUrl: "https://example.test/profile",
        text: "Budi Santoso — kontak",
        links: [
          { href: "mailto:budi@example.test", text: "Email", context: "Hubungi Budi" },
          { href: "tel:+628123456789", text: "Telepon", context: "Nomor Budi" },
        ],
        jsonLd: [{ "@type": "Person", name: "Budi Santoso" }],
      },
    ]);
    expect(result.discoveries[0]).toMatchObject({
      resultUrl: "https://example.test/start",
      finalUrl: "https://example.test/profile",
      status: "visited",
      reason: null,
    });
  });

  it("caps text, links, and JSON-LD in the artifact", async () => {
    const harness = createHarness({
      search: () => ({
        hits: [{ title: "Budi Santoso", url: "https://example.test/big" }],
      }),
      pages: {
        "https://example.test/big": {
          snapshot: {
            text: "x".repeat(2_000_005),
            links: Array.from({ length: 2_001 }, () => ({
              href: "https://example.test/link",
              text: "Budi",
              context: "Context",
            })),
            jsonLd: Array.from({ length: 501 }, (_value, index) => ({ index })),
          },
        },
      },
    });

    const result = await harness.acquire();

    expect(result.pages[0]?.text).toHaveLength(2_000_000);
    expect(result.pages[0]?.links).toHaveLength(2_000);
    expect(result.pages[0]?.jsonLd).toHaveLength(500);
  });
});

describe("research acquisition page failures", () => {
  it("skips login pages and continues with the next result", async () => {
    const harness = createHarness({
      search: (query) =>
        query === '"Budi Santoso" "PT Contoh"'
          ? {
              hits: [
                { title: "LinkedIn login", url: "https://www.linkedin.com/in/budi" },
                { title: "Website", url: "https://budi.test" },
              ],
            }
          : { hits: [] },
      pages: {
        "https://www.linkedin.com/in/budi": {
          finalUrl: "https://www.linkedin.com/login?next=%2Fin%2Fbudi",
        },
        "https://budi.test": {},
      },
    });

    const result = await harness.acquire();

    expect(result.pages.map((page) => page.sourceUrl)).toEqual(["https://budi.test"]);
    expect(result.discoveries[0]).toMatchObject({
      status: "skipped",
      reason: "Halaman meminta login.",
      finalUrl: "https://www.linkedin.com/login?next=%2Fin%2Fbudi",
    });
    expect(result.discoveries[1]).toMatchObject({ status: "visited", reason: null });
  });

  it("skips LinkedIn authwall, Google accounts, and login hosts", async () => {
    const harness = createHarness({
      search: (query) =>
        query === '"Budi Santoso" "PT Contoh"'
          ? {
              hits: [
                { title: "Authwall", url: "https://a.test/one" },
                { title: "Accounts", url: "https://b.test/two" },
                { title: "Login", url: "https://c.test/three" },
              ],
            }
          : { hits: [] },
      pages: {
        "https://a.test/one": {
          finalUrl: "https://www.linkedin.com/authwall?trk=abc",
        },
        "https://b.test/two": {
          finalUrl: "https://accounts.google.com/signin",
        },
        "https://c.test/three": {
          finalUrl: "https://login.example.test/session",
        },
      },
    });

    const result = await harness.acquire();

    expect(result.pages).toEqual([]);
    for (const discovery of result.discoveries) {
      expect(discovery).toMatchObject({
        status: "skipped",
        reason: "Halaman meminta login.",
      });
    }
  });

  it("skips non-HTML and empty pages", async () => {
    const harness = createHarness({
      search: (query) =>
        query === '"Budi Santoso" "PT Contoh"'
          ? {
              hits: [
                { title: "PDF", url: "https://example.test/file.pdf" },
                { title: "Empty", url: "https://example.test/empty" },
              ],
            }
          : { hits: [] },
      pages: {
        "https://example.test/file.pdf": {
          snapshot: { contentType: "application/pdf", text: "pdf", links: [], jsonLd: [] },
        },
        "https://example.test/empty": {
          snapshot: { contentType: "text/html", text: "   ", links: [], jsonLd: [] },
        },
      },
    });

    const result = await harness.acquire();

    expect(result.pages).toEqual([]);
    expect(result.discoveries[0]).toMatchObject({
      status: "skipped",
      reason: "Halaman bukan HTML.",
    });
    expect(result.discoveries[1]).toMatchObject({
      status: "skipped",
      reason: "Halaman kosong.",
    });
  });

  it("records navigation timeouts and failures without stopping other pages", async () => {
    const timeout = new Error("Timed out.");
    timeout.name = "TimeoutError";
    const harness = createHarness({
      search: () => ({
        hits: [
          { title: "Timeout", url: "https://example.test/timeout" },
          { title: "Broken", url: "https://example.test/broken" },
          { title: "Working", url: "https://example.test/working" },
        ],
      }),
      pages: {
        "https://example.test/timeout": { gotoError: timeout },
        "https://example.test/broken": { gotoError: new Error("net::ERR_FAILED") },
        "https://example.test/working": {},
      },
    });

    const result = await harness.acquire();

    expect(result.pages.map((page) => page.sourceUrl)).toEqual([
      "https://example.test/working",
    ]);
    expect(result.discoveries[0]).toMatchObject({
      status: "failed",
      reason: "Halaman tidak merespons dalam batas waktu.",
      finalUrl: null,
    });
    expect(result.discoveries[1]).toMatchObject({
      status: "failed",
      reason: "Halaman gagal dibuka.",
      finalUrl: null,
    });
    expect(result.discoveries[2]).toMatchObject({ status: "visited" });
  });

  it("records an evaluation failure as a failed page", async () => {
    const harness = createHarness({
      search: () => ({
        hits: [{ title: "Budi", url: "https://example.test/broken" }],
      }),
      pages: {
        "https://example.test/broken": { evaluateError: new Error("Evaluation failed.") },
      },
    });

    const result = await harness.acquire();

    expect(result.pages).toEqual([]);
    expect(result.discoveries[0]).toMatchObject({
      status: "failed",
      reason: "Halaman gagal dibuka.",
      finalUrl: "https://example.test/broken",
    });
  });

  it("ignores a networkidle failure and still collects the page", async () => {
    const harness = createHarness({
      search: () => ({
        hits: [{ title: "Budi", url: "https://example.test/idle" }],
      }),
      pages: {
        "https://example.test/idle": {
          waitForLoadStateError: new Error("Timeout waiting for networkidle."),
        },
      },
    });

    const result = await harness.acquire();

    expect(result.pages).toHaveLength(1);
    expect(result.discoveries[0]).toMatchObject({ status: "visited", reason: null });
  });

  it("returns partial results when one query fails and another succeeds", async () => {
    const harness = createHarness({
      search: (query) => {
        if (query === '"Budi Santoso" "PT Contoh"') {
          return { gotoError: new Error("Search unavailable.") };
        }
        if (query.includes("whatsapp")) {
          return {
            hits: [{ title: "Budi", url: "https://example.test/budi" }],
          };
        }
        return { hits: [] };
      },
    });

    const result = await harness.acquire();

    expect(result.searchFailures[0]).toEqual({
      query: '"Budi Santoso" "PT Contoh"',
      reason: "Pencarian tidak dapat dibuka.",
    });
    expect(result.pages).toHaveLength(1);
    expect(visitedDiscoveries(result.discoveries)).toHaveLength(1);
  });
});

describe("research acquisition Google blocks", () => {
  it.each([
    {
      label: "consent URL",
      behavior: { finalUrl: "https://consent.google.com/ml?continue=1" },
      reason: "Google meminta persetujuan.",
    },
    {
      label: "captcha form",
      behavior: { hasCaptcha: true },
      reason: "Google meminta verifikasi manusia.",
    },
    {
      label: "sorry URL",
      behavior: { finalUrl: "https://www.google.com/sorry/index?continue=1" },
      reason: "Google meminta verifikasi manusia.",
    },
  ])("records $label without bypassing the block", async ({ behavior, reason }) => {
    const harness = createHarness({
      search: () => ({ ...behavior, hits: [{ title: "Budi", url: "https://budi.test" }] }),
    });

    const result = await harness.acquire();

    expect(result.searchFailures).toEqual([
      { query: '"Budi Santoso" "PT Contoh"', reason },
      {
        query: '"Budi Santoso" (whatsapp OR wa.me OR "nomor telepon" OR email)',
        reason,
      },
      {
        query:
          '"Budi Santoso" (site:linkedin.com/in OR site:github.com OR site:scholar.google.com OR site:researchgate.net OR site:instagram.com)',
        reason,
      },
    ]);
    expect(result.pages).toEqual([]);
    expect(pageRequests(harness.requests)).toEqual([]);
  });

  it("records a query failure when a result URL points to consent", async () => {
    const harness = createHarness({
      search: () => ({
        hits: [{ title: "Consent", url: "https://consent.google.com/ml?continue=1" }],
      }),
    });

    const result = await harness.acquire();

    expect(result.searchFailures).toEqual([
      { query: '"Budi Santoso" "PT Contoh"', reason: "Google meminta persetujuan." },
      {
        query: '"Budi Santoso" (whatsapp OR wa.me OR "nomor telepon" OR email)',
        reason: "Google meminta persetujuan.",
      },
      {
        query:
          '"Budi Santoso" (site:linkedin.com/in OR site:github.com OR site:scholar.google.com OR site:researchgate.net OR site:instagram.com)',
        reason: "Google meminta persetujuan.",
      },
    ]);
    expect(result.pages).toEqual([]);
    expect(harness.requests).toHaveLength(3);
  });

  it("records queries without organic results", async () => {
    const harness = createHarness({
      search: () => ({ hits: [] }),
    });

    const result = await harness.acquire();

    expect(result.searchFailures).toHaveLength(3);
    for (const failure of result.searchFailures) {
      expect(failure.reason).toBe("Tidak ada hasil organik.");
    }
  });
});

describe("research acquisition input validation", () => {
  it("rejects an empty target name", async () => {
    const harness = createHarness();

    await expect(harness.acquire({ targetName: "   " })).rejects.toThrow(
      "Nama target wajib diisi.",
    );
  });

  it("rejects an invalid search base URL", async () => {
    const harness = createHarness({ searchBaseUrl: "ftp://search.test" });

    await expect(harness.acquire()).rejects.toThrow("Alamat pencarian tidak valid.");
  });

  it("throws when the browser page cannot evaluate", async () => {
    const harness = createHarness({ omitEvaluate: true });

    await expect(harness.acquire()).rejects.toThrow(
      "Browser tidak mendukung evaluasi halaman.",
    );
    expect(harness.requests).toEqual([]);
  });
});
