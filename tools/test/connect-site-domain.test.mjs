import assert from "node:assert/strict";
import test from "node:test";
import { connectSiteDomain, parseDomainPhase } from "../scripts/connect-site-domain.mjs";

const domain = "chess.kosarevsky.dev";
const target = "agent-axiom.github.io";
const pagesUrl = "https://api.github.com/repos/agent-axiom/a-move-ago/pages";
const token = "PRIVATE_GH_TOKEN_MUST_NOT_LEAVE_GITHUB";
const privateBody = "PRIVATE_PROVIDER_BODY_MUST_NOT_BE_PRINTED";

function harness({
  cname = null,
  state = "pending",
  enforced = false,
  names = [target],
  status = 200,
  mutate = () => {},
  lookupError,
  apiError,
  httpsError,
  requestError,
  putStatus = 204,
} = {}) {
  const site = {
    cname,
    build_type: "workflow",
    https_enforced: enforced,
    https_certificate: { state, domains: [domain] },
  };
  const requests = [];
  const dnsRequests = [];
  const run = (phase = "connect") =>
    connectSiteDomain(
      { token, phase },
      {
        resolveCname: async (name) => {
          dnsRequests.push(name);
          if (lookupError) throw new Error(`${token} ${privateBody}`);
          return names;
        },
        fetch: async (url, init) => {
          requests.push({ url, ...init });
          assert.equal(init.redirect, "error");
          assert.equal(init.cache, "no-store");
          assert.ok(init.signal instanceof AbortSignal);
          if (url === `https://${domain}/`) {
            assert.equal(init.headers.authorization, undefined);
            if (httpsError) throw new Error(`${token} ${privateBody}`);
            return new Response("site", { status });
          }
          assert.equal(url, pagesUrl);
          assert.equal(init.headers.authorization, `Bearer ${token}`);
          if (requestError) throw new Error(`${token} ${privateBody}`);
          if (apiError) return new Response(privateBody, { status: apiError });
          if (init.method === "PUT") {
            const body = JSON.parse(init.body);
            assert.equal(Object.keys(body).length, 1);
            Object.assign(site, body);
            mutate(site, init);
            return new Response(null, { status: putStatus });
          }
          mutate(site, init);
          return Response.json(site);
        },
      },
    );
  return { run, requests, dnsRequests, site };
}

function puts(h) {
  return h.requests
    .filter((request) => request.method === "PUT")
    .map((request) => JSON.parse(request.body));
}

test("connects the exact DNS-backed domain and returns pending certificate without waiting", async () => {
  const h = harness();
  assert.deepEqual(await h.run(), {
    domain,
    cname: domain,
    httpsEnforced: false,
    certificate: "pending",
    phase: "connect",
    status: "pending-certificate",
  });
  assert.deepEqual(h.dnsRequests, [domain]);
  assert.deepEqual(puts(h), [{ cname: domain }]);
  assert.deepEqual(
    h.requests.map((request) => request.method),
    ["GET", "PUT", "GET"],
  );
});

test("DNS comparison allows DNS case and a single terminal dot", async () => {
  const h = harness({ names: ["AGENT-AXIOM.GITHUB.IO."] });
  assert.equal((await h.run()).status, "pending-certificate");
});

test("missing, A-only, wildcard, multiple, and mismatched CNAME records never contact GitHub", async (t) => {
  for (const options of [
    { lookupError: true },
    { names: [] },
    { names: ["*.github.io"] },
    { names: ["agent-axiom.github.io.evil.test"] },
    { names: [" agent-axiom.github.io"] },
    { names: ["agent-axiom.github.io.."] },
    { names: [target, "other.github.io"] },
  ])
    await t.test(JSON.stringify(options), async () => {
      const h = harness(options);
      await assert.rejects(h.run, /DOMAIN_CNAME_/);
      assert.equal(h.requests.length, 0);
    });
});

test("never replaces another custom domain or changes the build mode", async (t) => {
  for (const options of [
    { cname: "other.example.test" },
    {
      mutate: (site) => {
        site.build_type = "legacy";
      },
    },
  ]) {
    await t.test("refuses conflicting Pages settings", async () => {
      const h = harness(options);
      await assert.rejects(h.run, /GITHUB_PAGES_(DOMAIN_CONFLICT|BUILD_TYPE_MISMATCH)/);
      assert.deepEqual(puts(h), []);
    });
  }
});

