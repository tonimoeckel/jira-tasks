// plugins/jira-tasks/src/open-panel.ts
import { execFile as execFile2 } from "node:child_process";

// plugins/jira-tasks/src/session.ts
import { open as openFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// plugins/jira-tasks/src/jira.ts
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

// plugins/jira-tasks/src/avatar.ts
var MAX_BYTES = 64 * 1024;
function avatarUrl(value) {
  if (typeof value !== "string" || value.length > 2e3) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !/^avatar-management--avatars\.[a-z0-9-]+\.prod\.public\.atl-paas\.net$/.test(
      url.hostname
    ))
      return "";
    return url.href;
  } catch {
    return "";
  }
}
function createAvatarLoader(fetchImage = fetch) {
  const cache = /* @__PURE__ */ new Map();
  return async (input, signal) => {
    const url = avatarUrl(input?.url);
    if (!url) return null;
    const cached = cache.get(url);
    if (cached && cached.expires > Date.now()) return cached.result;
    if (cache.size >= 100) cache.delete(cache.keys().next().value);
    const result = (async () => {
      try {
        const response = await fetchImage(url, {
          redirect: "error",
          credentials: "omit",
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5e3)]) : AbortSignal.timeout(5e3)
        });
        if (!response.ok || !response.body) return null;
        if (Number(response.headers.get("content-length")) > MAX_BYTES) {
          await response.body.cancel();
          return null;
        }
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > MAX_BYTES) {
            await reader.cancel();
            return null;
          }
          chunks.push(part.value);
        }
        const bytes = Buffer.concat(chunks);
        const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png" : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg" : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP" ? "image/webp" : "";
        return mime ? `data:${mime};base64,${bytes.toString("base64")}` : null;
      } catch {
        return null;
      }
    })();
    cache.set(url, { expires: Date.now() + 5 * 60 * 1e3, result });
    return result;
  };
}

