import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyNetworkPolicyEnvironment,
  captureInheritedProxyEnvironment,
  loadNetworkPolicy,
  networkPolicyProxySecrets,
  networkProviderEnvironment,
  networkProxyForTarget,
  parseNetworkProxySettings,
  reconstructChildEnvironment,
  restoreBunSandboxEnvironment,
  resolveNetworkPolicy,
  withTemporaryNetworkPolicyEnvironment,
} from "./network-policy";

const invalidError = (field: "settings" | "all" | "llm" | "search") => ({
  code: "NETWORK_PROXY_INVALID" as const,
  field,
});

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("configured network proxy parsing", () => {
  it("normalizes IPv6 origins and default ports while pruning empty values", () => {
    const settings = {
      httpProxy: "  HTTP://[2001:db8::1]:80/  ",
      easyresearch: {
        network: {
          llmProxy: "\t",
          searchProxy: "https://Proxy.Example:443/",
        },
      },
    };
    const original = structuredClone(settings);

    const parsed = parseNetworkProxySettings(settings);

    expect(parsed.configured).toEqual({
      all: "http://[2001:db8::1]",
      search: "https://proxy.example",
    });
    expect(parsed.errors).toEqual([]);
    expect(settings).toEqual(original);
  });

  it("accepts non-default IPv6 ports", () => {
    expect(parseNetworkProxySettings({
      easyresearch: { network: { llmProxy: "https://[::1]:8443" } },
    }).configured).toEqual({ llm: "https://[::1]:8443" });
  });

  it.each([
    ["a non-string", 42],
    ["a malformed URL", "not a URL"],
    ["a missing host", "http://"],
    ["a non-HTTP scheme", "socks5://proxy.example:1080"],
    ["credentials", "http://user:secret@proxy.example"],
    ["empty userinfo", "http://@proxy.example"],
    ["a non-root path", "http://proxy.example/tunnel"],
    ["a query", "http://proxy.example?mode=tunnel"],
    ["an empty query", "http://proxy.example?"],
    ["a fragment", "http://proxy.example#tunnel"],
  ])("rejects %s", (_label, httpProxy) => {
    const parsed = parseNetworkProxySettings({ httpProxy });

    expect(parsed.configured).toEqual({});
    expect(parsed.errors).toEqual([invalidError("all")]);
  });

  it("returns every invalid field in stable field order", () => {
    const parsed = parseNetworkProxySettings({
      httpProxy: "ftp://all.example",
      easyresearch: {
        network: {
          llmProxy: false,
          searchProxy: "https://search.example/path",
        },
      },
    });

    expect(parsed.errors).toEqual([
      invalidError("all"),
      invalidError("llm"),
      invalidError("search"),
    ]);
  });

  it.each([
    { settings: null },
    { settings: [] },
    { settings: { easyresearch: null } },
    { settings: { easyresearch: [] } },
    { settings: { easyresearch: { network: null } } },
    { settings: { easyresearch: { network: [] } } },
  ])("reports a malformed settings ancestor once for $settings", ({ settings }) => {
    expect(parseNetworkProxySettings(settings).errors).toEqual([invalidError("settings")]);
  });

  it("orders an ancestor error before an independently invalid top-level field", () => {
    expect(parseNetworkProxySettings({
      httpProxy: [],
      easyresearch: { network: [] },
    }).errors).toEqual([
      invalidError("settings"),
      invalidError("all"),
    ]);
  });

  it("produces a canonical configured-only fingerprint", () => {
    const first = parseNetworkProxySettings({
      unrelated: "first",
      httpProxy: "HTTP://PROXY.EXAMPLE:80/",
      easyresearch: { network: { searchProxy: "  ", llmProxy: "https://llm.example:443" } },
    });
    const equivalent = parseNetworkProxySettings({
      easyresearch: { network: { llmProxy: "https://llm.example" } },
      httpProxy: "http://proxy.example",
      unrelated: "second",
    });
    const changed = parseNetworkProxySettings({
      httpProxy: "http://proxy.example",
      easyresearch: { network: { llmProxy: "https://other.example" } },
    });

    expect(first.configuredFingerprint).toBe(equivalent.configuredFingerprint);
    expect(changed.configuredFingerprint).not.toBe(first.configuredFingerprint);
    expect(first.configuredFingerprint).not.toContain("proxy.example");
  });
});

