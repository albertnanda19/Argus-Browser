import { describe, expect, it, vi } from "vitest";
import type { ActionResponse } from "./action";
import type { AgentStep, AgentStepListResponse } from "./agent-step";
import type {
  ApprovalListResponse,
  ApprovalResponse,
  ProfileListResponse,
  ProfileResponse,
  ResearchResultResponse,
  SessionListResponse,
  SessionResponse,
  TaskListResponse,
  TaskResponse,
} from "./api";
import type { ChromeInstallerState } from "./chrome-installer";
import {
  ArgusApiError,
  createArgusClient,
  type ArgusEvent,
} from "./client";
import type { HealthResponse, Problem } from "./contracts";
import type { ProviderConfig, ProviderConfigRequest } from "./provider";
import type { Approval, TaskEntity } from "./task";
import type { Profile } from "./profile";
import { createDefaultProfilePolicy } from "./profile-policy";
import type { Session } from "./session";

const token = "test-token-argus";
const baseUrl = "http://127.0.0.1:4321/";
const timestamp = "2026-10-25T10:00:00.000Z";
const profileId = "p_0000000000000001";
const sessionId = "s_0000000000000001";
const taskId = "t_0000000000000001";
const approvalId = "a_0000000000000001";
const idempotencyKey = "task-key-001";

const health: HealthResponse = {
  data: {
    ok: true,
    chrome: { status: "ready", version: "156.0.8078.47" },
  },
};

const browserState: ChromeInstallerState = {
  status: "ready",
  source: "managed",
  version: "156.0.8078.47",
  progress: null,
  error: null,
};

const profile: Profile = {
  id: profileId,
  name: "Profil Kerja",
  createdAt: timestamp,
  lastUsedAt: null,
};

const profileResponse: ProfileResponse = { data: profile };

const profilePolicy = createDefaultProfilePolicy();

const profileList: ProfileListResponse = {
  data: [profile],
  total: 1,
  page: 1,
  page_size: 20,
};

const session: Session = {
  id: sessionId,
  profileId,
  status: "ready",
  startedAt: timestamp,
  endedAt: null,
  pid: null,
};

const sessionResponse: SessionResponse = { data: session };

const sessionList: SessionListResponse = {
  data: [session],
  total: 1,
  page: 1,
  page_size: 20,
};

const task: TaskEntity = {
  id: taskId,
  sessionId,
  goal: "Cari kontak",
  kind: "agent",
  research: null,
  outputSchema: { email: "string" },
  status: "queued",
  createdAt: timestamp,
  completedAt: null,
};

const waitingTask: TaskEntity = { ...task, status: "waiting_approval" };

const cancelledTask: TaskEntity = { ...task, status: "cancelled", completedAt: timestamp };

const researchTask: TaskEntity = {
  ...task,
  id: "t_0000000000000002",
  goal: "Cari kontak Budi",
  kind: "research",
  research: { targetName: "Budi Santoso", organization: "PT Contoh" },
};

const researchResult: ResearchResultResponse = {
  data: {
    taskId: researchTask.id,
    contacts: [
      {
        id: "c_0000000000000001",
        taskId: researchTask.id,
        type: "whatsapp",
        value: "+628123456789",
        sourceUrl: "https://example.test/kontak",
        method: "wa_me_link",
        confidence: 0.8,
        verification: "unverified",
      },
    ],
    chain: [
      {
        id: "e_0000000000000001",
        taskId: researchTask.id,
        fromNode: "Budi Santoso",
        toNode: "https://example.test/kontak",
        how: "halaman kontak perusahaan menautkan nomor WhatsApp",
      },
    ],
  },
};

const taskResponse: TaskResponse = { data: task };

const agentStep: AgentStep = {
  id: "st_0000000000000001",
  taskId,
  index: 1,
  action: "click",
  target: "Buka kontak",
  result: {
    status: "done",
    url: "https://example.test/kontak",
    pageChanged: true,
    verification: {
      stepOk: true,
      goalComplete: false,
      reason: "Halaman berubah.",
    },
  },
  durationMs: 812,
};

const agentStepList: AgentStepListResponse = {
  data: [agentStep],
  total: 1,
  page: 1,
  page_size: 20,
};

const approval: Approval = {
  id: approvalId,
  taskId,
  action: "send_email",
  target: "sales@example.com",
  payload: { to: "sales@example.com" },
  decision: "approved",
  requestedAt: timestamp,
  decidedAt: timestamp,
};