// plugins/jira-tasks/src/child-query.ts
function quoteJql(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
function values(value, max) {
  if (value === void 0) return [];
  if (!Array.isArray(value) || value.length > max || value.some(
    (item) => typeof item !== "string" || !item || item.length > 200 || /[\x00-\x1f]/.test(item)
  ))
    throw new Error("Invalid child issue query.");
  return [...new Set(value)];
}
function childJql(input) {
  const clauses = [`parent = ${quoteJql(input.key)}`];
  const search = input.search ?? "";
  if (typeof search !== "string" || search.length > 200 || /[\x00-\x1f]/.test(search))
    throw new Error("Invalid child search.");
  if (search.trim()) {
    const term = search.trim();
    if (/^[a-z][a-z0-9_]*-\d+$/i.test(term))
      clauses.push(`key = ${quoteJql(term.toUpperCase())}`);
    else {
      const words = term.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
      if (!words) throw new Error("Enter an issue key or title words.");
      clauses.push(
        `summary ~ ${quoteJql(words + (/^[\p{L}\p{N}']+$/u.test(words.split(" ").at(-1)) ? "*" : ""))}`
      );
    }
  }
  const statuses = values(input.statuses, 100);
  if (statuses.length)
    clauses.push(`status IN (${statuses.map(quoteJql).join(", ")})`);
  const assignees = values(input.assignees, 100);
  const assigned = assignees.filter((value) => value !== "unassigned").map((value) => {
    if (!value.startsWith("id:"))
      throw new Error("The selected assignee has no Jira account ID.");
    return value.slice(3);
  });
  if (assigned.some((value) => !value)) throw new Error("Invalid assignee.");
  const assigneeClauses = [];
  if (assigned.length)
    assigneeClauses.push(`assignee IN (${assigned.map(quoteJql).join(", ")})`);
  if (assignees.includes("unassigned"))
    assigneeClauses.push("assignee IS EMPTY");
  if (assigneeClauses.length) clauses.push(`(${assigneeClauses.join(" OR ")})`);
  return `${clauses.join(" AND ")} ORDER BY key ASC`;
}
function optionAccumulator() {
  const statuses = /* @__PURE__ */ new Set();
  const assignees = /* @__PURE__ */ new Map();
  return {
    add(tasks) {
      for (const task of tasks) {
        if (task.status) statuses.add(task.status);
        if (task.assigneeId)
          assignees.set(`id:${task.assigneeId}`, task.assignee);
        else if (!task.assignee) assignees.set("unassigned", "");
      }
    },
    unseenJql(key) {
      const accounts = [...assignees.keys()].filter((value) => value.startsWith("id:")).map((value) => value.slice(3));
      const unknown = [
        accounts.length ? `assignee NOT IN (${accounts.map(quoteJql).join(", ")})` : "assignee IS NOT EMPTY"
      ];
      if (!assignees.has("unassigned")) unknown.push("assignee IS EMPTY");
      if (statuses.size)
        unknown.push(
          `status NOT IN (${[...statuses].map(quoteJql).join(", ")})`
        );
      return `parent = ${quoteJql(key)} AND (${unknown.join(" OR ")}) ORDER BY key ASC`;
    },
    result(limited) {
      return {
        statuses: [...statuses],
        assignees: [...assignees].map(([value, label]) => ({ value, label })),
        limited
      };
    }
  };
}

// plugins/jira-tasks/src/description.ts
function extractDescription(value) {
  if (typeof value !== "string") return { text: "", images: [] };
  const images = [];
  let bytes = 0;
  const text2 = value.replace(
    /!\[([^\]\r\n]*)\]\(([^)]*)\)/g,
    (_match, alt, src) => {
      if (/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(src) && src.length <= 6e5 && bytes + src.length <= 72e4 && images.length < 8) {
        const index = images.length;
        bytes += src.length;
        images.push({ alt: alt.slice(0, 200), src });
        return `

[[image:${index}]]

`;
      }
      return `

> \u{1F5BC} ${alt.trim().slice(0, 200)}

`;
    }
  ).replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: text2, images };
}

