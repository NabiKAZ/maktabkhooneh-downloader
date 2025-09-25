/**
 * CLI tool to download all lecture videos of a maktabkhooneh course
 *
 * Usage examples:
 *   node download.mjs "https://maktabkhooneh.org/course/<slug>/" --user you@example.com --pass "Secret123"
 *   node download.mjs "https://maktabkhooneh.org/course/<slug>/" --sample-bytes 65536 --verbose
 *
 * Notes: Only download content you have legal rights to access.
 *
 * @repository https://github.com/NabiKAZ/maktabkhooneh-downloader
 * @author NabiKAZ <https://x.com/NabiKAZ>
 * @license GPL-3.0
 * @created 2025
 *
 * Copyright(C) 2025 NabiKAZ
 */

import fs from "fs";
import path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { setTimeout as sleep } from "timers/promises";

// ===============
// Console styling (ANSI colors) and emojis
// ===============
const COLOR = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
  cyan: "\u001b[36m",
  lightBlue: "\u001b[94m",
};
const paint = (code, s) => `${code}${s}${COLOR.reset}`;
const paintBold = (s) => paint(COLOR.bold, s);
const paintGreen = (s) => paint(COLOR.green, s);
const paintRed = (s) => paint(COLOR.red, s);
const paintYellow = (s) => paint(COLOR.yellow, s);
const paintCyan = (s) => paint(COLOR.cyan, s);
// Combined style helpers
const paintBoldCyan = (s) => `${COLOR.bold}${COLOR.cyan}${s}${COLOR.reset}`; // bold + cyan
const paintBlue = (s) => paint(COLOR.blue, s);
const paintLightBlue = (s) => paint(COLOR.lightBlue, s);

const logInfo = (...a) => console.log("ℹ️", ...a);
const logStep = (...a) => console.log("▶️", ...a);
const logSuccess = (...a) => console.log("✅", ...a);
const logWarn = (...a) => console.warn("⚠️", ...a);
const logError = (...a) => console.error("❌", ...a);

// ===============
// Configuration
// ===============
// Cookie: read from env MK_COOKIE or file path in MK_COOKIE_FILE; fallback to placeholder.
const COOKIE = (() => {
  if (process.env.MK_COOKIE && process.env.MK_COOKIE.trim())
    return process.env.MK_COOKIE.trim();
  if (process.env.MK_COOKIE_FILE) {
    try {
      return fs.readFileSync(process.env.MK_COOKIE_FILE, "utf8").trim();
    } catch {}
  }
  return "PUT_YOUR_COOKIE_HERE";
})();
// ACTIVE_COOKIE will be dynamically set after login/session load (fallback to COOKIE)
let ACTIVE_COOKIE = null;
// Sample mode default (0 means full download)
const DEFAULT_SAMPLE_BYTES = 0;

// Ensure Node 18+ for global fetch
if (typeof fetch !== "function") {
  logError("This script requires Node.js v18+ with global fetch.");
  process.exit(1);
}

const ORIGIN = "https://maktabkhooneh.org";

// Build common headers for authenticated requests.
function commonHeaders(referer) {
  /** @type {Record<string,string>} */
  const headers = {
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9,fa;q=0.8",
    "cache-control": "no-cache",
    pragma: "no-cache",
    "x-requested-with": "XMLHttpRequest",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
  };
  const ck = ACTIVE_COOKIE || COOKIE;
  if (ck && ck !== "PUT_YOUR_COOKIE_HERE") headers["cookie"] = ck;
  if (referer) headers["referer"] = referer;
  return headers;
}

// Human-friendly byte formatter
function formatBytes(bytes) {
  if (bytes == null || isNaN(bytes)) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = Number(bytes);
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`;
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || !isFinite(bytesPerSec)) return "-";
  return `${formatBytes(bytesPerSec)}/s`;
}

function buildProgressBar(ratio, width = 24) {
  const r = Math.max(0, Math.min(1, ratio || 0));
  const filled = Math.round(r * width);
  const left = width - filled;
  const bar = `${"█".repeat(filled)}${"░".repeat(left)}`;
  return bar;
}

function ensureCookiePresent() {
  if (
    !(ACTIVE_COOKIE && ACTIVE_COOKIE !== "PUT_YOUR_COOKIE_HERE") &&
    !(COOKIE && COOKIE !== "PUT_YOUR_COOKIE_HERE")
  ) {
    logError(
      "No active session. Provide --user / --pass to login or set MK_COOKIE / MK_COOKIE_FILE."
    );
    process.exit(1);
  }
}

// CLI usage
function printUsage() {
  // Header section
  console.log(
    `${paintBoldCyan("Maktabkhooneh Downloader")} - ${paintYellow(
      "version 1.0.0"
    )} ${paint(COLOR.dim, "© 2025")}`
  );
  console.log(
    paint(COLOR.magenta, "By ") +
      paint(COLOR.magenta, "@NabiKAZ") +
      " " +
      paintLightBlue("<www.nabi.ir>") +
      " " +
      paintGreen("<nabikaz@gmail.com>") +
      " " +
      paintLightBlue("<x.com/NabiKAZ>")
  );
  console.log(
    paint(COLOR.dim, "Signup: ") + paintLightBlue("https://maktabkhooneh.org/")
  );
  console.log(
    paint(COLOR.dim, "Project: ") +
      paintLightBlue("https://github.com/NabiKAZ/maktabkhooneh-downloader")
  );
  console.log(
    paint(
      COLOR.dim,
      "=============================================================\n"
    )
  );

  // Usage
  console.log(paintBold("Usage:"));
  console.log(
    `  ${paintCyan("node download.mjs")} ${paintYellow(
      "<course_url>"
    )} [options]`
  );

  // Options
  console.log("\n" + paintBold("Options:"));
  console.log(
    `  ${paintYellow(
      "<course_url>"
    )}                The maktabkhooneh course URL (e.g., https://maktabkhooneh.org/course/<slug>/)`
  );
  console.log(
    `  ${paintGreen("--sample-bytes")} ${paintYellow(
      "N"
    )}            Download only the first N bytes of each video (also via env MK_SAMPLE_BYTES)`
  );
  console.log(
    `  ${paintGreen("--user")} | ${paintGreen("--email")} ${paintYellow(
      "<EMAIL>"
    )}    Login with email (stores cookie in session file)`
  );
  console.log(
    `  ${paintGreen("--pass")} | ${paintGreen("--password")} ${paintYellow(
      "<PASS>"
    )}  Password for login (consider quoting)`
  );
  console.log(
    `  ${paintGreen("--session-file")} ${paintYellow(
      "<FILE>"
    )}       Session store path (default: session.json, multi-user)`
  );
  console.log(
    `  ${paintGreen(
      "--force-login"
    )}               Force fresh login even if stored session is valid`
  );
  console.log(
    `  ${paintGreen("--verbose")} | ${paintGreen(
      "-v"
    )}              Verbose debug / HTTP flow info`
  );
  console.log(
    `  ${paintGreen("--help")} | ${paintGreen(
      "-h"
    )}                 Show this help and exit`
  );
  console.log("\n" + paintBold("Env vars:"));
  console.log(
    `    MK_COOKIE / MK_COOKIE_FILE   Override cookie manually (bypass credential login)`
  );
  console.log(
    `    MK_SAMPLE_BYTES              Default sample bytes (overridden by --sample-bytes)`
  );

  // Examples
  console.log("\n" + paintBold("Examples:"));
  console.log(
    "  " +
      paintCyan('node download.mjs "https://maktabkhooneh.org/course/<slug>/"')
  );
  console.log(
    "  " +
      paintCyan(
        'node download.mjs "https://maktabkhooneh.org/course/<slug>/" --sample-bytes 65536 --verbose'
      )
  );
  console.log(
    "  " +
      paintCyan(
        'node download.mjs "https://maktabkhooneh.org/course/<slug>/" --user you@example.com --pass "Secret123"'
      )
  );
  console.log(
    "  " +
      paintCyan(
        'node download.mjs "https://maktabkhooneh.org/course/<slug>/" --user you@example.com --pass "Secret123" --force-login'
      )
  );
  console.log("");
}

