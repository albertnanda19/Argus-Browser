import { describe, expect, it } from "vitest";
import { isWhatsAppNumber, normalizePhoneNumber } from "./research-phone";

describe("normalizePhoneNumber", () => {
  it.each([
    "08123456789",
    "628123456789",
    "+62 812 3456 789",
    "0062 812 3456 789",
    "+62-812-3456-789",
    "0812.3456.789",
    "(0812) 3456 789",
    "+62\u00A0812\u00A03456\u00A0789",
  ])("normalizes %s to the same E.164 value", (raw) => {
    expect(normalizePhoneNumber(raw)).toBe("+628123456789");
  });

  it("accepts international numbers with a plus or double zero prefix", () => {
    expect(normalizePhoneNumber("+1 (415) 555-2671")).toBe("+14155552671");
    expect(normalizePhoneNumber("0044 20 7946 0958")).toBe("+442079460958");
  });

  it("uses the provided default country code for local numbers", () => {
    expect(normalizePhoneNumber("07911 123456", "44")).toBe("+447911123456");
    expect(normalizePhoneNumber("+1 415 555 2671", "44")).toBe("+14155552671");
  });

  it.each([
    "0812-3456-789 ext 12",
    "0812-3456-789 ext. 12",
    "0812-3456-789 x12",
    "0812-3456-789 #12",
    "0812345678a",
    "0812/3456/789",
    "0812_3456_789",
    "phone: 08123456789",
    "",
    "+",
  ])("rejects %s", (raw) => {
    expect(normalizePhoneNumber(raw)).toBeNull();
  });

  it.each(["8123456789", "44123456789", "1234567", "+6281234567890123456"])(
    "does not guess a country for %s",
    (raw) => {
      expect(normalizePhoneNumber(raw)).toBeNull();
    },
  );

  it("accepts a default country code with or without a plus", () => {
    expect(normalizePhoneNumber("08123456789", "62")).toBe("+628123456789");
    expect(normalizePhoneNumber("08123456789", "+62")).toBe("+628123456789");
  });

  it("rejects an invalid default country code", () => {
    expect(normalizePhoneNumber("08123456789", "abc")).toBeNull();
    expect(normalizePhoneNumber("08123456789", "0")).toBeNull();
    expect(normalizePhoneNumber("08123456789", "1234")).toBeNull();
  });
});

describe("isWhatsAppNumber", () => {
  it("accepts Indonesian mobile numbers", () => {
    expect(isWhatsAppNumber("+628123456789")).toBe(true);
    expect(isWhatsAppNumber("+6281234567890")).toBe(true);
  });

  it("rejects Indonesian non-mobile numbers", () => {
    expect(isWhatsAppNumber("+622112345678")).toBe(false);
    expect(isWhatsAppNumber("+62211234567")).toBe(false);
  });

  it("accepts numbers outside Indonesia", () => {
    expect(isWhatsAppNumber("+14155552671")).toBe(true);
    expect(isWhatsAppNumber("+442079460958")).toBe(true);
  });
});
