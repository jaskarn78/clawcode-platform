import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  __testOnly_buildHandler,
  __testOnly_buildMcpResponse,
  createBrowserMcpServer,
} from "../mcp-server.js";
import type { BrowserToolOutcome } from "../types.js";

/* ------------------------------------------------------------------ */
/*  Handler forward-to-daemon contract (DI seam)                        */
/* ------------------------------------------------------------------ */

describe("__testOnly_buildHandler", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.CLAWCODE_AGENT;
    delete process.env.CLAWCODE_AGENT;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CLAWCODE_AGENT;
    else process.env.CLAWCODE_AGENT = originalEnv;
  });

  it("forwards a browser_navigate call to sendIpcRequest with the correct params", async () => {
    const sendIpc = vi.fn(async () =>
      ({
        ok: true,
        data: { url: "https://x/", title: "t", status: 200 },
      }) as BrowserToolOutcome<unknown>,
    );
    const handler = __testOnly_buildHandler("browser_navigate", { sendIpc });
    const response = await handler({ agent: "clawdy", url: "https://x/" });
    expect(sendIpc).toHaveBeenCalledTimes(1);
    const call = sendIpc.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
    ];
    const method = call[1];
    const params = call[2];
    expect(method).toBe("browser-tool-call");
    expect(params).toEqual({
      agent: "clawdy",
      toolName: "browser_navigate",
      args: { url: "https://x/" },
    });
    // Response is a text-only success envelope
    expect(response.isError).toBeUndefined();
    expect(response.content).toHaveLength(1);
    expect(response.content[0].type).toBe("text");
  });

  it("uses process.env.CLAWCODE_AGENT when agent arg is missing", async () => {
    const sendIpc = vi.fn(async () =>
      ({ ok: true, data: {} }) as BrowserToolOutcome<unknown>,
    );
    const handler = __testOnly_buildHandler("browser_click", {
      sendIpc,
      env: { CLAWCODE_AGENT: "clawdy" },
    });
    await handler({ selector: "#btn" });
    const call = sendIpc.mock.calls[0] as unknown as [
      string,
      string,
      { agent: string; args: Record<string, unknown> },
    ];
    const params = call[2];
    expect(params.agent).toBe("clawdy");
    expect(params.args).toEqual({ selector: "#btn" });
  });

  it("arg agent takes precedence over env CLAWCODE_AGENT", async () => {
    const sendIpc = vi.fn(async () =>
      ({ ok: true, data: {} }) as BrowserToolOutcome<unknown>,
    );
    const handler = __testOnly_buildHandler("browser_fill", {
      sendIpc,
      env: { CLAWCODE_AGENT: "envAgent" },
    });
    await handler({ agent: "argAgent", selector: "#x", value: "v" });
    const call = sendIpc.mock.calls[0] as unknown as [
      string,
      string,
      { agent: string },
    ];
    expect(call[2].agent).toBe("argAgent");
  });

  it("returns invalid_argument when agent missing from arg AND env", async () => {
    const sendIpc = vi.fn();
    const handler = __testOnly_buildHandler("browser_navigate", {
      sendIpc,
      env: {},
    });
    const response = await handler({ url: "https://x/" });
    expect(sendIpc).not.toHaveBeenCalled();
    expect(response.isError).toBe(true);
    if (response.content[0].type === "text") {
      const parsed = JSON.parse(response.content[0].text) as {
        error: { type: string };
      };
      expect(parsed.error.type).toBe("invalid_argument");
    }
  });

  it("stringifies successful outcome data as text content", async () => {
    const sendIpc = vi.fn(async () =>
      ({
        ok: true,
        data: { url: "https://x/", title: "T", status: 200 },
      }) as BrowserToolOutcome<unknown>,
    );
    const handler = __testOnly_buildHandler("browser_navigate", { sendIpc });
    const response = await handler({ agent: "c", url: "https://x/" });
    expect(response.content).toHaveLength(1);
    if (response.content[0].type === "text") {
      const parsed = JSON.parse(response.content[0].text) as {
        url: string;
        title: string;
        status: number;
      };
      expect(parsed.url).toBe("https://x/");
      expect(parsed.status).toBe(200);
    }
  });

  it("emits text + image content when screenshot outcome includes inlineBase64", async () => {
    const sendIpc = vi.fn(async () =>
      ({
        ok: true,
        data: {
          path: "/tmp/shot.png",
          bytes: 128,
          inlineBase64: "AAAA",
        },
      }) as BrowserToolOutcome<unknown>,
    );
    const handler = __testOnly_buildHandler("browser_screenshot", {
      sendIpc,
    });
    const response = await handler({ agent: "c" });
    expect(response.content).toHaveLength(2);
    expect(response.content[0].type).toBe("text");
    expect(response.content[1].type).toBe("image");
    if (response.content[1].type === "image") {
      expect(response.content[1].data).toBe("AAAA");
      expect(response.content[1].mimeType).toBe("image/png");
    }
  });

  it("emits path-only content for screenshot outcome without inlineBase64", async () => {
    const sendIpc = vi.fn(async () =>
      ({
        ok: true,
        data: { path: "/tmp/big.png", bytes: 999999 },
      }) as BrowserToolOutcome<unknown>,
    );
    const handler = __testOnly_buildHandler("browser_screenshot", {
      sendIpc,
    });
    const response = await handler({ agent: "c" });
    expect(response.content).toHaveLength(1);
    if (response.content[0].type === "text") {
      const parsed = JSON.parse(response.content[0].text) as {
        path: string;
        inline: boolean;
      };
      expect(parsed.inline).toBe(false);
      expect(parsed.path).toBe("/tmp/big.png");
    }
  });

  it("maps failure outcome to isError:true with JSON error body", async () => {
    const sendIpc = vi.fn(async () =>
      ({
        ok: false,
        error: {
          type: "timeout" as const,
          message: "nav timeout",
          timeoutMs: 30000,
        },
      }) as BrowserToolOutcome<unknown>,
    );
    const handler = __testOnly_buildHandler("browser_navigate", { sendIpc });
    const response = await handler({ agent: "c", url: "https://x/" });
    expect(response.isError).toBe(true);
    if (response.content[0].type === "text") {
      const parsed = JSON.parse(response.content[0].text) as {
        error: { type: string; message: string; timeoutMs: number };
      };
      expect(parsed.error.type).toBe("timeout");
      expect(parsed.error.timeoutMs).toBe(30000);
    }
  });

  it("maps IPC exception to isError:true with internal type", async () => {
    const sendIpc = vi.fn(async () => {
      throw new Error("daemon not running");
    });
    const handler = __testOnly_buildHandler("browser_click", { sendIpc });
    const response = await handler({ agent: "c", selector: "#x" });
    expect(response.isError).toBe(true);
    if (response.content[0].type === "text") {
      const parsed = JSON.parse(response.content[0].text) as {
        error: { type: string; message: string };
      };
      expect(parsed.error.type).toBe("internal");
      expect(parsed.error.message).toContain("daemon not running");
    }
  });

  it("strips agent from args before forwarding to daemon", async () => {
    const sendIpc = vi.fn(async () =>
      ({ ok: true, data: {} }) as BrowserToolOutcome<unknown>,
    );
    const handler = __testOnly_buildHandler("browser_fill", { sendIpc });
    await handler({ agent: "c", selector: "#x", value: "v" });
    const call = sendIpc.mock.calls[0] as unknown as [
      string,
      string,
      { args: Record<string, unknown> },
    ];
    const params = call[2];
    expect(params.args).not.toHaveProperty("agent");
    expect(params.args).toEqual({ selector: "#x", value: "v" });
  });
});

