// src/host/index.ts
import { credentialRef } from "@deepseek-ai/dsh-credentials";

// src/host/sessions.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";

// src/host/pricing.ts
var DEFAULT_TIMEZONE = "Asia/Shanghai";
var DEFAULT_PEAK_WINDOWS = [[9, 12], [14, 18]];
var ZERO_UNIT = Object.freeze({ input: 0, cacheRead: 0, output: 0 });
var OFFICIAL_PRICING_POLICIES = [
  {
    since: "2025-02-09T00:00:00+08:00",
    label: "deepseek-chat / deepseek-reasoner \u6807\u51C6\u4EF7\uFF082025-02-09 \u4F18\u60E0\u671F\u7ED3\u675F\uFF09",
    prices: {
      "deepseek-chat": {
        cny: { input: 2, cacheRead: 0.5, output: 8 },
        usd: { input: 0.28, cacheRead: 0.028, output: 0.42 }
      },
      "deepseek-reasoner": {
        cny: { input: 4, cacheRead: 1, output: 16 },
        usd: { input: 0.55, cacheRead: 0.055, output: 1.68 }
      },
      "*": {
        cny: { input: 2, cacheRead: 0.5, output: 8 },
        usd: { input: 0.28, cacheRead: 0.028, output: 0.42 }
      }
    }
  },
  {
    since: "2026-05-22T00:00:00+08:00",
    label: "V4 \u7CFB\u5217 75% \u964D\u4EF7\u8F6C\u6C38\u4E45\uFF08deepseek-v4-flash / deepseek-v4-pro \u4E0A\u7EBF\uFF09",
    prices: {
      "deepseek-v4-flash": {
        cny: { input: 1, cacheRead: 0.02, output: 2 },
        usd: { input: 0.14, cacheRead: 28e-4, output: 0.28 }
      },
      "deepseek-v4-pro": {
        cny: { input: 3, cacheRead: 0.025, output: 6 },
        usd: { input: 0.435, cacheRead: 3625e-6, output: 0.87 }
      },
      "*": {
        cny: { input: 1, cacheRead: 0.02, output: 2 },
        usd: { input: 0.14, cacheRead: 28e-4, output: 0.28 }
      }
    }
  },
  {
    since: "2026-08-17T00:00:00+08:00",
    label: "\u5CF0\u8C37\u5B9A\u4EF7\uFF1A\u9AD8\u5CF0 09:00-12:00 / 14:00-18:00\uFF08\u5317\u4EAC\u65F6\u95F4\uFF09\uFF0C\u7A7A\u95F2\u65F6\u6BB5\u534A\u4EF7",
    peak: {
      "deepseek-v4-flash": {
        cny: { input: 3, cacheRead: 0.1, output: 9 },
        usd: { input: 0.44, cacheRead: 0.014, output: 1.32 }
      },
      "deepseek-v4-pro": {
        cny: { input: 9, cacheRead: 0.3, output: 27 },
        usd: { input: 1.32, cacheRead: 0.044, output: 3.96 }
      },
      "*": {
        cny: { input: 3, cacheRead: 0.1, output: 9 },
        usd: { input: 0.44, cacheRead: 0.014, output: 1.32 }
      }
    },
    offPeak: {
      "deepseek-v4-flash": {
        cny: { input: 1.5, cacheRead: 0.05, output: 4.5 },
        usd: { input: 0.22, cacheRead: 7e-3, output: 0.66 }
      },
      "deepseek-v4-pro": {
        cny: { input: 4.5, cacheRead: 0.15, output: 13.5 },
        usd: { input: 0.66, cacheRead: 0.022, output: 1.98 }
      },
      "*": {
        cny: { input: 1.5, cacheRead: 0.05, output: 4.5 },
        usd: { input: 0.22, cacheRead: 7e-3, output: 0.66 }
      }
    }
  }
];
function isPeak(timeMs, timezone = DEFAULT_TIMEZONE, windows = DEFAULT_PEAK_WINDOWS) {
  let hour;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      hour: "numeric",
      minute: "numeric"
    }).formatToParts(new Date(timeMs));
    hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0") % 24;
  } catch {
    hour = -1;
  }
  return windows.some(([start, end]) => hour >= start && hour < end);
}
function priceFor(model, table) {
  return table[model] ?? table["*"] ?? { cny: ZERO_UNIT, usd: ZERO_UNIT };
}
function mergeUnit(base, over) {
  return {
    cny: { ...base.cny, ...over?.cny ?? {} },
    usd: { ...base.usd, ...over?.usd ?? {} }
  };
}
function priceAt(model, timeMs, opts) {
  const { timezone = DEFAULT_TIMEZONE, peakWindows = DEFAULT_PEAK_WINDOWS, policies = OFFICIAL_PRICING_POLICIES } = opts ?? {};
  const peak = isPeak(timeMs, timezone, peakWindows);
  const applicable = policies.filter((policy) => timeMs >= Date.parse(policy.since));
  const scope = applicable.length > 0 ? applicable : [policies[0]];
  let winner;
  let named = false;
  let baseTable;
  for (let index = scope.length - 1; index >= 0; index--) {
    const policy = scope[index];
    const table = policy.peak !== void 0 && policy.offPeak !== void 0 ? peak ? policy.peak : policy.offPeak : policy.prices;
    if (table !== void 0 && table[model] !== void 0) {
      winner = policy;
      named = true;
      baseTable = table;
      break;
    }
  }
  if (winner === void 0 || baseTable === void 0) {
    winner = scope[scope.length - 1];
    baseTable = winner.peak !== void 0 && winner.offPeak !== void 0 ? peak ? winner.peak : winner.offPeak : winner.prices;
  }
  const unit = named ? priceFor(model, baseTable) : mergeUnit(priceFor(model, baseTable));
  return {
    cny: unit.cny,
    usd: unit.usd,
    mode: winner.peak !== void 0 && winner.offPeak !== void 0 ? peak ? "peak" : "offPeak" : "flat"
  };
}
function createPriceCache() {
  const cache = /* @__PURE__ */ new Map();
  return (model, timeMs) => {
    const key = `${model}\0${Math.floor(timeMs / 36e5)}`;
    let hit = cache.get(key);
    if (hit === void 0) {
      hit = priceAt(model, timeMs);
      cache.set(key, hit);
    }
    return hit;
  };
}
function costOf(usage, unit) {
  const inputTokens = usage.inputTokens ?? 0;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cost = (inputTokens * unit.cny.input + cacheReadTokens * unit.cny.cacheRead + outputTokens * unit.cny.output) / 1e6;
  const costUsd = (inputTokens * unit.usd.input + cacheReadTokens * unit.usd.cacheRead + outputTokens * unit.usd.output) / 1e6;
  return { inputTokens, cacheReadTokens, outputTokens, cost, costUsd };
}