const approvalResponse: ApprovalResponse = {
  data: { task: waitingTask, approval },
};

const taskList: TaskListResponse = {
  data: [task, waitingTask],
  total: 2,
  page: 1,
  page_size: 20,
};

const approvalList: ApprovalListResponse = {
  data: [approval],
  total: 1,
  page: 1,
  page_size: 20,
};

const thumbnailBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

const actionResponse: ActionResponse = {
  data: { action: "navigate", url: "https://example.com/" },
};

const providerConfig: ProviderConfig = {
  provider: "gemini",
  model: "gemini-2.5-flash",
  configured: true,
  updatedAt: timestamp,
  available: ["gemini"],
};

const providerRequest: ProviderConfigRequest = {
  provider: "gemini",
  model: "gemini-2.5-flash",
  apiKey: "unit-test-provider-key",
};

type FetchCall = {
  readonly input: RequestInfo | URL;
  readonly init: RequestInit | undefined;
};

type FetchStub = {
  readonly fetch: typeof fetch;
  readonly calls: FetchCall[];
};

function createFetchStub(
  handle: (call: FetchCall) => Response | Promise<Response>,
): FetchStub {
  const calls: FetchCall[] = [];

  const fetchStub: typeof fetch = async (input, init) => {
    const call = { input, init };
    calls.push(call);
    return handle(call);
  };

  return { fetch: fetchStub, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(): Response {
  return new Response(null, { status: 204 });
}

function firstCall(calls: readonly FetchCall[]): FetchCall {
  const call = calls[0];
  if (call === undefined) {
    throw new Error("Expected a fetch call.");
  }
  return call;
}

function requireArgusError(error: unknown): ArgusApiError {
  if (!(error instanceof ArgusApiError)) {
    throw new Error("Expected ArgusApiError.");
  }
  return error;
}

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the request to fail.");
}

function routeResponse(method: string, pathname: string): Response {
  const key = `${method} ${pathname}`;

  if (key === "GET /v1/health") return jsonResponse(health);
  if (key === "GET /v1/browser") return jsonResponse({ data: browserState });
  if (key === "POST /v1/browser/download") return jsonResponse({ data: browserState }, 202);
  if (key === "PUT /v1/browser/local-executable") {
    return jsonResponse({ data: browserState });
  }
  if (key === "DELETE /v1/browser/local-executable") return emptyResponse();
  if (key === "GET /v1/providers") return jsonResponse({ data: providerConfig });
  if (key === "PUT /v1/providers") return jsonResponse({ data: providerConfig });
  if (key === "GET /v1/profiles") return jsonResponse(profileList);
  if (key === "POST /v1/profiles") return jsonResponse(profileResponse, 201);
  if (key === `DELETE /v1/profiles/${profileId}`) return emptyResponse();
  if (key === `GET /v1/profiles/${profileId}/policy`) {
    return jsonResponse({ data: profilePolicy });
  }
  if (key === `PUT /v1/profiles/${profileId}/policy`) {
    return jsonResponse({ data: profilePolicy });
  }
  if (key === "GET /v1/sessions") return jsonResponse(sessionList);
  if (key === "POST /v1/sessions") return jsonResponse(sessionResponse, 201);
  if (key === `GET /v1/sessions/${sessionId}`) return jsonResponse(sessionResponse);
  if (key === `DELETE /v1/sessions/${sessionId}`) return emptyResponse();
  if (key === `GET /v1/sessions/${sessionId}/thumbnail`) {
    return new Response(thumbnailBytes, {
      status: 200,
      headers: { "Content-Type": "image/jpeg" },
    });
  }
  if (key === "GET /v1/tasks") return jsonResponse(taskList);
  if (key === "GET /v1/approvals") return jsonResponse(approvalList);
  if (key === `POST /v1/sessions/${sessionId}/tasks`) {
    return jsonResponse(taskResponse, 202);
  }
  if (key === `GET /v1/tasks/${taskId}`) return jsonResponse(taskResponse);
  if (key === `GET /v1/tasks/${researchTask.id}/research`) {
    return jsonResponse(researchResult);
  }
  if (key === `GET /v1/tasks/${taskId}/steps`) return jsonResponse(agentStepList);
  if (key === `POST /v1/tasks/${taskId}/cancel`) {
    return jsonResponse({ data: cancelledTask }, 202);
  }
  if (key === `POST /v1/tasks/${taskId}/approval`) {
    return jsonResponse(approvalResponse, 202);
  }
  if (key === `POST /v1/sessions/${sessionId}/actions`) {
    return jsonResponse(actionResponse);
  }

  return jsonResponse(
    { type: "about:blank", title: "Not Found", status: 404, detail: "Tidak ditemukan." },
    404,
  );
}

function createClient(fetchStub: typeof fetch) {
  return createArgusClient({ api: { baseUrl, token }, fetch: fetchStub });
}

const encoder = new TextEncoder();

type SseFixture = {
  readonly response: Response;
  readonly stream: ReadableStream<Uint8Array>;
};

function createSseResponse(
  chunks: readonly string[],
  isClosed = true,
): SseFixture {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      if (isClosed) {
        controller.close();
      }
    },
  });

  return {
    response: new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
    stream,
  };
}

