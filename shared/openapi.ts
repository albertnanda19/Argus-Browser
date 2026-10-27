import { z } from "zod";
import {
  approvalDecisionRequestSchema,
  approvalResponseSchema,
  browserStateResponseSchema,
  createProfileRequestSchema,
  createSessionRequestSchema,
  createTaskRequestSchema,
  idempotencyKeySchema,
  localExecutableRequestSchema,
  paginationQuerySchema,
  profileListResponseSchema,
  profilePolicyResponseSchema,
  profileResponseSchema,
  sessionListResponseSchema,
  sessionResponseSchema,
  taskResponseSchema,
} from "./api";
import {
  agentStepListResponseSchema,
  agentStepResultSchema,
  agentStepSchema,
  agentStepVerificationSchema,
} from "./agent-step";
import { actionRequestSchema, actionResponseSchema, actionResultSchema } from "./action";
import { chromeInstallerStateSchema } from "./chrome-installer";
import { healthResponseSchema, problemSchema } from "./contracts";
import { profileIdSchema, profileSchema } from "./profile";
import { profilePolicySchema } from "./profile-policy";
import {
  providerConfigRequestSchema,
  providerConfigSchema,
  providerResponseSchema,
} from "./provider";
import { sessionIdSchema, sessionSchema } from "./session";
import { approvalSchema, taskIdSchema, taskSchema } from "./task";

type JsonSchema = Record<string, unknown>;

export type OpenApiParameter = {
  readonly name: string;
  readonly in: "path" | "query" | "header";
  readonly required: boolean;
  readonly description: string;
  readonly schema: JsonSchema;
};

export type OpenApiMediaType = {
  readonly schema: JsonSchema;
};

export type OpenApiResponse = {
  readonly description: string;
  readonly content?: Record<string, OpenApiMediaType>;
};

export type OpenApiOperation = {
  readonly operationId: string;
  readonly summary: string;
  readonly tags?: readonly string[];
  readonly parameters?: readonly OpenApiParameter[];
  readonly requestBody?: {
    readonly required: boolean;
    readonly content: Record<string, OpenApiMediaType>;
  };
  readonly responses: Record<string, OpenApiResponse>;
};

export type OpenApiDocument = {
  readonly openapi: "3.1.0";
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly description: string;
  };
  readonly servers: readonly { readonly url: string }[];
  readonly security: readonly Record<string, readonly string[]>[];
  readonly tags: readonly { readonly name: string }[];
  readonly paths: Record<string, Record<string, OpenApiOperation>>;
  readonly components: {
    readonly securitySchemes: Record<string, Record<string, unknown>>;
    readonly schemas: Record<string, JsonSchema>;
  };
};

type ComponentDefinition = {
  readonly name: string;
  readonly schema: z.ZodType;
  readonly io: "input" | "output";
};

const COMPONENTS: readonly ComponentDefinition[] = [
  { name: "HealthResponse", schema: healthResponseSchema, io: "output" },
  { name: "BrowserStateResponse", schema: browserStateResponseSchema, io: "output" },
  { name: "LocalExecutableRequest", schema: localExecutableRequestSchema, io: "input" },
  { name: "Profile", schema: profileSchema, io: "output" },
  { name: "ProfileResponse", schema: profileResponseSchema, io: "output" },
  { name: "ProfilePolicy", schema: profilePolicySchema, io: "output" },
  { name: "ProfilePolicyResponse", schema: profilePolicyResponseSchema, io: "output" },
  { name: "ProfileListResponse", schema: profileListResponseSchema, io: "output" },
  { name: "CreateProfileRequest", schema: createProfileRequestSchema, io: "input" },
  { name: "Session", schema: sessionSchema, io: "output" },
  { name: "SessionResponse", schema: sessionResponseSchema, io: "output" },
  { name: "SessionListResponse", schema: sessionListResponseSchema, io: "output" },
  { name: "CreateSessionRequest", schema: createSessionRequestSchema, io: "input" },
  { name: "Task", schema: taskSchema, io: "output" },
  { name: "TaskResponse", schema: taskResponseSchema, io: "output" },
  { name: "AgentStep", schema: agentStepSchema, io: "output" },
  { name: "AgentStepResult", schema: agentStepResultSchema, io: "output" },
  { name: "AgentStepVerification", schema: agentStepVerificationSchema, io: "output" },
  { name: "AgentStepListResponse", schema: agentStepListResponseSchema, io: "output" },
  { name: "CreateTaskRequest", schema: createTaskRequestSchema, io: "input" },
  { name: "Approval", schema: approvalSchema, io: "output" },
  { name: "ApprovalResponse", schema: approvalResponseSchema, io: "output" },
  { name: "ApprovalDecisionRequest", schema: approvalDecisionRequestSchema, io: "input" },
  { name: "ActionRequest", schema: actionRequestSchema, io: "input" },
  { name: "ActionResult", schema: actionResultSchema, io: "output" },
  { name: "ActionResponse", schema: actionResponseSchema, io: "output" },
  { name: "ChromeInstallerState", schema: chromeInstallerStateSchema, io: "output" },
  { name: "ProviderConfig", schema: providerConfigSchema, io: "output" },
  { name: "ProviderResponse", schema: providerResponseSchema, io: "output" },
  { name: "UpdateProviderRequest", schema: providerConfigRequestSchema, io: "input" },
  { name: "Problem", schema: problemSchema, io: "output" },
];