test("enables HTTPS only after approved matching certificate and a verified HTTPS 200", async () => {
  const h = harness({ cname: domain, state: "approved" });
  assert.deepEqual(await h.run("check-https"), {
    domain,
    cname: domain,
    httpsEnforced: true,
    certificate: "approved",
    phase: "check-https",
    status: "ready",
  });
  assert.deepEqual(puts(h), [{ https_enforced: true }]);
  assert.deepEqual(
    h.requests.map((request) => request.url),
    [pagesUrl, `https://${domain}/`, pagesUrl, pagesUrl],
  );
  assert.equal(JSON.stringify(h.requests.at(1)).includes(token), false);
});

test("an already enforced valid domain is idempotent", async () => {
  const h = harness({ cname: "CHESS.KOSAREVSKY.DEV.", state: "approved", enforced: true });
  assert.equal((await h.run()).status, "ready");
  assert.deepEqual(puts(h), []);
});

test("pending, unrelated, or unverified certificates cannot enable HTTPS", async (t) => {
  for (const options of [
    { state: "issued" },
    { state: "error-with-private-provider-details" },
    {
      state: "approved",
      mutate: (site) => {
        site.https_certificate.domains = ["other.example.test"];
      },
    },
    { state: "approved", httpsError: true },
    { state: "approved", status: 404 },
    { state: "approved", status: 301 },
  ])
    await t.test("requires both certificate approval and live TLS", async () => {
      const h = harness({ cname: domain, ...options });
      const summary = await h.run();
      assert.match(summary.status, /^pending-/);
      assert.equal(JSON.stringify(summary).includes("private-provider-details"), false);
      assert.deepEqual(puts(h), []);
      await assert.rejects(
        () => h.run("check-https"),
        /DOMAIN_(CERTIFICATE_PENDING|HTTPS_UNAVAILABLE)/,
      );
      assert.deepEqual(puts(h), []);
    });
});

test("the check phase cannot configure a missing custom domain", async () => {
  const h = harness();
  await assert.rejects(() => h.run("check-https"), /DOMAIN_NOT_CONNECTED/);
  assert.deepEqual(puts(h), []);
});

test("forbidden and provider errors are sanitized without reading or returning their bodies", async (t) => {
  for (const status of [403, 401, 422, 500])
    await t.test(String(status), async () => {
      const h = harness({ apiError: status });
      await assert.rejects(h.run, (error) => {
        assert.match(error.message, /^GITHUB_PAGES_(FORBIDDEN|HTTP_FAILED)$/);
        assert.equal(error.message.includes(token), false);
        assert.equal(error.message.includes(privateBody), false);
        return true;
      });
      assert.deepEqual(puts(h), []);
    });
});

test("request failures cannot expose credentials or provider details", async () => {
  const h = harness({ requestError: true });
  await assert.rejects(h.run, (error) => {
    assert.equal(error.message, "GITHUB_PAGES_REQUEST_FAILED");
    assert.equal(error.message.includes(token), false);
    assert.equal(error.message.includes(privateBody), false);
    return true;
  });
});

test("only the documented 204 mutation response is accepted", async () => {
  const h = harness({ putStatus: 200 });
  await assert.rejects(h.run, /GITHUB_PAGES_HTTP_FAILED/);
  assert.deepEqual(
    h.requests.map((request) => request.method),
    ["GET", "PUT"],
  );
});

test("HTTPS enforcement must be confirmed after its write", async () => {
  const h = harness({
    cname: domain,
    state: "approved",
    mutate: (site, init) => {
      if (init.method === "PUT") site.https_enforced = false;
    },
  });
  await assert.rejects(() => h.run("check-https"), /DOMAIN_HTTPS_UNCONFIRMED/);
  assert.deepEqual(puts(h), [{ https_enforced: true }]);
});

test("a write must be confirmed by a fresh Pages read", async () => {
  const h = harness({
    mutate: (site, init) => {
      if (init.method === "PUT") site.cname = null;
    },
  });
  await assert.rejects(h.run, /DOMAIN_CONNECT_UNCONFIRMED/);
  assert.deepEqual(puts(h), [{ cname: domain }]);
});

test("only fixed supported phases and a token are accepted before DNS or HTTP", async () => {
  assert.equal(parseDomainPhase([]), "connect");
  assert.equal(parseDomainPhase(["--phase", "check-https"]), "check-https");
  assert.throws(() => parseDomainPhase(["--url", "https://evil.test"]), /INVALID_DOMAIN_ARGUMENTS/);
  let touched = false;
  const dependencies = {
    resolveCname: async () => {
      touched = true;
    },
    fetch: async () => {
      touched = true;
    },
  };
  await assert.rejects(
    () => connectSiteDomain({ phase: "delete", token }, dependencies),
    /INVALID_DOMAIN_ARGUMENTS/,
  );
  await assert.rejects(() => connectSiteDomain({}, dependencies), /MISSING_GH_TOKEN/);
  assert.equal(touched, false);
});