/* ------------------------------------------------------------------ */
/*  buildMcpResponse envelope shape                                     */
/* ------------------------------------------------------------------ */

describe("buildMcpResponse", () => {
  it("non-screenshot success emits one text content item", () => {
    const r = __testOnly_buildMcpResponse(
      { ok: true, data: { url: "/" } } as BrowserToolOutcome,
      "browser_navigate",
    );
    expect(r.content).toHaveLength(1);
    expect(r.content[0].type).toBe("text");
    expect(r.isError).toBeUndefined();
  });

  it("error outcome is JSON-encoded under .error with isError:true", () => {
    const r = __testOnly_buildMcpResponse(
      {
        ok: false,
        error: { type: "element_not_found", message: "no", selector: ".x" },
      } as BrowserToolOutcome,
      "browser_click",
    );
    expect(r.isError).toBe(true);
    if (r.content[0].type === "text") {
      const parsed = JSON.parse(r.content[0].text) as {
        error: { type: string };
      };
      expect(parsed.error.type).toBe("element_not_found");
    }
  });
});

/* ------------------------------------------------------------------ */
/*  createBrowserMcpServer — tool registration                          */
/* ------------------------------------------------------------------ */

describe("createBrowserMcpServer", () => {
  it("constructs without error and returns an McpServer-shaped object", () => {
    const server = createBrowserMcpServer();
    // Duck-type check — McpServer has connect() and internal registration.
    expect(server).toBeDefined();
    expect(typeof (server as unknown as { connect: unknown }).connect).toBe(
      "function",
    );
  });

  it("accepts a deps.sendIpc override (DI seam for Plan 03 integration)", () => {
    const sendIpc = vi.fn();
    const server = createBrowserMcpServer({ sendIpc });
    expect(server).toBeDefined();
  });
});
