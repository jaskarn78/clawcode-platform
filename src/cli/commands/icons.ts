/**
 * `clawcode icons sync` — upload the bundled Lucide icon set as the bot's
 * application emojis (999.160 v1.2). Reads `cc_*.png` from the bundled
 * assets dir (dist/assets/icons; assets/icons in a dev tree), ships them to
 * the daemon over IPC in small batches; the daemon uploads through its own
 * logged-in client (no token handling here) and reloads the icon registry.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { cliLog, cliError } from "../output.js";

const BATCH = 8;

function defaultIconDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "assets", "icons"), // dist/cli/index.js → dist/assets/icons
    join(here, "..", "..", "assets", "icons"),
    join(here, "..", "..", "..", "assets", "icons"), // src/cli/commands → assets/icons
    join(process.cwd(), "assets", "icons"),
  ];
  return candidates.find((c) => existsSync(c));
}

type SyncReply = {
  ok?: boolean;
  message?: string;
  created?: string[];
  existing?: string[];
  failed?: { name: string; error: string }[];
};

export function registerIconsCommand(program: Command): void {
  const icons = program.command("icons").description("Discord icon set (application emojis)");
  icons
    .command("sync")
    .description("Upload every missing icon from the bundled set through the running daemon")
    .option("--dir <dir>", "directory of cc_*.png files (default: the bundled set)")
    .action(async (opts: { dir?: string }) => {
      const dir = opts.dir ? resolve(opts.dir) : defaultIconDir();
      if (!dir || !existsSync(dir)) {
        cliError(`icon directory not found${opts.dir ? `: ${opts.dir}` : ""}`);
        process.exitCode = 1;
        return;
      }
      const files = readdirSync(dir).filter((f) => /^cc_[a-z0-9_]{1,29}\.png$/.test(f)).sort();
      if (files.length === 0) {
        cliError(`no cc_*.png files in ${dir}`);
        process.exitCode = 1;
        return;
      }
      const created: string[] = [];
      const existing: string[] = [];
      const failed: { name: string; error: string }[] = [];
      for (let i = 0; i < files.length; i += BATCH) {
        const batch = files
          .slice(i, i + BATCH)
          .map((f) => ({ name: f.replace(/\.png$/, ""), png: readFileSync(join(dir, f)).toString("base64") }));
        const reply = (await sendIpcRequest(SOCKET_PATH, "discord-sync-icons", { icons: batch })) as SyncReply;
        if (reply?.ok !== true) {
          cliError(reply?.message ?? "icon sync failed");
          process.exitCode = 1;
          return;
        }
        created.push(...(reply.created ?? []));
        existing.push(...(reply.existing ?? []));
        failed.push(...(reply.failed ?? []));
      }
      cliLog(`icons: ${created.length} created, ${existing.length} already present, ${failed.length} failed (${files.length} files in ${dir})`);
      for (const f of failed) cliLog(`  failed ${f.name}: ${f.error}`);
      if (failed.length > 0) process.exitCode = 1;
    });
}