describe("inherited proxy resolution", () => {
  it("uses lowercase before uppercase and HTTPS before ALL before HTTP", () => {
    const cases = [
      {
        env: {
          https_proxy: "https://lower-https.example",
          HTTPS_PROXY: "https://upper-https.example",
          all_proxy: "http://lower-all.example",
          ALL_PROXY: "http://upper-all.example",
          http_proxy: "http://lower-http.example",
          HTTP_PROXY: "http://upper-http.example",
        },
        expected: "https://lower-https.example",
      },
      {
        env: {
          https_proxy: "",
          HTTPS_PROXY: "  ",
          all_proxy: "http://lower-all.example",
          ALL_PROXY: "http://upper-all.example",
          http_proxy: "http://lower-http.example",
        },
        expected: "http://lower-all.example",
      },
      {
        env: {
          ALL_PROXY: "",
          http_proxy: "http://lower-http.example",
          HTTP_PROXY: "http://upper-http.example",
        },
        expected: "http://lower-http.example",
      },
      {
        env: {
          https_proxy: "",
          HTTPS_PROXY: "https://upper-https.example",
        },
        expected: "https://upper-https.example",
      },
    ];

    for (const { env, expected } of cases) {
      const baseline = captureInheritedProxyEnvironment(env);
      const policy = resolveNetworkPolicy(parseNetworkProxySettings({}), baseline);
      expect(networkProxyForTarget(policy, "all", "https:")).toBe(expected);
      expect(networkProxyForTarget(policy, "llm", "https:")).toBe(expected);
      expect(networkProxyForTarget(policy, "search", "https:")).toBe(expected);
      expect(policy.sources).toEqual({ all: "environment", llm: "environment", search: "environment" });
    }
  });

  it("captures both cases without retaining unrelated environment values or mutating input", () => {
    const env = {
      HTTP_PROXY: "http://upper-http.example",
      http_proxy: "http://lower-http.example",
      HTTPS_PROXY: "https://upper-https.example",
      https_proxy: "https://lower-https.example",
      ALL_PROXY: "http://upper-all.example",
      all_proxy: "http://lower-all.example",
      NO_PROXY: "upper.internal",
      no_proxy: "lower.internal",
      PIP_PROXY: "http://pip-user:pip-secret@pip.example",
      PATH: "/bin",
    };
    const original = { ...env };

    const baseline = captureInheritedProxyEnvironment(env);

    expect(baseline.values).toEqual({
      HTTP_PROXY: "http://upper-http.example",
      http_proxy: "http://lower-http.example",
      HTTPS_PROXY: "https://upper-https.example",
      https_proxy: "https://lower-https.example",
      ALL_PROXY: "http://upper-all.example",
      all_proxy: "http://lower-all.example",
      NO_PROXY: "upper.internal",
      no_proxy: "lower.internal",
      PIP_PROXY: "http://pip-user:pip-secret@pip.example",
    });
    expect(env).toEqual(original);
  });

  it("resolves category overrides before All traffic and inherited routes", () => {
    const parsed = parseNetworkProxySettings({
      httpProxy: "http://all.example:8080",
      easyresearch: { network: { llmProxy: "https://llm.example:8443" } },
    });
    const baseline = captureInheritedProxyEnvironment({ HTTPS_PROXY: "http://inherited.example" });

    const policy = resolveNetworkPolicy(parsed, baseline);

    expect(networkProxyForTarget(policy, "all", "https:")).toBe("http://all.example:8080");
    expect(networkProxyForTarget(policy, "llm", "https:")).toBe("https://llm.example:8443");
    expect(networkProxyForTarget(policy, "search", "https:")).toBe("http://all.example:8080");
    expect(policy.sources).toEqual({ all: "configured", llm: "configured", search: "all" });
  });

  it("classifies missing routes as direct without placing inherited URLs in source metadata", () => {
    const direct = resolveNetworkPolicy(
      parseNetworkProxySettings({}),
      captureInheritedProxyEnvironment({}),
    );
    expect(networkProxyForTarget(direct, "all", "http:")).toBeUndefined();
    expect(networkProxyForTarget(direct, "all", "https:")).toBeUndefined();
    expect(direct.sources).toEqual({ all: "direct", llm: "direct", search: "direct" });

    const inheritedUrl = "http://private-user:private-secret@inherited.example";
    const inherited = resolveNetworkPolicy(
      parseNetworkProxySettings({}),
      captureInheritedProxyEnvironment({ HTTPS_PROXY: inheritedUrl }),
    );
    expect(inherited.sources).toEqual({ all: "environment", llm: "environment", search: "environment" });
    expect(JSON.stringify(inherited.sources)).not.toContain(inheritedUrl);
    expect(inherited.configuredFingerprint).not.toContain(inheritedUrl);
  });
});

