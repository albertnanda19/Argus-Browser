import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  actionRequestSchema,
  actionResultSchema,
} from "./action";
import {
  agentStepListResponseSchema,
  agentStepResultSchema,
  agentStepSchema,
  agentStepVerificationSchema,
} from "./agent-step";
import { chromeInstallerStateSchema } from "./chrome-installer";
import { problemSchema } from "./contracts";
import { createOpenApiDocument, type OpenApiOperation } from "./openapi";
import { profileSchema } from "./profile";
import { profilePolicySchema } from "./profile-policy";
import {
  providerConfigRequestSchema,
  providerConfigSchema,
} from "./provider";
import { sessionSchema } from "./session";
import { approvalSchema, taskSchema } from "./task";

type JsonObject = { readonly [key: string]: unknown };

const EXPECTED_OPERATIONS = [
  "GET /health",
  "GET /browser",
  "POST /browser/download",
  "PUT /browser/local-executable",
  "DELETE /browser/local-executable",
  "GET /providers",
  "PUT /providers",
  "GET /profiles",
  "POST /profiles",
  "DELETE /profiles/{id}",
  "GET /profiles/{id}/policy",
  "PUT /profiles/{id}/policy",
  "GET /sessions",
  "POST /sessions",
  "GET /sessions/{id}",
  "DELETE /sessions/{id}",
  "GET /sessions/{id}/thumbnail",
  "POST /sessions/{id}/tasks",
  "POST /sessions/{id}/actions",
  "GET /tasks",
  "GET /tasks/{id}",
  "GET /tasks/{id}/steps",
  "GET /tasks/{id}/research",
  "POST /tasks/{id}/cancel",
  "POST /tasks/{id}/approval",
  "GET /approvals",
  "GET /events",
  "GET /openapi.json",
];

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectRefs(value: unknown, refs: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRefs(item, refs);
    }
    return refs;
  }

  if (!isObject(value)) {
    return refs;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string") {
      refs.push(child);
    } else {
      collectRefs(child, refs);
    }
  }

  return refs;
}

function collectKeys(value: unknown, keys: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeys(item, keys);
    }
    return;
  }

  if (!isObject(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    keys.add(key);
    collectKeys(child, keys);
  }
}

function requiredOf(schema: unknown): string[] {
  if (!isObject(schema) || !Array.isArray(schema.required)) {
    return [];
  }

  return schema.required.filter((item): item is string => typeof item === "string");
}

function operationAt(
  method: string,
  path: string,
): OpenApiOperation {
  const operation = createOpenApiDocument().paths[path]?.[method];

  if (operation === undefined) {
    throw new Error(`Missing operation ${method} ${path}`);
  }

  return operation;
}

function allOperations(): { method: string; path: string; operation: OpenApiOperation }[] {
  return Object.entries(createOpenApiDocument().paths).flatMap(([path, item]) =>
    Object.entries(item).map(([method, operation]) => ({ method, path, operation })),
  );
}

function generatedJsonSchema(schema: z.ZodType, io: "input" | "output"): JsonObject {
  const json = { ...z.toJSONSchema(schema, { io }) };
  delete json.$schema;
  delete json.$id;
  return json;
}

function generatedAgentStepComponents(): Record<string, JsonObject> {
  const registry = z.registry<{ id?: string }>();
  const components = [
    { name: "AgentStep", schema: agentStepSchema },
    { name: "AgentStepResult", schema: agentStepResultSchema },
    { name: "AgentStepVerification", schema: agentStepVerificationSchema },
    { name: "AgentStepListResponse", schema: agentStepListResponseSchema },
  ] as const;

  for (const component of components) {
    registry.add(component.schema, { id: component.name });
  }

  const uri = (id: string): string => `#/components/schemas/${id}`;
  const generated = z.toJSONSchema(registry, { io: "output", uri }).schemas;

  return Object.fromEntries(
    Object.entries(generated).map(([name, schema]) => {
      const json = { ...schema };
      delete json.$schema;
      delete json.$id;
      return [name, json];
    }),
  );
}

