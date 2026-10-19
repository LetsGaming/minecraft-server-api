import { describe, it, expect } from "vitest";
import { resolveTrustProxy } from "../../src/config/trustProxy.js";

describe("resolveTrustProxy", () => {
  it.each([undefined, "", "false", "  "])("is off for %j", (raw) => {
    expect(resolveTrustProxy(raw, "0.0.0.0")).toEqual({ trustProxy: false });
  });

  it.each(["127.0.0.1", "::1", "localhost", "127.0.0.2"])("trusts true on loopback bind %s", (host) => {
    expect(resolveTrustProxy("true", host)).toEqual({ trustProxy: true });
  });

  it.each(["0.0.0.0", "::", "192.168.1.10"])("refuses true on the non-loopback bind %s", (host) => {
    const res = resolveTrustProxy("true", host);
    expect(res.trustProxy).toBe(false);
    expect(res.error).toMatch(/loopback/);
  });

  it("accepts named proxies on any bind", () => {
    expect(resolveTrustProxy("10.0.0.5, 192.168.1.0/24,fd00::/8", "0.0.0.0")).toEqual({
      trustProxy: ["10.0.0.5", "192.168.1.0/24", "fd00::/8"],
    });
    expect(resolveTrustProxy("loopback", "0.0.0.0")).toEqual({ trustProxy: ["loopback"] });
  });

  it.each(["1", "yes", "10.0.0.5;rm", "a b"])("rejects %j", (raw) => {
    expect(resolveTrustProxy(raw, "127.0.0.1").error).toBeDefined();
  });
});