// src/host/sessions.ts
var ZSTD_MAGIC = 4247762216;
var DAY_TIMEZONE = "Asia/Shanghai";
function dshHome(homeFn) {
  if (typeof homeFn === "function") {
    try {
      return homeFn("");
    } catch {
    }
  }
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}
function isSessionArtifact(filename) {
  return filename === "session.jsonl" || filename === "session.jsonl.zstd";
}
function listSessionLogs(home) {
  const root = join(home, "sessions");
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && isSessionArtifact(entry.name)) {
        out.push({ id: basename(dirname(full)), path: full });
      }
    }
  };
  walk(root);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
function fileRevision(meta) {
  try {
    const st = statSync(meta.path);
    return `${st.mtimeMs}\0${st.size}`;
  } catch {
    return "";
  }
}
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
    offset += 4;
    if (offset === buffer.length) break;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) break;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    for (; ; ) {
      if (buffer.length - offset < 3) break;
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = blockHeader >>> 1 & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) break;
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) break;
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) break;
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}
function readLogContent(meta) {
  try {
    const buffer = readFileSync(meta.path);
    if (meta.path.endsWith(".zstd")) {
      const frames = scanZstdFrames(buffer);
      if (frames.length === 0) return void 0;
      const parts = [];
      for (const frame of frames) {
        try {
          parts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)));
        } catch {
        }
      }
      if (parts.length === 0) return void 0;
      return Buffer.concat(parts).toString("utf8");
    }
    return buffer.toString("utf8");
  } catch {
    return void 0;
  }
}
function shanghaiDay(timeMs) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DAY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(timeMs));
  const value = (type) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("year")}-${value("month")}-${value("day")}`;
}
function spendWindowDays(nowMs, days) {
  const endDay = shanghaiDay(nowMs);
  const startDay = shanghaiDay(nowMs - (days - 1) * 864e5);
  return { startDay, endDay };
}
function emptyDay() {
  return { cost: 0, costUsd: 0, calls: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
}
function replayLogContent(content, price) {
  const out = [];
  let currentModel = "unknown";
  for (const line of content.split("\n")) {
    if (line === "") continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event === null || typeof event !== "object") continue;
    if (event.type === "request/header") {
      try {
        const data2 = event.data;
        const model = data2?.header?.config?.model;
        if (typeof model === "string" && model !== "") currentModel = model;
      } catch {
      }
      continue;
    }
    if (event.type !== "assistant/message") continue;
    const data = event.data;
    const usage = data?.usage;
    if (usage === null || typeof usage !== "object") continue;
    const time = typeof event.time === "number" && Number.isFinite(event.time) ? event.time : Date.now();
    const breakdown = costOf(
      {
        inputTokens: toFinite(usage.inputTokens),
        cacheReadTokens: toFinite(usage.cacheReadTokens),
        outputTokens: toFinite(usage.outputTokens)
      },
      price(currentModel, time)
    );
    out.push({
      time,
      cost: breakdown.cost,
      costUsd: breakdown.costUsd,
      inputTokens: breakdown.inputTokens,
      cacheReadTokens: breakdown.cacheReadTokens,
      outputTokens: breakdown.outputTokens
    });
  }
  return out;
}
function toFinite(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return void 0;
}
var logCache = /* @__PURE__ */ new Map();
function aggregateSessionSpend(home, options = {}) {
  const reader = options.reader ?? {
    listLogs: () => listSessionLogs(home),
    revision: fileRevision,
    readContent: readLogContent
  };
  const price = createPriceCache();
  const byDay = /* @__PURE__ */ new Map();
  const maxEvents = options.maxEvents ?? 2e5;
  let sessionsWithUsage = 0;
  let calls = 0;
  let events = 0;
  const logs = reader.listLogs();
  for (const meta of logs) {
    const rev = reader.revision(meta);
    if (rev === "") continue;
    let cached = logCache.get(meta.id);
    if (cached === void 0 || cached.rev !== rev) {
      const content = reader.readContent(meta);
      if (content === void 0) continue;
      const priced = replayLogContent(content, price);
      if (priced.length === 0) continue;
      cached = { rev, priced };
      logCache.set(meta.id, cached);
      if (logCache.size > 400) {
        const keys = [...logCache.keys()];
        for (const key of keys.slice(0, 200)) logCache.delete(key);
      }
    }
    if (cached.priced.length === 0) continue;
    sessionsWithUsage += 1;
    for (const item of cached.priced) {
      if (events >= maxEvents) break;
      events += 1;
      calls += 1;
      const day = shanghaiDay(item.time);
      let bucket = byDay.get(day);
      if (bucket === void 0) {
        bucket = emptyDay();
        byDay.set(day, bucket);
      }
      bucket.cost += item.cost;
      bucket.costUsd += item.costUsd;
      bucket.calls += 1;
      bucket.inputTokens += item.inputTokens;
      bucket.cacheReadTokens += item.cacheReadTokens;
      bucket.outputTokens += item.outputTokens;
    }
  }
  const sortedDays = [...byDay.keys()].sort();
  const byDayRecord = {};
  for (const day of sortedDays) {
    const b = byDay.get(day);
    byDayRecord[day] = {
      cost: round2(b.cost),
      costUsd: round2(b.costUsd),
      calls: b.calls,
      inputTokens: b.inputTokens,
      cacheReadTokens: b.cacheReadTokens,
      outputTokens: b.outputTokens
    };
  }
  return { sessionsScanned: logs.length, sessionsWithUsage, calls, byDay: byDayRecord };
}
function round2(value) {
  return Math.round(value * 100) / 100;
}
function sumWindow(byDay, startDay, endDay) {
  let cost = 0;
  let costUsd = 0;
  let calls = 0;
  for (const [day, spend] of Object.entries(byDay)) {
    if (day < startDay || day > endDay) continue;
    cost += spend.cost;
    costUsd += spend.costUsd;
    calls += spend.calls;
  }
  return { cost: round2(cost), costUsd: round2(costUsd), calls, startDay, endDay };
}

// src/host/official.ts
var PLATFORM_USAGE_URL = "https://platform.deepseek.com/api/v0/usage/cost";
var TIMEOUT_MS = 15e3;
function parsePlatformDays(body, todayDate) {
  const data = body && typeof body === "object" ? body.data : void 0;
  const biz = data && typeof data === "object" ? data.biz_data : void 0;
  const container = Array.isArray(biz) ? biz[0] : biz;
  const days = container && typeof container === "object" ? container.days : void 0;
  if (!Array.isArray(days)) return [];
  const rows = [];
  for (const entry of days) {
    if (entry === null || typeof entry !== "object") continue;
    const date = entry.date;
    const dataList = entry.data;
    if (typeof date !== "string" || !Array.isArray(dataList)) continue;
    if (date > todayDate) continue;
    let total = 0;
    for (const modelEntry of dataList) {
      if (modelEntry === null || typeof modelEntry !== "object") continue;
      const usageList = modelEntry.usage;
      if (!Array.isArray(usageList)) continue;
      for (const usage of usageList) {
        if (usage === null || typeof usage !== "object") continue;
        const value = toFinite2(usage.cost ?? usage.amount);
        if (Number.isFinite(value)) total += value;
      }
    }
    rows.push({ date, cost: Math.round(total * 100) / 100 });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}
function toFinite2(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
function shanghaiDateString(d = /* @__PURE__ */ new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(d);
  const value = (type) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("year")}-${value("month")}-${value("day")}`;
}
async function fetchPlatformMonth(token, year, month, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const url = `${PLATFORM_USAGE_URL}?month=${month}&year=${year}`;
  try {
    const response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "x-app-version": "1.0.0",
        Origin: "https://platform.deepseek.com",
        Referer: "https://platform.deepseek.com/usage"
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      return { ok: false, days: [], error: `DeepSeek \u5E73\u53F0\u7528\u91CF\u63A5\u53E3\u8FD4\u56DE HTTP ${response.status}` };
    }
    const body = await response.json();
    const data = body && typeof body === "object" ? body.data : void 0;
    const biz = data && typeof data === "object" ? data.biz_code : void 0;
    const code = body && typeof body === "object" ? body.code : void 0;
    if (code !== 0 || biz !== 0) {
      const numeric = Number(code ?? biz ?? "unknown");
      if (numeric === 40002 || numeric === 40003) {
        return { ok: false, days: [], expired: true, error: "DEEPSEEK_PLATFORM_TOKEN \u5DF2\u8FC7\u671F\uFF1A\u8BF7\u91CD\u65B0\u767B\u5F55 platform.deepseek.com \u5E76\u66F4\u65B0 userToken" };
      }
      return { ok: false, days: [], error: `DeepSeek \u5E73\u53F0\u7528\u91CF\u63A5\u53E3\u9519\u8BEF (code ${String(code ?? biz ?? "unknown")})` };
    }
    return { ok: true, days: parsePlatformDays(body, shanghaiDateString()) };
  } catch (error) {
    return { ok: false, days: [], error: error instanceof Error ? error.message : String(error) };
  }
}
async function fetchPlatformWindow(token, days, options = {}) {
  const now = /* @__PURE__ */ new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const current = await fetchPlatformMonth(token, year, month, options);
  if (!current.ok) return current;
  const rows = [...current.days];
  const windowStart = new Date(Date.now() - (days - 1) * 864e5);
  const startMonth = windowStart.getMonth() + 1;
  const startYear = windowStart.getFullYear();
  if (startYear !== year || startMonth !== month) {
    const previous = await fetchPlatformMonth(token, startYear, startMonth, options);
    if (previous.ok) {
      rows.push(...previous.days);
      rows.sort((a, b) => a.date.localeCompare(b.date));
    }
  }
  return { ok: true, days: rows };
}
function sumPlatformWindow(days, startDay, endDay) {
  let total = 0;
  for (const row of days) {
    if (row.date < startDay || row.date > endDay) continue;
    total += row.cost;
  }
  return Math.round(total * 100) / 100;
}