describe("proxy bypass policy", () => {
  it("removes inherited wildcards for explicit configuration while preserving and deduplicating specifics", () => {
    const parsed = parseNetworkProxySettings({
      easyresearch: { network: { searchProxy: "http://search.example:8080" } },
    });
    const baseline = captureInheritedProxyEnvironment({
      no_proxy: "corp.example, api.internal 127.0.0.1",
      NO_PROXY: "*,corp.example,LOCALHOST,*",
    });

    expect(resolveNetworkPolicy(parsed, baseline).bypass).toBe(
      "corp.example,api.internal,127.0.0.1,localhost,::1",
    );
  });

  it("preserves inherited wildcard semantics when no product proxy is configured", () => {
    const policy = resolveNetworkPolicy(
      parseNetworkProxySettings({}),
      captureInheritedProxyEnvironment({ no_proxy: "*,corp.example,*" }),
    );

    expect(policy.bypass).toBe("*,corp.example,localhost,127.0.0.1,::1");
  });

  it("keeps normalized public matching while exporting Bun's loopback spellings", () => {
    const baseline = captureInheritedProxyEnvironment({ NO_PROXY: "corp.example" });
    const policy = resolveNetworkPolicy(
      parseNetworkProxySettings({ httpProxy: "http://proxy.example:8080" }),
      baseline,
    );
    const processEnvironment: Record<string, string | undefined> = {};

    applyNetworkPolicyEnvironment(policy, baseline, processEnvironment);

    expect(policy.bypass).toBe("corp.example,localhost,127.0.0.1,::1");
    expect(processEnvironment.NO_PROXY).toBe(
      "corp.example,localhost,127.0.0.1,::1,localhost.,[::1]",
    );
    expect(processEnvironment.no_proxy).toBe(processEnvironment.NO_PROXY);
    expect(processEnvironment.PLAYWRIGHT_MCP_PROXY_BYPASS).toBe(processEnvironment.NO_PROXY);
    expect(networkProviderEnvironment(policy, "llm").NO_PROXY).toBe(processEnvironment.NO_PROXY);
  });

  it("genuinely bypasses an explicit proxy for a local IPv6 request under Bun 1.4", async () => {
    const listen = (server: Server, host: string): Promise<number> => new Promise((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(0, host, () => {
        server.off("error", onError);
        resolve((server.address() as AddressInfo).port);
      });
    });
    const close = (server: Server): Promise<void> => new Promise((resolve) => {
      server.closeAllConnections();
      server.close();
      resolve();
    });
    let targetRequests = 0;
    const target = createServer((_request, response) => {
      targetRequests += 1;
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("ipv6-direct");
    });
    let targetPort: number;
    try {
      targetPort = await listen(target, "::1");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EAFNOSUPPORT" || code === "EADDRNOTAVAIL" || code === "EPROTONOSUPPORT") {
        return;
      }
      throw error;
    }

    let proxyRequests = 0;
    const proxy = createServer((_request, response) => {
      proxyRequests += 1;
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("proxy-used");
    });
    const proxyPort = await listen(proxy, "127.0.0.1");
    try {
      const baseline = captureInheritedProxyEnvironment({});
      const policy = resolveNetworkPolicy(
        parseNetworkProxySettings({ httpProxy: `http://127.0.0.1:${proxyPort}` }),
        baseline,
      );
      const childEnvironment: Record<string, string | undefined> = { ...process.env };
      applyNetworkPolicyEnvironment(policy, baseline, childEnvironment);

      const child = spawn("bun", [
        "-e",
        `const response = await fetch("http://[::1]:${targetPort}/"); console.log(await response.text());`,
      ], {
        env: childEnvironment,
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => { stdout += chunk; });
      child.stderr?.on("data", (chunk) => { stderr += chunk; });
      const status = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });

      expect(status, stderr).toBe(0);
      expect(stdout.trim()).toBe("ipv6-direct");
      expect(targetRequests).toBe(1);
      expect(proxyRequests).toBe(0);
    } finally {
      await Promise.all([close(proxy), close(target)]);
    }
  });

  it("genuinely bypasses an explicit proxy for Bun's localhost-dot hostname", async () => {
    const listen = (server: Server, host: string): Promise<number> => new Promise((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(0, host, () => {
        server.off("error", onError);
        resolve((server.address() as AddressInfo).port);
      });
    });
    const close = (server: Server): void => {
      server.closeAllConnections();
      server.close();
    };
    let targetRequests = 0;
    const target = createServer((_request, response) => {
      targetRequests += 1;
      response.writeHead(200, { "Content-Type": "text/plain", Connection: "close" });
      response.end("localhost-dot-direct");
    });
    const targetPort = await listen(target, "127.0.0.1");
    let proxyRequests = 0;
    const proxy = createServer((_request, response) => {
      proxyRequests += 1;
      response.writeHead(200, { "Content-Type": "text/plain", Connection: "close" });
      response.end("proxy-used");
    });
    const proxyPort = await listen(proxy, "127.0.0.1");
    try {
      const baseline = captureInheritedProxyEnvironment({});
      const policy = resolveNetworkPolicy(
        parseNetworkProxySettings({ httpProxy: `http://127.0.0.1:${proxyPort}` }),
        baseline,
      );
      const childEnvironment: Record<string, string | undefined> = { ...process.env };
      applyNetworkPolicyEnvironment(policy, baseline, childEnvironment);

      const child = spawn("bun", [
        "-e",
        `const response = await fetch("http://localhost.:${targetPort}/", { signal: AbortSignal.timeout(2000) }); console.log(await response.text());`,
      ], { env: childEnvironment });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => { stdout += chunk; });
      child.stderr?.on("data", (chunk) => { stderr += chunk; });
      const status = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });

      expect(status, stderr).toBe(0);
      expect(stdout.trim()).toBe("localhost-dot-direct");
      expect(targetRequests).toBe(1);
      expect(proxyRequests).toBe(0);
    } finally {
      close(proxy);
      close(target);
    }
  });

  it("genuinely preserves Bun IPv6 loopback recovery when All traffic is malformed", async () => {
    const target = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/plain", Connection: "close" });
      response.end("malformed-ipv6-direct");
    });
    let targetPort: number;
    try {
      targetPort = await new Promise((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        target.once("error", onError);
        target.listen(0, "::1", () => {
          target.off("error", onError);
          resolve((target.address() as AddressInfo).port);
        });
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EAFNOSUPPORT" || code === "EADDRNOTAVAIL" || code === "EPROTONOSUPPORT") return;
      throw error;
    }
    try {
      const baseline = captureInheritedProxyEnvironment({ NO_PROXY: "*,corp.internal" });
      const policy = resolveNetworkPolicy(
        parseNetworkProxySettings({ httpProxy: "malformed" }),
        baseline,
      );
      const childEnvironment: Record<string, string | undefined> = { ...process.env };
      applyNetworkPolicyEnvironment(policy, baseline, childEnvironment);

      const child = spawn("bun", [
        "-e",
        `const response = await fetch("http://[::1]:${targetPort}/", { signal: AbortSignal.timeout(2000) }); console.log(await response.text());`,
      ], { env: childEnvironment });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => { stdout += chunk; });
      child.stderr?.on("data", (chunk) => { stderr += chunk; });
      const status = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });

      expect(status, stderr).toBe(0);
      expect(stdout.trim()).toBe("malformed-ipv6-direct");
    } finally {
      target.closeAllConnections();
      target.close();
    }
  });
});