// plugins/jira-tasks/src/jira.ts
var LIMIT = 100;
var FILTERS = /* @__PURE__ */ new Set(["assigned", "reported", "all"]);
var KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Jira response.");
  return value;
}
function text(value, limit = 1e3) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}
function optional(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function siteId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,199}$/.test(value))
    throw new Error("Invalid Jira site.");
}
function safeUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
}
function normalizeTask(value, detail = false) {
  const row = record(value);
  const body = extractDescription(detail ? row.description : "");
  const description = body.text.slice(0, 24e3);
  const parent = optional(row.parent);
  const parentKey = text(parent.key, 100);
  return {
    key: text(row.key, 100),
    title: text(row.title, 240),
    url: safeUrl(row.url),
    project: text(optional(row.project).key, 100),
    status: text(optional(row.status).name, 100),
    category: text(optional(row.status).categoryKey, 100),
    issueType: {
      name: text(optional(row.issueType).name, 100),
      subtask: optional(row.issueType).subtask === true
    },
    assignee: text(optional(row.assignee).displayName, 200),
    assigneeId: text(optional(row.assignee).accountId, 200),
    assigneeAvatarUrl: avatarUrl(optional(row.assignee).avatarUrl),
    reporter: {
      name: text(optional(row.reporter).displayName, 200),
      avatarUrl: avatarUrl(optional(row.reporter).avatarUrl)
    },
    priority: text(optional(row.priority).name, 100),
    updatedAt: text(row.updatedAt, 100),
    description,
    descriptionTruncated: body.text.length > description.length,
    images: body.images,
    parent: /^[A-Z][A-Z0-9_]*-\d+$/.test(parentKey) ? {
      key: parentKey,
      title: text(parent.title, 240),
      issueTypeName: text(parent.issueTypeName, 100)
    } : null
  };
}
function cliExecutable() {
  if (process.env.ORCA_CLI_COMMAND) return process.env.ORCA_CLI_COMMAND;
  if (process.platform === "darwin" && existsSync("/Applications/Orca.app/Contents/Resources/bin/orca"))
    return "/Applications/Orca.app/Contents/Resources/bin/orca";
  return process.platform === "linux" ? "orca-ide" : "orca";
}
var runCli = (args, signal) => new Promise((resolve, reject) => {
  execFile(
    cliExecutable(),
    ["jira", ...args, "--environment", "local", "--json"],
    {
      timeout: 25e3,
      maxBuffer: 8 * 1024 * 1024,
      signal,
      windowsHide: true
    },
    (error, stdout) => {
      let answer;
      try {
        answer = record(JSON.parse(stdout));
      } catch {
        const code = error?.code;
        reject(
          new Error(
            code === "ENOENT" ? "Orca CLI was not found. Update or reinstall Orca." : signal?.aborted ? "Request cancelled." : "Could not read Jira. Check the Orca connection and try again."
          )
        );
        return;
      }
      if (error || answer.ok !== true) {
        const code = text(optional(answer.error).code, 100);
        reject(
          new Error(
            `Jira request failed${code ? ` (${code})` : ""}. Check the Jira connection in Orca Tasks.`
          )
        );
      } else resolve(answer.result);
    }
  );
});
function createJiraClient(run = runCli, optionsBudgetMs = 15e3) {
  if (!Number.isInteger(optionsBudgetMs) || optionsBudgetMs < 1 || optionsBudgetMs > 15e3)
    throw new Error("Invalid Jira options timeout.");
  return {
    async connection(signal) {
      const result = record(await run(["connection"], signal));
      const sites = Array.isArray(result.sites) ? result.sites.map((value) => {
        const site = record(value);
        siteId(site.id);
        return {
          id: site.id,
          siteUrl: safeUrl(site.siteUrl),
          email: text(site.email, 200)
        };
      }) : [];
      const selected = text(result.selectedSiteId || result.activeSiteId, 200);
      return {
        sites,
        selectedSiteId: sites.some((s) => s.id === selected) ? selected : sites[0]?.id ?? null
      };
    },
    async list(input, signal) {
      siteId(input?.siteId);
      if (!FILTERS.has(input.filter)) throw new Error("Invalid Jira filter.");
      const rows = await run(
        [
          "list",
          "--site",
          input.siteId,
          "--filter",
          input.filter,
          "--limit",
          String(LIMIT)
        ],
        signal
      );
      if (!Array.isArray(rows)) throw new Error("Invalid Jira task list.");
      return {
        tasks: rows.slice(0, LIMIT).map((row) => normalizeTask(row)),
        limitReached: rows.length >= LIMIT
      };
    },
    async byKeys(input, signal) {
      siteId(input?.siteId);
      if (!Array.isArray(input.keys) || input.keys.length > LIMIT || input.keys.some((key) => typeof key !== "string" || !KEY.test(key) || key.length > 100))
        throw new Error("Invalid Jira issue keys.");
      if (!input.keys.length) return { tasks: [], limitReached: false };
      const rows = await run(
        [
          "search",
          `key IN (${input.keys.map(quoteJql).join(", ")})`,
          "--site",
          input.siteId,
          "--limit",
          String(LIMIT)
        ],
        signal
      );
      if (!Array.isArray(rows)) throw new Error("Invalid Jira task list.");
      const order = new Map(input.keys.map((key, index) => [key, index]));
      const tasks = rows.slice(0, LIMIT).map((row) => normalizeTask(row)).sort((a, b) => (order.get(a.key) ?? LIMIT) - (order.get(b.key) ?? LIMIT));
      return { tasks, limitReached: false };
    },
    async searchAll(input, signal) {
      siteId(input?.siteId);
      const search = input.search;
      if (typeof search !== "string" || !search.trim() || search.length > 200 || /[\x00-\x1f]/.test(search))
        throw new Error("Invalid Jira search.");
      const term = search.trim();
      let jql;
      if (/^[a-z][a-z0-9_]*-\d+$/i.test(term))
        jql = `key = ${quoteJql(term.toUpperCase())}`;
      else {
        const words = term.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
        if (!words) throw new Error("Enter an issue key or title words.");
        jql = `summary ~ ${quoteJql(words + (/^[\p{L}\p{N}']+$/u.test(words.split(" ").at(-1)) ? "*" : ""))} ORDER BY updated DESC`;
      }
      const rows = await run(
        ["search", jql, "--site", input.siteId, "--limit", String(LIMIT)],
        signal
      );
      if (!Array.isArray(rows)) throw new Error("Invalid Jira task list.");
      return {
        tasks: rows.slice(0, LIMIT).map((row) => normalizeTask(row)),
        limitReached: rows.length >= LIMIT
      };
    },
    async children(input, signal) {
      siteId(input?.siteId);
      if (typeof input.key !== "string" || !/^[A-Z][A-Z0-9_]*-\d+$/.test(input.key) || input.key.length > 100)
        throw new Error("Invalid Jira issue key.");
      if (input.includeOptions !== void 0 && typeof input.includeOptions !== "boolean")
        throw new Error("Invalid child query options.");
      const rows = await run(
        [
          "search",
          childJql(input),
          "--site",
          input.siteId,
          "--limit",
          String(LIMIT)
        ],
        signal
      );
      if (!Array.isArray(rows))
        throw new Error("Invalid Jira child task list.");
      const result = {
        tasks: rows.slice(0, LIMIT).map((row) => normalizeTask(row)),
        limitReached: rows.length >= LIMIT
      };
      if (input.includeOptions) {
        const options = optionAccumulator();
        options.add(result.tasks);
        let limited = true;
        const discovery = new AbortController();
        const discoverySignal = AbortSignal.any([
          discovery.signal,
          ...signal ? [signal] : []
        ]);
        const timer = setTimeout(() => discovery.abort(), optionsBudgetMs);
        try {
          for (let attempt = 0; attempt < 8 && !discoverySignal.aborted; attempt++) {
            let found;
            try {
              found = await run(
                [
                  "search",
                  options.unseenJql(input.key),
                  "--site",
                  input.siteId,
                  "--limit",
                  String(LIMIT)
                ],
                discoverySignal
              );
            } catch (error) {
              if (signal?.aborted) throw error;
              break;
            }
            if (!Array.isArray(found)) break;
            if (!found.length) {
              limited = false;
              break;
            }
            const before = JSON.stringify(options.result(false));
            options.add(found.map((row) => normalizeTask(row)));
            if (before === JSON.stringify(options.result(false))) break;
          }
        } finally {
          clearTimeout(timer);
        }
        result.options = options.result(limited);
      }
      return result;
    },
    async issue(input, signal) {
      siteId(input?.siteId);
      if (typeof input.key !== "string" || !/^[A-Z][A-Z0-9_]*-\d+$/.test(input.key) || input.key.length > 100)
        throw new Error("Invalid Jira issue key.");
      return normalizeTask(
        await run(["issue", input.key, "--site", input.siteId], signal),
        true
      );
    }
  };
}