// src/host/tasks.ts
import { readFileSync as readFileSync2, statSync as statSync2 } from "node:fs";
import { zstdDecompressSync as zstdDecompressSync2 } from "node:zlib";
var PARSE_TYPES = /* @__PURE__ */ new Set([
  "todo/write",
  "tool/call",
  "step/start",
  "turn/start"
]);
function freshCursor(kind) {
  return {
    kind,
    rev: "",
    processedFrames: 0,
    processedBytes: 0,
    todoTotal: 0,
    todoDone: 0,
    todoCurrent: null,
    lastTool: null,
    lastStep: null,
    lastTurn: null,
    lastEventType: null
  };
}
function processLogText(text, cursor) {
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const type = line[0] === "{" ? line.slice(0, 60).match(/^\{?"type":"([^"]+)"/)?.[1] : null;
    if (type === void 0 || type === null) continue;
    cursor.lastEventType = type;
    if (!PARSE_TYPES.has(type)) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== type) continue;
    const data = event.data;
    if (type === "todo/write") {
      const todos = Array.isArray(data?.todos) ? data.todos : [];
      const done = todos.filter((t) => t.status === "completed").length;
      const current = todos.find((t) => t.status === "in_progress");
      cursor.todoTotal = todos.length;
      cursor.todoDone = done;
      cursor.todoCurrent = typeof current?.content === "string" ? current.content : null;
    } else if (type === "tool/call") {
      const turn = toInt(data?.turn);
      const step = toInt(data?.step);
      const name2 = typeof data?.name === "string" ? data.name : null;
      if (turn !== null && step !== null && name2 !== null) cursor.lastTool = { turn, step, name: name2 };
    } else if (type === "step/start") {
      const turn = toInt(data?.turn);
      const step = toInt(data?.step);
      if (turn !== null && step !== null) cursor.lastStep = { turn, step };
      if (turn !== null) cursor.lastTurn = turn;
    } else if (type === "turn/start") {
      const turn = toInt(data?.turn);
      if (turn !== null) cursor.lastTurn = turn;
    }
  }
}
function toInt(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}
function refreshCursor(meta, cursor) {
  let stat;
  try {
    stat = statSync2(meta.path);
  } catch {
    return false;
  }
  const rev = `${stat.mtimeMs}\0${stat.size}`;
  if (cursor.rev !== "" && cursor.rev === rev) return false;
  let buffer;
  try {
    buffer = readFileSync2(meta.path);
  } catch {
    return false;
  }
  if (meta.path.endsWith(".zstd") && cursor.kind === "zstd") {
    const frames = scanZstdFrames(buffer);
    if (frames.length < cursor.processedFrames) {
      cursor.processedFrames = 0;
      cursor.todoTotal = 0;
      cursor.todoDone = 0;
      cursor.todoCurrent = null;
      cursor.lastTool = null;
      cursor.lastStep = null;
      cursor.lastTurn = null;
      cursor.lastEventType = null;
    }
    for (const frame of frames.slice(cursor.processedFrames)) {
      try {
        processLogText(zstdDecompressSync2(buffer.subarray(frame.start, frame.end)).toString("utf8"), cursor);
      } catch {
      }
    }
    cursor.processedFrames = frames.length;
  } else if (!meta.path.endsWith(".zstd") && cursor.kind === "plain") {
    const text = buffer.toString("utf8");
    const start = Math.min(cursor.processedBytes, text.length);
    if (start < text.length) {
      const raw = text.slice(start);
      const nl = raw.lastIndexOf("\n");
      if (nl >= 0) {
        processLogText(raw.slice(0, nl + 1), cursor);
        cursor.processedBytes = start + nl + 1;
      }
    }
  } else {
    const fresh = freshCursor(meta.path.endsWith(".zstd") ? "zstd" : "plain");
    Object.assign(cursor, fresh);
    return refreshCursor(meta, cursor);
  }
  cursor.rev = rev;
  return true;
}
var cursors = /* @__PURE__ */ new Map();
function progressForSession(logIndex, id) {
  const meta = logIndex.get(id);
  if (meta === void 0) {
    cursors.delete(id);
    return { id, found: false, totalTodos: 0, doneTodos: 0, currentTodo: null, pct: null, stage: "idle", tool: null, turn: null, step: null, updatedAt: null };
  }
  let cursor = cursors.get(id);
  if (cursor === void 0) {
    cursor = freshCursor(meta.path.endsWith(".zstd") ? "zstd" : "plain");
    cursors.set(id, cursor);
  }
  refreshCursor(meta, cursor);
  const pct = cursor.todoTotal > 0 ? Math.round(cursor.todoDone / cursor.todoTotal * 100) : null;
  const last = cursor.lastEventType;
  const stage = last === "tool/call" || last === "tool-call-chunks" ? "tool" : last !== null ? "thinking" : "idle";
  const tool = cursor.lastTool !== null ? cursor.lastTool.name : null;
  const turn = cursor.lastTool !== null ? cursor.lastTool.turn : cursor.lastTurn;
  const step = cursor.lastTool !== null ? cursor.lastTool.step : cursor.lastStep !== null ? cursor.lastStep.step : null;
  let updatedAt = null;
  try {
    updatedAt = statSync2(meta.path).mtimeMs;
  } catch {
  }
  return {
    id,
    found: true,
    totalTodos: cursor.todoTotal,
    doneTodos: cursor.todoDone,
    currentTodo: cursor.todoCurrent,
    pct,
    stage,
    tool,
    turn,
    step,
    updatedAt
  };
}