describe("network policy environment application", () => {
  it("applies All traffic to standard variables and Search to Playwright", () => {
    const baseline = captureInheritedProxyEnvironment({
      HTTPS_PROXY: "http://inherited.example",
      NO_PROXY: "corp.example",
    });
    const policy = resolveNetworkPolicy(parseNetworkProxySettings({
      httpProxy: "http://all.example:8080",
      easyresearch: { network: { searchProxy: "https://search.example:8443" } },
    }), baseline);
    const target: Record<string, string | undefined> = {
      HTTP_PROXY: "http://old-applied.example",
      PLAYWRIGHT_MCP_PROXY_SERVER: "http://old-search.example",
      KEEP: "yes",
    };

    applyNetworkPolicyEnvironment(policy, baseline, target);

    for (const key of [
      "HTTP_PROXY",
      "http_proxy",
      "HTTPS_PROXY",
      "https_proxy",
      "ALL_PROXY",
      "all_proxy",
    ]) {
      expect(target[key]).toBe("http://all.example:8080");
    }
    expect(target.NO_PROXY).toBe(
      "corp.example,localhost,127.0.0.1,::1,localhost.,[::1]",
    );
    expect(target.no_proxy).toBe(target.NO_PROXY);
    expect(target.PLAYWRIGHT_MCP_PROXY_SERVER).toBe("https://search.example:8443");
    expect(target.PLAYWRIGHT_MCP_PROXY_BYPASS).toBe(target.NO_PROXY);
    expect(target.KEEP).toBe("yes");
  });

  it("overrides inherited npm proxy configuration in both case variants when All traffic is explicit", () => {
    const inheritedNpm = {
      npm_config_proxy: "http://ambient-lower-proxy.example",
      NPM_CONFIG_PROXY: "http://ambient-upper-proxy.example",
      npm_config_https_proxy: "http://ambient-lower-https.example",
      NPM_CONFIG_HTTPS_PROXY: "http://ambient-upper-https.example",
      npm_config_noproxy: "ambient.lower.internal",
      NPM_CONFIG_NOPROXY: "ambient.upper.internal",
    };
    const baseline = captureInheritedProxyEnvironment(inheritedNpm);
    const policy = resolveNetworkPolicy(
      parseNetworkProxySettings({ httpProxy: "http://all.example:8080" }),
      baseline,
    );
    const target: Record<string, string | undefined> = { ...inheritedNpm };

    applyNetworkPolicyEnvironment(policy, baseline, target);

    for (const key of [
      "npm_config_proxy",
      "NPM_CONFIG_PROXY",
      "npm_config_https_proxy",
      "NPM_CONFIG_HTTPS_PROXY",
    ]) {
      expect(target[key]).toBe("http://all.example:8080");
    }
    for (const key of ["npm_config_noproxy", "NPM_CONFIG_NOPROXY"]) {
      expect(target[key]).toBe("localhost,127.0.0.1,::1,localhost.,[::1]");
    }
  });

  it("overrides pip's dedicated ambient proxy when All traffic is explicit", () => {
    const baseline = captureInheritedProxyEnvironment({
      PIP_PROXY: "http://ambient-user:ambient-secret@pip.example:8080",
    });
    const policy = resolveNetworkPolicy(
      parseNetworkProxySettings({ httpProxy: "http://all.example:7890" }),
      baseline,
    );
    const target: Record<string, string | undefined> = {
      PIP_PROXY: "http://old-applied.example",
    };

    applyNetworkPolicyEnvironment(policy, baseline, target);

    expect(target.PIP_PROXY).toBe("http://all.example:7890");
  });

  it("preserves ambient npm proxy behavior exactly when All traffic is absent", () => {
    const inheritedNpm = {
      npm_config_proxy: "http://ambient-lower-proxy.example",
      NPM_CONFIG_HTTPS_PROXY: "http://ambient-upper-https.example",
      npm_config_noproxy: "ambient.lower.internal",
      NPM_CONFIG_NOPROXY: "ambient.upper.internal",
    };
    const baseline = captureInheritedProxyEnvironment(inheritedNpm);
    const policy = resolveNetworkPolicy(parseNetworkProxySettings({
      easyresearch: { network: { llmProxy: "http://llm.example:8081" } },
    }), baseline);
    const target: Record<string, string | undefined> = {
      npm_config_proxy: "http://old-applied.example",
      NPM_CONFIG_PROXY: "http://old-applied.example",
      npm_config_https_proxy: "http://old-applied.example",
      NPM_CONFIG_HTTPS_PROXY: "http://old-applied.example",
      npm_config_noproxy: "old.internal",
      NPM_CONFIG_NOPROXY: "old.internal",
    };

    applyNetworkPolicyEnvironment(policy, baseline, target);

    expect(Object.fromEntries(
      Object.entries(target).filter(([key]) => key.toLowerCase().startsWith("npm_config_")),
    )).toEqual(inheritedNpm);
  });

  it("preserves pip's dedicated ambient proxy exactly when All traffic is absent", () => {
    const ambient = "http://ambient-user:ambient-secret@pip.example:8080";
    const baseline = captureInheritedProxyEnvironment({ PIP_PROXY: ambient });
    const policy = resolveNetworkPolicy(parseNetworkProxySettings({
      easyresearch: { network: { searchProxy: "http://search.example:8082" } },
    }), baseline);
    const target: Record<string, string | undefined> = {
      PIP_PROXY: "http://old-applied.example",
    };

    applyNetworkPolicyEnvironment(policy, baseline, target);

    expect(target.PIP_PROXY).toBe(ambient);
  });

  it("preserves the exact inherited standard proxy shape when All traffic is not configured", () => {
    const inherited = {
      HTTP_PROXY: "http://upper-http.example",
      https_proxy: "https://lower-https.example",
      no_proxy: "internal.example",
    };
    const baseline = captureInheritedProxyEnvironment(inherited);
    const policy = resolveNetworkPolicy(parseNetworkProxySettings({}), baseline);
    const target: Record<string, string | undefined> = {
      HTTP_PROXY: "http://old-applied.example",
      http_proxy: "http://old-applied.example",
      HTTPS_PROXY: "http://old-applied.example",
      ALL_PROXY: "http://old-applied.example",
    };

    applyNetworkPolicyEnvironment(policy, baseline, target);

    expect(target.HTTP_PROXY).toBe(inherited.HTTP_PROXY);
    expect(target.https_proxy).toBe(inherited.https_proxy);
    expect(target.http_proxy).toBeUndefined();
    expect(target.HTTPS_PROXY).toBeUndefined();
    expect(target.ALL_PROXY).toBeUndefined();
    expect(target.PLAYWRIGHT_MCP_PROXY_SERVER).toBe(inherited.https_proxy);
  });

  it.each([
    ["malformed settings", undefined],
    ["malformed All traffic", { httpProxy: "not a proxy" }],
  ])("permanently fails daemon and child standard proxy variables closed for %s", (_label, settings) => {
    const baseline = captureInheritedProxyEnvironment({
      http_proxy: "http://ambient-http.example:8080",
      HTTPS_PROXY: "http://ambient-https.example:8443",
      ALL_PROXY: "http://ambient-all.example:8888",
      NO_PROXY: "*,corp.internal",
    });
    const policy = resolveNetworkPolicy(parseNetworkProxySettings(settings), baseline);
    const target: Record<string, string | undefined> = {
      ...baseline.values,
      KEEP: "yes",
    };

    applyNetworkPolicyEnvironment(policy, baseline, target);

    for (const key of [
      "HTTP_PROXY",
      "http_proxy",
      "HTTPS_PROXY",
      "https_proxy",
      "ALL_PROXY",
      "all_proxy",
    ]) {
      expect(target[key]).toBe("http://127.0.0.1:0");
    }
    expect(target.PIP_PROXY).toBe("http://127.0.0.1:0");
    expect(target.NO_PROXY).toBe(
      "corp.internal,localhost,127.0.0.1,::1,localhost.,[::1]",
    );
    expect(target.no_proxy).toBe(target.NO_PROXY);
    expect(target.PLAYWRIGHT_MCP_PROXY_SERVER).toBe("http://127.0.0.1:0");
    expect(target.PLAYWRIGHT_MCP_PROXY_BYPASS).toBe(target.NO_PROXY);
    expect(target.KEEP).toBe("yes");
  });

  it("fails only Playwright closed for an invalid Search field while preserving valid All traffic", () => {
    const baseline = captureInheritedProxyEnvironment({ NO_PROXY: "*,corp.internal" });
    const policy = resolveNetworkPolicy(parseNetworkProxySettings({
      httpProxy: "http://all.example:8080",
      easyresearch: { network: { searchProxy: "invalid search proxy" } },
    }), baseline);
    const target: Record<string, string | undefined> = {};

    applyNetworkPolicyEnvironment(policy, baseline, target);

    expect(target.HTTP_PROXY).toBe("http://all.example:8080");
    expect(target.https_proxy).toBe("http://all.example:8080");
    expect(target.PLAYWRIGHT_MCP_PROXY_SERVER).toBe("http://127.0.0.1:0");
    expect(target.PLAYWRIGHT_MCP_PROXY_BYPASS).toBe(
      "corp.internal,localhost,127.0.0.1,::1,localhost.,[::1]",
    );
  });

  it("strips a wildcard only from invalid Search's fail-closed Playwright bypass", () => {
    const baseline = captureInheritedProxyEnvironment({
      HTTPS_PROXY: "http://ambient.proxy:8080",
      NO_PROXY: "*,corp.internal",
    });
    const policy = resolveNetworkPolicy(parseNetworkProxySettings({
      easyresearch: { network: { searchProxy: "invalid search proxy" } },
    }), baseline);
    const target: Record<string, string | undefined> = {};

    applyNetworkPolicyEnvironment(policy, baseline, target);

    expect(target.HTTPS_PROXY).toBe("http://ambient.proxy:8080");
    expect(target.NO_PROXY).toBe(
      "*,corp.internal,localhost,127.0.0.1,::1,localhost.,[::1]",
    );
    expect(target.PLAYWRIGHT_MCP_PROXY_SERVER).toBe("http://127.0.0.1:0");
    expect(target.PLAYWRIGHT_MCP_PROXY_BYPASS).toBe(
      "corp.internal,localhost,127.0.0.1,::1,localhost.,[::1]",
    );
  });

  it("preserves ambient Playwright proxy values when Search and All traffic are not configured", () => {
    const baseline = captureInheritedProxyEnvironment({
      PLAYWRIGHT_MCP_PROXY_SERVER: "socks5://ambient-playwright.example:1080",
      PLAYWRIGHT_MCP_PROXY_BYPASS: "browser.internal",
    });
    const policy = resolveNetworkPolicy(parseNetworkProxySettings({}), baseline);
    const target: Record<string, string | undefined> = {
      PLAYWRIGHT_MCP_PROXY_SERVER: "http://old-applied.example",
      PLAYWRIGHT_MCP_PROXY_BYPASS: "old.internal",
    };

    applyNetworkPolicyEnvironment(policy, baseline, target);

    expect(target.PLAYWRIGHT_MCP_PROXY_SERVER).toBe("socks5://ambient-playwright.example:1080");
    expect(target.PLAYWRIGHT_MCP_PROXY_BYPASS).toBe("browser.internal");
    expect(reconstructChildEnvironment(target, baseline)).toEqual({
      PLAYWRIGHT_MCP_PROXY_SERVER: "socks5://ambient-playwright.example:1080",
      PLAYWRIGHT_MCP_PROXY_BYPASS: "browser.internal",
    });
  });

  it("reconstructs child environments from the baseline without leaking old applied values", () => {
    const baseline = captureInheritedProxyEnvironment({
      HTTP_PROXY: "http://inherited.example",
      no_proxy: "inherited.internal",
    });
    const current: Record<string, string | undefined> = {
      HTTP_PROXY: "http://old-applied.example",
      http_proxy: "http://old-applied.example",
      HTTPS_PROXY: "http://old-applied.example",
      https_proxy: "http://old-applied.example",
      ALL_PROXY: "http://old-applied.example",
      all_proxy: "http://old-applied.example",
      NO_PROXY: "old.internal,localhost",
      no_proxy: "old.internal,localhost",
      PLAYWRIGHT_MCP_PROXY_SERVER: "http://old-search.example",
      PLAYWRIGHT_MCP_PROXY_BYPASS: "old.internal",
      KEEP: "current",
    };
    const original = { ...current };
    const baselineBefore = { ...baseline.values };

    const child = reconstructChildEnvironment(current, baseline);

    expect(child).toEqual({
      HTTP_PROXY: "http://inherited.example",
      no_proxy: "inherited.internal",
      KEEP: "current",
    });
    expect(current).toEqual(original);
    expect(baseline.values).toEqual(baselineBefore);
  });

  it("reconstructs successor npm configuration only from the captured baseline", () => {
    const baseline = captureInheritedProxyEnvironment({
      npm_config_proxy: "http://ambient.example:8080",
      NPM_CONFIG_HTTPS_PROXY: "http://ambient-secure.example:8443",
      npm_config_noproxy: "ambient.internal",
    });
    const current: Record<string, string | undefined> = {
      npm_config_proxy: "http://old-applied.example",
      NPM_CONFIG_PROXY: "http://old-applied.example",
      npm_config_https_proxy: "http://old-applied.example",
      NPM_CONFIG_HTTPS_PROXY: "http://old-applied.example",
      npm_config_noproxy: "old.internal",
      NPM_CONFIG_NOPROXY: "old.internal",
      KEEP: "current",
    };

    expect(reconstructChildEnvironment(current, baseline)).toEqual({
      npm_config_proxy: "http://ambient.example:8080",
      NPM_CONFIG_HTTPS_PROXY: "http://ambient-secure.example:8443",
      npm_config_noproxy: "ambient.internal",
      KEEP: "current",
    });
  });

  it("reconstructs a successor pip route from baseline instead of the old applied value", () => {
    const ambient = "http://ambient-user:ambient-secret@pip.example:8080";
    const baseline = captureInheritedProxyEnvironment({ PIP_PROXY: ambient });
    const oldApplied = {
      PIP_PROXY: "http://old-applied.example",
      KEEP: "current",
    };

    expect(reconstructChildEnvironment(oldApplied, baseline)).toEqual({
      PIP_PROXY: ambient,
      KEEP: "current",
    });
    expect(reconstructChildEnvironment(
      oldApplied,
      captureInheritedProxyEnvironment({}),
    )).toEqual({ KEEP: "current" });
  });

  it("registers inherited pip proxy credentials for diagnostic sanitization", () => {
    const secret = "http://pip-user:PIP_PROXY_SECRET@pip.example:8080";
    const policy = resolveNetworkPolicy(
      parseNetworkProxySettings({}),
      captureInheritedProxyEnvironment({ PIP_PROXY: secret }),
    );

    expect(networkPolicyProxySecrets(policy)).toContain(secret);
    expect(JSON.stringify(policy)).not.toContain("PIP_PROXY_SECRET");
  });
});