// plugins/jira-tasks/src/session.ts
var MAX_SESSION_KEYS = 100;
var MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
var MENTION = /(?<![A-Za-z0-9_.-])([A-Za-z][A-Za-z0-9_]{1,19})-([1-9]\d{0,7})(?![A-Za-z0-9_])/g;
function transcriptDirName(path) {
  return path.replace(/[^A-Za-z0-9]/g, "-");
}
function orcaDataDirs() {
  const home = homedir();
  const dirs = [];
  if (process.env.ORCA_USER_DATA_PATH) dirs.push(process.env.ORCA_USER_DATA_PATH);
  if (process.platform === "darwin")
    dirs.push(join(home, "Library", "Application Support", "orca"));
  else if (process.platform === "win32" && process.env.APPDATA)
    dirs.push(join(process.env.APPDATA, "orca"));
  else dirs.push(join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "orca"));
  return dirs;
}
async function claudeProjectRoots() {
  const roots = [join(homedir(), ".claude")];
  if (process.env.CLAUDE_CONFIG_DIR) roots.push(process.env.CLAUDE_CONFIG_DIR);
  for (const dir of orcaDataDirs()) {
    try {
      for (const profile of await readdir(join(dir, "claude-profiles"), { withFileTypes: true }))
        if (profile.isDirectory())
          roots.push(join(dir, "claude-profiles", profile.name, "home"));
    } catch {
    }
  }
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const root of roots) {
    try {
      const real = await realpath(join(root, "projects"));
      if (!seen.has(real)) {
        seen.add(real);
        result.push(real);
      }
    } catch {
    }
  }
  return result;
}
async function readTranscript(file) {
  const handle = await openFile(file, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, MAX_TRANSCRIPT_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text2 = buffer.toString("utf8");
    return size > length ? text2.slice(text2.indexOf("\n") + 1) : text2;
  } finally {
    await handle.close();
  }
}
function conversationTexts(transcript) {
  const texts = [];
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row?.type !== "user" && row?.type !== "assistant" || row.isSidechain || row.isMeta)
      continue;
    const content = row.message?.content;
    const parts = typeof content === "string" ? [content] : Array.isArray(content) ? content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text) : [];
    for (const part of parts)
      texts.push(part.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " "));
  }
  return texts;
}
function issueKeys(texts) {
  const keys = [];
  for (let index = texts.length - 1; index >= 0; index--) {
    const found = [...texts[index].matchAll(MENTION)].map((match) => `${match[1].toUpperCase()}-${match[2]}`);
    for (let item = found.length - 1; item >= 0; item--) {
      const key = found[item];
      if (!keys.includes(key)) keys.push(key);
      if (keys.length >= MAX_SESSION_KEYS) return keys;
    }
  }
  return keys;
}
function isNamingTask(texts) {
  return /^Name this chat from the user's first request/.test(texts[0] ?? "");
}
async function workspacePath(host, context) {
  const workspaceId = context.workspaceId;
  const branch = String(context.branch || "").replace(/^refs\/heads\//, "");
  try {
    const { workspaces } = await host.call("workspace.list");
    const local = workspaces.filter((row) => row.path && (row.hostId === "local" || row.hostId === null));
    const match = local.find((row) => row.id === workspaceId || workspaceId.endsWith(`::${row.path}`)) ?? local.filter(
      (row) => row.name === context.displayName && String(row.branch || "").replace(/^refs\/heads\//, "") === branch
    ).at(0);
    if (match?.path) return match.path;
  } catch {
  }
  const separator = workspaceId.indexOf("::");
  return separator >= 0 ? workspaceId.slice(separator + 2) : "";
}
async function sessionKeys(host) {
  const context = await host.call("workspace.readContext");
  if (!context?.workspaceId) return { status: "no-workspace", keys: [] };
  const path = await workspacePath(host, context);
  if (!path) return { status: "no-workspace", keys: [] };
  let agents = [];
  try {
    agents = (await host.call("agents.list")).agents ?? [];
  } catch {
  }
  const titles = new Map(
    agents.filter((agent) => agent.sessionId).map((agent) => [String(agent.sessionId), agent.title || ""])
  );
  const files = [];
  for (const root of await claudeProjectRoots()) {
    const dir = join(root, transcriptDirName(path));
    let names;
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(dir, name);
      try {
        const info = await stat(file);
        if (info.isFile()) files.push({ file, id: basename(name, ".jsonl"), mtime: info.mtimeMs });
      } catch {
      }
    }
  }
  const live = files.filter((entry) => titles.has(entry.id));
  const candidates = (live.length ? live : files).sort((a, b) => b.mtime - a.mtime);
  for (const candidate of candidates.slice(0, 10)) {
    let texts;
    try {
      texts = conversationTexts(await readTranscript(candidate.file));
    } catch {
      continue;
    }
    if (!texts.length || isNamingTask(texts)) continue;
    const keys = issueKeys(texts);
    const title = titles.get(candidate.id) || [...titles.values()].find(Boolean) || "";
    return { status: keys.length ? "ok" : "no-keys", keys, title: title.slice(0, 200) };
  }
  return { status: "no-chat", keys: [] };
}

// plugins/jira-tasks/src/open-panel.ts
function parseOpenResponse(stdout, executionError = null) {
  if (executionError && (executionError.killed || executionError.signal || typeof executionError.code !== "number" || ![1, 2, 3].includes(executionError.code)))
    throw new Error("The Orca CLI did not finish normally.");
  const answer = JSON.parse(stdout);
  if (typeof answer?.ok !== "boolean" || executionError && answer.ok)
    throw new Error("Invalid plugin open response.");
  if (answer.error?.code === "plugin_not_found" && executionError && executionError.code !== 1)
    throw new Error("Inconsistent plugin not-found response.");
  return answer;
}
var runOpen = (key, signal) => new Promise((resolve, reject) => {
  execFile2(
    cliExecutable(),
    [
      "plugin",
      "open",
      key,
      "--panel",
      "jira-tasks",
      "--environment",
      "local",
      "--json"
    ],
    { signal, timeout: 1e4, maxBuffer: 512 * 1024, windowsHide: true },
    (error, stdout) => {
      try {
        resolve(parseOpenResponse(stdout, error));
      } catch {
        reject(
          new Error(
            "Could not open Jira Tasks. Check that Orca is running and a workspace is open."
          )
        );
      }
    }
  );
});
async function openPanel(signal, open = runOpen) {
  signal.throwIfAborted();
  let result = await open("tienne.jira-tasks", signal);
  if (!result.ok && result.error?.code === "plugin_not_found") {
    signal.throwIfAborted();
    result = await open("local.jira-tasks", signal);
  }
  signal.throwIfAborted();
  if (!result.ok)
    throw new Error(
      result.error?.message || "Could not open Jira Tasks. Open a workspace and try again."
    );
}

// plugins/jira-tasks/src/worker.ts
function activate(orca) {
  orca.commands.register(
    "jira-tasks.open",
    (_args, { signal }) => openPanel(signal)
  );
  const jira = createJiraClient();
  const avatar = createAvatarLoader();
  orca.panels.handle(
    "jira.avatar",
    (input, { signal }) => avatar(input, signal)
  );
  orca.panels.handle(
    "jira.connection",
    (_input, { signal }) => jira.connection(signal)
  );
  orca.panels.handle("jira.list", async (input, { signal }) => {
    if (input?.filter !== "session") return jira.list(input, signal);
    siteId(input.siteId);
    const session = await sessionKeys(orca.host);
    const result = await jira.byKeys({ siteId: input.siteId, keys: session.keys }, signal);
    return {
      ...result,
      session: {
        status: session.status === "ok" && !result.tasks.length ? "no-keys" : session.status,
        title: session.title ?? "",
        mentioned: session.keys.length
      }
    };
  });
  orca.panels.handle(
    "jira.searchAll",
    (input, { signal }) => jira.searchAll(input, signal)
  );
  orca.panels.handle(
    "jira.children",
    (input, { signal }) => jira.children(input, signal)
  );
  orca.panels.handle(
    "jira.issue",
    (input, { signal }) => jira.issue(input, signal)
  );
}
export {
  activate as default
};
