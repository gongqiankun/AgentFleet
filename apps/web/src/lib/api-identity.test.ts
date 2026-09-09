// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => vi.unstubAllGlobals());

it("does not invent an account address when authenticated user data omits it", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(
    url.endsWith("/api/auth/status") ? { authenticated: true, user: { userId: "test-user" } } : {},
  ), { status: 200, headers: { "Content-Type": "application/json" } })));
  const { user } = await api.dashboard();
  expect(user.email).toBe("");
  expect(user.displayName).toBe("Admin");
});

it("uses only the account address returned by the authenticated API", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(
    url.endsWith("/api/auth/status") ? { authenticated: true, user: { userId: "test-user", email: "owner@example.com" } } : {},
  ), { status: 200, headers: { "Content-Type": "application/json" } })));
  expect((await api.dashboard()).user.email).toBe("owner@example.com");
});
