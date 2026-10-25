import { describe, expect, it } from "vitest";
import { createApp } from "./app";

const token = "test-token";
const allowedOrigin = "http://127.0.0.1:5173";
const app = createApp({ token, allowedOrigin });

describe("GET /v1/health", () => {
  it("rejects a request without a bearer token", async () => {
    const response = await app.request("/v1/health");

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    await expect(response.json()).resolves.toEqual({
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      detail: "Token akses tidak valid.",
    });
  });

  it("rejects a request with a wrong bearer token", async () => {
    const response = await app.request("/v1/health", {
      headers: { Authorization: "Bearer wrong-token" },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
  });

  it("returns ok for the expected bearer token", async () => {
    const response = await app.request("/v1/health", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { ok: true } });
  });

  it("allows CORS only for the UI origin", async () => {
    const allowed = await app.request("/v1/health", {
      headers: { Authorization: `Bearer ${token}`, Origin: allowedOrigin },
    });
    const foreign = await app.request("/v1/health", {
      headers: { Authorization: `Bearer ${token}`, Origin: "https://example.com" },
    });

    expect(allowed.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers preflight for the UI origin without a token", async () => {
    const response = await app.request("/v1/health", {
      method: "OPTIONS",
      headers: {
        Origin: allowedOrigin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
    expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
  });
});
