import { describe, it, expect } from "vitest";
import { matchCommand, AllowlistMatcher } from "./allowlist-matcher.js";

describe("matchCommand", () => {
  it("matches npm install with npm install * pattern", () => {
    const result = matchCommand("npm install express", ["npm install *"]);
    expect(result).toEqual({ allowed: true, matchedPattern: "npm install *" });
  });

  it("rejects command not in allowlist", () => {
    const result = matchCommand("rm -rf /", ["npm *", "git *"]);
    expect(result).toEqual({ allowed: false });
  });

  it("matches glob pattern with curl", () => {
    const result = matchCommand("curl example.com", ["curl *"]);
    expect(result).toEqual({ allowed: true, matchedPattern: "curl *" });
  });

  it("denies all commands when allowlist is empty", () => {
    const result = matchCommand("bash -c 'evil'", []);
    expect(result).toEqual({ allowed: false });
  });

  it("matches exact command without wildcards", () => {
    const result = matchCommand("git status", ["git status"]);
    expect(result).toEqual({ allowed: true, matchedPattern: "git status" });
  });

  it("does not match partial patterns without wildcard", () => {
    const result = matchCommand("git status --verbose", ["git status"]);
    expect(result).toEqual({ allowed: false });
  });

  it("matches first matching pattern when multiple match", () => {
    const result = matchCommand("npm install express", ["npm *", "npm install *"]);
    expect(result).toEqual({ allowed: true, matchedPattern: "npm *" });
  });

  it("handles special regex characters in patterns", () => {
    const result = matchCommand("echo hello.world", ["echo hello.world"]);
    expect(result).toEqual({ allowed: true, matchedPattern: "echo hello.world" });
  });

  it("escapes regex dots so they match literally", () => {
    const result = matchCommand("echo helloXworld", ["echo hello.world"]);
    expect(result).toEqual({ allowed: false });
  });
});

describe("AllowlistMatcher", () => {
  it("checks against static patterns", () => {
    const matcher = new AllowlistMatcher(["npm *", "git *"]);
    expect(matcher.check("npm install express")).toEqual({
      allowed: true,
      matchedPattern: "npm *",
    });
    expect(matcher.check("rm -rf /")).toEqual({ allowed: false });
  });

  it("supports allow-always patterns", () => {
    const matcher = new AllowlistMatcher(["npm *"]);
    expect(matcher.check("docker build .")).toEqual({ allowed: false });

    matcher.addAllowAlways("docker build *");
    expect(matcher.check("docker build .")).toEqual({
      allowed: true,
      matchedPattern: "docker build *",
    });
  });

  it("persists allow-always patterns and matches future checks", () => {
    const matcher = new AllowlistMatcher([]);
    matcher.addAllowAlways("docker build *");
    matcher.addAllowAlways("docker push *");

    const patterns = matcher.getAllowAlwaysPatterns();
    expect(patterns).toEqual(["docker build *", "docker push *"]);

    expect(matcher.check("docker build my-image")).toEqual({
      allowed: true,
      matchedPattern: "docker build *",
    });
    expect(matcher.check("docker push my-image")).toEqual({
      allowed: true,
      matchedPattern: "docker push *",
    });
  });

  it("returns empty array when no allow-always patterns added", () => {
    const matcher = new AllowlistMatcher(["npm *"]);
    expect(matcher.getAllowAlwaysPatterns()).toEqual([]);
  });
});