const TAGS = [
  "Health",
  "Browser",
  "Providers",
  "Profiles",
  "Sessions",
  "Tasks",
  "Approvals",
  "Actions",
  "Events",
] as const;

function stripMeta(schema: JsonSchema): JsonSchema {
  const result = { ...schema };
  delete result.$schema;
  delete result.$id;
  return result;
}

function inlineSchema<T extends z.ZodType>(schema: T, io: "input" | "output"): JsonSchema {
  return stripMeta(z.toJSONSchema(schema, { io }));
}

function componentRef(name: string): JsonSchema {
  return { $ref: `#/components/schemas/${name}` };
}

function buildComponentSchemas(): Record<string, JsonSchema> {
  const registry = z.registry<{ id?: string }>();

  for (const component of COMPONENTS) {
    registry.add(component.schema, { id: component.name });
  }

  const uri = (id: string): string => `#/components/schemas/${id}`;
  const inputSchemas = z.toJSONSchema(registry, { io: "input", uri }).schemas;
  const outputSchemas = z.toJSONSchema(registry, { io: "output", uri }).schemas;
  const schemas: Record<string, JsonSchema> = {};

  for (const component of COMPONENTS) {
    const source = component.io === "input" ? inputSchemas : outputSchemas;
    const generated = source[component.name];

    if (generated === undefined) {
      throw new Error(`Missing generated schema for ${component.name}`);
    }

    schemas[component.name] = stripMeta(generated);
  }

  return schemas;
}

function jsonContent(name: string): Record<string, OpenApiMediaType> {
  return { "application/json": { schema: componentRef(name) } };
}

const problemContent = (): Record<string, OpenApiMediaType> => ({
  "application/problem+json": { schema: componentRef("Problem") },
});

function jsonResponse(description: string, name: string): OpenApiResponse {
  return { description, content: jsonContent(name) };
}

function problemResponse(description: string): OpenApiResponse {
  return { description, content: problemContent() };
}

function emptyResponse(description: string): OpenApiResponse {
  return { description };
}

function requestBody(name: string): OpenApiOperation["requestBody"] {
  return { required: true, content: jsonContent(name) };
}

function pathParameter(name: string, schema: z.ZodType, description: string): OpenApiParameter {
  return { name, in: "path", required: true, description, schema: inlineSchema(schema, "input") };
}

const UNAUTHORIZED = problemResponse("Token akses tidak valid.");
const BAD_REQUEST = problemResponse("Permintaan tidak valid.");
const NOT_FOUND = problemResponse("Resource tidak ditemukan.");
const CONFLICT = problemResponse("Permintaan bertentangan dengan state saat ini.");
const UNPROCESSABLE = problemResponse("Permintaan tidak dapat diproses.");
const INTERNAL_ERROR = problemResponse("Terjadi kesalahan internal.");

const PAGE_PARAMETER: OpenApiParameter = {
  name: "page",
  in: "query",
  required: false,
  description: "Halaman daftar yang diminta, dimulai dari 1.",
  schema: inlineSchema(paginationQuerySchema.shape.page, "input"),
};

const PAGE_SIZE_PARAMETER: OpenApiParameter = {
  name: "page_size",
  in: "query",
  required: false,
  description: "Jumlah item per halaman, 1 sampai 100.",
  schema: inlineSchema(paginationQuerySchema.shape.page_size, "input"),
};

