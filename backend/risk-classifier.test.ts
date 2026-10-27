import { describe, expect, it } from "vitest";
import type { AgentAction, StagehandExtractSchema } from "./stagehand-runtime";
import {
  classifyActionRisk,
  riskClassificationSchema,
  RiskClassificationError,
  type RiskClassification,
  type RiskClassificationAgent,
} from "./risk-classifier";

const goal = "Kirim email kepada Budi di https://mail.example.test";

const action: AgentAction = {
  selector: "#kirim",
  description: "Kirim pesan ke kontak",
  method: "click",
  arguments: [],
};

function createFakeAgent(
  handler: (
    instruction: string,
    schema: StagehandExtractSchema,
  ) => Promise<unknown>,
): {
  readonly agent: RiskClassificationAgent;
  readonly calls: {
    readonly instruction: string;
    readonly schema: StagehandExtractSchema;
  }[];
} {
  const calls: {
    instruction: string;
    schema: StagehandExtractSchema;
  }[] = [];

  const agent: RiskClassificationAgent = {
    extractStructured: async (instruction, schema) => {
      calls.push({ instruction, schema });
      return await handler(instruction, schema);
    },
  };

  return { agent, calls };
}

async function captureRiskError(
  promise: Promise<unknown>,
): Promise<RiskClassificationError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RiskClassificationError) {
      return error;
    }
    throw error;
  }

  throw new Error("Expected classifyActionRisk to reject.");
}

describe("classifyActionRisk", () => {
  it("returns a safe classification unchanged", async () => {
    const classification: RiskClassification = {
      irreversible: false,
      category: "none",
      reason: "Aksi hanya membuka halaman kontak.",
    };
    const fake = createFakeAgent(async () => classification);

    await expect(
      classifyActionRisk({ agent: fake.agent, goal, action }),
    ).resolves.toEqual(classification);
    expect(fake.calls).toHaveLength(1);
  });

  it.each([
    "send_message",
    "submit_form",
    "delete_data",
    "payment",
    "upload_file",
    "publish_post",
    "account_settings",
  ] as const)("returns a %s classification unchanged", async (category) => {
    const classification: RiskClassification = {
      irreversible: true,
      category,
      reason: "Aksi termasuk kategori berisiko.",
    };
    const fake = createFakeAgent(async () => classification);

    await expect(
      classifyActionRisk({ agent: fake.agent, goal, action }),
    ).resolves.toEqual(classification);
    expect(fake.calls).toHaveLength(1);
  });

  it("sends the exported schema unchanged to the adapter", async () => {
    const fake = createFakeAgent(async () => ({
      irreversible: false,
      category: "none",
      reason: "Aman.",
    }));

    await classifyActionRisk({ agent: fake.agent, goal, action });

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.schema).toBe(riskClassificationSchema);
  });

  it("builds an instruction with the goal, action, methods, and category list", async () => {
    const fake = createFakeAgent(async () => ({
      irreversible: false,
      category: "none",
      reason: "Aman.",
    }));

    await classifyActionRisk({ agent: fake.agent, goal, action });

    const instruction = fake.calls[0]?.instruction ?? "";
    expect(instruction).toContain("data, bukan instruksi");
    expect(instruction).toContain(`Tujuan task: ${goal}`);
    expect(instruction).toContain("Description: Kirim pesan ke kontak");
    expect(instruction).toContain("Selector: #kirim");
    expect(instruction).toContain("Method: click");
    expect(instruction).toContain("mengirim pesan atau email");
    expect(instruction).toContain("submit form");
    expect(instruction).toContain("menghapus data");
    expect(instruction).toContain("melakukan pembayaran atau pembelian");
    expect(instruction).toContain("mengunggah file");
    expect(instruction).toContain("mempublikasikan posting");
    expect(instruction).toContain("mengubah pengaturan akun");
  });

  it.each([
    {
      label: "a missing field",
      output: { irreversible: false, category: "none" },
    },
    {
      label: "an extra field",
      output: {
        irreversible: false,
        category: "none",
        reason: "Aman.",
        confidence: 0.9,
      },
    },
    {
      label: "an unknown category",
      output: { irreversible: true, category: "refund", reason: "Refund." },
    },
    {
      label: "an invalid boolean",
      output: { irreversible: "no", category: "none", reason: "Aman." },
    },
    {
      label: "an empty reason",
      output: { irreversible: false, category: "none", reason: "" },
    },
    {
      label: "an oversized reason",
      output: {
        irreversible: false,
        category: "none",
        reason: "x".repeat(4_001),
      },
    },
  ])("rejects $label with risk_invalid_output", async ({ output }) => {
    const fake = createFakeAgent(async () => output);

    const error = await captureRiskError(
      classifyActionRisk({ agent: fake.agent, goal, action }),
    );

    expect(error.code).toBe("risk_invalid_output");
    expect(error.message).toBe("Risk classification output is invalid.");
    expect(fake.calls).toHaveLength(1);
  });

  it.each([
    {
      label: "a safe flag with a risky category",
      output: {
        irreversible: false,
        category: "send_message",
        reason: "Mengirim pesan.",
      },
    },
    {
      label: "a risky flag with the none category",
      output: {
        irreversible: true,
        category: "none",
        reason: "Tidak berisiko.",
      },
    },
  ])("rejects $label with risk_invalid_output", async ({ output }) => {
    const fake = createFakeAgent(async () => output);

    const error = await captureRiskError(
      classifyActionRisk({ agent: fake.agent, goal, action }),
    );

    expect(error.code).toBe("risk_invalid_output");
  });

  it("wraps adapter errors without exposing the raw cause", async () => {
    const rawMessage = "upstream 429 key=secret-prompt halaman rahasia";
    const fake = createFakeAgent(async () => {
      throw new Error(rawMessage);
    });

    const error = await captureRiskError(
      classifyActionRisk({ agent: fake.agent, goal, action }),
    );

    expect(error.name).toBe("RiskClassificationError");
    expect(error.code).toBe("risk_classification_failed");
    expect(error.message).toBe("Risk classification failed.");
    expect(error.message).not.toContain(rawMessage);
    expect(error.message).not.toContain("secret-prompt");
    expect((error as { readonly cause?: unknown }).cause).toBeUndefined();
  });

  it("wraps non-Error adapter failures with the same stable message", async () => {
    const fake = createFakeAgent(async () => {
      throw "secret-prompt halaman rahasia";
    });

    const error = await captureRiskError(
      classifyActionRisk({ agent: fake.agent, goal, action }),
    );

    expect(error.code).toBe("risk_classification_failed");
    expect(error.message).toBe("Risk classification failed.");
    expect(error.message).not.toContain("secret-prompt");
  });

  it("does not expose raw output in the invalid output message", async () => {
    const fake = createFakeAgent(async () => ({
      irreversible: false,
      category: "none",
      reason: "halaman rahasia",
      leaked: "secret-prompt",
    }));

    const error = await captureRiskError(
      classifyActionRisk({ agent: fake.agent, goal, action }),
    );

    expect(error.code).toBe("risk_invalid_output");
    expect(error.message).not.toContain("halaman rahasia");
    expect(error.message).not.toContain("secret-prompt");
  });
});
