/**
 * MC_TRUST_PROXY: whether `X-Forwarded-For` may decide the client address the
 * auth lockout and rate limits key on.
 *
 * The header is only trustworthy when every connection comes from the proxy
 * that wrote it. `true` therefore needs a loopback bind (the proxy runs on the
 * same host); a proxy elsewhere is named by address or CIDR, so a direct
 * connection from anyone else cannot forge it.
 */
export interface TrustProxyResolution {
  trustProxy: boolean | string[];
  error?: string;
}

const LOOPBACK_BINDS = new Set(["127.0.0.1", "::1", "localhost"]);
const PROXY_ENTRY =
  /^(?:loopback|linklocal|uniquelocal|(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]*:[0-9a-f:.]*)(?:\/\d{1,3})?)$/i;

export function resolveTrustProxy(raw: string | undefined, bindHost: string): TrustProxyResolution {
  const value = raw?.trim() ?? "";
  if (value === "" || value.toLowerCase() === "false") return { trustProxy: false };

  if (value.toLowerCase() === "true") {
    if (LOOPBACK_BINDS.has(bindHost) || /^127\./.test(bindHost)) return { trustProxy: true };
    return {
      trustProxy: false,
      error:
        `MC_TRUST_PROXY=true needs MC_BIND_HOST on loopback (it is ${bindHost}): with the port ` +
        `reachable directly, anyone could forge X-Forwarded-For and dodge the lockout. ` +
        `Bind to 127.0.0.1 behind a local proxy, or list the proxy addresses ` +
        `(MC_TRUST_PROXY=10.0.0.5,192.168.1.0/24).`,
    };
  }

  const entries = value.split(",").map((e) => e.trim()).filter((e) => e !== "");
  if (entries.length === 0 || !entries.every((e) => PROXY_ENTRY.test(e))) {
    return {
      trustProxy: false,
      error:
        `MC_TRUST_PROXY must be true, false, or a comma-separated list of proxy addresses or CIDRs ` +
        `(got ${JSON.stringify(value)}).`,
    };
  }
  return { trustProxy: entries };
}
