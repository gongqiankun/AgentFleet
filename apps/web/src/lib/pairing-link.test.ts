import { describe, expect, it } from "vitest";
import { readPairingLink, removePairingCode } from "./pairing-link";

describe("pairing link", () => {
  it("normalizes generated codes on the pairing route", () => {
    expect(readPairingLink("/pair", "?code=abcd-efgh")).toEqual({
      hadCodeParameter: true,
      code: "ABCD-EFGH",
    });
    expect(readPairingLink("/pair/", "?code=23456789")).toEqual({
      hadCodeParameter: true,
      code: "2345-6789",
    });
  });

  it("does not auto-open for malformed, ambiguous, or unrelated links", () => {
    expect(readPairingLink("/pair", "?code=ABCI-EFGH")).toEqual({ hadCodeParameter: true });
    expect(readPairingLink("/pair", "?code=ABCD-EFGH&code=JKLM-NPQR")).toEqual({ hadCodeParameter: true });
    expect(readPairingLink("/", "?code=ABCD-EFGH")).toEqual({ hadCodeParameter: true });
  });

  it("removes the consumed code without discarding other URL state", () => {
    expect(removePairingCode("https://fleet.example/pair?code=ABCD-EFGH&from=terminal#verify"))
      .toBe("/pair?from=terminal#verify");
  });
});