// src/host/index.ts
var name = "dsh-whale-pet";
var inject = ["credentials", "webServer"];
var VERSION = "0.2.0";
var HEALTH_PATH = "/api/whale-pet/health";
var STATE_PATH = "/api/whale-pet/state";
var TASKS_PATH = "/api/whale-pet/tasks";
var PUBLIC_BASE_URL = "https://api.deepseek.com";
var BASE_URL_ENV = "DEEPSEEK_BASE_URL";
var CREDENTIAL_REF = credentialRef("DEEPSEEK_API_KEY");
var PLATFORM_TOKEN_REF = credentialRef("DEEPSEEK_PLATFORM_TOKEN");
var BALANCE_PATH = "/user/balance";
var BALANCE_CACHE_MS = 55e3;
var SPEND_CACHE_MS = 6e4;
var FETCH_TIMEOUT_MS = 15e3;
var SPEND_WINDOW_DAYS = 7;
var JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};
var balanceMemo;
var spendMemo;
function balanceUrl() {
  const base = process.env[BASE_URL_ENV] ?? PUBLIC_BASE_URL;
  return `${base.replace(/\/+$/, "")}${BALANCE_PATH}`;
}
function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}
async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (chunks.reduce((sum, c) => sum + c.length, 0) > 1024 * 1024) break;
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function parseBalanceBody(body, fetchedAt) {
  if (body === null || typeof body !== "object") return null;
  const record = body;
  const infos = Array.isArray(record.balance_infos) ? record.balance_infos.filter((info) => info !== null && typeof info === "object").map((info) => ({
    currency: typeof info.currency === "string" ? info.currency : "CNY",
    totalBalance: toFiniteNumber(info.total_balance),
    grantedBalance: toFiniteNumber(info.granted_balance),
    toppedUpBalance: toFiniteNumber(info.topped_up_balance)
  })) : [];
  if (infos.length === 0) return null;
  const primary = infos.find((info) => info.currency === "CNY") ?? infos[0];
  return {
    available: record.is_available !== false,
    currency: primary.currency,
    totalBalance: primary.totalBalance,
    grantedBalance: primary.grantedBalance,
    toppedUpBalance: primary.toppedUpBalance,
    infos,
    fetchedAt
  };
}
async function fetchBalance(ctx) {
  if (balanceMemo !== void 0 && Date.now() - balanceMemo.at < BALANCE_CACHE_MS) {
    return balanceMemo.value;
  }
  let snapshot = null;
  try {
    const hit = await ctx.credentials.resolve(CREDENTIAL_REF);
    if (hit !== void 0 && typeof hit.value === "string" && hit.value !== "") {
      const response = await fetch(balanceUrl(), {
        headers: {
          Authorization: `Bearer ${hit.value}`,
          Accept: "application/json"
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
      if (response.ok) {
        snapshot = parseBalanceBody(await response.json(), Date.now());
      }
    }
  } catch {
  }
  balanceMemo = { at: Date.now(), value: snapshot };
  return snapshot;
}
async function computeSpend(ctx, nowMs = Date.now()) {
  if (spendMemo !== void 0 && nowMs - spendMemo.at < SPEND_CACHE_MS) {
    return spendMemo.value;
  }
  const errors = [];
  const window = spendWindowDays(nowMs, SPEND_WINDOW_DAYS);
  let official = null;
  try {
    const platformHit = await ctx.credentials.resolve(PLATFORM_TOKEN_REF);
    if (platformHit !== void 0 && typeof platformHit.value === "string" && platformHit.value !== "") {
      const result = await fetchPlatformWindow(platformHit.value, SPEND_WINDOW_DAYS);
      if (result.ok) {
        official = {
          today: sumPlatformWindow(result.days, window.endDay, window.endDay),
          days7: sumPlatformWindow(result.days, window.startDay, window.endDay)
        };
      } else {
        errors.push(result.error ?? "official unavailable");
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  let home = "";
  try {
    const homeFn = typeof ctx.get === "function" ? ctx.get("dshHomePath") : void 0;
    home = dshHome(typeof homeFn === "function" ? homeFn : void 0);
  } catch {
    home = dshHome();
  }
  const aggregates = aggregateSessionSpend(home);
  const estimateToday = sumWindow(aggregates.byDay, window.endDay, window.endDay);
  const estimateDays7 = sumWindow(aggregates.byDay, window.startDay, window.endDay);
  const today = official !== null ? { amount: official.today, amountUsd: null, calls: estimateToday.calls, source: "official" } : { amount: estimateToday.cost, amountUsd: estimateToday.costUsd, calls: estimateToday.calls, source: "estimate" };
  const days7 = official !== null ? { amount: official.days7, amountUsd: null, calls: estimateDays7.calls, source: "official" } : { amount: estimateDays7.cost, amountUsd: estimateDays7.costUsd, calls: estimateDays7.calls, source: "estimate" };
  const value = {
    today,
    days7,
    byDay: aggregates.byDay,
    computedAt: nowMs
  };
  spendMemo = { at: nowMs, value };
  return value;
}
function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: HEALTH_PATH,
      handler: (_req, res) => {
        sendJson(res, 200, { plugin: name, version: VERSION, ok: true });
      }
    }),
    "dsh-whale-pet: health route"
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: STATE_PATH,
      handler: async (_req, res) => {
        try {
          const [balance, spend] = await Promise.all([fetchBalance(ctx), computeSpend(ctx)]);
          sendJson(res, 200, {
            ok: true,
            fetchedAt: Date.now(),
            balance,
            spend
          });
        } catch (error) {
          ctx.logger?.warn?.("dsh-whale-pet: state route failed");
          ctx.logger?.warn?.(error);
          sendJson(res, 500, { ok: false, error: "internal", message: error instanceof Error ? error.message : String(error) });
        }
      }
    }),
    "dsh-whale-pet: state route"
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: TASKS_PATH,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req);
          const rawIds = Array.isArray(body.ids) ? body.ids : [];
          const ids = rawIds.filter((id) => typeof id === "string");
          let home = "";
          try {
            const homeFn = typeof ctx.get === "function" ? ctx.get("dshHomePath") : void 0;
            home = dshHome(typeof homeFn === "function" ? homeFn : void 0);
          } catch {
            home = dshHome();
          }
          const logs = listSessionLogs(home);
          const index = new Map(logs.map((meta) => [meta.id, meta]));
          const tasks = ids.map((id) => progressForSession(index, id));
          sendJson(res, 200, { ok: true, fetchedAt: Date.now(), tasks });
        } catch (error) {
          ctx.logger?.warn?.("dsh-whale-pet: tasks route failed");
          ctx.logger?.warn?.(error);
          sendJson(res, 500, { ok: false, error: "internal", message: error instanceof Error ? error.message : String(error) });
        }
      }
    }),
    "dsh-whale-pet: tasks route"
  );
}
export {
  apply,
  inject,
  name
};
