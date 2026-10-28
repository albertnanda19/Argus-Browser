import { describe, expect, it } from "vitest";
import {
  extractResearchContacts,
  type ContactCandidate,
  type ResearchPageArtifact,
} from "./research-extract";

const pageUrl = "https://example.test/team/budi";

const budi = { targetName: "Budi Santoso", organization: null };

function page(overrides: Partial<ResearchPageArtifact>): ResearchPageArtifact {
  return { sourceUrl: pageUrl, text: "", links: [], jsonLd: [], ...overrides };
}

function only(result: ContactCandidate[]): ContactCandidate {
  expect(result).toHaveLength(1);
  const candidate = result[0];
  if (candidate === undefined) {
    throw new Error("Missing candidate.");
  }
  return candidate;
}

describe("extractResearchContacts phone artifacts", () => {
  it("extracts a wa.me link from text as WhatsApp", () => {
    const result = extractResearchContacts(
      page({
        text: "Budi Santoso — hubungi https://wa.me/628123456789?text=Halo untuk janji.",
      }),
      budi,
    );

    expect(only(result)).toEqual({
      type: "whatsapp",
      value: "+628123456789",
      sourceUrl: pageUrl,
      method: "wa_me_link",
      confidence: 0.95,
    });
  });

  it("extracts and decodes an api.whatsapp.com send link", () => {
    const result = extractResearchContacts(
      page({
        text: "Profil Budi Santoso. Chat: https://api.whatsapp.com/send?phone=%2B62%20812%203456%20789&text=Halo",
      }),
      budi,
    );

    expect(only(result)).toMatchObject({
      type: "whatsapp",
      value: "+628123456789",
      method: "api_whatsapp_link",
      confidence: 0.9,
    });
  });

  it("extracts a tel link scoped by the link text", () => {
    const result = extractResearchContacts(
      page({
        links: [{ href: "tel:+62-812-3456-789", text: "Telepon Budi Santoso", context: "" }],
      }),
      budi,
    );

    expect(only(result)).toMatchObject({
      type: "phone",
      value: "+628123456789",
      method: "tel_link",
      confidence: 0.75,
    });
  });

  it("extracts a visible phone number adjacent to the target", () => {
    const result = extractResearchContacts(
      page({ text: "Budi Santoso · 0812-3456-789" }),
      budi,
    );

    expect(only(result)).toMatchObject({
      type: "phone",
      value: "+628123456789",
      method: "tel_link",
      confidence: 0.75,
    });
  });

  it("rejects a WhatsApp link with an Indonesian landline number", () => {
    const result = extractResearchContacts(
      page({ text: "Budi Santoso wa.me/622112345678" }),
      budi,
    );

    expect(result).toEqual([]);
  });

  it("rejects a phone number with an extension", () => {
    const result = extractResearchContacts(
      page({ text: "Budi Santoso 0812-3456-789 ext 12" }),
      budi,
    );

    expect(result).toEqual([]);
  });

  it("does not guess a country for a number without a recognizable prefix", () => {
    const result = extractResearchContacts(
      page({ text: "Budi Santoso 812-3456-789" }),
      budi,
    );

    expect(result).toEqual([]);
  });

  it("honors a custom default country code", () => {
    const result = extractResearchContacts(
      page({ text: "Budi Santoso 07911 123456" }),
      { targetName: "Budi Santoso", organization: null, defaultCountryCode: "44" },
    );

    expect(only(result)).toMatchObject({ type: "phone", value: "+447911123456" });
  });
});

describe("extractResearchContacts email artifacts", () => {
  it("extracts a mailto address without query parameters and lowercases it", () => {
    const result = extractResearchContacts(
      page({
        links: [
          {
            href: "mailto:Budi.Santoso@Example.TEST?subject=Halo%20Budi",
            text: "",
            context: "Kontak Budi Santoso",
          },
        ],
      }),
      budi,
    );

    expect(only(result)).toMatchObject({
      type: "email",
      value: "budi.santoso@example.test",
      method: "email_text",
      confidence: 0.9,
    });
  });

  it("extracts an email from text with a lower score", () => {
    const result = extractResearchContacts(
      page({ text: "Budi Santoso dapat dihubungi di Budi@Example.Test." }),
      budi,
    );

    expect(only(result)).toMatchObject({
      type: "email",
      value: "budi@example.test",
      method: "email_text",
      confidence: 0.7,
    });
  });
});

