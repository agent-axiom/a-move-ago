import { resolveCname } from "node:dns/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const domain = "chess.kosarevsky.dev";
const target = "agent-axiom.github.io";
const pagesUrl = "https://api.github.com/repos/agent-axiom/a-move-ago/pages";
const siteUrl = `https://${domain}/`;

class DomainConnectionError extends Error {}

function ensure(condition, code) {
  if (!condition) throw new DomainConnectionError(code);
}

function canonicalName(value) {
  return typeof value === "string" ? value.toLowerCase().replace(/\.$/, "") : undefined;
}

export function parseDomainPhase(args) {
  if (args.length === 0) return "connect";
  ensure(
    args.length === 2 && args[0] === "--phase" && ["connect", "check-https"].includes(args[1]),
    "INVALID_DOMAIN_ARGUMENTS",
  );
  return args[1];
}

/** Connect only the requested site; the Actions workflow supplies its scoped token. */
export async function connectSiteDomain(
  { token, phase = "connect" } = {},
  { fetch: request = globalThis.fetch, resolveCname: lookup = resolveCname } = {},
) {
  try {
    ensure(["connect", "check-https"].includes(phase), "INVALID_DOMAIN_ARGUMENTS");
    ensure(
      typeof token === "string" && token.length > 0 && !/[\s\p{Cc}]/u.test(token),
      "MISSING_GH_TOKEN",
    );
    let names;
    try {
      names = await lookup(domain);
    } catch {
      throw new DomainConnectionError("DOMAIN_CNAME_NOT_READY");
    }
    ensure(
      Array.isArray(names) && names.length === 1 && canonicalName(names[0]) === target,
      "DOMAIN_CNAME_MISMATCH",
    );

    async function pages(method = "GET", body) {
      let response;
      try {
        response = await request(pagesUrl, {
          method,
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "x-github-api-version": "2022-11-28",
            "user-agent": "a-move-ago-domain-connector",
            ...(body ? { "content-type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new DomainConnectionError("GITHUB_PAGES_REQUEST_FAILED");
      }
      ensure(response.status !== 403, "GITHUB_PAGES_FORBIDDEN");
      ensure(response.status === (method === "GET" ? 200 : 204), "GITHUB_PAGES_HTTP_FAILED");
      if (method !== "GET") return;
      let value;
      try {
        value = await response.json();
      } catch {
        throw new DomainConnectionError("GITHUB_PAGES_JSON_FAILED");
      }
      ensure(value && typeof value === "object" && !Array.isArray(value), "GITHUB_PAGES_INVALID");
      ensure(value.build_type === "workflow", "GITHUB_PAGES_BUILD_TYPE_MISMATCH");
      ensure(
        value.cname === null || canonicalName(value.cname) === domain,
        "GITHUB_PAGES_DOMAIN_CONFLICT",
      );
      ensure(typeof value.https_enforced === "boolean", "GITHUB_PAGES_INVALID");
      return value;
    }

    let site = await pages();
    if (site.cname === null) {
      ensure(phase === "connect", "DOMAIN_NOT_CONNECTED");
      await pages("PUT", { cname: domain });
      site = await pages();
    }
    ensure(canonicalName(site.cname) === domain, "DOMAIN_CONNECT_UNCONFIRMED");
    function summary(status) {
      return {
        domain,
        cname: domain,
        httpsEnforced: site.https_enforced,
        certificate: site.https_certificate?.state === "approved" ? "approved" : "pending",
        phase,
        status,
      };
    }
    function approvedCertificate(value) {
      const certificate = value.https_certificate;
      return (
        certificate?.state === "approved" &&
        Array.isArray(certificate.domains) &&
        certificate.domains.some((name) => canonicalName(name) === domain)
      );
    }
    if (!approvedCertificate(site)) {
      ensure(phase === "connect", "DOMAIN_CERTIFICATE_PENDING");
      return summary("pending-certificate");
    }

    let httpsReady = false;
    try {
      // No GitHub credentials leave the fixed API origin. Fetch verifies TLS normally.
      const response = await request(siteUrl, {
        method: "GET",
        headers: { accept: "text/html" },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
      httpsReady = response.status === 200;
      await response.body?.cancel();
    } catch {
      httpsReady = false;
    }
    if (!httpsReady) {
      ensure(phase === "connect", "DOMAIN_HTTPS_UNAVAILABLE");
      return summary("pending-https");
    }
    if (!site.https_enforced) {
      await pages("PUT", { https_enforced: true });
      site = await pages();
    }
    ensure(
      canonicalName(site.cname) === domain && site.https_enforced && approvedCertificate(site),
      "DOMAIN_HTTPS_UNCONFIRMED",
    );
    return summary("ready");
  } catch (error) {
    throw new DomainConnectionError(
      error instanceof DomainConnectionError ? error.message : "DOMAIN_CONNECTION_FAILED",
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(
      JSON.stringify(
        await connectSiteDomain({
          token: process.env.GH_TOKEN,
          phase: parseDomainPhase(process.argv.slice(2)),
        }),
      ),
    );
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error.message }));
    process.exitCode = 1;
  }
}
