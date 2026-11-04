// src/host/index.ts
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { readFileSync as readFileSync6 } from "node:fs";
import { fileURLToPath } from "node:url";

// src/host/sessions.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { constants, zstdDecompressSync } from "node:zlib";

// src/host/pricing.ts
var DEFAULT_TIMEZONE = "Asia/Shanghai";
var DEFAULT_PEAK_WINDOWS = [[9, 12], [14, 18]];
var OFFICIAL_MODEL_ALIASES = {
  "deepseek-flash": "deepseek-v4-flash"
};
var ZERO_PRICE = Object.freeze({
  cny: Object.freeze({ input: 0, cacheRead: 0, output: 0 }),
  usd: Object.freeze({ input: 0, cacheRead: 0, output: 0 })
});
var ZERO_UNIT = ZERO_PRICE.cny;
var DEFAULT_USD_TO_CNY = 7.2;
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
function priceAt(model, timeMs, opts) {
  const normalizedOptions = typeof opts === "string" ? { provider: opts } : opts;
  const {
    timezone = DEFAULT_TIMEZONE,
    peakWindows = DEFAULT_PEAK_WINDOWS,
    policies = OFFICIAL_PRICING_POLICIES,
    provider = "",
    externalCatalog,
    usdToCny = DEFAULT_USD_TO_CNY
  } = normalizedOptions ?? {};
  if (provider !== "" && provider !== "deepseek" && provider !== "deepseek-official") {
    const external = externalCatalog?.providers[provider]?.models[model];
    if (external !== void 0) {
      const cny = external.cny ?? {
        input: external.usd.input * usdToCny,
        cacheRead: external.usd.cacheRead * usdToCny,
        output: external.usd.output * usdToCny
      };
      return { cny, usd: external.usd, mode: "flat", source: "models.dev" };
    }
    return { cny: ZERO_UNIT, usd: ZERO_UNIT, mode: "flat", source: "none" };
  }
  const peak = isPeak(timeMs, timezone, peakWindows);
  const pricedModel = OFFICIAL_MODEL_ALIASES[model] ?? model;
  const applicable = policies.filter((policy) => timeMs >= Date.parse(policy.since));
  const scope = applicable.length > 0 ? applicable : [policies[0]];
  let winner;
  let named = false;
  let baseTable;
  for (let index = scope.length - 1; index >= 0; index--) {
    const policy = scope[index];
    const table = policy.peak !== void 0 && policy.offPeak !== void 0 ? peak ? policy.peak : policy.offPeak : policy.prices;
    if (table !== void 0 && table[pricedModel] !== void 0) {
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
  const unit = named && baseTable !== void 0 ? priceFor(pricedModel, baseTable) : { cny: ZERO_UNIT, usd: ZERO_UNIT };
  return {
    cny: unit.cny,
    usd: unit.usd,
    mode: winner.peak !== void 0 && winner.offPeak !== void 0 ? peak ? "peak" : "offPeak" : "flat",
    source: named ? "official" : "none"
  };
}
function officialPriceRows(timeMs, opts) {
  const timezone = opts?.timezone ?? DEFAULT_TIMEZONE;
  const peakWindows = opts?.peakWindows ?? DEFAULT_PEAK_WINDOWS;
  const policies = opts?.policies ?? OFFICIAL_PRICING_POLICIES;
  const models = [];
  const seen = /* @__PURE__ */ new Set();
  for (let index = policies.length - 1; index >= 0; index--) {
    const policy = policies[index];
    for (const table of [policy.prices, policy.peak, policy.offPeak]) {
      if (table === void 0) continue;
      for (const model of Object.keys(table)) {
        if (model === "*" || seen.has(model)) continue;
        seen.add(model);
        models.push(model);
      }
    }
  }
  return models.map((model) => {
    const price = priceAt(model, timeMs, { timezone, peakWindows, policies });
    return { model, cny: price.cny, usd: price.usd, mode: price.mode };
  });
}
function createPriceCache(opts) {
  const cache = /* @__PURE__ */ new Map();
  return (model, timeMs, provider = "") => {
    const catalogRevision = opts?.externalCatalog?.revision ?? opts?.externalCatalog?.fetchedAt ?? 0;
    const key = `${provider}\0${model}\0${catalogRevision}\0${Math.floor(timeMs / 36e5)}`;
    let hit = cache.get(key);
    if (hit === void 0) {
      hit = priceAt(model, timeMs, { ...opts, provider });
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
var SESSION_ARTIFACT = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/u;
function sessionArtifactVersion(filename) {
  const match = SESSION_ARTIFACT.exec(filename);
  if (match === null) return 0;
  return match[1] === void 0 ? 1 : Number(match[1]);
}
function isSessionArtifact(filename) {
  return sessionArtifactVersion(filename) > 0;
}
function listSessionLogs(home) {
  const root = join(home, "sessions");
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { encoding: "utf8", withFileTypes: true });
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
  const preferred = /* @__PURE__ */ new Map();
  const preferredVersion = /* @__PURE__ */ new Map();
  for (const meta of out) {
    const version = sessionArtifactVersion(basename(meta.path));
    if (version > (preferredVersion.get(meta.id) ?? 0)) {
      preferred.set(meta.id, meta);
      preferredVersion.set(meta.id, version);
    }
  }
  out.length = 0;
  out.push(...preferred.values());
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
function fileModifiedAt(meta) {
  try {
    return statSync(meta.path).mtimeMs;
  } catch {
    return 0;
  }
}
function scanZstdFrameStream(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (; ; ) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = blockHeader >>> 1 & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}
function completeJsonlPrefix(buffer) {
  const newline = buffer.lastIndexOf(10);
  return newline < 0 ? Buffer.alloc(0) : buffer.subarray(0, newline + 1);
}
function readLogContent(meta) {
  let buffer;
  try {
    buffer = readFileSync(meta.path);
  } catch {
    return void 0;
  }
  if (meta.path.endsWith(".zstd")) {
    const { frames, tornStart } = scanZstdFrameStream(buffer);
    const parts = [];
    for (const frame of frames) {
      try {
        parts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)));
      } catch (cause) {
        throw new Error(
          `corrupt Zstandard session log: failed to decompress complete frame at byte ${frame.start}`,
          { cause }
        );
      }
    }
    if (tornStart !== void 0) {
      try {
        const recovered = zstdDecompressSync(buffer.subarray(tornStart), {
          finishFlush: constants.ZSTD_e_flush
        });
        const committed = completeJsonlPrefix(recovered);
        if (committed.length > 0) parts.push(committed);
      } catch {
      }
    }
    if (parts.length === 0) return void 0;
    return Buffer.concat(parts).toString("utf8");
  }
  return buffer.toString("utf8");
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
  let currentProvider = "";
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
        const provider = data2?.header?.config?.provider;
        const model = data2?.header?.config?.model;
        if (typeof provider === "string" && provider !== "") currentProvider = provider;
        if (typeof model === "string" && model !== "") currentModel = model;
      } catch {
      }
      continue;
    }
    if (event.type !== "assistant/message") continue;
    const data = event.data;
    const messageProvider = data?.message?.source?.provider;
    const messageModel = data?.message?.source?.model;
    const eventProvider = typeof messageProvider === "string" && messageProvider !== "" ? messageProvider : currentProvider;
    const eventModel = typeof messageModel === "string" && messageModel !== "" ? messageModel : currentModel;
    const usage = data?.usage;
    if (usage === null || typeof usage !== "object") continue;
    const time = typeof event.time === "number" && Number.isFinite(event.time) ? event.time : Date.now();
    const breakdown = costOf(
      {
        inputTokens: toFinite(usage.inputTokens),
        cacheReadTokens: toFinite(usage.cacheReadTokens),
        outputTokens: toFinite(usage.outputTokens)
      },
      price(eventModel, time, eventProvider === "" ? void 0 : eventProvider)
    );
    out.push({
      provider: eventProvider,
      model: eventModel,
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
    readContent: readLogContent,
    modifiedAt: fileModifiedAt
  };
  const pricing = options.pricing;
  const price = options.price ?? (pricing !== void 0 ? pricing.lookup : createPriceCache());
  const byDay = /* @__PURE__ */ new Map();
  const byModel = /* @__PURE__ */ new Map();
  const window = options.window;
  const windowStartMs = window === void 0 ? 0 : Date.parse(`${window.startDay}T00:00:00+08:00`) || 0;
  const maxEvents = options.maxEvents ?? 2e5;
  let sessionsWithUsage = 0;
  let calls = 0;
  let events = 0;
  const logs = reader.listLogs();
  for (const meta of logs) {
    if (windowStartMs > 0 && reader.modifiedAt !== void 0 && reader.modifiedAt(meta) < windowStartMs) continue;
    const rev = reader.revision(meta);
    if (rev === "") continue;
    const cacheKey = `${meta.path}\0${meta.id}\0${options.pricing?.revision ?? "builtin"}`;
    let cached = logCache.get(cacheKey);
    if (cached === void 0 || cached.rev !== rev) {
      const content = reader.readContent(meta);
      if (content === void 0) continue;
      const priced = replayLogContent(content, price);
      if (priced.length === 0) continue;
      cached = { rev, priced };
      logCache.set(cacheKey, cached);
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
      if (window !== void 0 && (day < window.startDay || day > window.endDay)) continue;
      const modelKey = `${item.provider}\0${item.model}`;
      let modelRow = byModel.get(modelKey);
      if (modelRow === void 0) {
        modelRow = {
          provider: item.provider,
          model: item.model,
          calls: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          cost: 0,
          costUsd: 0
        };
        byModel.set(modelKey, modelRow);
      }
      modelRow.calls += 1;
      modelRow.inputTokens += item.inputTokens;
      modelRow.cacheReadTokens += item.cacheReadTokens;
      modelRow.outputTokens += item.outputTokens;
      modelRow.cost += item.cost;
      modelRow.costUsd += item.costUsd;
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
  const models = [...byModel.values()].map((row) => ({ ...row, cost: round2(row.cost), costUsd: round4(row.costUsd) })).sort((a, b) => b.cost - a.cost || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
  return { sessionsScanned: logs.length, sessionsWithUsage, calls, byDay: byDayRecord, models };
}
function round2(value) {
  return Math.round(value * 100) / 100;
}
function round4(value) {
  return Math.round(value * 1e4) / 1e4;
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

// src/host/balance-spend.ts
import { closeSync, mkdirSync, openSync, readFileSync as readFileSync2, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname as dirname2, join as join2 } from "node:path";
import { randomBytes } from "node:crypto";
var STATE_VERSION = 2;
var HISTORY_DAYS = 35;
var STATE_RELATIVE_PATH = join2("whale-pet", "balance-spend.json");
var stateCache = /* @__PURE__ */ new Map();
function emptyLedger(balanceMinor) {
  return { lastBalanceMinor: balanceMinor, byDayMinor: {} };
}
function validMinor(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function parseLedger(value) {
  if (value === null || typeof value !== "object") return void 0;
  const record = value;
  if (!validMinor(record.lastBalanceMinor)) return void 0;
  if (record.byDayMinor === null || typeof record.byDayMinor !== "object" || Array.isArray(record.byDayMinor)) return void 0;
  const byDayMinor = {};
  for (const [day, amount] of Object.entries(record.byDayMinor)) {
    if (/^\d{4}-\d{2}-\d{2}$/u.test(day) && validMinor(amount)) byDayMinor[day] = amount;
  }
  return { lastBalanceMinor: record.lastBalanceMinor, byDayMinor };
}
function parseState(value) {
  if (value === null || typeof value !== "object") return void 0;
  const record = value;
  if (record.version !== STATE_VERSION) return void 0;
  if (typeof record.lastCurrency !== "string") return void 0;
  if (record.ledgers === null || typeof record.ledgers !== "object" || Array.isArray(record.ledgers)) return void 0;
  const ledgers = {};
  for (const [currency, ledger] of Object.entries(record.ledgers)) {
    if (currency === "" || ledger === null || typeof ledger !== "object") continue;
    const parsed = parseLedger(ledger);
    if (parsed !== void 0) ledgers[currency] = parsed;
  }
  return { version: STATE_VERSION, lastCurrency: record.lastCurrency, ledgers };
}
function cloneState(state) {
  const ledgers = {};
  for (const [currency, ledger] of Object.entries(state.ledgers)) {
    ledgers[currency] = { lastBalanceMinor: ledger.lastBalanceMinor, byDayMinor: { ...ledger.byDayMinor } };
  }
  return { version: STATE_VERSION, lastCurrency: state.lastCurrency, ledgers };
}
function loadState(path) {
  const cached = stateCache.get(path);
  if (cached !== void 0) return cloneState(cached);
  try {
    const parsed = parseState(JSON.parse(readFileSync2(path, "utf8")));
    if (parsed !== void 0) stateCache.set(path, parsed);
    return parsed !== void 0 ? cloneState(parsed) : void 0;
  } catch {
    return void 0;
  }
}
function saveState(path, state) {
  stateCache.set(path, state);
  try {
    mkdirSync(dirname2(path), { recursive: true, mode: 448 });
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const fd = openSync(temporary, "wx", 384);
    try {
      writeSync(fd, `${JSON.stringify(state, null, 2)}
`);
      closeSync(fd);
      renameSync(temporary, path);
    } catch (error) {
      try {
        closeSync(fd);
      } catch {
      }
      throw error;
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
      }
    }
  } catch {
    console.warn("dsh-whale-pet: failed to persist balance spend state");
  }
}
function toMinor(amount) {
  if (!Number.isFinite(amount) || amount < 0) return void 0;
  const minor = Math.round(amount * 100);
  return Number.isSafeInteger(minor) ? minor : void 0;
}
function fromMinor(minor) {
  return Math.round(minor) / 100;
}
function pruneHistory(ledger, nowMs) {
  const oldest = shanghaiDay(nowMs - (HISTORY_DAYS - 1) * 864e5);
  for (const day of Object.keys(ledger.byDayMinor)) {
    if (day < oldest) delete ledger.byDayMinor[day];
  }
}
function snapshot(state, currency, nowMs) {
  if (state === void 0 || currency === null) return { currency, today: 0, days7: 0, byDay: {} };
  const ledger = state.ledgers[currency];
  if (ledger === void 0) return { currency, today: 0, days7: 0, byDay: {} };
  const { startDay, endDay } = spendWindowDays(nowMs, 7);
  let todayMinor = 0;
  let days7Minor = 0;
  const byDay = {};
  for (const [day, minor] of Object.entries(ledger.byDayMinor).sort(([a], [b]) => a.localeCompare(b))) {
    byDay[day] = fromMinor(minor);
    if (day === endDay) todayMinor += minor;
    if (day >= startDay && day <= endDay) days7Minor += minor;
  }
  return {
    currency,
    today: fromMinor(todayMinor),
    days7: fromMinor(days7Minor),
    byDay
  };
}
function observeBalanceSpend(home, observation, nowMs = Date.now()) {
  const path = join2(home, STATE_RELATIVE_PATH);
  const state = loadState(path);
  if (observation === null) {
    const active = state !== void 0 && state.lastCurrency !== "" ? state.lastCurrency : null;
    return snapshot(state, active, nowMs);
  }
  const balanceMinor = toMinor(observation.totalBalance);
  const currency = observation.currency.trim();
  if (balanceMinor === void 0 || currency === "") return snapshot(state, null, nowMs);
  if (state === void 0) {
    const fresh = { version: STATE_VERSION, lastCurrency: currency, ledgers: { [currency]: emptyLedger(balanceMinor) } };
    saveState(path, fresh);
    return snapshot(fresh, currency, nowMs);
  }
  const next = cloneState(state);
  const currencyChanged = next.lastCurrency !== currency;
  if (currencyChanged) next.lastCurrency = currency;
  const ledger = next.ledgers[currency] ?? emptyLedger(balanceMinor);
  next.ledgers[currency] = ledger;
  pruneHistory(ledger, nowMs);
  const decreaseMinor = ledger.lastBalanceMinor - balanceMinor;
  if (decreaseMinor > 0) {
    const day = shanghaiDay(nowMs);
    ledger.byDayMinor[day] = (ledger.byDayMinor[day] ?? 0) + decreaseMinor;
  }
  if (ledger.lastBalanceMinor !== balanceMinor || decreaseMinor > 0 || currencyChanged) {
    ledger.lastBalanceMinor = balanceMinor;
    saveState(path, next);
  }
  return snapshot(next, currency, nowMs);
}

// src/host/opencode.ts
import { readFileSync as readFileSync3 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join3 } from "node:path";
var OPENCODE_GO_API = "https://opencode.ai/zen/go/v1/usage";
var KEY_ENV = "OPENCODE_GO_API_KEY";
var AUTH_JSON_REL = join3(".local", "share", "opencode", "auth.json");
var FETCH_TIMEOUT_MS = 15e3;
var CACHE_MS = 3e4;
var WINDOW_LABELS = {
  rolling: "5 \u5C0F\u65F6",
  weekly: "7 \u5929",
  monthly: "1 \u4E2A\u6708"
};
var WINDOW_KEYS = ["rolling", "weekly", "monthly"];
function emptyWindows() {
  return {
    rolling: { key: "rolling", label: WINDOW_LABELS.rolling, status: "", percent: null, remaining: null, resetsAt: null },
    weekly: { key: "weekly", label: WINDOW_LABELS.weekly, status: "", percent: null, remaining: null, resetsAt: null },
    monthly: { key: "monthly", label: WINDOW_LABELS.monthly, status: "", percent: null, remaining: null, resetsAt: null }
  };
}
function resolveOpenCodeGoKey(env = process.env, homeDir = homedir2()) {
  const envKey = env[KEY_ENV];
  if (typeof envKey === "string" && envKey !== "") return { key: envKey, source: "env" };
  try {
    const parsed = JSON.parse(readFileSync3(join3(homeDir, AUTH_JSON_REL), "utf8"));
    const token = parsed?.["opencode-go"]?.key;
    if (typeof token === "string" && token !== "") return { key: token, source: "auth" };
  } catch {
  }
  return null;
}
function toPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}
function toTime(value) {
  if (typeof value !== "string" || value === "") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}
function parseOpenCodeGoUsage(body, fetchedAt, keySource) {
  if (body === null || typeof body !== "object") return null;
  const usage = body.usage;
  if (usage === null || typeof usage !== "object") return null;
  const record = usage;
  const windows = emptyWindows();
  for (const key of WINDOW_KEYS) {
    const raw = record[key];
    if (raw === null || typeof raw !== "object") continue;
    const row = raw;
    const percent = toPercent(row.percent);
    windows[key] = {
      key,
      label: WINDOW_LABELS[key],
      status: typeof row.status === "string" ? row.status : "",
      percent,
      remaining: percent === null ? null : Math.max(0, 100 - percent),
      resetsAt: toTime(row.resetsAt)
    };
  }
  return {
    configured: true,
    keySource,
    error: null,
    fetchedAt,
    windows
  };
}
var memo;
var inFlight;
var lastOk;
async function fetchOpenCodeGoUsage(options = {}) {
  const {
    env = process.env,
    homeDir = homedir2(),
    baseUrl = OPENCODE_GO_API,
    fetchImpl = fetch,
    timeoutMs = FETCH_TIMEOUT_MS,
    cacheMs = CACHE_MS
  } = options;
  const now = Date.now();
  if (memo !== void 0 && now - memo.at < cacheMs) return memo.value;
  if (inFlight !== void 0) return inFlight;
  inFlight = (async () => {
    const fetchedAt = Date.now();
    const credential = resolveOpenCodeGoKey(env, homeDir);
    if (credential === null) {
      const usage = {
        configured: false,
        keySource: null,
        error: null,
        fetchedAt,
        windows: emptyWindows()
      };
      memo = { at: fetchedAt, value: usage };
      return usage;
    }
    try {
      const response = await fetchImpl(baseUrl, {
        headers: {
          Authorization: `Bearer ${credential.key}`,
          Accept: "application/json"
        },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) throw new Error(`gateway ${response.status}`);
      const parsed = parseOpenCodeGoUsage(await response.json(), fetchedAt, credential.source);
      if (parsed === null) throw new Error("unexpected response shape");
      memo = { at: fetchedAt, value: parsed };
      lastOk = parsed;
      return parsed;
    } catch (cause) {
      if (lastOk !== void 0) {
        const stale = {
          ...lastOk,
          error: "\u6682\u65F6\u65E0\u6CD5\u5237\u65B0\uFF0C\u663E\u793A\u4E0A\u6B21\u6570\u636E"
        };
        memo = { at: fetchedAt, value: stale };
        return stale;
      }
      const usage = {
        configured: true,
        keySource: credential.source,
        error: cause instanceof Error ? cause.message : String(cause),
        fetchedAt,
        windows: emptyWindows()
      };
      memo = { at: fetchedAt, value: usage };
      return usage;
    }
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = void 0;
  }
}

// src/host/tasks.ts
import { readFileSync as readFileSync4, statSync as statSync2 } from "node:fs";
import { constants as constants2, zstdDecompressSync as zstdDecompressSync2 } from "node:zlib";
var PARSE_TYPES = /* @__PURE__ */ new Set([
  "todo/write",
  "tool/call",
  "step/start",
  "turn/start",
  "approval/asked",
  "approval/decided"
]);
var USER_AWAITING_TOOLS = /* @__PURE__ */ new Set([
  "ask_user_question"
]);
function freshCursor(kind) {
  return {
    kind,
    rev: "",
    processedFrames: 0,
    processedBytes: 0,
    committed: null,
    hadTornFrame: false,
    todoTotal: 0,
    todoDone: 0,
    todoCurrent: null,
    lastTool: null,
    lastStep: null,
    lastTurn: null,
    lastEventType: null,
    awaitingUser: false
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
      cursor.awaitingUser = false;
    } else if (type === "tool/call") {
      const turn = toInt(data?.turn);
      const step = toInt(data?.step);
      const name2 = typeof data?.name === "string" ? data.name : null;
      if (turn !== null && step !== null && name2 !== null) cursor.lastTool = { turn, step, name: name2 };
      cursor.awaitingUser = name2 !== null && USER_AWAITING_TOOLS.has(name2);
    } else if (type === "step/start") {
      const turn = toInt(data?.turn);
      const step = toInt(data?.step);
      if (turn !== null && step !== null) cursor.lastStep = { turn, step };
      if (turn !== null) cursor.lastTurn = turn;
      cursor.awaitingUser = false;
    } else if (type === "turn/start") {
      const turn = toInt(data?.turn);
      if (turn !== null) cursor.lastTurn = turn;
      cursor.awaitingUser = false;
    } else if (type === "approval/asked") {
      cursor.awaitingUser = true;
    } else if (type === "approval/decided") {
      cursor.awaitingUser = false;
    }
  }
}
function toInt(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}
function snapshotState(cursor) {
  return {
    todoTotal: cursor.todoTotal,
    todoDone: cursor.todoDone,
    todoCurrent: cursor.todoCurrent,
    lastTool: cursor.lastTool,
    lastStep: cursor.lastStep,
    lastTurn: cursor.lastTurn,
    lastEventType: cursor.lastEventType,
    awaitingUser: cursor.awaitingUser
  };
}
function restoreState(cursor, state) {
  Object.assign(cursor, state);
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
    buffer = readFileSync4(meta.path);
  } catch {
    return false;
  }
  if (meta.path.endsWith(".zstd") && cursor.kind === "zstd") {
    const { frames, tornStart } = scanZstdFrameStream(buffer);
    if (frames.length < cursor.processedFrames) {
      cursor.processedFrames = 0;
      cursor.todoTotal = 0;
      cursor.todoDone = 0;
      cursor.todoCurrent = null;
      cursor.lastTool = null;
      cursor.lastStep = null;
      cursor.lastTurn = null;
      cursor.lastEventType = null;
      cursor.awaitingUser = false;
      cursor.committed = null;
      cursor.hadTornFrame = false;
    }
    const formerTornFrameCompleted = cursor.hadTornFrame && frames.length > cursor.processedFrames;
    if (cursor.committed !== null) restoreState(cursor, cursor.committed);
    if (formerTornFrameCompleted && cursor.processedFrames > 0) {
      cursor.processedFrames -= 1;
    }
    for (const frame of frames.slice(cursor.processedFrames)) {
      let text;
      try {
        text = zstdDecompressSync2(buffer.subarray(frame.start, frame.end)).toString("utf8");
      } catch (cause) {
        throw new Error(
          `corrupt Zstandard session log: failed to decompress complete frame at byte ${frame.start}`,
          { cause }
        );
      }
      processLogText(text, cursor);
    }
    cursor.processedFrames = frames.length;
    cursor.committed = snapshotState(cursor);
    cursor.hadTornFrame = tornStart !== void 0;
    if (tornStart !== void 0) {
      try {
        const recovered = zstdDecompressSync2(buffer.subarray(tornStart), {
          finishFlush: constants2.ZSTD_e_flush
        }).toString("utf8");
        const newline = recovered.lastIndexOf("\n");
        if (newline >= 0) processLogText(recovered.slice(0, newline + 1), cursor);
      } catch {
      }
    }
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
var MAX_PROJECTION_ENTRIES = 400;
var EVICT_PROJECTION_ENTRIES = 200;
var cursors = /* @__PURE__ */ new Map();
function trimProjectionCache(cache) {
  if (cache.size <= MAX_PROJECTION_ENTRIES) return;
  for (const key of [...cache.keys()].slice(0, EVICT_PROJECTION_ENTRIES)) cache.delete(key);
}
function progressForSession(logIndex, id) {
  const meta = logIndex.get(id);
  if (meta === void 0) {
    cursors.delete(id);
    return { id, found: false, totalTodos: 0, doneTodos: 0, currentTodo: null, pct: null, stage: "idle", tool: null, turn: null, step: null, updatedAt: null, awaitingUser: false };
  }
  let cursor = cursors.get(id);
  if (cursor === void 0) {
    cursor = freshCursor(meta.path.endsWith(".zstd") ? "zstd" : "plain");
    cursors.set(id, cursor);
    trimProjectionCache(cursors);
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
    updatedAt,
    awaitingUser: cursor.awaitingUser
  };
}
var summaryCache = /* @__PURE__ */ new Map();
function usageByModel(events) {
  const grouped = /* @__PURE__ */ new Map();
  for (const event of events) {
    const route = `${event.provider}\0${event.model}`;
    let row = grouped.get(route);
    if (row === void 0) {
      row = { provider: event.provider, model: event.model, calls: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, cost: 0, costUsd: 0 };
      grouped.set(route, row);
    }
    row.calls += 1;
    row.inputTokens += event.inputTokens;
    row.cacheReadTokens += event.cacheReadTokens;
    row.outputTokens += event.outputTokens;
    row.cost += event.cost;
    row.costUsd += event.costUsd;
  }
  return [...grouped.values()].map((row) => ({
    ...row,
    cost: Math.round(row.cost * 100) / 100,
    costUsd: Math.round(row.costUsd * 1e4) / 1e4
  }));
}
function sessionSummary(logIndex, id, options = {}) {
  const meta = logIndex.get(id);
  if (meta === void 0) {
    for (const key of summaryCache.keys()) if (key.endsWith(`\0${id}\0builtin`)) summaryCache.delete(key);
    return {
      id,
      found: false,
      model: "unknown",
      calls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      cost: 0,
      costUsd: 0,
      models: [],
      totalCalls: 0,
      totalInputTokens: 0,
      totalCacheReadTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      totalCostUsd: 0,
      totalModels: []
    };
  }
  let stat;
  try {
    stat = statSync2(meta.path);
  } catch {
    return {
      id,
      found: false,
      model: "unknown",
      calls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      cost: 0,
      costUsd: 0,
      models: [],
      totalCalls: 0,
      totalInputTokens: 0,
      totalCacheReadTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      totalCostUsd: 0,
      totalModels: []
    };
  }
  const rev = `${stat.mtimeMs}\0${stat.size}`;
  const pricing = options.pricing;
  const price = options.price ?? (pricing !== void 0 ? pricing.lookup : createPriceCache());
  const cacheKey = `${meta.path}\0${id}\0${pricing?.revision ?? "builtin"}`;
  const cached = summaryCache.get(cacheKey);
  if (cached !== void 0 && cached.rev === rev) return cached.summary;
  const content = readLogContent(meta);
  if (content === void 0) {
    return {
      id,
      found: false,
      model: "unknown",
      calls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      cost: 0,
      costUsd: 0,
      models: [],
      totalCalls: 0,
      totalInputTokens: 0,
      totalCacheReadTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      totalCostUsd: 0,
      totalModels: []
    };
  }
  let totalCalls = 0;
  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;
  let totalCostUsd = 0;
  const totalEvents = replayLogContent(content, (model2, timeMs, provider2) => price(model2, timeMs, provider2 === "" ? void 0 : provider2));
  for (const event of totalEvents) {
    totalCalls += 1;
    totalInputTokens += event.inputTokens;
    totalCacheReadTokens += event.cacheReadTokens;
    totalOutputTokens += event.outputTokens;
    totalCost += event.cost;
    totalCostUsd += event.costUsd;
  }
  let provider = "";
  let providerAtLastUser = "";
  let model = "unknown";
  let modelAtLastUser = "unknown";
  let lastUserMessageIndex = -1;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "request/header") {
        const p = event.data?.header?.config?.provider;
        const m = event.data?.header?.config?.model;
        if (typeof p === "string" && p !== "") provider = p;
        if (typeof m === "string" && m !== "") model = m;
      }
      if (event.type === "assistant/message") {
        const p = event.data?.message?.source?.provider;
        const m = event.data?.message?.source?.model;
        if (typeof p === "string" && p !== "") provider = p;
        if (typeof m === "string" && m !== "") model = m;
      }
      if (event.type === "user/message") {
        lastUserMessageIndex = i;
        providerAtLastUser = provider;
        modelAtLastUser = model;
      }
    } catch {
    }
  }
  let calls = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  let costUsd = 0;
  let currentEvents;
  if (lastUserMessageIndex >= 0) {
    const modelHeader = JSON.stringify({
      type: "request/header",
      data: { header: { config: { provider: providerAtLastUser, model: modelAtLastUser } } }
    });
    const contentAfter = `${modelHeader}
${lines.slice(lastUserMessageIndex).join("\n")}`;
    currentEvents = replayLogContent(contentAfter, (m, t, p) => price(m, t, p));
    for (const event of currentEvents) {
      calls += 1;
      inputTokens += event.inputTokens;
      cacheReadTokens += event.cacheReadTokens;
      outputTokens += event.outputTokens;
      cost += event.cost;
      costUsd += event.costUsd;
    }
  } else {
    currentEvents = totalEvents;
    calls = totalCalls;
    inputTokens = totalInputTokens;
    cacheReadTokens = totalCacheReadTokens;
    outputTokens = totalOutputTokens;
    cost = totalCost;
    costUsd = totalCostUsd;
  }
  const summary = {
    id,
    found: totalCalls > 0,
    model,
    calls,
    inputTokens,
    cacheReadTokens,
    outputTokens,
    cost: Math.round(cost * 100) / 100,
    costUsd: Math.round(costUsd * 1e4) / 1e4,
    models: usageByModel(currentEvents),
    totalCalls,
    totalInputTokens,
    totalCacheReadTokens,
    totalOutputTokens,
    totalCost: Math.round(totalCost * 100) / 100,
    totalCostUsd: Math.round(totalCostUsd * 1e4) / 1e4,
    totalModels: usageByModel(totalEvents)
  };
  summaryCache.set(cacheKey, { rev, summary });
  trimProjectionCache(summaryCache);
  return summary;
}

// src/host/session-projection.ts
function createSessionProjection(options = {}) {
  const ttlMs = options.ttlMs ?? 1e3;
  const maxHomes = options.maxHomes ?? 4;
  const maxEntries = options.maxEntries ?? 2e3;
  const now = options.now ?? Date.now;
  const scan = options.scan ?? listSessionLogs;
  const homes = /* @__PURE__ */ new Map();
  const trim = () => {
    let entries = [...homes.values()].reduce((sum, value) => sum + value.index.size, 0);
    while (homes.size > maxHomes || entries > maxEntries) {
      const first = homes.entries().next().value;
      if (first === void 0) break;
      homes.delete(first[0]);
      entries -= first[1].index.size;
    }
  };
  return {
    index(home) {
      const timestamp = now();
      const cached = homes.get(home);
      if (cached !== void 0 && timestamp < cached.expiresAt) {
        homes.delete(home);
        homes.set(home, cached);
        return cached.index;
      }
      const logs = scan(home).slice(0, maxEntries);
      const index = new Map(logs.map((meta) => [meta.id, meta]));
      homes.delete(home);
      homes.set(home, { expiresAt: timestamp + ttlMs, index });
      trim();
      return index;
    },
    invalidate(home) {
      if (home === void 0) homes.clear();
      else homes.delete(home);
    },
    stats() {
      return {
        homes: homes.size,
        entries: [...homes.values()].reduce((sum, value) => sum + value.index.size, 0)
      };
    }
  };
}

// src/host/pricing-catalog.ts
import { closeSync as closeSync2, mkdirSync as mkdirSync2, openSync as openSync2, readFileSync as readFileSync5, renameSync as renameSync2, unlinkSync as unlinkSync2, writeSync as writeSync2 } from "node:fs";
import { dirname as dirname3, join as join4 } from "node:path";
import { createHash, randomBytes as randomBytes2 } from "node:crypto";
var MODELS_DEV_URL = "https://models.dev/api.json";
var PRICING_CACHE_RELATIVE_PATH = join4("whale-pet", "models-dev.json");
var PRICING_REFRESH_MS = 7 * 864e5;
var PRICING_RETRY_MS = 60 * 6e4;
var MAX_FEED_BYTES = 8 * 1024 * 1024;
var MAX_PROVIDERS = 512;
var MAX_MODELS = 1e5;
var MAX_KEY_LENGTH = 160;
var EXTERNAL_PROVIDER_ALIASES = {
  codex: "openai"
};
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
}
function safeKey(value) {
  return value.length > 0 && value.length <= MAX_KEY_LENGTH && value !== "__proto__" && value !== "constructor" && value !== "prototype";
}
function safeDisplayName(value) {
  if (typeof value !== "string") return void 0;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, MAX_KEY_LENGTH);
  return cleaned === "" ? void 0 : cleaned;
}
function priceRecord(input, output, cacheRead) {
  return { usd: { input, cacheRead, output } };
}
function catalogProviders() {
  return /* @__PURE__ */ Object.create(null);
}
function modelRecords() {
  return /* @__PURE__ */ Object.create(null);
}
function normalizeModelsDevCatalog(body, options) {
  if (!isRecord(body)) return void 0;
  const providers = catalogProviders();
  let providerCount = 0;
  let modelCount = 0;
  for (const [provider, rawProvider] of Object.entries(body)) {
    if (!safeKey(provider) || !isRecord(rawProvider)) continue;
    if (providerCount >= MAX_PROVIDERS) return void 0;
    const rawModels = rawProvider.models;
    if (!isRecord(rawModels)) continue;
    const models = modelRecords();
    for (const [model, rawModel] of Object.entries(rawModels)) {
      if (!safeKey(model) || !isRecord(rawModel)) continue;
      if (++modelCount > MAX_MODELS) return void 0;
      const rawCost = rawModel.cost;
      if (!isRecord(rawCost)) continue;
      const input = finiteNonNegative(rawCost.input);
      const output = finiteNonNegative(rawCost.output);
      if (input === void 0 || output === void 0) continue;
      const cacheRead = finiteNonNegative(rawCost.cache_read) ?? input;
      models[model] = priceRecord(input, output, cacheRead);
    }
    if (Object.keys(models).length === 0) continue;
    const name2 = safeDisplayName(rawProvider.name);
    providers[provider] = name2 === void 0 ? { models } : { name: name2, models };
    providerCount += 1;
  }
  if (providerCount === 0 || modelCount === 0) return void 0;
  const fetchedAt = finiteNonNegative(options.fetchedAt);
  if (fetchedAt === void 0) return void 0;
  const usdToCny = finiteNonNegative(options.usdToCny) ?? DEFAULT_USD_TO_CNY;
  if (usdToCny <= 0) return void 0;
  return {
    version: 1,
    source: options.source ?? MODELS_DEV_URL,
    fetchedAt,
    revision: options.sha256 ?? `models.dev:${fetchedAt}`,
    usdToCny,
    providers
  };
}
function validateCatalog(value) {
  if (!isRecord(value) || value.version !== 1) return void 0;
  const fetchedAt = finiteNonNegative(value.fetchedAt);
  if (fetchedAt === void 0) return void 0;
  if (!isRecord(value.providers)) return void 0;
  const providers = catalogProviders();
  let providerCount = 0;
  let modelCount = 0;
  for (const [provider, rawProvider] of Object.entries(value.providers)) {
    if (!safeKey(provider) || !isRecord(rawProvider) || !isRecord(rawProvider.models)) continue;
    if (providerCount >= MAX_PROVIDERS) return void 0;
    const models = modelRecords();
    for (const [model, rawModel] of Object.entries(rawProvider.models)) {
      if (!safeKey(model) || !isRecord(rawModel) || !isRecord(rawModel.usd)) continue;
      if (++modelCount > MAX_MODELS) return void 0;
      const input = finiteNonNegative(rawModel.usd.input);
      const output = finiteNonNegative(rawModel.usd.output);
      const cacheRead = finiteNonNegative(rawModel.usd.cacheRead);
      if (input === void 0 || output === void 0 || cacheRead === void 0) continue;
      models[model] = priceRecord(input, output, cacheRead);
    }
    if (Object.keys(models).length === 0) continue;
    const name2 = safeDisplayName(rawProvider.name);
    providers[provider] = name2 === void 0 ? { models } : { name: name2, models };
    providerCount += 1;
  }
  if (providerCount === 0 || modelCount === 0) return void 0;
  const usdToCny = finiteNonNegative(value.usdToCny) ?? DEFAULT_USD_TO_CNY;
  if (usdToCny <= 0) return void 0;
  return {
    version: 1,
    source: typeof value.source === "string" ? value.source : MODELS_DEV_URL,
    fetchedAt,
    revision: typeof value.revision === "string" && value.revision !== "" ? value.revision : typeof value.sha256 === "string" && value.sha256 !== "" ? value.sha256 : `models.dev:${fetchedAt}`,
    usdToCny,
    providers
  };
}
function readPricingCatalog(path) {
  try {
    return validateCatalog(JSON.parse(readFileSync5(path, "utf8")));
  } catch {
    return void 0;
  }
}
function writePricingCatalog(path, catalog) {
  mkdirSync2(dirname3(path), { recursive: true, mode: 448 });
  const temporary = `${path}.${process.pid}.${randomBytes2(6).toString("hex")}.tmp`;
  const fd = openSync2(temporary, "wx", 384);
  try {
    writeSync2(fd, `${JSON.stringify(catalog)}
`);
    closeSync2(fd);
    renameSync2(temporary, path);
  } finally {
    try {
      closeSync2(fd);
    } catch {
    }
    try {
      unlinkSync2(temporary);
    } catch {
    }
  }
}
async function readResponseText(response) {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_FEED_BYTES) throw new Error("pricing feed too large");
  if (response.body === null) {
    const bytes2 = new Uint8Array(await response.arrayBuffer());
    if (bytes2.byteLength > MAX_FEED_BYTES) throw new Error("pricing feed too large");
    return new TextDecoder().decode(bytes2);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (; ; ) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_FEED_BYTES) throw new Error("pricing feed too large");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
function snapshotFor(catalog) {
  const lookup = createPriceCache(catalog === void 0 ? void 0 : {
    externalCatalog: catalog,
    usdToCny: catalog.usdToCny ?? DEFAULT_USD_TO_CNY
  });
  const aliases = EXTERNAL_PROVIDER_ALIASES;
  const routeLookup = (model, timeMs, provider = "") => {
    const catalogProvider = aliases[provider] ?? provider;
    return lookup(model, timeMs, catalogProvider);
  };
  return {
    revision: catalog?.revision ?? "builtin",
    source: catalog === void 0 ? "builtin" : "mixed",
    fetchedAt: catalog?.fetchedAt ?? null,
    lookup: routeLookup
  };
}
function convertUsd(unit, usdToCny) {
  return {
    input: unit.input * usdToCny,
    cacheRead: unit.cacheRead * usdToCny,
    output: unit.output * usdToCny
  };
}
function tableFor(catalog, nowMs) {
  const usdToCny = catalog?.usdToCny ?? DEFAULT_USD_TO_CNY;
  const providers = [];
  let modelCount = 0;
  if (catalog !== void 0) {
    for (const [id, provider] of Object.entries(catalog.providers)) {
      const models = Object.entries(provider.models).map(([model, record]) => ({
        id: model,
        usd: record.usd,
        cny: record.cny ?? convertUsd(record.usd, usdToCny)
      })).sort((a, b) => a.id.localeCompare(b.id));
      modelCount += models.length;
      providers.push({
        id,
        ...provider.name === void 0 ? {} : { name: provider.name },
        models
      });
    }
    providers.sort((a, b) => a.id.localeCompare(b.id));
  }
  const official = officialPriceRows(nowMs).map((row) => ({
    model: row.model,
    usd: row.usd,
    cny: row.cny,
    mode: row.mode
  }));
  const fetchedAt = catalog?.fetchedAt ?? null;
  return {
    revision: catalog?.revision ?? "builtin",
    source: catalog === void 0 ? "builtin" : "mixed",
    fetchedAt,
    nextRefreshAt: fetchedAt === null ? null : fetchedAt + PRICING_REFRESH_MS,
    usdToCny,
    official,
    providers,
    modelCount: modelCount + official.length
  };
}
function createPricingManager(options) {
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sourceUrl = options.sourceUrl ?? MODELS_DEV_URL;
  if (sourceUrl !== MODELS_DEV_URL) throw new Error("pricing source must be models.dev");
  const cachePath = join4(options.home, PRICING_CACHE_RELATIVE_PATH);
  let catalog = readPricingCatalog(cachePath);
  let current = snapshotFor(catalog);
  let inFlight2;
  let lastAttempt = 0;
  const refresh = async (force = false) => {
    const timestamp = now();
    if (!force && catalog !== void 0 && timestamp - catalog.fetchedAt < PRICING_REFRESH_MS) return current;
    if (!force && lastAttempt !== 0 && timestamp - lastAttempt < PRICING_RETRY_MS) return current;
    if (inFlight2 !== void 0) return inFlight2;
    lastAttempt = timestamp;
    inFlight2 = (async () => {
      try {
        const response = await fetchImpl(sourceUrl, {
          headers: { Accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(15e3)
        });
        if (!response.ok) throw new Error(`pricing feed HTTP ${response.status}`);
        const text = await readResponseText(response);
        const parsed = JSON.parse(text);
        const sha256 = createHash("sha256").update(text).digest("hex");
        const next = normalizeModelsDevCatalog(parsed, {
          fetchedAt: now(),
          source: sourceUrl,
          sha256,
          usdToCny: options.usdToCny
        });
        if (next === void 0) throw new Error("pricing feed schema invalid");
        writePricingCatalog(cachePath, next);
        catalog = next;
        current = snapshotFor(catalog);
      } catch {
      }
      return current;
    })();
    try {
      return await inFlight2;
    } finally {
      inFlight2 = void 0;
    }
  };
  return { snapshot: () => current, refresh, table: (nowMs = now()) => tableFor(catalog, nowMs), cachePath };
}

// src/host/companion-grants.ts
import { createHash as createHash2, randomBytes as randomBytes3, timingSafeEqual } from "node:crypto";
import {
  credentialKey
} from "@deepseek-ai/dsh-credentials";
var RECORD_KEY = credentialKey("dsh-whale-pet", "companion-grants");
var TOKEN_PREFIX = "wpg1";
var DIGEST_DOMAIN = "dsh-whale-pet/grant/v1\0";
var MAX_GRANTS = 32;
var MAX_LABEL_LENGTH = 80;
function canonicalBase64Url(value, bytes) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return void 0;
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== bytes || decoded.toString("base64url") !== value) return void 0;
  return decoded;
}
function digest(id, secret) {
  return createHash2("sha256").update(DIGEST_DOMAIN, "utf8").update(id, "utf8").update("\0", "utf8").update(secret).digest();
}
function parseStoredGrant(value) {
  if (value === null || typeof value !== "object") return void 0;
  const grant = value;
  if (typeof grant.id !== "string" || canonicalBase64Url(grant.id, 16) === void 0) return void 0;
  if (typeof grant.label !== "string" || grant.label.length === 0 || grant.label.length > MAX_LABEL_LENGTH) return void 0;
  if (typeof grant.createdAt !== "number" || !Number.isSafeInteger(grant.createdAt) || grant.createdAt < 0) return void 0;
  if (typeof grant.digest !== "string" || canonicalBase64Url(grant.digest, 32) === void 0) return void 0;
  return { id: grant.id, label: grant.label, createdAt: grant.createdAt, digest: grant.digest };
}
function parsePayload(record) {
  if (record === void 0) return { v: 1, grants: [] };
  if (record.kind !== "grant" || record.payload === null || typeof record.payload !== "object") {
    throw new Error("companion grant record has an unsupported format");
  }
  const payload = record.payload;
  if (payload.v !== 1 || !Array.isArray(payload.grants) || payload.grants.length > MAX_GRANTS) {
    throw new Error("companion grant record has an unsupported format");
  }
  const grants = payload.grants.map(parseStoredGrant);
  if (grants.some((grant) => grant === void 0)) throw new Error("companion grant record is invalid");
  const ids = new Set(grants.map((grant) => grant.id));
  if (ids.size !== grants.length) throw new Error("companion grant record repeats an id");
  return { v: 1, grants };
}
function view(grant) {
  return { id: grant.id, label: grant.label, createdAt: grant.createdAt };
}
function header(value) {
  return typeof value === "string" ? value : void 0;
}
function isTrustedCompanionRequest(headers) {
  const host = header(headers.host);
  if (host === void 0) return false;
  let hostname;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "[::1]") return false;
  if (header(headers["sec-fetch-site"]) === "cross-site") return false;
  const origin = header(headers.origin);
  if (origin === void 0) return true;
  try {
    return new URL(origin).host === new URL(`http://${host}`).host;
  } catch {
    return false;
  }
}
function isCompanionLoopback(remoteAddress) {
  if (remoteAddress === void 0) return false;
  if (remoteAddress === "::1") return true;
  const address = remoteAddress.toLowerCase().startsWith("::ffff:") ? remoteAddress.slice(7) : remoteAddress;
  const octets = address.split(".");
  return octets.length === 4 && octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255) && octets[0] === "127";
}
function parseBearer(value) {
  if (typeof value !== "string") return void 0;
  const match = /^Bearer (wpg1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43}))$/u.exec(value);
  if (match === null) return void 0;
  const id = match[2];
  const secretText = match[3];
  if (canonicalBase64Url(id, 16) === void 0) return void 0;
  const secret = canonicalBase64Url(secretText, 32);
  return secret === void 0 ? void 0 : { id, secret };
}
function createCompanionGrants(records) {
  return {
    async list() {
      return parsePayload(await records.readRecord(RECORD_KEY)).grants.map(view);
    },
    async issue(rawLabel) {
      const label = rawLabel.trim();
      if (label.length === 0 || label.length > MAX_LABEL_LENGTH) throw new Error("companion label must be 1-80 characters");
      const id = randomBytes3(16).toString("base64url");
      const secret = randomBytes3(32);
      const createdAt = Date.now();
      const stored = { id, label, createdAt, digest: digest(id, secret).toString("base64url") };
      await records.modifyRecord(RECORD_KEY, async (current) => {
        const payload = parsePayload(current);
        if (payload.grants.length >= MAX_GRANTS) throw new Error(`at most ${MAX_GRANTS} companion grants are allowed`);
        return { kind: "grant", payload: { v: 1, grants: [...payload.grants, stored] } };
      });
      return { grant: view(stored), token: `${TOKEN_PREFIX}.${id}.${secret.toString("base64url")}` };
    },
    async revoke(id) {
      let removed = false;
      await records.modifyRecord(RECORD_KEY, async (current) => {
        const payload = parsePayload(current);
        const grants = payload.grants.filter((grant) => grant.id !== id);
        removed = grants.length !== payload.grants.length;
        return removed ? { kind: "grant", payload: { v: 1, grants } } : void 0;
      });
      return removed;
    },
    async authenticate(remoteAddress, authorization) {
      if (!isCompanionLoopback(remoteAddress)) return null;
      const bearer = parseBearer(authorization);
      if (bearer === void 0) return null;
      const stored = parsePayload(await records.readRecord(RECORD_KEY)).grants.find((grant) => grant.id === bearer.id);
      if (stored === void 0) return null;
      const expected = canonicalBase64Url(stored.digest, 32);
      if (expected === void 0) return null;
      const actual = digest(bearer.id, bearer.secret);
      return timingSafeEqual(expected, actual) ? view(stored) : null;
    }
  };
}

