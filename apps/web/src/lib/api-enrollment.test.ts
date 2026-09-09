// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { api, mapEnrollment } from "./api";
import { shouldPollEnrollment } from "../components/PairMachineDialog";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("enrollment API decoding", () => {
  it("rejects missing identity, status, or expiry instead of inventing pending state", () => {
    expect(() => mapEnrollment({ status: "created", expiresAt: new Date().toISOString() })).toThrow("不完整");
    expect(() => mapEnrollment({ enrollmentId: "enroll_1", expiresAt: new Date().toISOString() })).toThrow("不完整");
    expect(() => mapEnrollment({ enrollmentId: "enroll_1", status: "created", expiresAt: "not-a-date" })).toThrow("不完整");
  });

  it("rejects an empty successful response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));
    await expect(api.enrollment("enroll_1")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("bounds a hung enrollment poll with a timeout signal", async () => {
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort(new DOMException("timed out", "TimeoutError")));
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    })));
    await expect(api.enrollment("enroll_1")).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("keeps polling after credential redemption until actual readiness, including empty catalogs", () => {
    const base = {
      id: "enroll_1",
      status: "redeemed" as const,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    expect(shouldPollEnrollment({ ...base, machineReady: false })).toBe(true);
    expect(shouldPollEnrollment({ ...base, machineReady: true, projectCount: 1, machineReachability: "online" })).toBe(false);
    expect(shouldPollEnrollment({ ...base, machineReady: true, projectCount: 0, machineReachability: "online" })).toBe(false);
    expect(shouldPollEnrollment({ ...base, machineReady: false, recoveryExpiresAt: "2020-01-01T00:00:00.000Z" })).toBe(true);
  });
});