function stepFrame(id: string, selector = "#go"): string {
  return (
    `id: ${id}\n` +
    "event: step\n" +
    `data: {"taskId":null,"action":"click","selector":"${selector}","at":"${timestamp}"}\n` +
    "\n"
  );
}

function completedFrame(id: string): string {
  return (
    `id: ${id}\n` +
    "event: task.completed\n" +
    `data: {"taskId":"${taskId}","result":{},"at":"${timestamp}"}\n` +
    "\n"
  );
}

async function readUntilAborted(
  iterable: AsyncIterable<ArgusEvent>,
  controller: AbortController,
  abortAfter: number,
): Promise<ArgusEvent[]> {
  const items: ArgusEvent[] = [];

  for await (const item of iterable) {
    items.push(item);
    if (items.length === abortAfter) {
      controller.abort();
    }
  }

  return items;
}

async function readToEnd(
  iterable: AsyncIterable<ArgusEvent>,
): Promise<{ readonly items: ArgusEvent[]; readonly error: unknown }> {
  const items: ArgusEvent[] = [];

  try {
    for await (const item of iterable) {
      items.push(item);
    }
  } catch (error) {
    return { items, error };
  }

  return { items, error: null };
}

describe("createArgusClient", () => {
  it("calls all endpoints with the documented method, path, and headers", async () => {
    const stub = createFetchStub(({ input, init }) =>
      routeResponse(
        init?.method ?? "GET",
        new URL(String(input)).pathname,
      ),
    );
    const client = createClient(stub.fetch);

    const healthResult = await client.health();
    const browserResult = await client.browser.get();
    await client.browser.download();
    await client.browser.setLocalExecutable("/Applications/Chrome");
    await client.browser.clearLocalExecutable();
    await client.profiles.list();
    await client.profiles.create({ name: "Profil Kerja" });
    await client.profiles.delete(profileId);
    const policyResult = await client.profiles.getPolicy(profileId);
    const savedPolicy = await client.profiles.setPolicy(profileId, profilePolicy);
    await client.sessions.list();
    await client.sessions.start({ profileId });
    await client.sessions.get(sessionId);
    await client.sessions.close(sessionId);
    const thumbnail = await client.sessions.thumbnail(sessionId);
    await client.tasks.create(
      sessionId,
      { goal: "Cari kontak", outputSchema: { email: "string" } },
      { idempotencyKey },
    );
    await client.tasks.get(taskId);
    await client.tasks.list({ page: 2, page_size: 5, sessionId, status: "queued" });
    await client.tasks.listSteps(taskId);
    await client.tasks.getResearch(researchTask.id);
    await client.tasks.cancel(taskId);
    await client.tasks.resolveApproval(taskId, {
      approve: false,
      reason: "Target salah.",
    });
    await client.approvals.list({
      page: 2,
      page_size: 5,
      decision: "pending",
      taskId,
    });
    await client.actions.run(sessionId, { action: "click", selector: "#submit" });
    const providerResult = await client.providers.get();
    const savedProvider = await client.providers.set(providerRequest);

    const expectedCalls: readonly (readonly [string, string])[] = [
      ["GET", "/v1/health"],
      ["GET", "/v1/browser"],
      ["POST", "/v1/browser/download"],
      ["PUT", "/v1/browser/local-executable"],
      ["DELETE", "/v1/browser/local-executable"],
      ["GET", "/v1/profiles"],
      ["POST", "/v1/profiles"],
      ["DELETE", `/v1/profiles/${profileId}`],
      ["GET", `/v1/profiles/${profileId}/policy`],
      ["PUT", `/v1/profiles/${profileId}/policy`],
      ["GET", "/v1/sessions"],
      ["POST", "/v1/sessions"],
      ["GET", `/v1/sessions/${sessionId}`],
      ["DELETE", `/v1/sessions/${sessionId}`],
      ["GET", `/v1/sessions/${sessionId}/thumbnail`],
      ["POST", `/v1/sessions/${sessionId}/tasks`],
      ["GET", `/v1/tasks/${taskId}`],
      ["GET", "/v1/tasks"],
      ["GET", `/v1/tasks/${taskId}/steps`],
      ["GET", `/v1/tasks/${researchTask.id}/research`],
      ["POST", `/v1/tasks/${taskId}/cancel`],
      ["POST", `/v1/tasks/${taskId}/approval`],
      ["GET", "/v1/approvals"],
      ["POST", `/v1/sessions/${sessionId}/actions`],
      ["GET", "/v1/providers"],
      ["PUT", "/v1/providers"],
    ];

    expect(stub.calls).toHaveLength(expectedCalls.length);

    for (const [index, expected] of expectedCalls.entries()) {
      const call = stub.calls[index];
      if (call === undefined) {
        throw new Error(`Missing fetch call ${index}.`);
      }

      const url = new URL(String(call.input));
      const headers = new Headers(call.init?.headers);

      expect(call.init?.method).toBe(expected[0]);
      expect(url.origin).toBe("http://127.0.0.1:4321");
      expect(url.pathname).toBe(expected[1]);
      expect(headers.get("Authorization")).toBe(`Bearer ${token}`);
      expect(headers.get("Accept")).toBe(
        url.pathname === `/v1/sessions/${sessionId}/thumbnail`
          ? "image/jpeg"
          : "application/json",
      );
      expect(url.toString()).not.toContain(token);
      expect(String(call.init?.body ?? "")).not.toContain(token);

      if (url.pathname === `/v1/sessions/${sessionId}/tasks`) {
        expect(headers.get("Idempotency-Key")).toBe(idempotencyKey);
      } else {
        expect(headers.get("Idempotency-Key")).toBeNull();
      }

      if (call.init?.body === undefined) {
        expect(headers.get("Content-Type")).toBeNull();
      } else {
        expect(headers.get("Content-Type")).toBe("application/json");
      }
    }

    expect(healthResult).toEqual(health);
    expect(browserResult).toEqual(browserState);
    expect(policyResult).toEqual({ data: profilePolicy });
    expect(savedPolicy).toEqual({ data: profilePolicy });
    expect(providerResult).toEqual(providerConfig);
    expect(savedProvider).toEqual(providerConfig);
    expect(new Uint8Array(await thumbnail.arrayBuffer())).toEqual(thumbnailBytes);
  });

  it("exposes only the documented provider methods", () => {
    const stub = createFetchStub(() =>
      jsonResponse({ data: providerConfig }),
    );
    const client = createClient(stub.fetch);

    expect(Object.keys(client.providers).sort()).toEqual(["get", "set"]);
    expect(Object.keys(client.profiles).sort()).toEqual([
      "create",
      "delete",
      "getPolicy",
      "list",
      "setPolicy",
    ]);
    expect(Object.keys(client).sort()).toEqual([
      "actions",
      "approvals",
      "browser",
      "events",
      "health",
      "profiles",
      "providers",
      "sessions",
      "tasks",
    ]);
  });

  it("allows reactivating a stored provider without an API key", async () => {
    const stub = createFetchStub(() => jsonResponse({ data: providerConfig }));
    const client = createClient(stub.fetch);

    await client.providers.set({
      provider: "gemini",
      model: "gemini-2.5-pro",
    });

    const call = stub.calls[0];
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      provider: "gemini",
      model: "gemini-2.5-pro",
    });
  });

  it("sends JSON bodies only for endpoints that take input", async () => {
    const stub = createFetchStub(({ input, init }) =>
      routeResponse(
        init?.method ?? "GET",
        new URL(String(input)).pathname,
      ),
    );
    const client = createClient(stub.fetch);

    await client.browser.setLocalExecutable("/Applications/Chrome");
    await client.profiles.create({ name: "Profil Kerja" });
    await client.sessions.start({ profileId });
    await client.tasks.create(
      sessionId,
      { goal: "Cari kontak", outputSchema: { email: "string" } },
      { idempotencyKey },
    );
    await client.tasks.resolveApproval(taskId, {
      approve: false,
      reason: "Target salah.",
    });
    await client.actions.run(sessionId, { action: "click", selector: "#submit" });
    await client.providers.set(providerRequest);
    await client.profiles.setPolicy(profileId, profilePolicy);

    const bodies = stub.calls.map((call, index) => {
      const body = call.init?.body;
      if (typeof body !== "string") {
        throw new Error(`Expected a JSON body at call ${index}.`);
      }
      return JSON.parse(body);
    });

    expect(bodies[0]).toEqual({ path: "/Applications/Chrome" });
    expect(bodies[1]).toEqual({ name: "Profil Kerja" });
    expect(bodies[2]).toEqual({ profileId });
    expect(bodies[3]).toEqual({
      goal: "Cari kontak",
      outputSchema: { email: "string" },
    });
    expect(bodies[4]).toEqual({ approve: false, reason: "Target salah." });
    expect(bodies[5]).toEqual({ action: "click", selector: "#submit" });
    expect(bodies[6]).toEqual(providerRequest);
    expect(bodies[7]).toEqual(profilePolicy);
  });

  it("normalizes a trailing slash and forwards pagination only when provided", async () => {
    const stub = createFetchStub(({ input }) => {
      const pathname = new URL(String(input)).pathname;
      return pathname === "/v1/profiles"
        ? jsonResponse(profileList)
        : jsonResponse(sessionList);
    });
    const client = createArgusClient({
      api: { baseUrl: "http://127.0.0.1:4321///", token },
      fetch: stub.fetch,
    });

    await client.profiles.list({ page: 2, page_size: 5 });
    await client.sessions.list({});

    const profileCall = firstCall(stub.calls);
    const sessionCall = stub.calls[1];
    if (sessionCall === undefined) {
      throw new Error("Missing session list call.");
    }

    expect(new URL(String(profileCall.input)).pathname).toBe("/v1/profiles");
    expect(new URL(String(profileCall.input)).search).toBe("?page=2&page_size=5");
    expect(new URL(String(sessionCall.input)).search).toBe("");
  });

  it("validates a task step list and forwards pagination", async () => {
    const stub = createFetchStub(({ input, init }) => {
      expect(init?.method).toBe("GET");
      const url = new URL(String(input));
      expect(url.pathname).toBe(`/v1/tasks/${taskId}/steps`);
      expect(url.search).toBe("?page=2&page_size=5");
      return jsonResponse(agentStepList);
    });
    const client = createClient(stub.fetch);

    const result = await client.tasks.listSteps(taskId, { page: 2, page_size: 5 });
    const headers = new Headers(stub.calls[0]?.init?.headers);

    expect(result).toEqual(agentStepList);
    expect(headers.get("Authorization")).toBe(`Bearer ${token}`);
    expect(headers.get("Accept")).toBe("application/json");
  });

  it("validates the research result of a task", async () => {
    const stub = createFetchStub(({ input, init }) => {
      expect(init?.method).toBe("GET");
      expect(new URL(String(input)).pathname).toBe(
        `/v1/tasks/${researchTask.id}/research`,
      );
      return jsonResponse(researchResult);
    });
    const client = createClient(stub.fetch);

    const result = await client.tasks.getResearch(researchTask.id);

    expect(result).toEqual(researchResult);
  });

  it("rejects a research result with a contact without sourceUrl", async () => {
    const invalid = {
      data: {
        taskId: researchTask.id,
        contacts: [
          {
            id: "c_0000000000000001",
            taskId: researchTask.id,
            type: "email",
            value: "budi@example.test",
            method: "email_text",
            confidence: 0.5,
            verification: "unverified",
          },
        ],
        chain: [],
      },
    };
    const stub = createFetchStub(() => jsonResponse(invalid));
    const client = createClient(stub.fetch);

    const error = requireArgusError(
      await captureError(() => client.tasks.getResearch(researchTask.id)),
    );

    expect(error.status).toBe(200);
    expect(error.message).toBe("Respons Argus tidak valid.");
  });

  it("raises a 409 problem when the task is not a research task", async () => {
    const problem: Problem = {
      type: "about:blank",
      title: "Conflict",
      status: 409,
      detail: "Task ini bukan task riset.",
    };
    const stub = createFetchStub(() => jsonResponse(problem, 409));
    const client = createClient(stub.fetch);

    const error = requireArgusError(
      await captureError(() => client.tasks.getResearch(taskId)),
    );

    expect(error.status).toBe(409);
    expect(error.problem).toEqual(problem);
  });

  it("validates task and approval lists and forwards filters", async () => {
    const stub = createFetchStub(({ input }) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/tasks") {
        expect(url.search).toBe(
          `?page=2&page_size=5&sessionId=${sessionId}&status=queued`,
        );
        return jsonResponse(taskList);
      }
      expect(url.pathname).toBe("/v1/approvals");
      expect(url.search).toBe(
        `?page=3&page_size=10&decision=pending&taskId=${taskId}`,
      );
      return jsonResponse(approvalList);
    });
    const client = createClient(stub.fetch);

    const tasks = await client.tasks.list({
      page: 2,
      page_size: 5,
      sessionId,
      status: "queued",
    });
    const approvals = await client.approvals.list({
      page: 3,
      page_size: 10,
      decision: "pending",
      taskId,
    });

    expect(tasks).toEqual(taskList);
    expect(approvals).toEqual(approvalList);
  });

  it("returns a thumbnail blob and forwards the abort signal", async () => {
    const controller = new AbortController();
    const stub = createFetchStub(({ init }) => {
      expect(init?.signal).toBe(controller.signal);
      return new Response(thumbnailBytes, {
        status: 200,
        headers: { "Content-Type": "image/jpeg; charset=binary" },
      });
    });
    const client = createClient(stub.fetch);

    const blob = await client.sessions.thumbnail(sessionId, {
      signal: controller.signal,
    });

    expect(blob.type).toContain("image/jpeg");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(thumbnailBytes);
  });

  it("rejects a thumbnail response with a wrong content type", async () => {
    const stub = createFetchStub(
      () =>
        new Response(thumbnailBytes, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = createClient(stub.fetch);

    const error = requireArgusError(
      await captureError(() => client.sessions.thumbnail(sessionId)),
    );

    expect(error.status).toBe(200);
    expect(error.problem).toBeNull();
    expect(error.message).toBe("Respons Argus tidak valid.");
  });

  it("rejects an invalid profile policy response", async () => {
    const stub = createFetchStub(() =>
      jsonResponse({
        data: {
          workingHours: { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" },
        },
      }),
    );
    const client = createClient(stub.fetch);

    const error = requireArgusError(
      await captureError(() => client.profiles.getPolicy(profileId)),
    );

    expect(error.status).toBe(200);
    expect(error.message).toBe("Respons Argus tidak valid.");
  });

  it("raises a 404 problem when listing steps for an unknown task", async () => {
    const problem: Problem = {
      type: "about:blank",
      title: "Not Found",
      status: 404,
      detail: "Task tidak ditemukan.",
    };
    const stub = createFetchStub(() => jsonResponse(problem, 404));
    const client = createClient(stub.fetch);

    const error = requireArgusError(
      await captureError(() => client.tasks.listSteps(taskId)),
    );

    expect(error.status).toBe(404);
    expect(error.problem).toEqual(problem);
    expect(error.message).toBe(problem.detail);
  });

  it("rejects an invalid task step list response", async () => {
    const stub = createFetchStub(() =>
      jsonResponse({
        data: [{ id: "st_0000000000000001" }],
        total: 1,
        page: 1,
        page_size: 20,
      }),
    );
    const client = createClient(stub.fetch);

    const error = requireArgusError(
      await captureError(() => client.tasks.listSteps(taskId)),
    );

    expect(error.status).toBe(200);
    expect(error.problem).toBeNull();
    expect(error.message).toBe("Respons Argus tidak valid.");
  });

  it("exposes only the documented task methods", () => {
    const stub = createFetchStub(() => jsonResponse(taskResponse));
    const client = createClient(stub.fetch);

    expect(Object.keys(client.tasks).sort()).toEqual([
      "cancel",
      "create",
      "get",
      "getResearch",
      "list",
      "listSteps",
      "resolveApproval",
    ]);
  });

  it("exposes 27 documented methods", () => {
    const stub = createFetchStub(() => jsonResponse(taskResponse));
    const client = createClient(stub.fetch);
    const methods = [
      client.health,
      ...Object.values(client.browser),
      ...Object.values(client.profiles),
      ...Object.values(client.sessions),
      ...Object.values(client.tasks),
      ...Object.values(client.approvals),
      ...Object.values(client.actions),
      ...Object.values(client.providers),
      ...Object.values(client.events),
    ];

    expect(methods.filter((value) => typeof value === "function")).toHaveLength(27);
  });

  it("does not read a body for 204 responses", async () => {
    const responses = [
      emptyResponse(),
      emptyResponse(),
      emptyResponse(),
    ];
    const jsonSpies = responses.map((response) => vi.spyOn(response, "json"));
    let index = 0;
    const stub = createFetchStub(() => {
      const response = responses[index];
      index += 1;
      if (response === undefined) {
        throw new Error("Unexpected request.");
      }
      return response;
    });
    const client = createClient(stub.fetch);

    await client.browser.clearLocalExecutable();
    await client.profiles.delete(profileId);
    await client.sessions.close(sessionId);

    for (const spy of jsonSpies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

describe("ArgusApiError", () => {
  it("keeps the status and problem detail from a problem response", async () => {
    const problem: Problem = {
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      detail: "Token akses tidak valid.",
    };
    const stub = createFetchStub(() => jsonResponse(problem, 401));
    const client = createClient(stub.fetch);

    const error = requireArgusError(await captureError(() => client.health()));

    expect(error.status).toBe(401);
    expect(error.problem).toEqual(problem);
    expect(error.message).toBe(problem.detail);
    expect(error.message).not.toContain(token);
  });

  it("uses a generic message when the error body is not a problem", async () => {
    const stub = createFetchStub(() =>
      jsonResponse({ unexpected: "shape" }, 500),
    );
    const client = createClient(stub.fetch);

    const error = requireArgusError(await captureError(() => client.health()));

    expect(error.status).toBe(500);
    expect(error.problem).toBeNull();
    expect(error.message).toBe("Layanan Argus menolak permintaan.");
    expect(error.message).not.toContain(token);
  });

  it("rejects a 2xx response that does not match the schema", async () => {
    const stub = createFetchStub(() =>
      jsonResponse({ data: { ok: "yes", chrome: { status: "ready", version: null } } }),
    );
    const client = createClient(stub.fetch);

    const error = requireArgusError(await captureError(() => client.health()));

    expect(error.status).toBe(200);
    expect(error.problem).toBeNull();
    expect(error.message).toBe("Respons Argus tidak valid.");
  });

  it("rejects a 2xx response that is not JSON", async () => {
    const stub = createFetchStub(() => new Response("not-json", { status: 200 }));
    const client = createClient(stub.fetch);

    const error = requireArgusError(await captureError(() => client.health()));

    expect(error.status).toBe(200);
    expect(error.problem).toBeNull();
    expect(error.message).toBe("Respons Argus tidak valid.");
  });

  it("maps a network failure to status 0", async () => {
    const stub = createFetchStub(() => {
      throw new TypeError("fetch failed");
    });
    const client = createClient(stub.fetch);

    const error = requireArgusError(await captureError(() => client.health()));

    expect(error.status).toBe(0);
    expect(error.problem).toBeNull();
    expect(error.message).toBe("Layanan Argus tidak dapat dihubungi.");
    expect(error.message).not.toContain(token);
  });

  it("passes an AbortError through without wrapping it", async () => {
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    const stub = createFetchStub(() => {
      throw abortError;
    });
    const client = createClient(stub.fetch);

    const error = await captureError(() => client.health());

    expect(error).toBe(abortError);
    expect(error instanceof ArgusApiError).toBe(false);
  });
});

describe("events.stream", () => {
  it("parses frames split across chunks with CRLF and multi-line data", async () => {
    const first =
      "id: 10\r\n" +
      "event: step\r\n" +
      "data: {\"taskId\":null,\"action\":\"click\",";
    const second =
      "\"selector\":\"#go\",\"at\":\"" +
      timestamp +
      "\"}\r\n\r\n" +
      "id: 11\n" +
      "event: task.completed\n" +
      `data: {"taskId":"${taskId}",\n` +
      `data: "result":{},"at":"${timestamp}"}\n` +
      "\n";
    const fixture = createSseResponse([first, second]);
    const stub = createFetchStub(() => fixture.response);
    const client = createClient(stub.fetch);
    const controller = new AbortController();

    const items = await readUntilAborted(
      client.events.stream({ signal: controller.signal }),
      controller,
      2,
    );

    expect(items).toEqual([
      {
        id: "10",
        event: {
          type: "step",
          taskId: null,
          action: "click",
          selector: "#go",
          at: timestamp,
        },
      },
      {
        id: "11",
        event: { type: "task.completed", taskId, result: {}, at: timestamp },
      },
    ]);
    expect(fixture.stream.locked).toBe(false);
  });

  it("accepts approval.requested frames with selector, highlight, and category", async () => {
    const payload =
      "id: 12\n" +
      "event: approval.requested\n" +
      `data: {"taskId":"${taskId}","action":"click","target":"#kirim","selector":"#kirim","highlighted":true,"category":"submit_form","at":"${timestamp}"}\n` +
      "\n";
    const fixture = createSseResponse([payload]);
    const stub = createFetchStub(() => fixture.response);
    const client = createClient(stub.fetch);
    const controller = new AbortController();

    const items = await readUntilAborted(
      client.events.stream({ signal: controller.signal }),
      controller,
      1,
    );

    expect(items).toEqual([
      {
        id: "12",
        event: {
          type: "approval.requested",
          taskId,
          action: "click",
          target: "#kirim",
          selector: "#kirim",
          highlighted: true,
          category: "submit_form",
          at: timestamp,
        },
      },
    ]);
  });

  it("skips heartbeats, unknown events, and invalid data", async () => {
    const payload =
      ": ping\n" +
      "\n" +
      "id: 20\n" +
      "event: future.event\n" +
      "data: {\"taskId\":null}\n" +
      "\n" +
      "id: 21\n" +
      "event: step\n" +
      "data: not-json\n" +
      "\n" +
      "id: 22\n" +
      "event: step\n" +
      "data: {\"taskId\":null}\n" +
      "\n" +
      stepFrame("23", "#ok");
    const fixture = createSseResponse([payload]);
    const stub = createFetchStub(() => fixture.response);
    const client = createClient(stub.fetch);
    const controller = new AbortController();

    const items = await readUntilAborted(
      client.events.stream({ signal: controller.signal }),
      controller,
      1,
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("23");
    expect(items[0]?.event.type).toBe("step");
  });

  it("forwards taskId and Last-Event-ID with stream headers", async () => {
    const fixture = createSseResponse([stepFrame("30")]);
    const stub = createFetchStub(() => fixture.response);
    const client = createClient(stub.fetch);
    const controller = new AbortController();

    await readUntilAborted(
      client.events.stream({
        taskId,
        lastEventId: "29",
        signal: controller.signal,
      }),
      controller,
      1,
    );

    const call = firstCall(stub.calls);
    const url = new URL(String(call.input));
    const headers = new Headers(call.init?.headers);

    expect(call.init?.method).toBe("GET");
    expect(url.pathname).toBe("/v1/events");
    expect(url.searchParams.get("taskId")).toBe(taskId);
    expect(headers.get("Authorization")).toBe(`Bearer ${token}`);
    expect(headers.get("Accept")).toBe("text/event-stream");
    expect(headers.get("Last-Event-ID")).toBe("29");
    expect(headers.get("Content-Type")).toBeNull();
    expect(url.toString()).not.toContain(token);
  });

  it("stops cleanly on abort and releases the reader", async () => {
    const fixture = createSseResponse([stepFrame("40")], false);
    const stub = createFetchStub(() => fixture.response);
    const client = createClient(stub.fetch);
    const controller = new AbortController();

    const items = await readUntilAborted(
      client.events.stream({ signal: controller.signal }),
      controller,
      1,
    );

    expect(items).toHaveLength(1);
    expect(fixture.stream.locked).toBe(false);
  });

  it("does not fail when the caller aborts before the stream starts", async () => {
    const stub = createFetchStub(() => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    const client = createClient(stub.fetch);
    const controller = new AbortController();
    controller.abort();

    const result = await readToEnd(
      client.events.stream({ signal: controller.signal }),
    );

    expect(result.items).toHaveLength(0);
    expect(result.error).toBeNull();
  });

  it("reports a dropped connection as status 0", async () => {
    const fixture = createSseResponse([stepFrame("50")]);
    const stub = createFetchStub(() => fixture.response);
    const client = createClient(stub.fetch);

    const result = await readToEnd(client.events.stream());

    expect(result.items).toHaveLength(1);
    const error = requireArgusError(result.error);
    expect(error.status).toBe(0);
    expect(error.problem).toBeNull();
    expect(error.message).toBe("Koneksi event terputus.");
  });

  it("reports a non-2xx stream response as ArgusApiError", async () => {
    const problem: Problem = {
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      detail: "Token akses tidak valid.",
    };
    const stub = createFetchStub(() => jsonResponse(problem, 401));
    const client = createClient(stub.fetch);

    const result = await readToEnd(client.events.stream());

    const error = requireArgusError(result.error);
    expect(result.items).toHaveLength(0);
    expect(error.status).toBe(401);
    expect(error.problem).toEqual(problem);
    expect(error.message).toBe(problem.detail);
  });
});