describe("extractResearchContacts JSON-LD artifacts", () => {
  it("extracts telephone, email, sameAs, and contactPoint from a matching Person", () => {
    const result = extractResearchContacts(
      page({
        jsonLd: [
          {
            "@context": "https://schema.org",
            "@type": "Person",
            name: "Budi Santoso, S.Kom.",
            telephone: "+62 812 3456 789",
            email: "BUDI@EXAMPLE.TEST",
            sameAs: [
              "https://www.linkedin.com/in/budi-santoso/?trk=profile#experience",
              "https://github.com/budisantoso/",
              "https://instagram.com/budisantoso",
              "https://budi.example.test",
            ],
            contactPoint: {
              "@type": "ContactPoint",
              telephone: "0812 9999 8888",
              email: "cp@example.test",
            },
          },
        ],
      }),
      budi,
    );

    expect(result).toEqual([
      {
        type: "email",
        value: "budi@example.test",
        sourceUrl: pageUrl,
        method: "email_text",
        confidence: 0.7,
      },
      {
        type: "email",
        value: "cp@example.test",
        sourceUrl: pageUrl,
        method: "email_text",
        confidence: 0.7,
      },
      {
        type: "linkedin",
        value: "https://www.linkedin.com/in/budi-santoso",
        sourceUrl: pageUrl,
        method: "linkedin_url",
        confidence: 0.95,
      },
      {
        type: "phone",
        value: "+628123456789",
        sourceUrl: pageUrl,
        method: "jsonld_telephone",
        confidence: 0.85,
      },
      {
        type: "phone",
        value: "+6281299998888",
        sourceUrl: pageUrl,
        method: "jsonld_telephone",
        confidence: 0.85,
      },
      {
        type: "profile",
        value: "https://github.com/budisantoso",
        sourceUrl: pageUrl,
        method: "profile_url",
        confidence: 0.7,
      },
      {
        type: "social",
        value: "https://instagram.com/budisantoso",
        sourceUrl: pageUrl,
        method: "social_url",
        confidence: 0.8,
      },
    ]);
  });

  it("reads nested @graph Person nodes", () => {
    const result = extractResearchContacts(
      page({
        jsonLd: [
          {
            "@context": "https://schema.org",
            "@graph": [
              { "@type": "Organization", name: "PT Contoh" },
              { "@type": ["Person"], name: "Budi Santoso", telephone: "0812 3456 789" },
            ],
          },
        ],
      }),
      budi,
    );

    expect(only(result)).toMatchObject({
      type: "phone",
      value: "+628123456789",
      method: "jsonld_telephone",
    });
  });

  it("never turns an Organization telephone into a person contact", () => {
    const result = extractResearchContacts(
      page({
        jsonLd: [
          {
            "@type": "Organization",
            name: "PT Contoh",
            telephone: "+622112345678",
            email: "halo@example.test",
          },
        ],
      }),
      budi,
    );

    expect(result).toEqual([]);
  });

  it("ignores broken or unknown JSON-LD without throwing", () => {
    const circular: Record<string, unknown> = { "@type": "Organization" };
    circular.self = circular;

    const result = extractResearchContacts(
      page({
        text: "Budi Santoso wa.me/628123456789",
        jsonLd: [null, 42, "not json", [], { broken: true }, circular, { "@type": "Person", name: 123 }],
      }),
      budi,
    );

    expect(only(result)).toMatchObject({ type: "whatsapp", value: "+628123456789" });
  });
});