// src/shared/contract.ts
var WHALE_PET_PATHS = {
  health: "/api/whale-pet/health",
  state: "/api/whale-pet/state",
  tasks: "/api/whale-pet/tasks",
  taskSummary: "/api/whale-pet/task-summary",
  pricing: "/api/whale-pet/pricing",
  openCodeGo: "/api/whale-pet/opencode-go",
  companions: "/api/whale-pet/companions",
  companionIssue: "/api/whale-pet/companions/issue",
  companionRevoke: "/api/whale-pet/companions/revoke",
  companionState: "/dsh-whale-pet/companion/v1/state",
  companionTasks: "/dsh-whale-pet/companion/v1/tasks",
  companionTaskSummary: "/dsh-whale-pet/companion/v1/task-summary",
  companionOpenCodeGo: "/dsh-whale-pet/companion/v1/opencode-go",
  live2d: "/dsh-whale-pet-live2d.js",
  live2dZipWorker: "/dsh-whale-pet-live2d-zip-worker.js",
  cubismCore: "/dsh-whale-pet-live2dcubismcore.min.js"
};
var MAX_REQUEST_BODY_BYTES = 64 * 1024;
var MAX_TASK_IDS = 32;
var MAX_SESSION_ID_LENGTH = 256;

// src/host/index.ts
var LIVE2D_CHUNK_PATH = fileURLToPath(new URL("./live2d.js", import.meta.url));
var LIVE2D_ZIP_WORKER_PATH = fileURLToPath(new URL("./live2d-zip-worker.js", import.meta.url));
var CUBISM_CORE_PATH = fileURLToPath(new URL("./live2dcubismcore.min.js", import.meta.url));
var IMMUTABLE_JS_HEADERS = {
  "content-type": "application/javascript; charset=utf-8",
  "cache-control": "public, max-age=31536000, immutable"
};
var name = "dsh-whale-pet";
var inject = ["credentials", "webServer", "connection"];
var VERSION = "0.4.1";
var {
  health: HEALTH_PATH,
  state: STATE_PATH,
  tasks: TASKS_PATH,
  taskSummary: TASK_SUMMARY_PATH,
  pricing: PRICING_PATH,
  openCodeGo: OPENCODE_GO_PATH
} = WHALE_PET_PATHS;
var PUBLIC_BASE_URL = "https://api.deepseek.com";
var BASE_URL_ENV = "DEEPSEEK_BASE_URL";
var CREDENTIAL_REF = credentialRef("DEEPSEEK_API_KEY");
var BALANCE_PATH = "/user/balance";
var BALANCE_CACHE_MS = 55e3;
var FETCH_TIMEOUT_MS2 = 15e3;
var PRICING_CHECK_MS = 60 * 6e4;
var SPEND_WINDOW_DAYS = 7;
var JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};
var balanceMemo;
var balanceInFlight;
function balanceUrl() {
  const base = process.env[BASE_URL_ENV] ?? PUBLIC_BASE_URL;
  return `${base.replace(/\/+$/, "")}${BALANCE_PATH}`;
}
function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}
function rejectPrivateRequest(ctx, req, res) {
  const status = ctx.connection.requestRejection(req);
  if (status === void 0) return false;
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8"
  });
  res.end(status === 401 ? "unauthorized" : "forbidden");
  return true;
}
var RequestBodyError = class extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
};
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_REQUEST_BODY_BYTES) {
      throw new RequestBodyError(413, "payload-too-large", "request body exceeds 64 KiB");
    }
    chunks.push(bytes);
  }
  if (chunks.length === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    throw new RequestBodyError(400, "bad-json", "request body must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RequestBodyError(400, "bad-json", "request body must be a JSON object");
  }
  return parsed;
}
function sendRequestError(res, error) {
  if (!(error instanceof RequestBodyError)) return false;
  sendJson(res, error.status, { ok: false, error: error.code, message: error.message });
  return true;
}
var INVALID_TASK_IDS = `ids must contain at most ${MAX_TASK_IDS} unique session ids of at most ${MAX_SESSION_ID_LENGTH} characters`;
function parseTaskIds(value) {
  if (!Array.isArray(value)) return void 0;
  const ids = [];
  const seen = /* @__PURE__ */ new Set();
  for (const valueId of value) {
    if (typeof valueId !== "string" || valueId.length === 0 || valueId.length > MAX_SESSION_ID_LENGTH) return void 0;
    if (seen.has(valueId)) continue;
    seen.add(valueId);
    ids.push(valueId);
    if (ids.length > MAX_TASK_IDS) return void 0;
  }
  return ids;
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
  if (balanceInFlight !== void 0) return balanceInFlight;
  balanceInFlight = (async () => {
    let snapshot2 = null;
    try {
      const hit = await ctx.credentials.resolve(CREDENTIAL_REF);
      if (hit !== void 0 && typeof hit.value === "string" && hit.value !== "") {
        const response = await fetch(balanceUrl(), {
          headers: {
            Authorization: `Bearer ${hit.value}`,
            Accept: "application/json"
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS2)
        });
        if (response.ok) {
          snapshot2 = parseBalanceBody(await response.json(), Date.now());
        }
      }
    } catch {
    }
    balanceMemo = { at: Date.now(), value: snapshot2 };
    return snapshot2;
  })();
  try {
    return await balanceInFlight;
  } finally {
    balanceInFlight = void 0;
  }
}
function resolveDshHome(ctx) {
  try {
    const homeFn = typeof ctx.get === "function" ? ctx.get("dshHomePath") : void 0;
    return dshHome(typeof homeFn === "function" ? homeFn : void 0);
  } catch {
    return dshHome();
  }
}
function computeSpend(ctx, balance, pricing, nowMs = Date.now()) {
  const home = resolveDshHome(ctx);
  const ledger = observeBalanceSpend(
    home,
    balance?.totalBalance === null || balance === null ? null : { currency: balance.currency, totalBalance: balance.totalBalance },
    nowMs
  );
  const window = spendWindowDays(nowMs, SPEND_WINDOW_DAYS);
  const aggregates = aggregateSessionSpend(home, { pricing: pricing.snapshot(), window });
  const todayCalls = sumWindow(aggregates.byDay, window.endDay, window.endDay).calls;
  const days7Calls = sumWindow(aggregates.byDay, window.startDay, window.endDay).calls;
  return {
    today: { amount: ledger.today, amountUsd: null, calls: todayCalls, source: "balance" },
    days7: { amount: ledger.days7, amountUsd: null, calls: days7Calls, source: "balance" },
    byDay: ledger.byDay,
    computedAt: nowMs
  };
}
function apply(ctx) {
  const companionGrants = createCompanionGrants(ctx.credentials);
  const sessions = createSessionProjection();
  const pricing = createPricingManager({ home: resolveDshHome(ctx) });
  void pricing.refresh().catch(() => {
  });
  ctx.effect(() => {
    const timer = setInterval(() => {
      void pricing.refresh().catch(() => {
      });
    }, PRICING_CHECK_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }, "dsh-whale-pet: weekly pricing refresh");
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
      handler: async (req, res) => {
        if (rejectPrivateRequest(ctx, req, res)) return;
        try {
          const balance = await fetchBalance(ctx);
          const spend = computeSpend(ctx, balance, pricing);
          sendJson(res, 200, {
            ok: true,
            fetchedAt: Date.now(),
            balance,
            spend
          });
        } catch (error) {
          ctx.logger?.warn?.("dsh-whale-pet: state route failed");
          ctx.logger?.warn?.(error);
          sendJson(res, 500, { ok: false, error: "internal", message: "internal error" });
        }
      }
    }),
    "dsh-whale-pet: state route"
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: PRICING_PATH,
      handler: (req, res) => {
        if (rejectPrivateRequest(ctx, req, res)) return;
        if (req.method !== "GET") {
          sendJson(res, 405, { ok: false, error: "bad-request", message: "method not allowed" });
          return;
        }
        try {
          const now = Date.now();
          const snapshot2 = pricing.snapshot();
          const window = spendWindowDays(now, SPEND_WINDOW_DAYS);
          const aggregates = aggregateSessionSpend(resolveDshHome(ctx), { pricing: snapshot2, window });
          const models = aggregates.models;
          let totalCost = 0;
          let totalCostUsd = 0;
          let totalCalls = 0;
          for (const row of models) {
            totalCost += row.cost;
            totalCostUsd += row.costUsd;
            totalCalls += row.calls;
          }
          sendJson(res, 200, {
            ok: true,
            fetchedAt: now,
            pricing: pricing.table(now),
            usage: {
              days: SPEND_WINDOW_DAYS,
              startDay: window.startDay,
              endDay: window.endDay,
              models,
              totalCost: Math.round(totalCost * 100) / 100,
              totalCostUsd: Math.round(totalCostUsd * 1e4) / 1e4,
              totalCalls
            }
          });
        } catch (error) {
          ctx.logger?.warn?.("dsh-whale-pet: pricing route failed");
          ctx.logger?.warn?.(error);
          sendJson(res, 500, { ok: false, error: "internal", message: "internal error" });
        }
      }
    }),
    "dsh-whale-pet: pricing route"
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: TASKS_PATH,
      handler: async (req, res) => {
        if (rejectPrivateRequest(ctx, req, res)) return;
        try {
          const body = await readJsonBody(req);
          const ids = parseTaskIds(body.ids);
          if (ids === void 0) {
            sendJson(res, 400, { ok: false, error: "bad-request", message: INVALID_TASK_IDS });
            return;
          }
          const home = resolveDshHome(ctx);
          const index = sessions.index(home);
          const tasks = ids.map((id) => {
            try {
              return progressForSession(index, id);
            } catch (error) {
              ctx.logger?.warn?.(`dsh-whale-pet: session progress failed for ${id}`);
              ctx.logger?.warn?.(error);
              return { id, found: false, errorCode: "session-log-corrupt" };
            }
          });
          sendJson(res, 200, { ok: true, fetchedAt: Date.now(), tasks });
        } catch (error) {
          if (sendRequestError(res, error)) return;
          ctx.logger?.warn?.("dsh-whale-pet: tasks route failed");
          ctx.logger?.warn?.(error);
          sendJson(res, 500, { ok: false, error: "internal", message: "internal error" });
        }
      }
    }),
    "dsh-whale-pet: tasks route"
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: TASK_SUMMARY_PATH,
      handler: async (req, res) => {
        if (rejectPrivateRequest(ctx, req, res)) return;
        try {
          const body = await readJsonBody(req);
          const id = typeof body.id === "string" && body.id.length > 0 && body.id.length <= MAX_SESSION_ID_LENGTH ? body.id : "";
          if (id === "") {
            sendJson(res, 400, { ok: false, error: "bad-request", message: `id must be a non-empty session id of at most ${MAX_SESSION_ID_LENGTH} characters` });
            return;
          }
          const home = resolveDshHome(ctx);
          const index = sessions.index(home);
          const summary = sessionSummary(index, id, { pricing: pricing.snapshot() });
          sendJson(res, 200, { ok: true, fetchedAt: Date.now(), summary });
        } catch (error) {
          if (sendRequestError(res, error)) return;
          ctx.logger?.warn?.("dsh-whale-pet: task-summary route failed");
          ctx.logger?.warn?.(error);
          sendJson(res, 500, { ok: false, error: "internal", message: "internal error" });
        }
      }
    }),
    "dsh-whale-pet: task-summary route"
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: OPENCODE_GO_PATH,
      handler: async (req, res) => {
        if (rejectPrivateRequest(ctx, req, res)) return;
        try {
          const usage = await fetchOpenCodeGoUsage();
          sendJson(res, 200, { ok: true, fetchedAt: usage.fetchedAt, usage });
        } catch (error) {
          ctx.logger?.warn?.("dsh-whale-pet: opencode-go route failed");
          ctx.logger?.warn?.(error);
          sendJson(res, 500, { ok: false, error: "internal", message: "internal error" });
        }
      }
    }),
    "dsh-whale-pet: opencode-go route"
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: WHALE_PET_PATHS.companions,
      handler: async (req, res) => {
        if (rejectPrivateRequest(ctx, req, res)) return;
        if (req.method !== "GET") {
          sendJson(res, 405, { ok: false, error: "bad-request", message: "method not allowed" });
          return;
        }
        try {
          sendJson(res, 200, { ok: true, grants: await companionGrants.list() });
        } catch (error) {
          ctx.logger?.warn?.("dsh-whale-pet: companion list failed");
          ctx.logger?.warn?.(error);
          sendJson(res, 500, { ok: false, error: "internal", message: "internal error" });
        }
      }
    }),
    "dsh-whale-pet: companion list route"
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: WHALE_PET_PATHS.companionIssue,
      handler: async (req, res) => {
        if (rejectPrivateRequest(ctx, req, res)) return;
        if (req.method !== "POST") {
          sendJson(res, 405, { ok: false, error: "bad-request", message: "method not allowed" });
          return;
        }
        try {
          const body = await readJsonBody(req);
          const label = typeof body.label === "string" ? body.label : "";
          const issued = await companionGrants.issue(label);
          sendJson(res, 201, { ok: true, ...issued });
        } catch (error) {
          if (sendRequestError(res, error)) return;
          if (error instanceof Error && error.message === "companion label must be 1-80 characters") {
            sendJson(res, 400, { ok: false, error: "bad-request", message: error.message });
            return;
          }
          ctx.logger?.warn?.("dsh-whale-pet: companion issue failed");
          ctx.logger?.warn?.(error);
          sendJson(res, 500, { ok: false, error: "internal", message: "internal error" });
        }
      }
    }),
    "dsh-whale-pet: companion issue route"
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: WHALE_PET_PATHS.companionRevoke,
      handler: async (req, res) => {
        if (rejectPrivateRequest(ctx, req, res)) return;
        if (req.method !== "POST") {
          sendJson(res, 405, { ok: false, error: "bad-request", message: "method not allowed" });
          return;
        }
        try {
          const body = await readJsonBody(req);
          const id = typeof body.id === "string" ? body.id : "";
          if (id === "") {
            sendJson(res, 400, { ok: false, error: "bad-request", message: "id is required" });
            return;
          }
          sendJson(res, 200, { ok: true, revoked: await companionGrants.revoke(id) });
        } catch (error) {
          if (sendRequestError(res, error)) return;
          ctx.logger?.warn?.("dsh-whale-pet: companion revoke failed");
          ctx.logger?.warn?.(error);
          sendJson(res, 500, { ok: false, error: "internal", message: "internal error" });
        }
      }
    }),
    "dsh-whale-pet: companion revoke route"
  );
  const rejectCompanion = async (req, res) => {
    if (!isCompanionLoopback(req.socket.remoteAddress) || !isTrustedCompanionRequest(req.headers)) {
      sendJson(res, 403, { ok: false, error: "forbidden", message: "forbidden" });
      return true;
    }
    try {
      const authorization = req.headers.authorization;
      if (await companionGrants.authenticate(req.socket.remoteAddress, authorization) !== null) return false;
      sendJson(res, 401, { ok: false, error: "unauthorized", message: "unauthorized" });
      return true;
    } catch (error) {
      ctx.logger?.warn?.("dsh-whale-pet: companion credential record failed");
      ctx.logger?.warn?.(error);
      sendJson(res, 500, { ok: false, error: "internal", message: "internal error" });
      return true;
    }
  };
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: WHALE_PET_PATHS.companionState,
      handler: async (req, res) => {
        if (await rejectCompanion(req, res)) return;
        if (req.method !== "GET") {
          sendJson(res, 405, { ok: false, error: "bad-request", message: "method not allowed" });
          return;
        }
        try {
          const balance = await fetchBalance(ctx);
          const spend = computeSpend(ctx, balance, pricing);
          sendJson(res, 200, { ok: true, fetchedAt: Date.now(), balance, spend });
        } catch (error) {
          ctx.logger?.warn?.("dsh-whale-pet: companion state failed");
          ctx.logger?.warn?.(error);
          sendJson(res, 500, { ok: false, error: "internal", message: "internal error" });
        }
      }
    }),
    "dsh-whale-pet: companion state route"
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: WHALE_PET_PATHS.companionTasks,
      handler: async (req, res) => {
        if (await rejectCompanion(req, res)) return;
        if (req.method !== "POST") {
          sendJson(res, 405, { ok: false, error: "bad-request", message: "method not allowed" });
          return;
        }
        try {
          const body = await readJsonBody(req);
          const ids = parseTaskIds(body.ids);
          if (ids === void 0) {
            sendJson(res, 400, { ok: false, error: "bad-request", message: INVALID_TASK_IDS });
            return;
          }
          const index = sessions.index(resolveDshHome(ctx));
          const tasks = ids.map((id) => {
            try {
              return progressForSession(index, id);
            } catch (error) {
              ctx.logger?.warn?.(`dsh-whale-pet: companion session progress failed for ${id}`);
              ctx.logger?.warn?.(error);
              return { id, found: false, errorCode: "session-log-corrupt" };
            }
          });
          sendJson(res, 200, { ok: true, fetchedAt: Date.now(), tasks });
        } catch (error) {
          if (sendRequestError(res, error)) return;
          ctx.logger?.warn?.("dsh-whale-pet: companion tasks failed");
          ctx.logger?.warn?.(error);
          sendJson(res, 500, { ok: false, error: "internal", message: "internal error" });
        }
      }
    }),
    "dsh-whale-pet: companion tasks route"
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: WHALE_PET_PATHS.companionTaskSummary,
      handler: async (req, res) => {
        if (await rejectCompanion(req, res)) return;
        if (req.method !== "POST") {
          sendJson(res, 405, { ok: false, error: "bad-request", message: "method not allowed" });
          return;
        }
        try {
          const body = await readJsonBody(req);
          const id = typeof body.id === "string" && body.id.length > 0 && body.id.length <= MAX_SESSION_ID_LENGTH ? body.id : "";
          if (id === "") {
            sendJson(res, 400, { ok: false, error: "bad-request", message: `id must be a non-empty session id of at most ${MAX_SESSION_ID_LENGTH} characters` });
            return;
          }
          const index = sessions.index(resolveDshHome(ctx));
          sendJson(res, 200, { ok: true, fetchedAt: Date.now(), summary: sessionSummary(index, id, { pricing: pricing.snapshot() }) });
        } catch (error) {
          if (sendRequestError(res, error)) return;
          ctx.logger?.warn?.("dsh-whale-pet: companion task summary failed");
          ctx.logger?.warn?.(error);
          sendJson(res, 500, { ok: false, error: "internal", message: "internal error" });
        }
      }
    }),
    "dsh-whale-pet: companion task summary route"
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: WHALE_PET_PATHS.companionOpenCodeGo,
      handler: async (req, res) => {
        if (await rejectCompanion(req, res)) return;
        if (req.method !== "GET") {
          sendJson(res, 405, { ok: false, error: "bad-request", message: "method not allowed" });
          return;
        }
        try {
          const usage = await fetchOpenCodeGoUsage();
          sendJson(res, 200, { ok: true, fetchedAt: usage.fetchedAt, usage });
        } catch (error) {
          ctx.logger?.warn?.("dsh-whale-pet: companion opencode-go failed");
          ctx.logger?.warn?.(error);
          sendJson(res, 500, { ok: false, error: "internal", message: "internal error" });
        }
      }
    }),
    "dsh-whale-pet: companion opencode-go route"
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: WHALE_PET_PATHS.live2d,
      handler: (_req, res) => {
        try {
          const code = readFileSync6(LIVE2D_CHUNK_PATH, "utf8");
          res.writeHead(200, IMMUTABLE_JS_HEADERS);
          res.end(code);
        } catch (error) {
          ctx.logger?.warn?.("dsh-whale-pet: live2d chunk missing");
          ctx.logger?.warn?.(error);
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("live2d chunk not found");
        }
      }
    }),
    "dsh-whale-pet: live2d chunk route"
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: WHALE_PET_PATHS.live2dZipWorker,
      handler: (_req, res) => {
        try {
          const code = readFileSync6(LIVE2D_ZIP_WORKER_PATH, "utf8");
          res.writeHead(200, IMMUTABLE_JS_HEADERS);
          res.end(code);
        } catch (error) {
          ctx.logger?.warn?.("dsh-whale-pet: Live2D ZIP Worker missing");
          ctx.logger?.warn?.(error);
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("Live2D ZIP Worker not found");
        }
      }
    }),
    "dsh-whale-pet: Live2D ZIP Worker route"
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: WHALE_PET_PATHS.cubismCore,
      handler: (_req, res) => {
        try {
          const code = readFileSync6(CUBISM_CORE_PATH, "utf8");
          res.writeHead(200, IMMUTABLE_JS_HEADERS);
          res.end(code);
        } catch (error) {
          ctx.logger?.warn?.("dsh-whale-pet: Cubism Core runtime missing");
          ctx.logger?.warn?.(error);
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("Cubism Core runtime not found");
        }
      }
    }),
    "dsh-whale-pet: Cubism Core route"
  );
}
export {
  apply,
  inject,
  name
};
