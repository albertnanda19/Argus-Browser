import { appendFile, chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const AUDIT_DIR = "audit";
export const AUDIT_LOG_FILE = "audit.jsonl";

export const auditActorSchema = z.enum(["operator", "system"]);

export const auditActionSchema = z.enum([
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "approval.timeout",
]);

export const auditEntrySchema = z.strictObject({
  id: z.uuid(),
  actor: auditActorSchema,
  action: auditActionSchema,
  resource: z.string().min(1),
  metadata: z.strictObject({
    approvalId: z.string().min(1),
    actionKind: z.string().min(1).max(100),
    category: z.string().min(1).max(50),
  }),
  createdAt: z.iso.datetime({ offset: false }),
});

export type AuditEntry = z.infer<typeof auditEntrySchema>;

export type AuditAppendResult = { readonly written: true } | { readonly written: false };

let writeTail: Promise<unknown> = Promise.resolve();

async function writeAuditLine(
  appDataDir: string,
  entry: AuditEntry,
): Promise<AuditAppendResult> {
  try {
    await mkdir(appDataDir, { recursive: true, mode: 0o700 });

    const directory = join(appDataDir, AUDIT_DIR);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);

    const file = join(directory, AUDIT_LOG_FILE);
    await appendFile(file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(file, 0o600);

    return { written: true };
  } catch {
    console.warn("Failed to append audit entry.");
    return { written: false };
  }
}

export function appendAuditEntry(
  appDataDir: string,
  entry: unknown,
): Promise<AuditAppendResult> {
  const run = async (): Promise<AuditAppendResult> => {
    const parsed = auditEntrySchema.safeParse(entry);

    if (!parsed.success) {
      console.warn("Rejected invalid audit entry.");
      return { written: false };
    }

    return writeAuditLine(appDataDir, parsed.data);
  };

  const current = writeTail.catch(() => undefined).then(run);
  writeTail = current.then(
    () => undefined,
    () => undefined,
  );

  return current;
}