const PAGINATION_PARAMETERS = [PAGE_PARAMETER, PAGE_SIZE_PARAMETER] as const;

const PROFILE_ID_PARAMETER = pathParameter("id", profileIdSchema, "Id profil.");
const SESSION_ID_PARAMETER = pathParameter("id", sessionIdSchema, "Id sesi.");
const TASK_ID_PARAMETER = pathParameter("id", taskIdSchema, "Id task.");

const IDEMPOTENCY_KEY_PARAMETER: OpenApiParameter = {
  name: "Idempotency-Key",
  in: "header",
  required: true,
  description: "Kunci idempotensi 1 sampai 200 karakter untuk mencegah task ganda.",
  schema: inlineSchema(idempotencyKeySchema, "input"),
};

const TASK_ID_QUERY_PARAMETER: OpenApiParameter = {
  name: "taskId",
  in: "query",
  required: false,
  description: "Filter event berdasarkan id task.",
  schema: inlineSchema(taskIdSchema, "input"),
};

const LAST_EVENT_ID_PARAMETER: OpenApiParameter = {
  name: "Last-Event-ID",
  in: "header",
  required: false,
  description: "Id event terakhir yang diterima klien untuk replay best-effort.",
  schema: inlineSchema(z.string(), "input"),
};

const EVENT_STREAM_DESCRIPTION =
  "Stream Server-Sent Events dengan heartbeat 15 detik berupa komentar ping. Nama event: agent.step, approval.requested, task.completed, task.failed, task.cancelled, dan step. approval.requested membawa action, target, selector, highlighted, dan category tanpa screenshot; timeout approval 10 menit membatalkan task dan setiap keputusan dicatat di audit log. Replay Last-Event-ID bersifat best-effort dan hilang saat sidecar restart.";

const FREE_OBJECT_SCHEMA = inlineSchema(z.record(z.string(), z.unknown()), "output");