describe("startup network policy loading", () => {
  function tempAgentDir(): string {
    const root = mkdtempSync(join(tmpdir(), "easyresearch-network-policy-"));
    temporaryRoots.push(root);
    return root;
  }

  it("loads normalized global settings without evaluating project state", () => {
    const agentDir = tempAgentDir();
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      httpProxy: " HTTP://ALL.EXAMPLE:80/ ",
      easyresearch: { network: { llmProxy: "https://llm.example:443" } },
    }));
    const environment = {
      HTTPS_PROXY: "http://ambient.example:8080",
      PATH: "/bin",
    };

    const loaded = loadNetworkPolicy(agentDir, environment);

    expect(loaded.policy.configured).toEqual({
      all: "http://all.example",
      llm: "https://llm.example",
    });
    expect(networkProxyForTarget(loaded.policy, "search", "https:")).toBe("http://all.example");
    expect(loaded.baseline.values).toEqual({ HTTPS_PROXY: "http://ambient.example:8080" });
    expect(environment).toEqual({ HTTPS_PROXY: "http://ambient.example:8080", PATH: "/bin" });
  });

  it("loads a BOM-prefixed settings file accepted by Pi", () => {
    const agentDir = tempAgentDir();
    writeFileSync(
      join(agentDir, "settings.json"),
      `\uFEFF${JSON.stringify({
        httpProxy: "http://all.example:8000",
        easyresearch: { network: { searchProxy: "http://search.example:8002" } },
      })}`,
      "utf8",
    );

    const loaded = loadNetworkPolicy(agentDir, {});

    expect(loaded.policy.errors).toEqual([]);
    expect(loaded.policy.configured).toEqual({
      all: "http://all.example:8000",
      search: "http://search.example:8002",
    });
  });

  it("treats a missing settings file as empty and malformed JSON as a fail-closed settings error", () => {
    const agentDir = tempAgentDir();

    expect(loadNetworkPolicy(agentDir, {}).policy.errors).toEqual([]);

    writeFileSync(join(agentDir, "settings.json"), "{malformed", "utf8");
    expect(loadNetworkPolicy(agentDir, {}).policy.errors).toEqual([invalidError("settings")]);
  });

  it("restores a Bun sandbox environment from proc bytes only when the target is empty", () => {
    const empty: Record<string, string | undefined> = {};
    const restored = restoreBunSandboxEnvironment(empty, {
      isBun: true,
      readEnviron: () => "PATH=/usr/bin\0HTTPS_PROXY=http://proxy.example:8080\0INVALID\0=bad\0",
    });
    expect(restored).toBe(true);
    expect(empty).toEqual({ PATH: "/usr/bin", HTTPS_PROXY: "http://proxy.example:8080" });

    const existing = { PATH: "/controlled" };
    expect(restoreBunSandboxEnvironment(existing, {
      isBun: true,
      readEnviron: () => "PATH=/should-not-win\0",
    })).toBe(false);
    expect(existing).toEqual({ PATH: "/controlled" });
    expect(restoreBunSandboxEnvironment({}, {
      isBun: false,
      readEnviron: () => "PATH=/not-bun\0",
    })).toBe(false);
  });

  it("consumes one proc snapshot so deleting restored credentials cannot resurrect them", () => {
    const empty: Record<string, string | undefined> = {};
    const readEnviron = vi.fn(() => "EASYRESEARCH_DAEMON_TOKEN=private-token\0");
    const restoreOptions = { isBun: true, readEnviron };

    expect(restoreBunSandboxEnvironment(empty, restoreOptions)).toBe(true);
    delete empty.EASYRESEARCH_DAEMON_TOKEN;
    expect(restoreBunSandboxEnvironment(empty, restoreOptions)).toBe(false);

    expect(empty).toEqual({});
    expect(readEnviron).toHaveBeenCalledOnce();
  });

  it("temporarily applies policy for setup and restores every managed launch value after success or failure", () => {
    const baselineEnv = {
      HTTP_PROXY: "http://ambient.example:8080",
      PIP_PROXY: "http://ambient-pip.example:8081",
      NO_PROXY: "ambient.internal",
      PLAYWRIGHT_MCP_PROXY_SERVER: "socks5://browser.example:1080",
      KEEP: "yes",
    };
    const baseline = captureInheritedProxyEnvironment(baselineEnv);
    const policy = resolveNetworkPolicy(
      parseNetworkProxySettings({ httpProxy: "http://configured.example:7890" }),
      baseline,
    );
    const environment: Record<string, string | undefined> = { ...baselineEnv };

    expect(withTemporaryNetworkPolicyEnvironment(policy, baseline, environment, () => {
      expect(environment.HTTPS_PROXY).toBe("http://configured.example:7890");
      expect(environment.PIP_PROXY).toBe("http://configured.example:7890");
      expect(environment.PLAYWRIGHT_MCP_PROXY_SERVER).toBe("http://configured.example:7890");
      environment.TRANSIENT = "operation";
      return "result";
    })).toBe("result");
    expect(environment).toEqual({ ...baselineEnv, TRANSIENT: "operation" });

    expect(() => withTemporaryNetworkPolicyEnvironment(policy, baseline, environment, () => {
      throw new Error("setup failed");
    })).toThrow("setup failed");
    expect(environment).toEqual({ ...baselineEnv, TRANSIENT: "operation" });
  });

  it.each([
    ["malformed settings", undefined],
    ["malformed All traffic", { httpProxy: "not a proxy" }],
  ])("fails setup network closed for %s and restores the launch baseline", (_label, settings) => {
    const baselineEnv = {
      HTTPS_PROXY: "http://ambient.example:8080",
      PIP_PROXY: "http://ambient-pip.example:8081",
      NO_PROXY: "*,corp.internal",
      PLAYWRIGHT_MCP_PROXY_SERVER: "socks5://ambient-browser.example:1080",
      KEEP: "yes",
    };
    const baseline = captureInheritedProxyEnvironment(baselineEnv);
    const policy = resolveNetworkPolicy(parseNetworkProxySettings(settings), baseline);
    const environment: Record<string, string | undefined> = { ...baselineEnv };

    expect(() => withTemporaryNetworkPolicyEnvironment(policy, baseline, environment, () => {
      expect(environment.HTTP_PROXY).toBe("http://127.0.0.1:0");
      expect(environment.HTTPS_PROXY).toBe("http://127.0.0.1:0");
      expect(environment.ALL_PROXY).toBe("http://127.0.0.1:0");
      expect(environment.PIP_PROXY).toBe("http://127.0.0.1:0");
      expect(environment.NO_PROXY).toBe(
        "corp.internal,localhost,127.0.0.1,::1,localhost.,[::1]",
      );
      expect(environment.no_proxy).toBe(environment.NO_PROXY);
      expect(environment.PLAYWRIGHT_MCP_PROXY_SERVER).toBe("http://127.0.0.1:0");
      throw new Error("setup failed");
    })).toThrow("setup failed");
    expect(environment).toEqual(baselineEnv);
  });
});