describe("extractResearchContacts target scoping", () => {
  it("rejects artifacts outside the 240 character window", () => {
    const result = extractResearchContacts(
      page({ text: `Budi Santoso${"x".repeat(300)} wa.me/628123456789` }),
      budi,
    );

    expect(result).toEqual([]);
  });

  it("rejects a company footer far from the target", () => {
    const result = extractResearchContacts(
      page({
        text: `Budi Santoso adalah anggota komunitas.${"x".repeat(300)} PT Contoh | Jl. Merdeka 1 | 08123456789 | halo@example.test`,
      }),
      budi,
    );

    expect(result).toEqual([]);
  });

  it("rejects a link whose text and context do not mention the target", () => {
    const result = extractResearchContacts(
      page({
        text: "Budi Santoso",
        links: [
          { href: "https://wa.me/628123456789", text: "Kontak", context: "Hubungi admin" },
          { href: "mailto:admin@example.test", text: "Email", context: "Sekretariat" },
        ],
      }),
      budi,
    );

    expect(result).toEqual([]);
  });

  it("matches the target after diacritic and case normalization", () => {
    const result = extractResearchContacts(
      page({ text: "JOSE ALVAREZ wa.me/628123456789" }),
      { targetName: "José Álvarez", organization: null },
    );

    expect(only(result)).toMatchObject({ type: "whatsapp" });
  });

  it("returns nothing when the target name is absent", () => {
    const result = extractResearchContacts(
      page({ text: "Kontak umum wa.me/628123456789 halo@example.test" }),
      budi,
    );

    expect(result).toEqual([]);
  });
});

describe("extractResearchContacts organization filter", () => {
  it("rejects the whole page when no organization token appears", () => {
    const result = extractResearchContacts(
      page({ text: "Budi Santoso — PT Lain — wa.me/628123456789" }),
      { targetName: "Budi Santoso", organization: "PT Contoh" },
    );

    expect(result).toEqual([]);
  });

  it("accepts the page when an organization token appears", () => {
    const result = extractResearchContacts(
      page({ text: "Budi Santoso, PT Contoh. wa.me/628123456789" }),
      { targetName: "Budi Santoso", organization: "PT Contoh" },
    );

    expect(only(result)).toMatchObject({ type: "whatsapp" });
  });

  it("accepts an organization token that only appears in JSON-LD", () => {
    const result = extractResearchContacts(
      page({
        text: "Budi Santoso wa.me/628123456789",
        jsonLd: [{ "@type": "Organization", name: "PT Contoh" }],
      }),
      { targetName: "Budi Santoso", organization: "PT Contoh" },
    );

    expect(only(result)).toMatchObject({ type: "whatsapp" });
  });

  it("rejects a Person node whose worksFor does not match the organization", () => {
    const result = extractResearchContacts(
      page({
        text: "Budi Santoso dari PT Contoh.",
        jsonLd: [
          {
            "@type": "Person",
            name: "Budi Santoso",
            worksFor: { "@type": "Organization", name: "PT Lain" },
            telephone: "+628123456789",
          },
        ],
      }),
      { targetName: "Budi Santoso", organization: "PT Contoh" },
    );

    expect(result).toEqual([]);
  });

  it("accepts a Person node whose worksFor contains the organization", () => {
    const result = extractResearchContacts(
      page({
        text: "Budi Santoso dari PT Contoh.",
        jsonLd: [
          {
            "@type": "Person",
            name: "Budi Santoso",
            worksFor: { "@type": "Organization", name: "PT Contoh Tbk" },
            telephone: "+628123456789",
          },
        ],
      }),
      { targetName: "Budi Santoso", organization: "PT Contoh" },
    );

    expect(only(result)).toMatchObject({ type: "phone", value: "+628123456789" });
  });

  it("accepts a Person node without worksFor when the page references the organization", () => {
    const result = extractResearchContacts(
      page({
        text: "Budi Santoso dari PT Contoh.",
        jsonLd: [
          {
            "@type": "Person",
            name: "Budi Santoso",
            telephone: "+628123456789",
          },
        ],
      }),
      { targetName: "Budi Santoso", organization: "PT Contoh" },
    );

    expect(only(result)).toMatchObject({ type: "phone", value: "+628123456789" });
  });
});

