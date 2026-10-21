import { describe, it, expect } from "vitest";
import { resolveAgent } from "../routing.js";

const byTree = new Map([
  ["acme", "fin-client"],
  ["state-contract", "state-contract"],
  ["client-a-personal", "client-a-personal"],
]);
const byJobPrefix = new Map([["side-project-", "side-project"]]);

describe("resolveAgent", () => {
  it("routes by tree when nothing special applies", () => {
    expect(resolveAgent({ byTree }, "client-a-personal", "standup")).toBe("client-a-personal");
    expect(resolveAgent({ byTree }, "acme", "buyer-call")).toBe("fin-client");
  });

  it("routes a shared tree by job prefix — side-project must not land in fin-client", () => {
    expect(resolveAgent({ byTree, byJobPrefix }, "acme", "side-project-scrimmage"))
      .toBe("side-project");
  });

  it("leaves other jobs in the shared tree with the tree's owner", () => {
    expect(resolveAgent({ byTree, byJobPrefix }, "acme", "adam-call"))
      .toBe("fin-client");
  });

  it("is case-insensitive about the prefix", () => {
    expect(resolveAgent({ byTree, byJobPrefix }, "acme", "Side-Project-Game1"))
      .toBe("side-project");
  });

  it("returns undefined for a tree nobody owns, rather than guessing", () => {
    expect(resolveAgent({ byTree, byJobPrefix }, "orphan", "x")).toBeUndefined();
  });

  it("prefix wins over tree, because the prefix IS the exception", () => {
    const shadow = new Map([["acme", "fin-client"]]);
    expect(resolveAgent({ byTree: shadow, byJobPrefix }, "acme", "side-project-x"))
      .toBe("side-project");
  });
});