function parseCLI() {
  const args = process.argv.slice(2);
  let inputCourseUrl = null;
  let sampleBytesToDownload = DEFAULT_SAMPLE_BYTES;
  let isVerboseLoggingEnabled = false;
  let userEmail = null;
  let userPassword = null;
  let sessionFile = "session.json";
  let forceLogin = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    } else if (a === "--user" || a === "--email") {
      const v = args[i + 1];
      if (v) {
        userEmail = v;
        i++;
      }
    } else if (a.startsWith("--user=")) {
      userEmail = a.split("=")[1];
    } else if (a === "--pass" || a === "--password") {
      const v = args[i + 1];
      if (v) {
        userPassword = v;
        i++;
      }
    } else if (a.startsWith("--pass=")) {
      userPassword = a.split("=")[1];
    } else if (a === "--session-file") {
      const v = args[i + 1];
      if (v) {
        sessionFile = v;
        i++;
      }
    } else if (a.startsWith("--session-file=")) {
      sessionFile = a.split("=")[1];
    } else if (a.startsWith("--sample-bytes=")) {
      const v = a.split("=")[1];
      sampleBytesToDownload = parseInt(v, 10) || 0;
    } else if (a === "--sample-bytes") {
      const v = args[i + 1];
      if (v) {
        sampleBytesToDownload = parseInt(v, 10) || 0;
        i++;
      }
    } else if (a === "--verbose" || a === "-v") {
      isVerboseLoggingEnabled = true;
    } else if (a === "--force-login") {
      forceLogin = true;
    } else if (!inputCourseUrl) {
      inputCourseUrl = a;
    }
  }
  if (!sampleBytesToDownload && process.env.MK_SAMPLE_BYTES) {
    sampleBytesToDownload = parseInt(process.env.MK_SAMPLE_BYTES, 10) || 0;
  }
  return {
    inputCourseUrl,
    sampleBytesToDownload,
    isVerboseLoggingEnabled,
    userEmail,
    userPassword,
    sessionFile,
    forceLogin,
  };
}

function createVerboseLogger(isVerbose) {
  return {
    verbose: (...a) => {
      if (isVerbose) console.log(...a);
    },
  };
}

// Parse the course slug from the full course URL.
function extractCourseSlug(courseUrl) {
  try {
    const parsed = new URL(courseUrl);
    if (parsed.origin !== ORIGIN) {
      throw new Error("Unexpected origin: " + parsed.origin);
    }
    const parts = parsed.pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("course");
    if (idx === -1 || !parts[idx + 1])
      throw new Error("Cannot parse course slug");
    return parts[idx + 1];
  } catch (e) {
    throw new Error("Invalid course URL: " + e.message);
  }
}

// Fetch with timeout.
async function fetchWithTimeout(url, options = {}, timeoutMs = 60_000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

function ensureTrailingSlash(u) {
  return u.endsWith("/") ? u : u + "/";
}

// Try to detect remote file size and whether server supports Range
async function getRemoteSizeAndRanges(url, referer) {
  // HEAD first
  try {
    const res = await fetchWithTimeout(
      url,
      { method: "HEAD", headers: { ...commonHeaders(referer), accept: "*/*" } },
      20_000
    );
    if (res.ok) {
      const len = res.headers.get("content-length");
      const size = len ? parseInt(len, 10) : undefined;
      const acceptRanges = (res.headers.get("accept-ranges") || "")
        .toLowerCase()
        .includes("bytes");
      return { size, acceptRanges };
    }
  } catch {}
  // Fallback: GET single byte
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: "GET",
        headers: {
          ...commonHeaders(referer),
          range: "bytes=0-0",
          accept: "*/*",
        },
      },
      20_000
    );
    if (res.status === 206) {
      const cr = res.headers.get("content-range");
      // e.g. bytes 0-0/123456
      const m = cr && cr.match(/\/(\d+)$/);
      const size = m ? parseInt(m[1], 10) : undefined;
      try {
        if (res.body) {
          const rb = Readable.fromWeb(res.body);
          rb.resume();
        }
      } catch {}
      return { size, acceptRanges: true };
    }
  } catch {}
  return { size: undefined, acceptRanges: false };
}