describe("extractResearchContacts profile links", () => {
  function linkCandidates(href: string): ContactCandidate[] {
    return extractResearchContacts(
      page({ links: [{ href, text: "Budi Santoso", context: "" }] }),
      budi,
    );
  }

  it("accepts LinkedIn person profiles and normalizes the URL", () => {
    expect(linkCandidates("https://WWW.LinkedIn.com/in/Budi-Santoso/?trk=x#frag")).toEqual([
      {
        type: "linkedin",
        value: "https://www.linkedin.com/in/Budi-Santoso",
        sourceUrl: pageUrl,
        method: "linkedin_url",
        confidence: 0.95,
      },
    ]);
    expect(linkCandidates("https://id.linkedin.com/pub/budi-santoso/1/2")).toHaveLength(1);
  });

  it.each([
    "https://www.linkedin.com/company/acme",
    "https://www.linkedin.com/feed/",
    "https://www.linkedin.com/posts/budi_activity-1",
    "https://www.linkedin.com/search/results/all/?keywords=budi",
    "https://www.linkedin.com/school/example",
  ])("rejects non-profile LinkedIn URL %s", (href) => {
    expect(linkCandidates(href)).toEqual([]);
  });

  it.each([
    ["https://x.com/budisantoso", "https://x.com/budisantoso"],
    ["https://twitter.com/budisantoso", "https://twitter.com/budisantoso"],
    ["https://m.facebook.com/budisantoso", "https://m.facebook.com/budisantoso"],
    ["https://instagram.com/budisantoso/", "https://instagram.com/budisantoso"],
    ["https://www.tiktok.com/@budisantoso", "https://www.tiktok.com/@budisantoso"],
    ["https://youtube.com/@budisantoso", "https://youtube.com/@budisantoso"],
  ])("accepts social URL %s", (href, value) => {
    expect(linkCandidates(href)).toEqual([
      { type: "social", value, sourceUrl: pageUrl, method: "social_url", confidence: 0.8 },
    ]);
  });

  it.each([
    ["https://github.com/budisantoso", "https://github.com/budisantoso"],
    ["https://GitHub.com/BudiSantoso/", "https://github.com/BudiSantoso"],
    [
      "https://scholar.google.com/citations?user=abc123",
      "https://scholar.google.com/citations",
    ],
    ["https://orcid.org/0000-0002-1825-0097", "https://orcid.org/0000-0002-1825-0097"],
    [
      "https://www.researchgate.net/profile/Budi-Santoso",
      "https://www.researchgate.net/profile/Budi-Santoso",
    ],
  ])("accepts profile URL %s", (href, value) => {
    expect(linkCandidates(href)).toEqual([
      { type: "profile", value, sourceUrl: pageUrl, method: "profile_url", confidence: 0.7 },
    ]);
  });

  it.each([
    "https://github.com/budisantoso/argus",
    "https://github.com/budisantoso/argus/issues/1",
    "https://github.com/orgs/argus",
    "https://github.com/topics/typescript",
    "https://github.com",
    "https://www.researchgate.net/publication/123",
    "https://orcid.org",
  ])("rejects non-profile URL %s", (href) => {
    expect(linkCandidates(href)).toEqual([]);
  });

  it("does not treat a lookalike host as a WhatsApp link", () => {
    expect(linkCandidates("https://notwa.me/628123456789")).toEqual([]);
    expect(
      linkCandidates("https://evilapi.whatsapp.com/send?phone=628123456789"),
    ).toEqual([]);
  });

  it("normalizes a sameAs social URL and ignores non-profile sameAs values", () => {
    const result = extractResearchContacts(
      page({
        jsonLd: [
          {
            "@type": "Person",
            name: "Budi Santoso",
            sameAs: [
              "https://twitter.com/budisantoso?lang=en",
              "https://budi.example.test/about",
            ],
          },
        ],
      }),
      budi,
    );

    expect(only(result)).toMatchObject({
      type: "social",
      value: "https://twitter.com/budisantoso",
      method: "social_url",
    });
  });
});

