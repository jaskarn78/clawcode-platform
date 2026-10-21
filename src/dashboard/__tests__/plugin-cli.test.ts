/**
 * dashboard-rework — the `claude plugin` CLI shell-out validates its inputs as
 * defense-in-depth (args already go through execFile arrays, never a shell).
 * These tests pin the validators so a malicious ref/source can't slip through.
 */
import { describe, it, expect } from "vitest";
import {
  isValidPluginRef,
  isValidMarketplaceName,
  isValidMarketplaceSource,
} from "../plugin-cli.js";

describe("isValidPluginRef", () => {
  it("accepts <plugin>@<marketplace> slugs", () => {
    expect(isValidPluginRef("discord@claude-plugins-official")).toBe(true);
    expect(isValidPluginRef("agent-sdk-dev@claude-plugins-official")).toBe(true);
    expect(isValidPluginRef("a.b_c@d-e.f")).toBe(true);
  });
  it("rejects missing/extra @, spaces, and shell metacharacters", () => {
    expect(isValidPluginRef("no-at-sign")).toBe(false);
    expect(isValidPluginRef("a@b@c")).toBe(false);
    expect(isValidPluginRef("plugin @ mkt")).toBe(false);
    expect(isValidPluginRef("$(whoami)@x")).toBe(false);
    expect(isValidPluginRef("x@y; rm -rf /")).toBe(false);
    expect(isValidPluginRef("x@y && curl evil")).toBe(false);
    expect(isValidPluginRef("`id`@m")).toBe(false);
    expect(isValidPluginRef("")).toBe(false);
  });
});

describe("isValidMarketplaceSource", () => {
  it("accepts owner/repo shorthand and https git urls", () => {
    expect(isValidMarketplaceSource("anthropics/claude-plugins-official")).toBe(true);
    expect(isValidMarketplaceSource("https://github.com/anthropics/claude-plugins-official.git")).toBe(true);
  });
  it("rejects shell metacharacters, file urls, paths, and injection", () => {
    expect(isValidMarketplaceSource("; rm -rf /")).toBe(false);
    expect(isValidMarketplaceSource("owner/repo; echo pwned")).toBe(false);
    expect(isValidMarketplaceSource("file:///etc/passwd")).toBe(false);
    expect(isValidMarketplaceSource("$(curl evil)")).toBe(false);
    expect(isValidMarketplaceSource("../../etc")).toBe(false);
    expect(isValidMarketplaceSource("a b/c")).toBe(false);
  });
});

describe("isValidMarketplaceName", () => {
  it("accepts a single slug; rejects slashes/spaces/metachars", () => {
    expect(isValidMarketplaceName("claude-plugins-official")).toBe(true);
    expect(isValidMarketplaceName("owner/repo")).toBe(false);
    expect(isValidMarketplaceName("a b")).toBe(false);
    expect(isValidMarketplaceName("x;y")).toBe(false);
  });
});
