import { describe, expect, it } from "vitest";
import { formatMegabytes, formatPercent } from "./browser-format";

describe("formatMegabytes", () => {
  it("formats bytes as megabytes with Indonesian decimal separator", () => {
    expect(formatMegabytes(1_572_864)).toBe("1,5");
  });

  it("keeps whole megabytes without decimals", () => {
    expect(formatMegabytes(1_048_576)).toBe("1");
  });
});

describe("formatPercent", () => {
  it("rounds the percentage to a whole number", () => {
    expect(formatPercent(37.6)).toBe("38");
  });
});