describe("extractResearchContacts dedupe and output", () => {
  it("keeps one candidate per type and value with the highest score", () => {
    const result = extractResearchContacts(
      page({
        text: "Budi Santoso wa.me/628123456789 lalu https://api.whatsapp.com/send?phone=628123456789 dan wa.me/628123456789",
        links: [
          { href: "mailto:budi@example.test", text: "Budi Santoso", context: "" },
        ],
      }),
      budi,
    );

    expect(result).toEqual([
      {
        type: "email",
        value: "budi@example.test",
        sourceUrl: pageUrl,
        method: "email_text",
        confidence: 0.9,
      },
      {
        type: "whatsapp",
        value: "+628123456789",
        sourceUrl: pageUrl,
        method: "wa_me_link",
        confidence: 0.95,
      },
    ]);
  });

  it("prefers mailto over an email found in text", () => {
    const result = extractResearchContacts(
      page({
        text: "Budi Santoso budi@example.test",
        links: [{ href: "mailto:budi@example.test", text: "Budi Santoso", context: "" }],
      }),
      budi,
    );

    expect(only(result)).toMatchObject({ confidence: 0.9 });
  });

  it("sorts output by type and value", () => {
    const result = extractResearchContacts(
      page({
        text: "Budi Santoso wa.me/628123456789 halo@example.test 0812-9999-8888",
        links: [
          { href: "https://github.com/budisantoso", text: "Budi Santoso", context: "" },
          { href: "https://instagram.com/budisantoso", text: "Budi Santoso", context: "" },
          { href: "https://www.linkedin.com/in/budi-santoso", text: "Budi Santoso", context: "" },
        ],
      }),
      budi,
    );

    expect(result.map((candidate) => candidate.type)).toEqual([
      "email",
      "linkedin",
      "phone",
      "profile",
      "social",
      "whatsapp",
    ]);
  });

  it("returns deterministically for the same input", () => {
    const input = page({
      text: "Budi Santoso wa.me/628123456789 halo@example.test 0812-9999-8888",
      links: [{ href: "https://www.linkedin.com/in/budi-santoso", text: "Budi Santoso", context: "" }],
    });

    expect(extractResearchContacts(input, budi)).toEqual(
      extractResearchContacts(input, budi),
    );
  });

  it("returns an empty array for an invalid sourceUrl", () => {
    for (const sourceUrl of ["ftp://example.test/team", "/team/budi", "example.test", ""]) {
      expect(
        extractResearchContacts(page({ sourceUrl, text: "Budi Santoso wa.me/628123456789" }), budi),
      ).toEqual([]);
    }
  });

  it("never fabricates a value", () => {
    expect(
      extractResearchContacts(page({ text: "Budi Santoso adalah anggota komunitas." }), budi),
    ).toEqual([]);
  });
});

describe("extractResearchContacts limits", () => {
  it("returns at most 50 candidates", () => {
    const emails = Array.from({ length: 60 }, (_, index) => `mail${index}@example.test`);
    const text = emails.map((email) => `Budi Santoso ${email}`).join(" ");

    const result = extractResearchContacts(page({ text }), budi);

    expect(result).toHaveLength(50);
    expect(result.map((candidate) => candidate.value)).toEqual(
      [...emails].sort().slice(0, 50),
    );
  });

  it("ignores text beyond 2,000,000 characters", () => {
    const text = `Budi Santoso ${"x".repeat(2_000_000)} wa.me/628123456789`;

    expect(extractResearchContacts(page({ text }), budi)).toEqual([]);
  });

  it("ignores links beyond 2,000", () => {
    const links = Array.from({ length: 2_000 }, () => ({
      href: "tel:+628123456789",
      text: "Budi Santoso",
      context: "",
    }));
    links.push({ href: "tel:+628999999999", text: "Budi Santoso", context: "" });

    const result = extractResearchContacts(page({ links }), budi);

    expect(only(result)).toMatchObject({ value: "+628123456789" });
  });

  it("ignores JSON-LD nodes beyond 500", () => {
    const jsonLd: unknown[] = Array.from({ length: 500 }, (_, index) => ({
      "@type": "Organization",
      name: `Organization ${index}`,
    }));
    jsonLd.push({
      "@type": "Person",
      name: "Budi Santoso",
      telephone: "+628123456789",
    });

    expect(extractResearchContacts(page({ jsonLd }), budi)).toEqual([]);
  });
});