const PATHS: Record<string, Record<string, OpenApiOperation>> = {
  "/health": {
    get: {
      operationId: "getHealth",
      summary: "Status sidecar dan kesiapan Chrome",
      tags: ["Health"],
      responses: {
        "200": jsonResponse("Status sidecar dan kesiapan Chrome.", "HealthResponse"),
        "401": UNAUTHORIZED,
      },
    },
  },
  "/browser": {
    get: {
      operationId: "getBrowser",
      summary: "State installer Chrome for Testing",
      tags: ["Browser"],
      responses: {
        "200": jsonResponse("State installer Chrome for Testing.", "BrowserStateResponse"),
        "401": UNAUTHORIZED,
      },
    },
  },
  "/browser/download": {
    post: {
      operationId: "downloadBrowser",
      summary: "Mulai unduhan Chrome for Testing di latar belakang",
      tags: ["Browser"],
      responses: {
        "202": jsonResponse("Unduhan diterima; state saat ini dikembalikan.", "BrowserStateResponse"),
        "401": UNAUTHORIZED,
      },
    },
  },
  "/browser/local-executable": {
    put: {
      operationId: "setLocalExecutable",
      summary: "Pakai binary Chrome lokal",
      tags: ["Browser"],
      requestBody: requestBody("LocalExecutableRequest"),
      responses: {
        "200": jsonResponse("Binary lokal diterima.", "BrowserStateResponse"),
        "400": BAD_REQUEST,
        "401": UNAUTHORIZED,
        "422": UNPROCESSABLE,
      },
    },
    delete: {
      operationId: "clearLocalExecutable",
      summary: "Hapus override binary Chrome lokal",
      tags: ["Browser"],
      responses: {
        "204": emptyResponse("Override lokal dihapus."),
        "401": UNAUTHORIZED,
      },
    },
  },
  "/providers": {
    get: {
      operationId: "getProviderConfig",
      summary: "Konfigurasi provider aktif dan provider tersedia",
      tags: ["Providers"],
      responses: {
        "200": jsonResponse("Konfigurasi provider tanpa API key.", "ProviderResponse"),
        "401": UNAUTHORIZED,
      },
    },
    put: {
      operationId: "updateProviderConfig",
      summary: "Validasi, simpan, dan aktifkan konfigurasi provider",
      tags: ["Providers"],
      requestBody: requestBody("UpdateProviderRequest"),
      responses: {
        "200": jsonResponse("Konfigurasi tersimpan tanpa API key.", "ProviderResponse"),
        "400": BAD_REQUEST,
        "401": UNAUTHORIZED,
        "422": UNPROCESSABLE,
        "500": INTERNAL_ERROR,
      },
    },
  },
  "/profiles": {
    get: {
      operationId: "listProfiles",
      summary: "Daftar profil dengan paginasi",
      tags: ["Profiles"],
      parameters: PAGINATION_PARAMETERS,
      responses: {
        "200": jsonResponse("Daftar profil.", "ProfileListResponse"),
        "400": BAD_REQUEST,
        "401": UNAUTHORIZED,
      },
    },
    post: {
      operationId: "createProfile",
      summary: "Buat profil",
      tags: ["Profiles"],
      requestBody: requestBody("CreateProfileRequest"),
      responses: {
        "201": jsonResponse("Profil dibuat.", "ProfileResponse"),
        "400": BAD_REQUEST,
        "401": UNAUTHORIZED,
      },
    },
  },
  "/profiles/{id}": {
    delete: {
      operationId: "deleteProfile",
      summary: "Hapus profil beserta seluruh data identitasnya",
      tags: ["Profiles"],
      parameters: [PROFILE_ID_PARAMETER],
      responses: {
        "204": emptyResponse("Profil dihapus."),
        "400": BAD_REQUEST,
        "401": UNAUTHORIZED,
        "404": NOT_FOUND,
        "409": CONFLICT,
        "422": UNPROCESSABLE,
      },
    },
  },
  "/profiles/{id}/policy": {
    get: {
      operationId: "getProfilePolicy",
      summary: "Policy human-like efektif profil",
      tags: ["Profiles"],
      parameters: [PROFILE_ID_PARAMETER],
      responses: {
        "200": jsonResponse("Policy efektif profil.", "ProfilePolicyResponse"),
        "400": BAD_REQUEST,
        "401": UNAUTHORIZED,
        "404": NOT_FOUND,
        "422": UNPROCESSABLE,
      },
    },
    put: {
      operationId: "updateProfilePolicy",
      summary: "Ganti seluruh policy human-like profil",
      tags: ["Profiles"],
      parameters: [PROFILE_ID_PARAMETER],
      requestBody: requestBody("ProfilePolicy"),
      responses: {
        "200": jsonResponse("Policy efektif profil.", "ProfilePolicyResponse"),
        "400": BAD_REQUEST,
        "401": UNAUTHORIZED,
        "404": NOT_FOUND,
        "422": UNPROCESSABLE,
      },
    },
  },
  "/sessions": {
    get: {
      operationId: "listSessions",
      summary: "Daftar sesi aktif dengan paginasi",
      tags: ["Sessions"],
      parameters: PAGINATION_PARAMETERS,
      responses: {
        "200": jsonResponse("Daftar sesi aktif.", "SessionListResponse"),
        "400": BAD_REQUEST,
        "401": UNAUTHORIZED,
      },
    },
    post: {
      operationId: "createSession",
      summary: "Buka browser untuk profil",
      tags: ["Sessions"],
      requestBody: requestBody("CreateSessionRequest"),
      responses: {
        "201": jsonResponse("Sesi dibuat.", "SessionResponse"),
        "400": BAD_REQUEST,
        "401": UNAUTHORIZED,
        "404": NOT_FOUND,
        "409": CONFLICT,
        "422": UNPROCESSABLE,
        "500": INTERNAL_ERROR,
      },
    },
  },
  "/sessions/{id}": {
    get: {
      operationId: "getSession",
      summary: "Status sesi termasuk closed dan error",
      tags: ["Sessions"],
      parameters: [SESSION_ID_PARAMETER],
      responses: {
        "200": jsonResponse("Status sesi.", "SessionResponse"),
        "400": BAD_REQUEST,
        "401": UNAUTHORIZED,
        "404": NOT_FOUND,
      },
    },
    delete: {
      operationId: "closeSession",
      summary: "Tutup sesi",
      tags: ["Sessions"],
      parameters: [SESSION_ID_PARAMETER],
      responses: {
        "204": emptyResponse("Sesi ditutup."),
        "400": BAD_REQUEST,
        "401": UNAUTHORIZED,
        "404": NOT_FOUND,
        "500": INTERNAL_ERROR,
      },
    },
  },
  "/sessions/{id}/tasks": {
    post: {
      operationId: "createTask",
      summary: "Buat task untuk sesi",
      tags: ["Tasks"],
      parameters: [SESSION_ID_PARAMETER, IDEMPOTENCY_KEY_PARAMETER],
      requestBody: requestBody("CreateTaskRequest"),
      responses: {
        "202": jsonResponse("Task dibuat atau dikembalikan dari kunci idempotensi.", "TaskResponse"),
        "400": BAD_REQUEST,
        "401": UNAUTHORIZED,
        "404": NOT_FOUND,
        "409": CONFLICT,
      },
    },
  },
  "/sessions/{id}/actions": {
    post: {
      operationId: "executeAction",
      summary: "Jalankan aksi deterministik pada sesi",
      tags: ["Actions"],
      parameters: [SESSION_ID_PARAMETER],
      requestBody: requestBody("ActionRequest"),
      responses: {
        "200": jsonResponse("Aksi selesai.", "ActionResponse"),
        "400": BAD_REQUEST,
        "401": UNAUTHORIZED,
        "404": NOT_FOUND,
        "409": CONFLICT,
        "422": UNPROCESSABLE,
      },
    },
  },
  "/tasks/{id}": {
    get: {
      operationId: "getTask",
      summary: "Status task",
      tags: ["Tasks"],
      parameters: [TASK_ID_PARAMETER],
      responses: {
        "200": jsonResponse("Status task.", "TaskResponse"),
        "400": BAD_REQUEST,
        "401": UNAUTHORIZED,
        "404": NOT_FOUND,
      },
    },
  },
  "/tasks/{id}/steps": {
    get: {
      operationId: "listTaskSteps",
      summary: "Daftar langkah task dengan paginasi",
      tags: ["Tasks"],
      parameters: [TASK_ID_PARAMETER, ...PAGINATION_PARAMETERS],
      responses: {
        "200": jsonResponse("Daftar langkah task.", "AgentStepListResponse"),
        "400": BAD_REQUEST,
        "401": UNAUTHORIZED,
        "404": NOT_FOUND,
      },
    },
  },
  "/tasks/{id}/cancel": {
    post: {
      operationId: "cancelTask",
      summary: "Batalkan task",
      tags: ["Tasks"],
      parameters: [TASK_ID_PARAMETER],
      responses: {
        "202": jsonResponse("Task dibatalkan.", "TaskResponse"),
        "400": BAD_REQUEST,
        "401": UNAUTHORIZED,
        "404": NOT_FOUND,
        "409": CONFLICT,
      },
    },
  },
  "/tasks/{id}/approval": {
    post: {
      operationId: "decideApproval",
      summary: "Setujui atau tolak approval",
      tags: ["Approvals"],
      parameters: [TASK_ID_PARAMETER],
      requestBody: requestBody("ApprovalDecisionRequest"),
      responses: {
        "202": jsonResponse("Keputusan approval diterima.", "ApprovalResponse"),
        "400": BAD_REQUEST,
        "401": UNAUTHORIZED,
        "404": NOT_FOUND,
        "409": CONFLICT,
      },
    },
  },
  "/events": {
    get: {
      operationId: "streamEvents",
      summary: "Stream event task",
      tags: ["Events"],
      parameters: [TASK_ID_QUERY_PARAMETER, LAST_EVENT_ID_PARAMETER],
      responses: {
        "200": {
          description: EVENT_STREAM_DESCRIPTION,
          content: {
            "text/event-stream": { schema: inlineSchema(z.string(), "output") },
          },
        },
        "400": BAD_REQUEST,
        "401": UNAUTHORIZED,
      },
    },
  },
  "/openapi.json": {
    get: {
      operationId: "getOpenApiDocument",
      summary: "Dokumen OpenAPI 3.1 API ini",
      responses: {
        "200": {
          description: "Dokumen OpenAPI 3.1.",
          content: { "application/json": { schema: FREE_OBJECT_SCHEMA } },
        },
        "401": UNAUTHORIZED,
      },
    },
  },
};

export function createOpenApiDocument(): OpenApiDocument {
  return {
    openapi: "3.1.0",
    info: {
      title: "Argus Control API",
      version: "1.0.0",
      description:
        "API kontrol lokal Argus. Port dan token dibaca dari api.json pada direktori data aplikasi; token wajib dikirim sebagai bearer. Dokumen ini tidak memuat nilai port atau token.",
    },
    servers: [{ url: "/v1" }],
    security: [{ bearerAuth: [] }],
    tags: TAGS.map((name) => ({ name })),
    paths: structuredClone(PATHS),
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      schemas: buildComponentSchemas(),
    },
  };
}