describe("OpenAPI document", () => {
  it("declares OpenAPI 3.1, API metadata, server, security, and tags", () => {
    const document = createOpenApiDocument();

    expect(document.openapi).toBe("3.1.0");
    expect(document.info.title).toBe("Argus Control API");
    expect(document.info.version).toBe("1.0.0");
    expect(document.info.description).toContain("api.json");
    expect(document.info.description).toContain("token");
    expect(document.servers).toEqual([{ url: "/v1" }]);
    expect(document.security).toEqual([{ bearerAuth: [] }]);
    expect(document.components.securitySchemes.bearerAuth).toEqual({
      type: "http",
      scheme: "bearer",
    });
    expect(document.tags.map((tag) => tag.name)).toEqual([
      "Health",
      "Browser",
      "Providers",
      "Profiles",
      "Sessions",
      "Tasks",
      "Approvals",
      "Actions",
      "Events",
    ]);
  });

  it("contains exactly the required operations", () => {
    const document = createOpenApiDocument();
    const operations = allOperations().map(({ method, path }) => `${method.toUpperCase()} ${path}`);

    expect(Object.keys(document.paths)).toHaveLength(22);
    expect(operations).toHaveLength(28);
    expect(new Set(operations)).toEqual(new Set(EXPECTED_OPERATIONS));
  });

  it("resolves every ref to a component schema", () => {
    const document = createOpenApiDocument();
    const refs = collectRefs(document);

    expect(refs.length).toBeGreaterThan(0);

    for (const ref of refs) {
      expect(ref.startsWith("#/components/schemas/")).toBe(true);
      const name = ref.slice("#/components/schemas/".length);
      expect(document.components.schemas[name], ref).toBeDefined();
    }
  });

  it("serializes to JSON without undefined values", () => {
    const document = createOpenApiDocument();

    expect(JSON.parse(JSON.stringify(document))).toEqual(document);
  });

  it("removes JSON Schema metadata from every component", () => {
    const keys = new Set<string>();
    collectKeys(createOpenApiDocument(), keys);

    expect(keys.has("$schema")).toBe(false);
    expect(keys.has("$id")).toBe(false);
  });

  it("documents problem+json for every error response", () => {
    for (const { method, path, operation } of allOperations()) {
      for (const [status, response] of Object.entries(operation.responses)) {
        if (status.startsWith("2")) {
          continue;
        }

        expect(response.content, `${method} ${path} ${status}`).toEqual({
          "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } },
        });
      }
    }
  });

  it("documents 401 and a success status for every operation", () => {
    for (const { method, path, operation } of allOperations()) {
      const statuses = Object.keys(operation.responses);

      expect(statuses, `${method} ${path}`).toContain("401");
      expect(
        statuses.some((status) => status.startsWith("2")),
        `${method} ${path}`,
      ).toBe(true);
    }
  });

  it("generates entity components from the existing Zod schemas", () => {
    const schemas = createOpenApiDocument().components.schemas;

    expect(schemas.Task).toEqual(generatedJsonSchema(taskSchema, "output"));
    expect(schemas.TaskListResponse).toMatchObject({
      type: "object",
      required: ["data", "total", "page", "page_size"],
    });
    expect(collectRefs(schemas.TaskListResponse)).toEqual([
      "#/components/schemas/Task",
    ]);
    expect(schemas.Approval).toEqual(generatedJsonSchema(approvalSchema, "output"));
    expect(schemas.ApprovalListResponse).toMatchObject({
      type: "object",
      required: ["data", "total", "page", "page_size"],
    });
    expect(collectRefs(schemas.ApprovalListResponse)).toEqual([
      "#/components/schemas/Approval",
    ]);
    expect(schemas.Profile).toEqual(generatedJsonSchema(profileSchema, "output"));
    expect(schemas.Session).toEqual(generatedJsonSchema(sessionSchema, "output"));
    expect(schemas.Problem).toEqual(generatedJsonSchema(problemSchema, "output"));
    expect(schemas.ActionRequest).toEqual(generatedJsonSchema(actionRequestSchema, "input"));
    expect(schemas.ActionResult).toEqual(generatedJsonSchema(actionResultSchema, "output"));
    expect(schemas.ChromeInstallerState).toEqual(
      generatedJsonSchema(chromeInstallerStateSchema, "output"),
    );
    expect(schemas.ProfilePolicy).toEqual(generatedJsonSchema(profilePolicySchema, "output"));
    expect(schemas.ProviderConfig).toEqual(generatedJsonSchema(providerConfigSchema, "output"));
    expect(schemas.UpdateProviderRequest).toEqual(
      generatedJsonSchema(providerConfigRequestSchema, "input"),
    );
    const agentComponents = generatedAgentStepComponents();

    expect(schemas.AgentStep).toEqual(agentComponents.AgentStep);
    expect(schemas.AgentStepResult).toEqual(agentComponents.AgentStepResult);
    expect(schemas.AgentStepVerification).toEqual(
      agentComponents.AgentStepVerification,
    );
    expect(schemas.AgentStepListResponse).toEqual(
      agentComponents.AgentStepListResponse,
    );
    expect(Object.keys(schemas)).toHaveLength(37);
  });

  it("documents profile policy reads and writes", () => {
    const document = createOpenApiDocument();
    const schemas = document.components.schemas;
    const getOperation = operationAt("get", "/profiles/{id}/policy");
    const putOperation = operationAt("put", "/profiles/{id}/policy");

    expect(getOperation.responses["200"]).toEqual({
      description: "Policy efektif profil.",
      content: {
        "application/json": { schema: { $ref: "#/components/schemas/ProfilePolicyResponse" } },
      },
    });
    expect(putOperation.requestBody).toEqual({
      required: true,
      content: {
        "application/json": { schema: { $ref: "#/components/schemas/ProfilePolicy" } },
      },
    });
    expect(putOperation.responses["200"]).toEqual(getOperation.responses["200"]);
    expect(schemas.ProfilePolicyResponse).toEqual({
      type: "object",
      properties: { data: { $ref: "#/components/schemas/ProfilePolicy" } },
      required: ["data"],
      additionalProperties: false,
    });
  });
  it("documents provider configuration without returning the API key", () => {
    const document = createOpenApiDocument();
    const schemas = document.components.schemas;
    const request = schemas.UpdateProviderRequest;

    expect(JSON.stringify(schemas.ProviderConfig)).not.toContain("apiKey");
    expect(JSON.stringify(schemas.ProviderResponse)).not.toContain("apiKey");
    expect(collectRefs(schemas.ProviderResponse)).toEqual([
      "#/components/schemas/ProviderConfig",
    ]);
    expect(requiredOf(request)).toEqual(["provider", "model"]);
    expect(requiredOf(schemas.ProviderConfig)).toContain("available");

    const operation = operationAt("put", "/providers");

    expect(operation.tags).toEqual(["Providers"]);
    expect(operation.responses["400"]).toBeDefined();
    expect(operation.responses["422"]).toBeDefined();
    expect(operation.responses["500"]).toBeDefined();
  });

  it("keeps optional request fields optional", () => {
    const schemas = createOpenApiDocument().components.schemas;
    const createTask = schemas.CreateTaskRequest;
    const actionRequest = schemas.ActionRequest;

    expect(requiredOf(createTask)).toContain("goal");
    expect(requiredOf(createTask)).not.toContain("outputSchema");
    expect(requiredOf(createTask)).not.toContain("kind");
    expect(requiredOf(createTask)).not.toContain("research");
    expect(requiredOf(schemas.Task)).toEqual(
      expect.arrayContaining(["kind", "research"]),
    );

    const branches = actionRequest?.oneOf;

    expect(Array.isArray(branches)).toBe(true);
    if (!Array.isArray(branches)) {
      throw new Error("ActionRequest must be a union");
    }

    expect(branches).toHaveLength(4);
    for (const branch of branches) {
      expect(requiredOf(branch)).not.toContain("taskId");
    }
  });

  it("documents the paginated profile and session queries", () => {
    const cases = [
      { method: "get", path: "/profiles" },
      { method: "get", path: "/sessions" },
    ] as const;

    for (const entry of cases) {
      const operation = operationAt(entry.method, entry.path);
      const page = operation.parameters?.find((parameter) => parameter.name === "page");
      const pageSize = operation.parameters?.find((parameter) => parameter.name === "page_size");

      expect(page?.schema).toEqual({ default: 1, type: "integer", minimum: 1, maximum: 9007199254740991 });
      expect(pageSize?.schema).toEqual({
        default: 20,
        type: "integer",
        minimum: 1,
        maximum: 100,
      });
      expect(operation.responses["400"]).toBeDefined();
    }
  });

  it("documents the paginated task step query", () => {
    const operation = operationAt("get", "/tasks/{id}/steps");
    const id = operation.parameters?.find((parameter) => parameter.name === "id");
    const page = operation.parameters?.find((parameter) => parameter.name === "page");
    const pageSize = operation.parameters?.find(
      (parameter) => parameter.name === "page_size",
    );

    expect(operation.tags).toEqual(["Tasks"]);
    expect(id?.schema.pattern).toBe("^t_[0-9a-f]{16}$");
    expect(page?.schema).toEqual({
      default: 1,
      type: "integer",
      minimum: 1,
      maximum: 9007199254740991,
    });
    expect(pageSize?.schema).toEqual({
      default: 20,
      type: "integer",
      minimum: 1,
      maximum: 100,
    });
    expect(operation.responses["200"]).toEqual({
      description: "Daftar langkah task.",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/AgentStepListResponse" },
        },
      },
    });
    expect(operation.responses["400"]).toBeDefined();
    expect(operation.responses["404"]).toBeDefined();
    expect(Object.keys(createOpenApiDocument().paths["/tasks/{id}/steps"] ?? {})).toEqual([
      "get",
    ]);
  });

  it("documents the research result of a task", () => {
    const document = createOpenApiDocument();
    const schemas = document.components.schemas;
    const operation = operationAt("get", "/tasks/{id}/research");

    expect(operation.tags).toEqual(["Tasks"]);
    expect(operation.parameters?.map((parameter) => parameter.name)).toEqual(["id"]);
    expect(operation.responses["200"]).toEqual({
      description: "Hasil riset task.",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ResearchResultResponse" },
        },
      },
    });
    expect(operation.responses["400"]).toBeDefined();
    expect(operation.responses["401"]).toBeDefined();
    expect(operation.responses["404"]).toBeDefined();
    expect(operation.responses["409"]).toBeDefined();
    expect(collectRefs(schemas.ResearchResultResponse)).toEqual([
      "#/components/schemas/ResearchResult",
    ]);
    expect(collectRefs(schemas.ResearchResult)).toEqual([
      "#/components/schemas/ResearchContact",
      "#/components/schemas/ResearchChainEntry",
    ]);
    expect(requiredOf(schemas.ResearchContact)).toEqual([
      "id",
      "taskId",
      "type",
      "value",
      "sourceUrl",
      "method",
      "confidence",
      "verification",
    ]);
    expect(schemas.ResearchContact?.properties).toMatchObject({
      confidence: { type: "number", minimum: 0, maximum: 1 },
      sourceUrl: { type: "string", format: "uri" },
    });
    expect(requiredOf(schemas.Task)).toEqual(
      expect.arrayContaining(["kind", "research"]),
    );
  });

  it("documents cockpit read queries and thumbnail responses", () => {
    const document = createOpenApiDocument();
    const tasks = operationAt("get", "/tasks");
    const approvals = operationAt("get", "/approvals");
    const thumbnail = operationAt("get", "/sessions/{id}/thumbnail");

    expect(tasks.tags).toEqual(["Tasks"]);
    expect(tasks.parameters?.map((parameter) => parameter.name)).toEqual([
      "page",
      "page_size",
      "sessionId",
      "status",
    ]);
    expect(tasks.responses["200"]).toEqual({
      description: "Daftar task.",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/TaskListResponse" },
        },
      },
    });
    expect(tasks.responses["400"]).toBeDefined();
    expect(tasks.responses["401"]).toBeDefined();

    expect(approvals.tags).toEqual(["Approvals"]);
    expect(approvals.parameters?.map((parameter) => parameter.name)).toEqual([
      "page",
      "page_size",
      "decision",
      "taskId",
    ]);
    expect(approvals.responses["200"]).toEqual({
      description: "Daftar approval.",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ApprovalListResponse" },
        },
      },
    });
    expect(approvals.responses["400"]).toBeDefined();
    expect(approvals.responses["401"]).toBeDefined();

    expect(thumbnail.tags).toEqual(["Sessions"]);
    expect(thumbnail.parameters?.map((parameter) => parameter.name)).toEqual(["id"]);
    expect(thumbnail.responses["200"]).toEqual({
      description: "Cuplikan JPEG viewport sesi.",
      content: {
        "image/jpeg": {
          schema: { type: "string", contentMediaType: "image/jpeg" },
        },
      },
    });
    for (const status of ["400", "401", "404", "409", "500"]) {
      expect(thumbnail.responses[status], status).toBeDefined();
    }
    expect(document.components.schemas.Approval).toMatchObject({
      required: expect.arrayContaining(["target", "requestedAt"]),
    });
  });

  it("documents path id patterns", () => {
    const cases = [
      { method: "delete", path: "/profiles/{id}", pattern: "^p_[0-9a-f]{16}$" },
      { method: "get", path: "/sessions/{id}", pattern: "^s_[0-9a-f]{16}$" },
      { method: "get", path: "/tasks/{id}", pattern: "^t_[0-9a-f]{16}$" },
    ] as const;

    for (const entry of cases) {
      const operation = operationAt(entry.method, entry.path);
      const parameter = operation.parameters?.find((item) => item.name === "id");

      expect(parameter?.in).toBe("path");
      expect(parameter?.required).toBe(true);
      expect(parameter?.schema.pattern).toBe(entry.pattern);
    }
  });

  it("requires Idempotency-Key for task creation", () => {
    const operation = operationAt("post", "/sessions/{id}/tasks");
    const parameter = operation.parameters?.find((item) => item.name === "Idempotency-Key");

    expect(parameter?.in).toBe("header");
    expect(parameter?.required).toBe(true);
    expect(parameter?.schema).toEqual({ type: "string", minLength: 1, maxLength: 200 });
  });

  it("documents the event stream and its replay behavior", () => {
    const operation = operationAt("get", "/events");
    const response = operation.responses["200"];
    const taskId = operation.parameters?.find((parameter) => parameter.name === "taskId");
    const lastEventId = operation.parameters?.find((parameter) => parameter.name === "Last-Event-ID");

    expect(response?.content?.["text/event-stream"]?.schema).toEqual({ type: "string" });
    expect(response?.description).toContain("agent.step");
    expect(response?.description).toContain("approval.requested");
    expect(response?.description).toContain("task.completed");    expect(response?.description).toContain("task.failed");
    expect(response?.description).toContain("task.cancelled");
    expect(response?.description).toContain("step");
    expect(response?.description).toContain("heartbeat 15 detik");
    expect(response?.description).toContain("best-effort");
    expect(response?.description).toContain("selector");
    expect(response?.description).toContain("highlighted");
    expect(response?.description).toContain("timeout approval 10 menit");
    expect(response?.description).toContain("audit");
    expect(taskId?.schema.pattern).toBe("^t_[0-9a-f]{16}$");
    expect(lastEventId?.in).toBe("header");
    expect(lastEventId?.required).toBe(false);
    expect(operation.responses["400"]).toBeDefined();
    expect(operation.responses["401"]).toBeDefined();
  });

  it("serves the document itself as a free-form JSON object", () => {
    const operation = operationAt("get", "/openapi.json");
    const schema = operation.responses["200"]?.content?.["application/json"]?.schema;

    expect(isObject(schema)).toBe(true);
    expect(schema?.type).toBe("object");
    expect(operation.responses["401"]).toBeDefined();
  });

  it("contains no credentials or filesystem paths", () => {
    const serialized = JSON.stringify(createOpenApiDocument());

    expect(serialized).not.toContain("test-token");
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("backend/");
  });
});