// API: fetch chapters JSON for a course.
async function fetchChapters(courseSlug, referer) {
  const apiUrl = `${ORIGIN}/api/v1/courses/${courseSlug}/chapters/`;
  const res = await fetchWithTimeout(apiUrl, {
    method: "GET",
    headers: { ...commonHeaders(referer), accept: "application/json" },
  });
  if (!res.ok)
    throw new Error(
      `Failed to fetch chapters: ${res.status} ${res.statusText}`
    );
  return res.json();
}

// API: core-data to verify authentication and basic profile.
async function fetchCoreData(referer) {
  const url = `${ORIGIN}/api/v1/general/core-data/?profile=1`;
  const res = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: {
        ...commonHeaders(referer || ORIGIN),
        accept: "application/json",
      },
    },
    30_000
  );
  if (!res.ok)
    throw new Error(
      `Core-data request failed: ${res.status} ${res.statusText}`
    );
  return res.json();
}

function printProfileSummary(core) {
  const isAuthenticated = !!core?.auth?.details?.is_authenticated;
  const email =
    core?.auth?.details?.email || core?.profile?.details?.email || "-";
  const userId = core?.auth?.details?.user_id ?? "-";
  const studentId = core?.auth?.details?.student_id ?? "-";
  const hasSubscription = !!core?.auth?.conditions?.has_subscription;
  const hasCoursePurchase = !!core?.auth?.conditions?.has_course_purchase;
  const statusText = isAuthenticated
    ? paintGreen("Authenticated")
    : paintRed("NOT authenticated");
  console.log(`🔐 Auth check: ${statusText}`);
  console.log(
    `👤 User: ${paintCyan(email)}  | user_id: ${paintCyan(
      userId
    )}  | student_id: ${paintCyan(studentId)}`
  );
  console.log(
    `💳 Subscription: ${
      hasSubscription ? paintGreen("yes") : paintYellow("no")
    }  | Has course purchase: ${
      hasCoursePurchase ? paintGreen("yes") : paintYellow("no")
    }`
  );
  return isAuthenticated;
}

// Build lecture page URL for a specific chapter/unit.
function buildLectureUrl(courseSlug, chapter, unit) {
  const chapterSegment = `${encodeURIComponent(chapter.slug)}-ch${chapter.id}`;
  const unitSegment = encodeURIComponent(unit.slug);
  return `${ORIGIN}/course/${courseSlug}/${chapterSegment}/${unitSegment}/`;
}

// Minimal HTML entities decoder for attribute values.
function decodeHtmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCharCode(parseInt(h, 16))
    );
}

// Extract <source ... src="..."> URLs from lecture page HTML.
function extractVideoSources(html) {
  const urls = [];
  const re = /<source\b[^>]*?src=["']([^"'>]+)["'][^>]*>/gim;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1];
    const url = decodeHtmlEntities(raw);
    if (url && url.includes("/videos/")) urls.push(url);
  }
  return Array.from(new Set(urls));
}

// Pick best source, prefer HQ.
function pickBestSource(urls) {
  if (!urls || urls.length === 0) return null;
  const hq = urls.find(
    (u) => /\/videos\/hq\d+/.test(u) || u.includes("/videos/hq")
  );
  return hq || urls[0];
}

