import { describe, expect, it } from "vitest";
import { createTaskRequestSchema } from "./api";
import {
  researchChainEntrySchema,
  researchContactSchema,
  researchResultSchema,
} from "./research";

const taskId = "t_0000000000000001";

const validContact = {
  id: "c_0000000000000001",
  taskId,
  type: "whatsapp",
  value: "+628123456789",
  sourceUrl: "https://example.test/kontak",
  method: "wa_me_link",
  confidence: 0.8,
  verification: "unverified",
};

describe("researchContactSchema", () => {
  it("accepts a contact with an http source and an E.164 number", () => {
    const parsed = researchContactSchema.parse(validContact);

    expect(parsed.sourceUrl).toBe("https://example.test/kontak");
    expect(parsed.confidence).toBe(0.8);
  });

  it("rejects a contact without sourceUrl", () => {
    const { sourceUrl: _sourceUrl, ...withoutSource } = validContact;

    expect(researchContactSchema.safeParse(withoutSource).success).toBe(false);
  });

  it.each(["ftp://example.test/kontak", "/kontak", "example.test"])(
    "rejects a non-http sourceUrl %s",
    (sourceUrl) => {
      expect(
        researchContactSchema.safeParse({ ...validContact, sourceUrl }).success,
      ).toBe(false);
    },
  );

  it.each(["08123456789", "+08123456789", "+62812", "+6281234567890123456"])(
    "rejects a whatsapp or phone value that is not E.164 %s",
    (value) => {
      expect(
        researchContactSchema.safeParse({ ...validContact, value }).success,
      ).toBe(false);
      expect(
        researchContactSchema.safeParse({
          ...validContact,
          type: "phone",
          method: "tel_link",
          value,
        }).success,
      ).toBe(false);
    },
  );

  it("does not apply the E.164 rule to email contacts", () => {
    const parsed = researchContactSchema.safeParse({
      ...validContact,
      type: "email",
      value: "budi@example.test",
      method: "email_text",
    });

    expect(parsed.success).toBe(true);
  });

  it.each([-0.1, 1.1])("rejects confidence outside 0..1 %s", (confidence) => {
    expect(
      researchContactSchema.safeParse({ ...validContact, confidence }).success,
    ).toBe(false);
  });

  it("rejects an unknown contact type, method, or verification", () => {
    expect(
      researchContactSchema.safeParse({ ...validContact, type: "fax" }).success,
    ).toBe(false);
    expect(
      researchContactSchema.safeParse({ ...validContact, method: "scraped" }).success,
    ).toBe(false);
    expect(
      researchContactSchema.safeParse({ ...validContact, verification: "verified" }).success,
    ).toBe(false);
  });
});

describe("researchResultSchema", () => {
  it("accepts an empty result for a task", () => {
    expect(
      researchResultSchema.parse({ taskId, contacts: [], chain: [] }),
    ).toEqual({ taskId, contacts: [], chain: [] });
  });

  it("accepts contacts and a chain entry", () => {
    const parsed = researchResultSchema.parse({
      taskId,
      contacts: [validContact],
      chain: [
        {
          id: "e_0000000000000001",
          taskId,
          fromNode: "Budi Santoso",
          toNode: "linkedin.com/in/budi",
          how: "profil LinkedIn menautkan situs perusahaan",
        },
      ],
    });

    expect(parsed.contacts).toHaveLength(1);
    expect(parsed.chain).toHaveLength(1);
  });

  it("rejects a chain entry with an empty or oversized field", () => {
    const entry = {
      id: "e_0000000000000001",
      taskId,
      fromNode: "Budi",
      toNode: "PT Contoh",
      how: "halaman kontak",
    };

    expect(
      researchChainEntrySchema.safeParse({ ...entry, how: "" }).success,
    ).toBe(false);
    expect(
      researchChainEntrySchema.safeParse({ ...entry, fromNode: "x".repeat(301) }).success,
    ).toBe(false);
  });
});

describe("createTaskRequestSchema", () => {
  it("defaults kind to agent", () => {
    const parsed = createTaskRequestSchema.parse({ goal: "Buka halaman" });

    expect(parsed.kind).toBe("agent");
    expect(parsed.research).toBeUndefined();
  });

  it("accepts a research task with a target and optional organization", () => {
    const withOrganization = createTaskRequestSchema.parse({
      goal: "Cari kontak Budi",
      kind: "research",
      research: { targetName: "Budi Santoso", organization: "PT Contoh" },
    });
    const withoutOrganization = createTaskRequestSchema.parse({
      goal: "Cari kontak Budi",
      kind: "research",
      research: { targetName: "Budi Santoso" },
    });

    expect(withOrganization.research).toEqual({
      targetName: "Budi Santoso",
      organization: "PT Contoh",
    });
    expect(withoutOrganization.research).toEqual({ targetName: "Budi Santoso" });
  });

  it("rejects research without a kind of research", () => {
    expect(
      createTaskRequestSchema.safeParse({
        goal: "Cari kontak",
        research: { targetName: "Budi Santoso" },
      }).success,
    ).toBe(false);
    expect(
      createTaskRequestSchema.safeParse({
        goal: "Cari kontak",
        kind: "agent",
        research: { targetName: "Budi Santoso" },
      }).success,
    ).toBe(false);
  });

  it("rejects a research task without a target name", () => {
    expect(
      createTaskRequestSchema.safeParse({
        goal: "Cari kontak",
        kind: "research",
      }).success,
    ).toBe(false);
    expect(
      createTaskRequestSchema.safeParse({
        goal: "Cari kontak",
        kind: "research",
        research: { organization: "PT Contoh" },
      }).success,
    ).toBe(false);
    expect(
      createTaskRequestSchema.safeParse({
        goal: "Cari kontak",
        kind: "research",
        research: { targetName: "" },
      }).success,
    ).toBe(false);
  });

  it("keeps goal required for every kind", () => {
    expect(
      createTaskRequestSchema.safeParse({ kind: "research", research: { targetName: "Budi" } })
        .success,
    ).toBe(false);
  });

  it("keeps outputSchema opaque", () => {
    const outputSchema = { nested: { email: "string", score: 0.5 } };
    const parsed = createTaskRequestSchema.parse({
      goal: "Cari kontak",
      kind: "research",
      research: { targetName: "Budi" },
      outputSchema,
    });

    expect(parsed.outputSchema).toEqual(outputSchema);
  });
});