// Sanitize a string for safe Windows filenames.
function sanitizeName(name) {
  return name
    .replace(/[\/:*?"<>|]/g, " ")
    .replace(/[\s\u200c\u200f\u202a\u202b]+/g, " ")
    .trim()
    .slice(0, 150);
}

// Extract attachment links from lecture HTML.
function extractAttachmentLinks(html) {
  const results = new Set();
  if (!html) return [];
  // Regex to capture <div class="...unit-content--download..."> ... <a href="..."> inside
  const blockRe =
    /<div[^>]*class=["'][^"'>]*unit-content--download[^"'>]*["'][^>]*>[\s\S]*?<\/div>/gim;
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    const block = m[0];
    // Find anchor hrefs inside this block
    const aRe = /<a[^>]+href=["']([^"'>]+)["'][^>]*>/gim;
    let a;
    while ((a = aRe.exec(block)) !== null) {
      const raw = a[1];
      const url = decodeHtmlEntities(raw);
      if (url && /attachments/i.test(url)) {
        results.add(url);
      }
    }
  }
  return Array.from(results);
}

// --- Session / Login helpers ---
// --- Multi-user session file helpers ---
// Structure:
// {
//   "users": { "email@example.com": { "cookie": "csrftoken=..; sessionid=..", "updated": "ISO" }, ... },
//   "lastUsed": "email@example.com"
// }
async function readSessionFile(file) {
  try {
    const txt = await fs.promises.readFile(file, "utf8");
    const data = JSON.parse(txt);
    if (data && data.users) {
      // Already new format (or compatible)
      return data;
    }
    // Backward compatibility: old single-cookie format { cookie: "..." }
    if (data && typeof data.cookie === "string") {
      return {
        users: {
          default: {
            cookie: data.cookie,
            updated: data.updated || new Date().toISOString(),
          },
        },
        lastUsed: "default",
      };
    }
  } catch {}
  return null;
}

async function writeSessionFileMulti(file, email, cookie, existing) {
  // email can be null -> store under 'default'
  const key = (email || "default").trim().toLowerCase();
  let data =
    existing && existing.users ? existing : { users: {}, lastUsed: key };
  data.users[key] = { cookie, updated: new Date().toISOString() };
  data.lastUsed = key;
  try {
    await fs.promises.writeFile(file, JSON.stringify(data, null, 2), "utf8");
  } catch {}
}

async function fetchJson(url, referer) {
  const res = await fetchWithTimeout(
    url,
    { headers: { ...commonHeaders(referer), accept: "application/json" } },
    30_000
  );
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { res, text, json };
}

function extractSetCookie(res) {
  // Node fetch in Node 18 does not expose raw set-cookie headers directly. We rely on manual cookie env or future enhancement.
  return null;
}

async function obtainCsrfToken() {
  const { json } = await fetchJson(
    `${ORIGIN}/api/v1/general/core-data/?profile=1`,
    ORIGIN
  );
  let csrf = json?.auth?.csrf;
  // Try to parse cookie from ACTIVE_COOKIE fallback
  if (!csrf) {
    // Not critical; some endpoints may still set it later.
  }
  return csrf;
}

import https from "https";

// Manual minimal cookie store (in-memory) for login flow only
class SimpleCookieStore {
  constructor() {
    this.map = new Map();
  }
  setCookieLine(line) {
    if (!line) return;
    const seg = line.split(";")[0];
    const eq = seg.indexOf("=");
    if (eq === -1) return;
    const k = seg.slice(0, eq).trim();
    const v = seg.slice(eq + 1).trim();
    if (k) this.map.set(k, v);
  }
  applySetCookie(arr) {
    (arr || []).forEach((l) => this.setCookieLine(l));
  }
  get(name) {
    return this.map.get(name);
  }
  headerString() {
    return Array.from(this.map.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
}

function rawRequest(
  urlStr,
  { method = "GET", headers = {}, body = null } = {}
) {
  const u = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const opts = {
      method,
      hostname: u.hostname,
      path: u.pathname + (u.search || ""),
      protocol: u.protocol,
      headers,
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function loginWithCredentialsInline(email, password, verbose = () => {}) {
  if (!email || !password)
    throw new Error("Email & password required for login");
  const store = new SimpleCookieStore();
  const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";
  // Helper small debug printer (always go through verbose)
  const dbg = (...a) => verbose("[login]", ...a);

  // 0. Visit login page to obtain initial csrftoken cookie
  let r = await rawRequest(`${ORIGIN}/accounts/login/`, {
    method: "GET",
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  store.applySetCookie(r.headers["set-cookie"]);
  let csrf = store.get("csrftoken") || null;
  if (!csrf) {
    // 0b. fallback: core-data json endpoint (sometimes returns csrf in body)
    const r2 = await rawRequest(
      `${ORIGIN}/api/v1/general/core-data/?profile=1`,
      {
        method: "GET",
        headers: { "User-Agent": UA, Accept: "application/json" },
      }
    );
    store.applySetCookie(r2.headers["set-cookie"]);
    try {
      const j2 = JSON.parse(r2.body);
      csrf = csrf || j2?.auth?.csrf || null;
    } catch {}
    if (!csrf) csrf = store.get("csrftoken") || null;
    dbg("Fallback core-data for CSRF status:", r2.status);
  }
  if (!csrf) throw new Error("Cannot obtain CSRF token");
  dbg("CSRF token:", csrf.slice(0, 8) + "...");

  const cookieHeader = () => store.headerString();
  const baseHeaders = () => ({
    "User-Agent": UA,
    Accept: "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
  });
  const addCsrfHeaders = (h = {}) => ({
    ...h,
    "X-CSRFToken": csrf,
    Origin: ORIGIN,
    Referer: `${ORIGIN}/accounts/login/`,
  });

  // 1. check-active-user
  const formCheck = new URLSearchParams();
  formCheck.append("csrfmiddlewaretoken", csrf);
  formCheck.append("tessera", email);
  // recaptcha sometimes optional; keep param but empty to mimic browser before token set
  formCheck.append("g-recaptcha-response", "");
  r = await rawRequest(`${ORIGIN}/api/v1/auth/check-active-user`, {
    method: "POST",
    headers: addCsrfHeaders({
      ...baseHeaders(),
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Cookie: cookieHeader(),
    }),
    body: formCheck.toString(),
  });
  store.applySetCookie(r.headers["set-cookie"]);
  let jCheck = null;
  try {
    jCheck = JSON.parse(r.body);
  } catch {}
  if (!jCheck) {
    dbg("check-active-user raw body:", r.body.slice(0, 300));
    throw new Error("check-active-user invalid JSON status=" + r.status);
  }
  dbg("check-active-user response:", jCheck.status, jCheck.message);
  if (jCheck.status !== "success") {
    // Provide clearer error details
    throw new Error(
      "check-active-user failed status=" +
        jCheck.status +
        " message=" +
        jCheck.message
    );
  }
  if (jCheck.message !== "get-pass") {
    throw new Error(
      "Unsupported flow (expected get-pass, got " + jCheck.message + ")"
    );
  }
  dbg("check-active-user OK");

  // 2. login-authentication
  const formLogin = new URLSearchParams();
  formLogin.append("csrfmiddlewaretoken", csrf);
  formLogin.append("tessera", email);
  formLogin.append("hidden_username", email);
  formLogin.append("password", password);
  formLogin.append("g-recaptcha-response", "");
  r = await rawRequest(`${ORIGIN}/api/v1/auth/login-authentication`, {
    method: "POST",
    headers: addCsrfHeaders({
      ...baseHeaders(),
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Cookie: cookieHeader(),
    }),
    body: formLogin.toString(),
  });
  store.applySetCookie(r.headers["set-cookie"]);
  let jLogin = null;
  try {
    jLogin = JSON.parse(r.body);
  } catch {}
  if (!jLogin) {
    dbg("login-authentication raw body:", r.body.slice(0, 300));
    throw new Error("login-authentication invalid JSON status=" + r.status);
  }
  dbg("login-authentication response:", jLogin.status, jLogin.message);
  if (jLogin.status !== "success")
    throw new Error("login-authentication failed message=" + jLogin.message);
  dbg("login-authentication OK");

  // Compose final cookie header (only what we need for reuse)
  const sessionid = store.get("sessionid");
  const csrftoken = store.get("csrftoken") || csrf;
  if (!sessionid) throw new Error("Session cookie missing after login");
  ACTIVE_COOKIE = `csrftoken=${csrftoken}; sessionid=${sessionid}`;
  dbg("ACTIVE_COOKIE prepared");
  return true;
}

async function prepareSession({
  userEmail,
  userPassword,
  sessionFile,
  verbose,
  courseUrl,
  forceLogin,
}) {
  // Helper to verify current ACTIVE_COOKIE by calling core-data
  const verify = async () => {
    try {
      if (!ACTIVE_COOKIE) return null;
      verbose("Verifying existing session cookie...");
      const core = await fetchCoreData(courseUrl || ORIGIN);
      const ok = !!core?.auth?.details?.is_authenticated;
      if (ok) {
        logInfo("Session valid" + (userEmail ? ` (user: ${userEmail})` : ""));
        return core;
      }
      logWarn("Stored session not authenticated");
      return null;
    } catch (e) {
      verbose("Verify failed: " + e.message);
      return null;
    }
  };

  // 1. Environment / explicit cookie overrides everything
  if (COOKIE && COOKIE !== "PUT_YOUR_COOKIE_HERE") {
    ACTIVE_COOKIE = COOKIE;
    verbose("Using cookie from env / file override");
    const core = await verify();
    if (core) return { core, source: "env" };
    // If env cookie invalid and we have credentials we can attempt login below.
  }

  // 2. Load multi-user session store if exists
  let sessionData = null;
  if (sessionFile) {
    sessionData = await readSessionFile(sessionFile);
  }

  const desiredUserKey = userEmail ? userEmail.trim().toLowerCase() : null;

  // 2a. If user specified, try existing cookie first (even if password provided) unless forceLogin
  if (sessionData && desiredUserKey && !forceLogin) {
    const entry = sessionData.users[desiredUserKey];
    if (entry && entry.cookie) {
      ACTIVE_COOKIE = entry.cookie;
      logStep(`Loaded stored session for user ${desiredUserKey}`);
      const core = await verify();
      if (core) {
        if (userPassword)
          verbose(
            "Reusing valid stored session; skipping login because --force-login not set"
          );
        return { core, source: "stored-user" };
      }
      logWarn(
        "Stored session invalid; will attempt fresh login if password provided."
      );
      ACTIVE_COOKIE = null; // clear invalid
    }
  }
  // 2b. If no user specified, try lastUsed
  if (sessionData && !desiredUserKey) {
    const key = sessionData.lastUsed;
    if (key && sessionData.users[key] && sessionData.users[key].cookie) {
      ACTIVE_COOKIE = sessionData.users[key].cookie;
      logStep(`Loaded lastUsed session (${key})`);
      const core = await verify();
      if (core) return { core, source: "stored-last" };
      logWarn("Last used session invalid.");
    }
  }

  // 3. Need to login only if we have credentials AND either no session or it was invalid
  if (desiredUserKey && userPassword && (!ACTIVE_COOKIE || forceLogin)) {
    try {
      logStep("Attempting login for " + desiredUserKey);
      await loginWithCredentialsInline(userEmail, userPassword, verbose);
      if (ACTIVE_COOKIE && sessionFile) {
        await writeSessionFileMulti(
          sessionFile,
          userEmail,
          ACTIVE_COOKIE,
          sessionData
        );
        logSuccess("Login success; session stored for user " + desiredUserKey);
      }
      const core = await verify();
      if (core) return { core, source: "fresh-login" };
    } catch (e) {
      logWarn("Inline login failed: " + e.message);
    }
  }

  // 4. If we reach here, maybe we still have ACTIVE_COOKIE but verification failed or no cookie
  if (!ACTIVE_COOKIE) {
    logWarn(
      "No usable session found. Provide --user and --pass to create one."
    );
  }
  return { core: null, source: "none" };
}

// Extract <track ... src="..."> subtitle URLs from lecture HTML.
function extractSubtitleLinks(html) {
  const results = new Set();
  if (!html) return [];
  const re = /<track\b[^>]*?src=["']([^"'>]+)["'][^>]*>/gim;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1];
    const url = decodeHtmlEntities(raw);
    if (url) results.add(url);
  }
  return Array.from(results);
}

// Transform stream to limit to first N bytes and optionally signal upstream.
class ByteLimit extends Transform {
  // Limits the stream to the first `limit` bytes, then signals upstream to stop.
  constructor(limit, onLimit) {
    super();
    this.limit = limit;
    this.seen = 0;
    this._hit = false;
    this._onLimit = onLimit;
  }
  _transform(chunk, enc, cb) {
    if (this.limit <= 0) {
      this.push(chunk);
      return cb();
    }
    const remaining = this.limit - this.seen;
    if (remaining <= 0) {
      return cb();
    }
    const buf = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    this.push(buf);
    this.seen += buf.length;
    if (!this._hit && this.seen >= this.limit) {
      this.end();
      this._hit = true;
      if (typeof this._onLimit === "function") {
        try {
          this._onLimit();
        } catch {}
      }
    }
    cb();
  }
}

// Download a URL to a file (with retries). If sampleBytes > 0, request a Range and also enforce a local limit.
// label: optional display name to show in the progress line (e.g., final file name)
async function downloadToFile(
  url,
  filePath,
  referer,
  maxRetries = 3,
  sampleBytes = 0,
  label = ""
) {
  // Skip if already exists with non-zero size
  let existingFinalSize = 0;
  try {
    const stat = fs.statSync(filePath);
    existingFinalSize = stat.size;
    if (existingFinalSize > 0 && sampleBytes > 0) return "exists";
  } catch {}
  const tmpPath = filePath + ".part";
  let existingTmpSize = 0;
  try {
    const stat = fs.statSync(tmpPath);
    existingTmpSize = stat.size;
  } catch {}

  // For full downloads, see if final is already complete
  let remoteInfo;
  if (sampleBytes === 0 && existingFinalSize > 0) {
    remoteInfo = await getRemoteSizeAndRanges(url, referer);
    if (remoteInfo.size && existingFinalSize >= remoteInfo.size) {
      return "exists";
    }
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Re-check tmp file size on each attempt (in case previous attempt added data)
      let currentTmpSize = 0;
      try {
        const stat = fs.statSync(tmpPath);
        currentTmpSize = stat.size;
      } catch {}

      // Decide resume offset
      let resumeOffset = 0;
      let writingTo = tmpPath;
      if (sampleBytes > 0) {
        resumeOffset = 0; // do not resume sample downloads
        // For sample downloads, always start fresh
        try {
          await fs.promises.unlink(tmpPath);
        } catch {}
        currentTmpSize = 0;
      } else {
        if (currentTmpSize > 0) {
          resumeOffset = currentTmpSize;
        } else if (existingFinalSize > 0) {
          // Only resume from final if server supports ranges
          if (!remoteInfo)
            remoteInfo = await getRemoteSizeAndRanges(url, referer);
          if (remoteInfo.acceptRanges) {
            // Move final to tmp to resume appending
            try {
              await fs.promises.rename(filePath, tmpPath);
              currentTmpSize = existingFinalSize;
              resumeOffset = existingFinalSize;
              existingFinalSize = 0;
            } catch {}
          } else {
            // Cannot resume; start from scratch
            resumeOffset = 0;
          }
        }
      }

      const requestInit = {
        method: "GET",
        headers: {
          ...commonHeaders(referer),
          accept: "video/mp4,application/octet-stream,*/*",
        },
      };
      if (sampleBytes && sampleBytes > 0) {
        requestInit.headers["range"] = `bytes=0-${Math.max(
          0,
          sampleBytes - 1
        )}`;
      } else if (resumeOffset > 0) {
        requestInit.headers["range"] = `bytes=${resumeOffset}-`;
      }

      const controller = new AbortController();
      // Increase timeout and make it dynamic based on expected file size
      let timeoutMs = 300_000; // 5 minutes default
      if (!remoteInfo) remoteInfo = await getRemoteSizeAndRanges(url, referer);
      if (remoteInfo.size) {
        // Allow 1 minute per MB, minimum 2 minutes, maximum 30 minutes
        const estimatedMinutes = Math.max(
          2,
          Math.min(30, Math.ceil(remoteInfo.size / (1024 * 1024)))
        );
        timeoutMs = estimatedMinutes * 60 * 1000;
      }

      let timeoutId;
      let lastProgressTime = Date.now();
      const progressTimeout = 60_000; // 1 minute without progress = timeout

      const resetProgressTimeout = () => {
        if (timeoutId) clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
          controller.abort();
        }, progressTimeout);
        lastProgressTime = Date.now();
      };

      resetProgressTimeout(); // Start initial timeout
      const to = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(url, {
        ...requestInit,
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      if (resumeOffset > 0 && res.status !== 206) {
        // Server didn't honor Range; restart from 0
        try {
          await fs.promises.unlink(tmpPath);
        } catch {}
        currentTmpSize = 0;
        resumeOffset = 0;
        clearTimeout(to);
        throw new Error("Server did not honor range; restarting from 0");
      }

      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      const write = fs.createWriteStream(writingTo, {
        flags: sampleBytes > 0 || resumeOffset === 0 ? "w" : "a",
      });
      const readable = Readable.fromWeb(res.body);

      // Progress bar state
      const contentLengthHeader = res.headers.get("content-length");
      const fullLength = contentLengthHeader
        ? parseInt(contentLengthHeader, 10)
        : undefined;
      // Try content-range for total size when resuming
      let expectedTotal;
      const contentRange = res.headers.get("content-range");
      const crMatch = contentRange && contentRange.match(/\/(\d+)$/);
      if (sampleBytes && sampleBytes > 0) expectedTotal = sampleBytes;
      else if (crMatch) expectedTotal = parseInt(crMatch[1], 10);
      else if (fullLength && resumeOffset > 0)
        expectedTotal = resumeOffset + fullLength;
      else expectedTotal = fullLength;
      let downloadedBytes = resumeOffset;
      let bytesDownloadedThisAttempt = 0; // Track bytes downloaded in this specific attempt
      const startedAt = Date.now();

      // Progress render helper
      const truncate = (s, max = 70) => {
        if (!s) return "";
        const str = String(s);
        return str.length > max ? str.slice(0, max - 1) + "…" : str;
      };
      const render = (final = false) => {
        const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);
        // Calculate speed based only on bytes downloaded in this attempt
        const speed = bytesDownloadedThisAttempt / elapsedSec;
        // clamp bytes to expected total when finalizing or very close (to avoid 99.9% stuck)
        let shownDownloaded = downloadedBytes;
        if (expectedTotal && (final || downloadedBytes > expectedTotal)) {
          // Tolerate tiny overflow due to headers/rounding
          const overflow = downloadedBytes - expectedTotal;
          if (overflow <= 65536) shownDownloaded = expectedTotal;
        }
        // Decide ratio; if final, force full bar
        let ratio = 0;
        if (final) {
          ratio = 1;
        } else if (expectedTotal) {
          ratio = shownDownloaded / expectedTotal;
        } else {
          ratio = 0; // unknown total
        }
        const bar = buildProgressBar(ratio);
        const pct = final
          ? "100.0%"
          : expectedTotal
          ? `${(Math.min(1, ratio) * 100).toFixed(1)}%`
          : "--%";
        const sizeStr = `${formatBytes(shownDownloaded)}${
          expectedTotal ? " / " + formatBytes(expectedTotal) : ""
        }`;
        const name = label ? `  -  ${truncate(label, 80)}` : "";
        const line = `  ⬇️  [${bar}] ${pct}  ${sizeStr}  ${formatSpeed(
          speed
        )}${name}`;
        process.stdout.write(`\r${line}`);
      };

      // Counting transform
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          downloadedBytes += chunk.length;
          bytesDownloadedThisAttempt += chunk.length;
          resetProgressTimeout(); // Reset timeout when we receive data
          // throttle render slightly by size steps
          if (
            bytesDownloadedThisAttempt === chunk.length ||
            downloadedBytes % 65536 < 8192
          )
            render();
          cb(null, chunk);
        },
      });
      let byteLimitReached = false;
      try {
        if (sampleBytes && sampleBytes > 0) {
          const limiter = new ByteLimit(sampleBytes, () => {
            byteLimitReached = true;
            try {
              readable.destroy(new Error("byte-limit"));
            } catch {}
            try {
              controller.abort();
            } catch {}
          });
          await pipeline(readable, counter, limiter, write);
        } else {
          await pipeline(readable, counter, write);
        }
      } catch (pipeErr) {
        if (sampleBytes && byteLimitReached) {
          try {
            clearTimeout(to);
          } catch {}
          try {
            clearTimeout(timeoutId);
          } catch {}
          try {
            render(true);
            process.stdout.write("\n");
          } catch {}
          try {
            await fs.promises.rename(tmpPath, filePath);
          } catch (e) {
            try {
              await fs.promises.copyFile(writingTo, filePath);
            } catch {}
          }
          try {
            await fs.promises.unlink(tmpPath);
          } catch {}
          return "downloaded";
        }
        throw pipeErr;
      } finally {
        clearTimeout(to);
        if (timeoutId) clearTimeout(timeoutId);
      }

      // finalize progress bar to 100%
      try {
        render(true);
      } catch {}
      process.stdout.write("\n");
      try {
        await fs.promises.rename(tmpPath, filePath);
      } catch (e) {
        try {
          await fs.promises.copyFile(writingTo, filePath);
        } catch {}
      }
      try {
        await fs.promises.unlink(tmpPath);
      } catch {}
      return "downloaded";
    } catch (err) {
      try {
        process.stdout.write("\n");
      } catch {}
      // Keep .part file for future resume; do not delete on error
      if (attempt < maxRetries) {
        // Provide more specific error messages
        let errorMsg = err.message;
        if (err.name === "AbortError" || errorMsg.includes("aborted")) {
          if (Date.now() - lastProgressTime > progressTimeout - 5000) {
            errorMsg = "No progress for 60 seconds (connection stalled)";
          } else {
            errorMsg = "Download timeout (slow connection detected)";
          }
        }
        logWarn(
          `Retry ${attempt}/${maxRetries} for ${path.basename(
            filePath
          )} after error: ${errorMsg}`
        );
        // Update existingTmpSize for next attempt resume
        try {
          const stat = fs.statSync(tmpPath);
          existingTmpSize = stat.size;
        } catch {
          existingTmpSize = 0;
        }
        await sleep(1000 * attempt);
        continue;
      }
      throw err;
    }
  }
}

async function main() {
  const {
    inputCourseUrl,
    sampleBytesToDownload,
    isVerboseLoggingEnabled,
    userEmail,
    userPassword,
    sessionFile,
    forceLogin,
  } = parseCLI();
  const { verbose } = createVerboseLogger(isVerboseLoggingEnabled);
  if (!inputCourseUrl) {
    printUsage();
    process.exit(1);
  }
  // Attempt to load / create / verify session (may already return core)
  const prep = await prepareSession({
    userEmail,
    userPassword,
    sessionFile,
    verbose,
    courseUrl: inputCourseUrl,
    forceLogin,
  });
  ensureCookiePresent();

  const normalizedCourseUrl = ensureTrailingSlash(inputCourseUrl.trim());
  const courseSlug = extractCourseSlug(normalizedCourseUrl);
  // Use decoded slug (human-friendly, especially for Persian) for the top-level folder name
  const courseDisplayName = sanitizeName(decodeURIComponent(courseSlug));
  const outputRootFolder = path.resolve(
    process.cwd(),
    "download",
    courseDisplayName
  );
  // Ensure base output folder exists
  try {
    await fs.promises.mkdir(outputRootFolder, { recursive: true });
  } catch {}

  // Verify auth profile (reuse from prepareSession if available)
  let coreData = prep.core;
  if (!coreData) {
    try {
      coreData = await fetchCoreData(normalizedCourseUrl);
    } catch (e) {
      logError("Failed to verify authentication:", e.message);
      process.exit(1);
    }
  }
  const ok = printProfileSummary(coreData);
  if (!ok) {
    logError(
      "Not logged in. Session invalid. Provide credentials with --user --pass."
    );
    process.exit(1);
  }

  console.log(`📚 Course slug: ${paintBold(decodeURIComponent(courseSlug))}`);
  console.log(`📁 Output folder: ${paintCyan(outputRootFolder)}`);
  if (sampleBytesToDownload && sampleBytesToDownload > 0) {
    console.log(
      `🎯 Sample mode: downloading first ${paintBold(
        String(sampleBytesToDownload)
      )} bytes of each video (saved as .sample.mp4)`
    );
  }

  // Fetch chapters
  verbose(paintCyan("Fetching chapters..."));
  const chaptersData = await fetchChapters(courseSlug, normalizedCourseUrl);
  const chapters = Array.isArray(chaptersData?.chapters)
    ? chaptersData.chapters
    : [];
  if (chapters.length === 0) {
    logError("No chapters found. Make sure the URL and cookie are correct.");
    process.exit(2);
  }

  // Iterate chapters and units
  let totalUnits = 0,
    downloadedCount = 0,
    skippedCount = 0,
    failedCount = 0;
  try {
    for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex++) {
      const chapter = chapters[chapterIndex];
      const chapterOrder = String(chapterIndex + 1).padStart(2, "0");
      const chapterFolder = path.join(
        outputRootFolder,
        `${chapterOrder} - ${sanitizeName(
          chapter.title || chapter.slug || "chapter"
        )}`
      );
      console.log(
        `📖 Chapter ${chapterIndex + 1}/${chapters.length}: ${paintBold(
          chapter.title || chapter.slug
        )}`
      );

      const units = Array.isArray(chapter.unit_set) ? chapter.unit_set : [];
      for (let unitIndex = 0; unitIndex < units.length; unitIndex++) {
        const unit = units[unitIndex];
        if (!unit?.status) continue; // inactive
        if (unit?.type !== "lecture") continue; // skip non-video units
        totalUnits++;
        const unitOrder = String(unitIndex + 1).padStart(2, "0");
        const baseFileName = `${unitOrder} - ${sanitizeName(
          unit.title || unit.slug || "lecture"
        )}.mp4`;
        const finalFileName =
          sampleBytesToDownload && sampleBytesToDownload > 0
            ? baseFileName.replace(/\.mp4$/i, ".sample.mp4")
            : baseFileName;
        const outputFilePath = path.join(chapterFolder, finalFileName);
        verbose(
          `  🎬 Unit ${unitIndex + 1}/${units.length}: ${
            unit.title || unit.slug
          }`
        );

        // Skip locked content or content requiring purchase
        if (unit.locked) {
          logWarn(`🔒 Locked/No access: ${finalFileName}`);
          skippedCount++;
          continue;
        }

        const lectureUrl = buildLectureUrl(courseSlug, chapter, unit);
        try {
          // Fetch lecture page HTML
          const res = await fetchWithTimeout(lectureUrl, {
            headers: {
              ...commonHeaders(normalizedCourseUrl),
              accept: "text/html",
            },
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const html = await res.text();
          const videoSources = extractVideoSources(html);
          const bestSourceUrl = pickBestSource(videoSources);
          if (!bestSourceUrl) {
            logWarn(`No video source found for: ${finalFileName}`);
            skippedCount++;
            continue;
          }

          // Print the filename on its own line; progress bar will render on the next line
          console.log(`📥 Downloading: ${finalFileName}`);
          const status = await downloadToFile(
            bestSourceUrl,
            outputFilePath,
            lectureUrl,
            3,
            sampleBytesToDownload,
            ""
          );
          if (status === "exists") {
            console.log(paintYellow(`🟡 SKIP exists: ${finalFileName}`));
            skippedCount++;
          } else {
            logSuccess(`DOWNLOADED: ${finalFileName}`);
            downloadedCount++;
          }

          // ---- Subtitles (download beside video, same base name) ----
          try {
            const subtitleLinks = extractSubtitleLinks(html);
            if (subtitleLinks.length > 0) {
              const videoBaseNoExt = finalFileName
                .replace(/\.sample\.mp4$/i, "")
                .replace(/\.mp4$/i, "");
              for (const sUrl of subtitleLinks) {
                try {
                  const absUrl = (() => {
                    try {
                      return new URL(sUrl, ORIGIN).toString();
                    } catch {
                      return sUrl;
                    }
                  })();
                  // determine extension from pathname or fallback to .vtt
                  let ext = ".vtt";
                  try {
                    const up = new URL(absUrl);
                    ext = path.extname(up.pathname) || ".vtt";
                  } catch {}
                  const subtitleName = `${videoBaseNoExt}${ext}`;
                  const subtitlePath = path.join(chapterFolder, subtitleName);
                  if (
                    fs.existsSync(subtitlePath) &&
                    fs.statSync(subtitlePath).size > 0
                  ) {
                    console.log(
                      paintYellow(`🟡 Subtitle exists: ${subtitleName}`)
                    );
                    continue;
                  }
                  console.log(`📝 Subtitle: ${subtitleName}`);
                  const sStatus = await downloadToFile(
                    absUrl,
                    subtitlePath,
                    lectureUrl,
                    3,
                    0,
                    ""
                  );
                  if (sStatus === "exists")
                    console.log(
                      paintYellow(`🟡 Subtitle exists: ${subtitleName}`)
                    );
                  else logSuccess(`SUBTITLE: ${subtitleName}`);
                  await sleep(150);
                } catch (subErr) {
                  logWarn(`Subtitle fail: ${subErr.message}`);
                }
              }
            }
          } catch (subOuter) {
            logWarn(`Subtitle parse error: ${subOuter.message}`);
          }

          // ---- Attachments (download beside video) ----
          try {
            const attachmentLinks = extractAttachmentLinks(html);
            if (attachmentLinks.length > 0) {
              // Derive base (remove .sample.mp4 or .mp4)
              const videoBaseNoExt = finalFileName
                .replace(/\.sample\.mp4$/i, "")
                .replace(/\.mp4$/i, "");
              for (const attUrl of attachmentLinks) {
                try {
                  // Extract original filename from URL path (strip query)
                  let filePart;
                  try {
                    const u = new URL(attUrl);
                    filePart = u.pathname.split("/").pop() || "attachment.bin";
                  } catch {
                    filePart =
                      attUrl.split("?")[0].split("/").pop() || "attachment.bin";
                  }
                  // Keep original name (with underscores) but sanitize forbidden characters
                  const sanitizedAttachment = sanitizeName(filePart);
                  const finalAttachmentName = `${videoBaseNoExt} - ${sanitizedAttachment}`;
                  const attachmentPath = path.join(
                    chapterFolder,
                    finalAttachmentName
                  );
                  if (
                    fs.existsSync(attachmentPath) &&
                    fs.statSync(attachmentPath).size > 0
                  ) {
                    console.log(
                      paintYellow(
                        `🟡 Attachment exists: ${finalAttachmentName}`
                      )
                    );
                    continue;
                  }
                  console.log(`📎 Attachment: ${finalAttachmentName}`);
                  const aStatus = await downloadToFile(
                    attUrl,
                    attachmentPath,
                    lectureUrl,
                    3,
                    0,
                    ""
                  );
                  if (aStatus === "exists")
                    console.log(
                      paintYellow(
                        `🟡 Attachment exists: ${finalAttachmentName}`
                      )
                    );
                  else logSuccess(`ATTACHMENT: ${finalAttachmentName}`);
                  await sleep(200);
                } catch (attErr) {
                  logWarn(`Attachment fail: ${attErr.message}`);
                }
              }
            }
          } catch (attOuterErr) {
            logWarn(`Attachment parse error: ${attOuterErr.message}`);
          }
          // polite pause
          await sleep(400);
        } catch (err) {
          logError(`FAIL ${finalFileName}: ${err.message}`);
          failedCount++;
        }
      }
    }
  } finally {
    console.log("—".repeat(40));
    console.log(`📊 Total lecture units: ${paintBold(String(totalUnits))}`);
    console.log(`✅ Downloaded: ${paintGreen(String(downloadedCount))}`);
    console.log(`🟡 Skipped: ${paintYellow(String(skippedCount))}`);
    console.log(`❌ Failed: ${paintRed(String(failedCount))}`);
  }
}

main().catch((err) => {
  logError("Fatal:", err);
  process.exit(1);
});
