/**
 * CLI tool to download all lecture videos and materials of a Maktabkhooneh course.
 * Fully upgraded for Maktabkhooneh Nuxt 3 LMS Architecture.
 * Supports High-Res Videos (1080p/720p), Subtitles (.vtt), Attachments, and Quiz Extraction to Markdown.
 * 
 * Usage examples:
 *   node download.mjs "https://maktabkhooneh.org/course/<slug>/" --user you@example.com --pass "Secret123"
 *   node download.mjs "https://maktabkhooneh.org/course/<slug>/" --cookie-file "cookies.txt"
 *   node download.mjs "https://maktabkhooneh.org/course/<slug>/" --info
 *   node download.mjs "https://maktabkhooneh.org/course/<slug>/" --sample-bytes 65536 --verbose
 * 
 * Notes: Only download content you have legal rights to access.
 * 
 * @repository https://github.com/NabiKAZ/maktabkhooneh-downloader
 * @author NabiKAZ <https://x.com/NabiKAZ>
 * @license GPL-3.0
 * @created 2025-2026
 * 
 * Copyright(C) 2025-2026 NabiKAZ & Contributors
 */

import fs from 'fs';
import path from 'path';
import { Transform, Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { setTimeout as sleep } from 'timers/promises';
import https from 'https';

// ============================================================================
// Console Styling (ANSI Colors) & Logging Helpers
// ============================================================================

const COLOR = {
    reset: '\u001b[0m', bold: '\u001b[1m', dim: '\u001b[2m',
    red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m', blue: '\u001b[34m', magenta: '\u001b[35m', cyan: '\u001b[36m',
    lightBlue: '\u001b[94m'
};

const paint = (code, s) => `${code}${s}${COLOR.reset}`;
const paintBold = s => paint(COLOR.bold, s);
const paintGreen = s => paint(COLOR.green, s);
const paintRed = s => paint(COLOR.red, s);
const paintYellow = s => paint(COLOR.yellow, s);
const paintCyan = s => paint(COLOR.cyan, s);
const paintBoldCyan = s => `${COLOR.bold}${COLOR.cyan}${s}${COLOR.reset}`;
const paintLightBlue = s => paint(COLOR.lightBlue, s);

// Standardized status loggers
const logInfo = (...a) => console.log('ℹ️', ...a);
const logStep = (...a) => console.log('▶️', ...a);
const logSuccess = (...a) => console.log('✅', ...a);
const logWarn = (...a) => console.warn('⚠️', ...a);
const logError = (...a) => console.error('❌', ...a);

// ============================================================================
// Global Configuration & Runtime Checks
// ============================================================================

// Read fallback cookie from environment variable or cookie file
const COOKIE = (() => {
    if (process.env.MK_COOKIE && process.env.MK_COOKIE.trim()) return process.env.MK_COOKIE.trim();
    if (process.env.MK_COOKIE_FILE) {
        try { return fs.readFileSync(process.env.MK_COOKIE_FILE, 'utf8').trim(); } catch { }
    }
    return 'PUT_YOUR_COOKIE_HERE';
})();

// Holds the resolved active cookie header during runtime
let ACTIVE_COOKIE = null;

// Default sample mode: 0 means download full video
const DEFAULT_SAMPLE_BYTES = 0;

// Verify Node.js version supports native global fetch (v18+)
if (typeof fetch !== 'function') {
    logError('This script requires Node.js v18+ with global fetch.');
    process.exit(1);
}

const ORIGIN = 'https://maktabkhooneh.org';

// ============================================================================
// Header & String Utility Functions
// ============================================================================

/**
 * Extracts CSRF token from active cookie string if present.
 * @returns {string} CSRF token value or empty string
 */
function getCsrfToken() {
    const ck = ACTIVE_COOKIE || COOKIE || '';
    const m = ck.match(/csrftoken=([^;]+)/);
    return m ? m[1] : '';
}

/**
 * Builds standard HTTP headers required by Maktabkhooneh API and CDN requests.
 * @param {string} [referer] Optional referer URL
 * @returns {Record<string, string>} HTTP headers
 */
function commonHeaders(referer) {
    const headers = {
        'accept': 'application/json, text/html, */*',
        'accept-language': 'en-US,en;q=0.9,fa;q=0.8',
        'cache-control': 'no-cache',
        'pragma': 'no-cache',
        'x-requested-with': 'XMLHttpRequest',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
    };
    const ck = ACTIVE_COOKIE || COOKIE;
    if (ck && ck !== 'PUT_YOUR_COOKIE_HERE') headers['cookie'] = ck;
    const csrf = getCsrfToken();
    if (csrf) headers['x-csrftoken'] = csrf;
    if (referer) headers['referer'] = referer;
    return headers;
}

/**
 * Formats a raw byte count into human-readable format (e.g., KB, MB, GB).
 */
function formatBytes(bytes) {
    if (bytes == null || isNaN(bytes) || bytes === 0) return '-';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let n = Number(bytes);
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`;
}

/**
 * Formats download speed in bytes per second into human-readable format.
 */
function formatSpeed(bytesPerSec) {
    if (!bytesPerSec || !isFinite(bytesPerSec)) return '-';
    return `${formatBytes(bytesPerSec)}/s`;
}

/**
 * Builds an ASCII progress bar string based on completion ratio.
 */
function buildProgressBar(ratio, width = 24) {
    const r = Math.max(0, Math.min(1, ratio || 0));
    const filled = Math.round(r * width);
    const left = width - filled;
    return `${'█'.repeat(filled)}${'░'.repeat(left)}`;
}

/**
 * Ensures an active authenticated session exists before continuing.
 */
function ensureCookiePresent() {
    if (!(ACTIVE_COOKIE && ACTIVE_COOKIE !== 'PUT_YOUR_COOKIE_HERE') && !(COOKIE && COOKIE !== 'PUT_YOUR_COOKIE_HERE')) {
        logError('No active session. Provide --user / --pass to login or set --cookie-file / MK_COOKIE.');
        process.exit(1);
    }
}

/**
 * Decodes common HTML entities into raw Unicode characters.
 */
function decodeHtmlEntities(str) {
    if (!str) return str;
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&zwnj;/g, '\u200c')
        .replace(/&zwj;/g, '\u200d')
        .replace(/&rlm;/g, '\u200f')
        .replace(/&lrm;/g, '\u200e')
        .replace(/&bull;/g, '•')
        .replace(/&laquo;/g, '«')
        .replace(/&raquo;/g, '»')
        .replace(/&rarr;/g, '→')
        .replace(/&larr;/g, '←')
        .replace(/&ndash;/g, '–')
        .replace(/&mdash;/g, '—')
        .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * Sanitizes a string for safe usage as a Windows/Linux file and directory name.
 */
function sanitizeName(name) {
    return name.replace(/[\/:*?"<>|]/g, ' ').replace(/[\s\u200c\u200f\u202a\u202b]+/g, ' ').trim().slice(0, 150);
}

function ensureTrailingSlash(u) { return u.endsWith('/') ? u : u + '/'; }

// ============================================================================
// CLI Parsing & Usage Guide
// ============================================================================

function printUsage() {
    console.log(`${paintBoldCyan('Maktabkhooneh Downloader PLUS')} - ${paintYellow('version 3.0.0')} ${paint(COLOR.dim, '© 2026')}`);
    console.log(paint(COLOR.magenta, 'Features: ') + 'Downloads High-Res Videos (1080p/720p), Subtitles, Attachments + Extracts Quizzes/Exercises to Markdown');
    console.log(paint(COLOR.dim, 'Project: ') + paintLightBlue('https://github.com/NabiKAZ/maktabkhooneh-downloader'));
    console.log(paint(COLOR.dim, '=============================================================\n'));

    console.log(paintBold('Usage:'));
    console.log(`  ${paintCyan('node download.mjs')} ${paintYellow('<course_url>')} [options]`);

    console.log('\n' + paintBold('Options:'));
    console.log(`  ${paintYellow('<course_url>')}                The maktabkhooneh course URL (e.g., https://maktabkhooneh.org/course/<slug>/)`);
    console.log(`  ${paintGreen('--info')} | ${paintGreen('--table')} | ${paintGreen('--no-download')} ONLY show course curriculum and video sizes (No downloading)`);
    console.log(`  ${paintGreen('--sample-bytes')} ${paintYellow('N')}            Download only the first N bytes of each video`);
    console.log(`  ${paintGreen('--user')} | ${paintGreen('--email')} ${paintYellow('<EMAIL>')}    Login with email (stores session in session.json)`);
    console.log(`  ${paintGreen('--pass')} | ${paintGreen('--password')} ${paintYellow('<PASS>')}  Password for login`);
    console.log(`  ${paintGreen('--cookie-file')} ${paintYellow('<FILE>')}       Path to Netscape cookies.txt file`);
    console.log(`  ${paintGreen('--session-file')} ${paintYellow('<FILE>')}       Session store path (default: session.json, multi-user)`);
    console.log(`  ${paintGreen('--force-login')}               Force fresh login even if stored session is valid`);
    console.log(`  ${paintGreen('--verbose')} | ${paintGreen('-v')}              Verbose debug / HTTP flow info`);
    console.log(`  ${paintGreen('--help')} | ${paintGreen('-h')}                 Show this help and exit`);
}

function parseCLI() {
    const args = process.argv.slice(2);
    let inputCourseUrl = null;
    let sampleBytesToDownload = DEFAULT_SAMPLE_BYTES;
    let isVerboseLoggingEnabled = false;
    let userEmail = null;
    let userPassword = null;
    let sessionFile = 'session.json';
    let cookieFile = null;
    let forceLogin = false;
    let isInfoMode = false;

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--help' || a === '-h') {
            printUsage();
            process.exit(0);
        } else if (a === '--info' || a === '--no-download' || a === '--table') {
            isInfoMode = true;
        } else if (a === '--user' || a === '--email') {
            userEmail = args[++i];
        } else if (a.startsWith('--user=')) {
            userEmail = a.split('=')[1];
        } else if (a === '--pass' || a === '--password') {
            userPassword = args[++i];
        } else if (a.startsWith('--pass=')) {
            userPassword = a.split('=')[1];
        } else if (a === '--cookie-file') {
            cookieFile = args[++i];
        } else if (a.startsWith('--cookie-file=')) {
            cookieFile = a.split('=')[1];
        } else if (a === '--session-file') {
            sessionFile = args[++i];
        } else if (a.startsWith('--session-file=')) {
            sessionFile = a.split('=')[1];
        } else if (a === '--sample-bytes') {
            sampleBytesToDownload = parseInt(args[++i], 10) || 0;
        } else if (a.startsWith('--sample-bytes=')) {
            sampleBytesToDownload = parseInt(a.split('=')[1], 10) || 0;
        } else if (a === '--verbose' || a === '-v') {
            isVerboseLoggingEnabled = true;
        } else if (a === '--force-login') {
            forceLogin = true;
        } else if (!inputCourseUrl && !a.startsWith('--')) {
            inputCourseUrl = a;
        }
    }
    if (!sampleBytesToDownload && process.env.MK_SAMPLE_BYTES) {
        sampleBytesToDownload = parseInt(process.env.MK_SAMPLE_BYTES, 10) || 0;
    }
    return { inputCourseUrl, sampleBytesToDownload, isVerboseLoggingEnabled, userEmail, userPassword, sessionFile, cookieFile, forceLogin, isInfoMode };
}

function createVerboseLogger(isVerbose) {
    return { verbose: (...a) => { if (isVerbose) console.log(...a); } };
}

/**
 * Extracts course slug from full URL.
 */
function extractCourseSlug(courseUrl) {
    try {
        const parsed = new URL(courseUrl);
        const parts = parsed.pathname.split('/').filter(Boolean);
        const idx = parts.indexOf('course');
        if (idx === -1 || !parts[idx + 1]) throw new Error('Cannot parse course slug');
        return parts[idx + 1];
    } catch (e) {
        throw new Error('Invalid course URL: ' + e.message);
    }
}

/**
 * Extracts course numeric/short ID from slug (e.g., 'mk1234' -> '1234').
 */
function extractCourseSlugId(courseSlug) {
    const match = courseSlug.match(/mk(\d+)/i) || courseSlug.match(/(\d+)$/);
    return match ? match[1] : courseSlug;
}

/**
 * Fetch wrapper with AbortController timeout.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 60_000) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(t);
    }
}

// ============================================================================
// Authentication & Multi-Session Engine
// ============================================================================

/**
 * Parses Netscape/curl cookies.txt file into a standard Cookie header string.
 * @param {string} filePath Path to cookie file
 * @returns {string|null} Formatted cookie header or null
 */
function parseNetscapeCookieFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        const cookies = {};
        for (const line of lines) {
            if (!line || line.startsWith('#')) continue;
            const parts = line.split('\t');
            if (parts.length >= 7) {
                const name = parts[5].trim();
                const value = parts[6].trim();
                if (name && value) cookies[name] = value;
            }
        }
        if (cookies['sessionid'] || cookies['csrftoken']) {
            return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
        }
    } catch { }
    return null;
}

/**
 * In-memory Cookie Jar for multi-step login authentication.
 */
class SimpleCookieStore {
    constructor() { this.map = new Map(); }
    setCookieLine(line) {
        if (!line) return;
        const seg = line.split(';')[0];
        const eq = seg.indexOf('=');
        if (eq === -1) return;
        const k = seg.slice(0, eq).trim();
        const v = seg.slice(eq + 1).trim();
        if (k) this.map.set(k, v);
    }
    applySetCookie(arr) { (arr || []).forEach(l => this.setCookieLine(l)); }
    get(name) { return this.map.get(name); }
    headerString() { return Array.from(this.map.entries()).map(([k, v]) => `${k}=${v}`).join('; '); }
}

/**
 * Low-level HTTPS request wrapper to reliably capture Set-Cookie headers across redirects.
 */
function rawRequest(urlStr, { method = 'GET', headers = {}, body = null } = {}) {
    const u = new URL(urlStr);
    return new Promise((resolve, reject) => {
        const opts = {
            method,
            hostname: u.hostname,
            path: u.pathname + (u.search || ''),
            protocol: u.protocol,
            headers
        };
        const req = https.request(opts, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                resolve({
                    status: res.statusCode || 0,
                    headers: res.headers,
                    body: Buffer.concat(chunks).toString('utf8')
                });
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

/**
 * Performs complete 2-step Maktabkhooneh credential login:
 * 1. GET /accounts/login/ to obtain initial CSRF token
 * 2. POST /api/v1/auth/check-active-user to verify username/email
 * 3. POST /api/v1/auth/login-authentication to verify password and retrieve sessionid
 */
async function loginWithCredentialsInline(email, password, verbose = () => { }) {
    if (!email || !password) throw new Error('Email & password required for login');
    const store = new SimpleCookieStore();
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';

    // Step 0: Get initial csrftoken
    let r = await rawRequest(`${ORIGIN}/accounts/login/`, {
        method: 'GET',
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
    });
    store.applySetCookie(r.headers['set-cookie']);
    let csrf = store.get('csrftoken') || null;

    // Fallback: Check core-data endpoint if CSRF not in login page cookies
    if (!csrf) {
        const r2 = await rawRequest(`${ORIGIN}/api/v1/general/core-data/?profile=1`, {
            method: 'GET',
            headers: { 'User-Agent': UA, 'Accept': 'application/json' }
        });
        store.applySetCookie(r2.headers['set-cookie']);
        try { const j2 = JSON.parse(r2.body); csrf = csrf || j2?.auth?.csrf || null; } catch { }
        if (!csrf) csrf = store.get('csrftoken') || null;
    }
    if (!csrf) throw new Error('Cannot obtain CSRF token');

    const cookieHeader = () => store.headerString();
    const baseHeaders = () => ({
        'User-Agent': UA,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest'
    });
    const addCsrfHeaders = (h = {}) => ({
        ...h,
        'X-CSRFToken': csrf,
        'Origin': ORIGIN,
        'Referer': `${ORIGIN}/accounts/login/`
    });

    // Step 1: Check active user endpoint
    const formCheck = new URLSearchParams();
    formCheck.append('csrfmiddlewaretoken', csrf);
    formCheck.append('tessera', email);
    formCheck.append('g-recaptcha-response', '');
    r = await rawRequest(`${ORIGIN}/api/v1/auth/check-active-user`, {
        method: 'POST',
        headers: addCsrfHeaders({
            ...baseHeaders(),
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Cookie': cookieHeader()
        }),
        body: formCheck.toString()
    });
    store.applySetCookie(r.headers['set-cookie']);
    let jCheck = null; try { jCheck = JSON.parse(r.body); } catch { }
    if (!jCheck || jCheck.status !== 'success') {
        throw new Error('check-active-user failed');
    }

    // Step 2: Authenticate password
    const formLogin = new URLSearchParams();
    formLogin.append('csrfmiddlewaretoken', csrf);
    formLogin.append('tessera', email);
    formLogin.append('hidden_username', email);
    formLogin.append('password', password);
    formLogin.append('g-recaptcha-response', '');
    r = await rawRequest(`${ORIGIN}/api/v1/auth/login-authentication`, {
        method: 'POST',
        headers: addCsrfHeaders({
            ...baseHeaders(),
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Cookie': cookieHeader()
        }),
        body: formLogin.toString()
    });
    store.applySetCookie(r.headers['set-cookie']);
    let jLogin = null; try { jLogin = JSON.parse(r.body); } catch { }
    if (!jLogin || jLogin.status !== 'success') throw new Error('login-authentication failed: ' + jLogin?.message);

    const sessionid = store.get('sessionid');
    const csrftoken = store.get('csrftoken') || csrf;
    if (!sessionid) throw new Error('Session cookie missing after login');

    ACTIVE_COOKIE = `csrftoken=${csrftoken}; sessionid=${sessionid}`;
    return true;
}

/**
 * Resolves and validates session cookie across multiple fallback strategies:
 * 1. Netscape cookie file (--cookie-file or cookies.txt)
 * 2. Environment variables (MK_COOKIE / MK_COOKIE_FILE)
 * 3. Stored multi-user session JSON file
 * 4. Fresh login via username & password
 */
async function prepareSession({ userEmail, userPassword, sessionFile, cookieFile, verbose, courseUrl, forceLogin }) {
    const verify = async () => {
        try {
            if (!ACTIVE_COOKIE) return null;
            const core = await fetchCoreData(courseUrl || ORIGIN);
            const ok = !!core?.auth?.details?.is_authenticated;
            if (ok) return core;
            return null;
        } catch { return null; }
    };

    // Strategy 1: Check Netscape cookies.txt file
    const txtCookie = cookieFile || (fs.existsSync('cookies.txt') ? 'cookies.txt' : null) || (fs.existsSync('maktabkhooneh.org_cookies.txt') ? 'maktabkhooneh.org_cookies.txt' : null);
    if (txtCookie) {
        const parsed = parseNetscapeCookieFile(txtCookie);
        if (parsed) {
            ACTIVE_COOKIE = parsed;
            const core = await verify();
            if (core) { logSuccess(`Loaded cookie from: ${txtCookie}`); return core; }
        }
    }

    // Strategy 2: Environment variable override
    if (COOKIE && COOKIE !== 'PUT_YOUR_COOKIE_HERE') {
        ACTIVE_COOKIE = COOKIE;
        const core = await verify();
        if (core) return core;
    }

    // Strategy 3: Multi-user session.json file
    let sessionData = null;
    if (fs.existsSync(sessionFile)) {
        try {
            sessionData = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
            const key = userEmail ? userEmail.trim().toLowerCase() : sessionData.lastUsed || Object.keys(sessionData.users || {})[0];
            if (key && sessionData?.users?.[key]?.cookie && !forceLogin) {
                ACTIVE_COOKIE = sessionData.users[key].cookie;
                const core = await verify();
                if (core) { logSuccess(`Loaded session for: ${key}`); return core; }
            }
        } catch { }
    }

    // Strategy 4: Fresh inline login
    if (userEmail && userPassword) {
        logStep(`Attempting login for: ${userEmail}`);
        await loginWithCredentialsInline(userEmail, userPassword, verbose);
        if (ACTIVE_COOKIE) {
            const core = await verify();
            if (core) {
                logSuccess('Login successful!');
                try {
                    const key = userEmail.trim().toLowerCase();
                    const sData = sessionData || { users: {}, lastUsed: key };
                    sData.users[key] = { cookie: ACTIVE_COOKIE, updated: new Date().toISOString() };
                    sData.lastUsed = key;
                    fs.writeFileSync(sessionFile, JSON.stringify(sData, null, 2), 'utf8');
                } catch { }
                return core;
            }
        }
    }

    return null;
}

// ============================================================================
// LMS API & Course Data Fetchers
// ============================================================================

/**
 * Fetches course chapters outline from LMS Nuxt endpoints (with fallback to legacy chapters API).
 */
async function fetchChapters(courseSlug, referer) {
    const slugId = extractCourseSlugId(courseSlug);
    const apiEndpoints = [
        `${ORIGIN}/api/v1/lms/courses/${slugId}/outline/`,
        `${ORIGIN}/api/v1/courses/${courseSlug}/chapters/`
    ];

    for (const apiUrl of apiEndpoints) {
        try {
            const res = await fetchWithTimeout(apiUrl, { method: 'GET', headers: { ...commonHeaders(referer) } });
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data.chapters)) return data;
            }
        } catch { }
    }
    throw new Error(`Failed to fetch chapters for: ${courseSlug}`);
}

/**
 * Fetches user profile core data to verify authentication and subscription privileges.
 */
async function fetchCoreData(referer) {
    const url = `${ORIGIN}/api/v1/general/core-data/?profile=1`;
    const res = await fetchWithTimeout(url, { method: 'GET', headers: { ...commonHeaders(referer || ORIGIN) } }, 30_000);
    if (!res.ok) throw new Error(`Core-data request failed: ${res.status}`);
    return res.json();
}

/**
 * Prints profile details and subscription summary to console.
 */
function printProfileSummary(core) {
    const isAuthenticated = !!core?.auth?.details?.is_authenticated;
    const email = core?.auth?.details?.email || core?.profile?.details?.email || '-';
    const userId = core?.auth?.details?.user_id ?? '-';
    const studentId = core?.auth?.details?.student_id ?? '-';
    const hasSubscription = !!core?.auth?.conditions?.has_subscription || !!core?.auth?.conditions?.business_student;
    const hasCoursePurchase = !!core?.auth?.conditions?.has_course_purchase;
    console.log(`🔐 Auth check: ${isAuthenticated ? paintGreen('Authenticated') : paintRed('NOT authenticated')}`);
    console.log(`👤 User: ${paintCyan(email)}  | user_id: ${paintCyan(userId)}  | student_id: ${paintCyan(studentId)}`);
    console.log(`💳 Subscription: ${hasSubscription ? paintGreen('yes') : paintYellow('no')}  | Has course purchase: ${hasCoursePurchase ? paintGreen('yes') : paintYellow('no')}`);
    return isAuthenticated;
}

/**
 * Fetches LMS lecture unit details and video source URLs.
 */
async function fetchLmsUnitDetails(unitId, referer) {
    const videoUrlApi = `${ORIGIN}/api/v1/lms/units/${unitId}/video_url/`;
    const unitDetailApi = `${ORIGIN}/api/v1/lms/units/${unitId}/`;

    let videoData = null;
    let detailData = null;

    try {
        const res = await fetchWithTimeout(videoUrlApi, { method: 'GET', headers: { ...commonHeaders(referer) } }, 12000);
        if (res.ok) videoData = await res.json();
    } catch { }

    try {
        const res = await fetchWithTimeout(unitDetailApi, { method: 'GET', headers: { ...commonHeaders(referer) } }, 12000);
        if (res.ok) detailData = await res.json();
    } catch { }

    return { videoData, detailData };
}

/**
 * Extracts and normalizes video URLs from LMS API response.
 */
function extractLmsVideoUrls(videoData, detailData) {
    const urls = [];
    if (videoData?.qualities && Array.isArray(videoData.qualities)) {
        for (const q of videoData.qualities) {
            if (q.download_url) urls.push({ url: q.download_url, quality: q.quality || 'HQ' });
        }
    }
    if (videoData?.video_urls) {
        if (videoData.video_urls.hq) urls.push({ url: videoData.video_urls.hq, quality: 'HQ' });
        if (videoData.video_urls.lq) urls.push({ url: videoData.video_urls.lq, quality: 'LQ' });
    }
    if (detailData?.resources && Array.isArray(detailData.resources)) {
        for (const r of detailData.resources) {
            if (r.download_url) urls.push({ url: r.download_url, quality: r.quality || 'HQ' });
        }
    }
    return urls;
}

/**
 * Selects highest available video resolution (1080p > 720p/HQ > first available).
 */
function pickBestLmsSource(videoItems) {
    if (!videoItems || videoItems.length === 0) return null;
    const p1080 = videoItems.find(v => /1080/i.test(v.quality) || /1080p/i.test(v.url));
    if (p1080) return p1080.url;
    const p720 = videoItems.find(v => /720/i.test(v.quality) || /720p/i.test(v.url) || /hq/i.test(v.url));
    if (p720) return p720.url;
    return videoItems[0].url;
}

// ============================================================================
// HTML Parsing & Markdown Conversion Engine
// ============================================================================

/**
 * Extracts downloadable file attachments from HTML content blocks.
 */
function extractAttachmentLinks(html) {
    const results = new Set();
    if (!html) return [];
    const blockRe = /<div[^>]*class=["'][^"'>]*unit-content--download[^"'>]*["'][^>]*>[\s\S]*?<\/div>/gim;
    let m;
    while ((m = blockRe.exec(html)) !== null) {
        const block = m[0];
        const aRe = /<a[^>]+href=["']([^"'>]+)["'][^>]*>/gim;
        let a;
        while ((a = aRe.exec(block)) !== null) {
            const raw = a[1];
            const url = decodeHtmlEntities(raw);
            if (url && /attachments/i.test(url)) results.add(url);
        }
    }
    return Array.from(results);
}

/**
 * Converts LMS quiz and text lesson HTML into clean, structured Markdown format.
 * - Strips navigation bars, breadcrumbs, styles, and scripts
 * - Converts interactive quiz choices into Markdown task checkboxes (- [ ])
 * - Formats headings, code blocks, images, links, and question numbering
 */
function convertHtmlToMarkdown(html, title) {
    if (!html) return '';
    let content = html;

    // 1. Remove navigation, header, footer, scripts, and layout elements
    content = content
        .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
        .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
        .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<button[^>]*>[\s\S]*?<\/button>/gi, '')
        .replace(/<(?:div|ol|ul)[^>]*class=["'][^"']*(?:breadcrumb|unit-breadcrumbs|course-breadcrumbs|unit-header|unit-content__header)[^"']*["'][^>]*>[\s\S]*?<\/(?:div|ol|ul)>/gi, '')
        .replace(/<div[^>]*class=["'][^"']*(?:unit-navigation|unit-nav|next-prev)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '');

    // 2. Extract content body if present inside container tags
    const contentRegexes = [
        /<div[^>]*class=["'][^"']*(?:unit-content__text|unit-content__body|reading-content|unit-content--reading|unit-content--text)[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<(?:div class="unit-content--download|div class="unit-navigation|footer|\/section|\/main)/i,
        /<div[^>]*class=["'][^"']*(?:unit-content|unit-detail|unit-body|unit-reading|quiz-container)[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<(?:div class="course-curriculum|aside|footer|\/main)/i,
        /<main[^>]*>([\s\S]*?)<\/main>/i
    ];

    for (const regex of contentRegexes) {
        const match = content.match(regex);
        if (match && match[1] && match[1].trim().length > 60) {
            content = match[1];
            break;
        }
    }

    // 3. Format quiz question options into Markdown checkboxes
    content = content.replace(/<(?:div|li|label)[^>]*class=["'][^"']*(?:answer|choice|option|quiz-item|choice-item)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|li|label)>/gi, (m, inner) => {
        const clean = inner.replace(/<[^>]+>/g, ' ').trim();
        return clean ? `\n- [ ] ${clean}\n` : '';
    });
    content = content.replace(/<input[^>]*type=["'](?:radio|checkbox)["'][^>]*>\s*(?:<label[^>]*>)?(.*?)(?:<\/label>)?/gi, '\n- [ ] $1\n');

    // 4. Transform standard HTML elements to Markdown equivalents
    content = content.replace(/<h([1-6])[^>]*>(.*?)<\/h\1>/gi, (_, level, text) => `\n\n${'#'.repeat(level)} ${text.trim()}\n\n`);
    content = content.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n\n');
    content = content.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n\n');
    content = content.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');
    content = content.replace(/<img[^>]*src=["']([^"'>]+)["'][^>]*alt=["']([^"'>]*)["'][^>]*>/gi, '![$2]($1)');
    content = content.replace(/<img[^>]*src=["']([^"'>]+)["'][^>]*>/gi, '![]($1)');
    content = content.replace(/<a[^>]*href=["']([^"'>]+)["'][^>]*>(.*?)<\/a>/gi, '[$2]($1)');
    content = content.replace(/<p[^>]*>/gi, '\n\n').replace(/<\/p>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<li[^>]*>/gi, '\n- ').replace(/<\/li>/gi, '');
    content = content.replace(/<(?:b|strong)[^>]*>(.*?)<\/(?:b|strong)>/gi, '**$1**')
        .replace(/<(?:i|em)[^>]*>(.*?)<\/(?:i|em)>/gi, '*$1*');
    content = content.replace(/<[^>]+>/g, ' ');
    content = decodeHtmlEntities(content);

    // 5. Structure question numbering
    content = content.replace(/(?:^|\n)\s*(\d+)\s*\n+/g, '\n\n---\n\n### سوال $1\n\n');

    // 6. Filter out UI remnants and boilerplate lines
    const unwantedLines = new Set(['-', '- [ ]', 'نمایش', 'نمایش محتوای دوره', 'محتوای دوره', 'جلسه بعد', 'جلسه قبل']);
    content = content
        .split('\n')
        .map(line => line.trim())
        .filter(line => !unwantedLines.has(line))
        .filter(line => !line.startsWith('نمره‌ی شما:') && !line.startsWith('%'))
        .join('\n');

    // Remove redundant title if already at the top of content
    const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    content = content.replace(new RegExp(`^(?:#+\\s*)?${escapedTitle}\\s*`, 'i'), '').trim();

    // Normalize spacing and zero-width characters
    content = content
        .replace(/[ \t\u200c]+/g, (match) => match.includes('\u200c') ? '\u200c' : ' ')
        .replace(/\n\s*\n\s*\n+/g, '\n\n')
        .trim();

    return `# ${title}\n\n${content}\n\n---\n*Extracted by Maktabkhooneh Downloader PLUS*`;
}

// ============================================================================
// Streaming & Download Engine with Resumption Support
// ============================================================================

/**
 * Transform Stream that limits output to N bytes and aborts upstream stream.
 */
class ByteLimit extends Transform {
    constructor(limit, onLimit) {
        super();
        this.limit = limit;
        this.seen = 0;
        this._hit = false;
        this._onLimit = onLimit;
    }
    _transform(chunk, enc, cb) {
        if (this.limit <= 0) { this.push(chunk); return cb(); }
        const remaining = this.limit - this.seen;
        if (remaining <= 0) return cb();
        const buf = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        this.push(buf);
        this.seen += buf.length;
        if (!this._hit && this.seen >= this.limit) {
            this.end();
            this._hit = true;
            if (typeof this._onLimit === 'function') {
                try { this._onLimit(); } catch { }
            }
        }
        cb();
    }
}

/**
 * Probes remote file size and checks whether server supports HTTP Range headers.
 */
async function getRemoteSizeAndRanges(url, referer) {
    try {
        const res = await fetchWithTimeout(url, { method: 'HEAD', headers: { ...commonHeaders(referer), accept: '*/*' } }, 15_000);
        if (res.ok) {
            const len = res.headers.get('content-length');
            const size = len ? parseInt(len, 10) : undefined;
            const acceptRanges = (res.headers.get('accept-ranges') || '').toLowerCase().includes('bytes');
            return { size, acceptRanges };
        }
    } catch { }
    // Fallback: Request single byte Range
    try {
        const res = await fetchWithTimeout(url, { method: 'GET', headers: { ...commonHeaders(referer), range: 'bytes=0-0', accept: '*/*' } }, 15_000);
        if (res.status === 206) {
            const cr = res.headers.get('content-range');
            const m = cr && cr.match(/\/(\d+)$/);
            const size = m ? parseInt(m[1], 10) : undefined;
            try { if (res.body) { const rb = Readable.fromWeb(res.body); rb.resume(); } } catch { }
            return { size, acceptRanges: true };
        }
    } catch { }
    return { size: undefined, acceptRanges: false };
}

/**
 * Downloads a URL to a file with retry logic, byte-range resumption, and interactive progress rendering.
 * @param {string} url Target download URL
 * @param {string} filePath Output destination path
 * @param {string} referer Referer URL for authorization
 * @param {number} maxRetries Maximum retry attempts
 * @param {number} sampleBytes Limit bytes if in sample mode (0 = full download)
 * @param {string} label Display label for progress line
 * @returns {Promise<'exists'|'downloaded'>}
 */
async function downloadToFile(url, filePath, referer, maxRetries = 3, sampleBytes = 0, label = '') {
    let existingFinalSize = 0;
    try { const stat = fs.statSync(filePath); existingFinalSize = stat.size; if (existingFinalSize > 0 && sampleBytes > 0) return 'exists'; } catch { }
    const tmpPath = filePath + '.part';
    let existingTmpSize = 0;
    try { const stat = fs.statSync(tmpPath); existingTmpSize = stat.size; } catch { }

    // Check if target file already exists and is fully downloaded
    let remoteInfo;
    if (sampleBytes === 0 && existingFinalSize > 0) {
        remoteInfo = await getRemoteSizeAndRanges(url, referer);
        if (remoteInfo.size && existingFinalSize >= remoteInfo.size) return 'exists';
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            let resumeOffset = 0;
            let writingTo = tmpPath;

            // Calculate resume byte offset
            if (sampleBytes > 0) {
                resumeOffset = 0;
            } else {
                if (existingTmpSize > 0) {
                    resumeOffset = existingTmpSize;
                } else if (existingFinalSize > 0) {
                    if (!remoteInfo) remoteInfo = await getRemoteSizeAndRanges(url, referer);
                    if (remoteInfo.acceptRanges) {
                        try { await fs.promises.rename(filePath, tmpPath); existingTmpSize = existingFinalSize; resumeOffset = existingFinalSize; existingFinalSize = 0; } catch { }
                    } else {
                        resumeOffset = 0;
                    }
                }
            }

            const requestInit = { method: 'GET', headers: { ...commonHeaders(referer), accept: 'video/mp4,application/octet-stream,*/*' } };
            if (sampleBytes && sampleBytes > 0) {
                requestInit.headers['range'] = `bytes=0-${Math.max(0, sampleBytes - 1)}`;
            } else if (resumeOffset > 0) {
                requestInit.headers['range'] = `bytes=${resumeOffset}-`;
            }

            const controller = new AbortController();
            const to = setTimeout(() => controller.abort(), 1800000); // 30 min per chunk timeout
            const res = await fetch(url, { ...requestInit, signal: controller.signal });
            if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
            
            // If server did not honor Range 206 response, clean up and restart
            if (resumeOffset > 0 && res.status !== 206) {
                try { await fs.promises.unlink(tmpPath); } catch { }
                existingTmpSize = 0; resumeOffset = 0;
                clearTimeout(to);
                throw new Error('Server did not honor range; restarting from 0');
            }

            await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
            const write = fs.createWriteStream(writingTo, { flags: (sampleBytes > 0 || resumeOffset === 0) ? 'w' : 'a' });
            const readable = Readable.fromWeb(res.body);

            const contentLengthHeader = res.headers.get('content-length');
            const fullLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : undefined;
            let expectedTotal;
            const contentRange = res.headers.get('content-range');
            const crMatch = contentRange && contentRange.match(/\/(\d+)$/);
            if (sampleBytes && sampleBytes > 0) expectedTotal = sampleBytes;
            else if (crMatch) expectedTotal = parseInt(crMatch[1], 10);
            else if (fullLength && resumeOffset > 0) expectedTotal = resumeOffset + fullLength;
            else expectedTotal = fullLength;

            let downloadedBytes = resumeOffset;
            const startedAt = Date.now();

            const truncate = (s, max = 70) => {
                if (!s) return '';
                const str = String(s);
                return str.length > max ? str.slice(0, max - 1) + '…' : str;
            };

            // Interactive single-line progress bar renderer
            const render = (final = false) => {
                const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);
                const speed = downloadedBytes / elapsedSec;
                let shownDownloaded = downloadedBytes;
                if (expectedTotal && (final || downloadedBytes > expectedTotal)) {
                    const overflow = downloadedBytes - expectedTotal;
                    if (overflow <= 65536) shownDownloaded = expectedTotal;
                }
                let ratio = final ? 1 : (expectedTotal ? (shownDownloaded / expectedTotal) : 0);
                const bar = buildProgressBar(ratio);
                const pct = final ? '100.0%' : (expectedTotal ? `${(Math.min(1, ratio) * 100).toFixed(1)}%` : '--%');
                const sizeStr = `${formatBytes(shownDownloaded)}${expectedTotal ? ' / ' + formatBytes(expectedTotal) : ''}`;
                const name = label ? `  -  ${truncate(label, 80)}` : '';
                const line = `  ⬇️  [${bar}] ${pct}  ${sizeStr}  ${formatSpeed(speed)}${name}`;
                process.stdout.write(`\r${line}`);
            };

            const counter = new Transform({
                transform(chunk, _enc, cb) {
                    downloadedBytes += chunk.length;
                    if (downloadedBytes === chunk.length || downloadedBytes % 65536 < 8192) render();
                    cb(null, chunk);
                }
            });

            let byteLimitReached = false;
            try {
                if (sampleBytes && sampleBytes > 0) {
                    const limiter = new ByteLimit(sampleBytes, () => {
                        byteLimitReached = true;
                        try { readable.destroy(new Error('byte-limit')); } catch { }
                        try { controller.abort(); } catch { }
                    });
                    await pipeline(readable, counter, limiter, write);
                } else {
                    await pipeline(readable, counter, write);
                }
            } catch (pipeErr) {
                if (sampleBytes && byteLimitReached) {
                    try { clearTimeout(to); } catch { }
                    try { render(true); process.stdout.write('\n'); } catch { }
                    try { await fs.promises.rename(tmpPath, filePath); } catch { }
                    return 'downloaded';
                }
                throw pipeErr;
            } finally {
                clearTimeout(to);
            }

            try { render(true); } catch { }
            process.stdout.write('\n');
            try { await fs.promises.rename(tmpPath, filePath); } catch { }
            return 'downloaded';
        } catch (err) {
            try { process.stdout.write('\n'); } catch { }
            if (attempt < maxRetries) {
                logWarn(`Retry ${attempt}/${maxRetries} for ${path.basename(filePath)} after error: ${err.message}`);
                await sleep(1000 * attempt);
                continue;
            }
            throw err;
        }
    }
}

// ============================================================================
// Main Execution Orchestrator
// ============================================================================

async function main() {
    const cliParams = parseCLI();
    const { inputCourseUrl, sampleBytesToDownload, isVerboseLoggingEnabled, userEmail, userPassword, sessionFile, cookieFile, forceLogin, isInfoMode } = cliParams;
    const { verbose } = createVerboseLogger(isVerboseLoggingEnabled);

    if (!inputCourseUrl) {
        printUsage();
        process.exit(1);
    }

    // Prepare session authentication
    const coreData = await prepareSession({ userEmail, userPassword, sessionFile, cookieFile, verbose, courseUrl: inputCourseUrl, forceLogin });
    ensureCookiePresent();

    const normalizedCourseUrl = ensureTrailingSlash(inputCourseUrl.trim());
    const courseSlug = extractCourseSlug(normalizedCourseUrl);
    const courseDisplayName = sanitizeName(decodeURIComponent(courseSlug));
    const outputRootFolder = path.resolve(process.cwd(), 'download', courseDisplayName);

    // Verify session
    const ok = printProfileSummary(coreData);
    if (!ok) {
        logError('Authentication failed. Check credentials or cookie.');
        process.exit(1);
    }

    if (isInfoMode) {
        console.log(`\n🔍 ${paintBoldCyan('INFO MODE ACTIVATED:')} Fetching curriculum and video sizes...\n`);
    } else {
        await fs.promises.mkdir(outputRootFolder, { recursive: true });
        console.log(`📚 Course slug: ${paintBold(decodeURIComponent(courseSlug))}`);
        console.log(`📁 Output folder: ${paintCyan(outputRootFolder)}`);
        if (sampleBytesToDownload > 0) {
            console.log(`🎯 Sample mode: downloading first ${paintBold(String(sampleBytesToDownload))} bytes of each video`);
        }
    }

    // Fetch chapters curriculum
    verbose(paintCyan('Fetching chapters outline from LMS API...'));
    const chaptersData = await fetchChapters(courseSlug, normalizedCourseUrl);
    const chapters = chaptersData.chapters || [];
    if (chapters.length === 0) { logError('No chapters found.'); process.exit(2); }

    let totalUnits = 0, downloadedCount = 0, skippedCount = 0, failedCount = 0, markdownCount = 0;
    let tableData = [], totalSizeApproxInfo = 0;

    // Process chapters and units
    for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex++) {
        const chapter = chapters[chapterIndex];
        const chapterOrder = String(chapterIndex + 1).padStart(2, '0');
        const chapterFolder = path.join(outputRootFolder, `${chapterOrder} - ${sanitizeName(chapter.title || chapter.slug || 'chapter')}`);

        if (!isInfoMode) {
            console.log(`\n📖 Chapter ${chapterIndex + 1}/${chapters.length}: ${paintBold(chapter.title || chapter.slug)}`);
        }

        const units = chapter.units || [];
        for (let unitIndex = 0; unitIndex < units.length; unitIndex++) {
            const unit = units[unitIndex];
            totalUnits++;

            const unitOrder = String(unitIndex + 1).padStart(2, '0');
            const sanitizedTitle = sanitizeName(unit.title || unit.slug || 'unit');
            const isVideo = unit.type === 1 || unit.type === 'lecture' || /video/i.test(unit.type_display || '');
            const isLocked = unit.locked === true || (unit.view_access === 2 && !coreData?.auth?.conditions?.has_subscription && !coreData?.auth?.conditions?.business_student && !coreData?.auth?.conditions?.has_course_purchase);
            const lectureUrl = `${ORIGIN}/lms/course/${courseSlug}/unit/${unit.id}/`;

            verbose(`  🎬 Unit ${unitIndex + 1}/${units.length}: ${unit.title} [Type: ${unit.type_display || unit.type}]`);

            // Handle locked/restricted access units
            if (isLocked) {
                logWarn(`🔒 Locked/No access: ${sanitizedTitle}`);
                skippedCount++;
                if (isInfoMode) {
                    tableData.push({ Chapter: chapter.title.slice(0, 30), Lesson: unit.title.slice(0, 45), Type: unit.type_display || 'Lesson', Size: 'Locked 🔒' });
                }
                continue;
            }

            try {
                const { videoData, detailData } = await fetchLmsUnitDetails(unit.id, lectureUrl);
                const videoItems = extractLmsVideoUrls(videoData, detailData);
                const bestSourceUrl = pickBestLmsSource(videoItems);

                // 1. Non-video units (quizzes, readings, exercises) -> Convert and save as Markdown
                if (!isVideo || !bestSourceUrl) {
                    if (isInfoMode) {
                        tableData.push({ Chapter: chapter.title.slice(0, 30), Lesson: unit.title.slice(0, 45), Type: unit.type_display || 'Text/Quiz', Size: 'N/A' });
                        continue;
                    }
                    const mdFileName = `${unitOrder} - ${sanitizedTitle}.md`;
                    const mdFilePath = path.join(chapterFolder, mdFileName);
                    if (fs.existsSync(mdFilePath) && fs.statSync(mdFilePath).size > 0) {
                        console.log(paintYellow(`🟡 SKIP exists: ${mdFileName}`));
                        skippedCount++;
                    } else {
                        console.log(`📝 Extracting Markdown: ${mdFileName}`);
                        await fs.promises.mkdir(chapterFolder, { recursive: true });
                        const rawText = detailData?.description || unit.description || '';
                        const mdContent = convertHtmlToMarkdown(rawText, unit.title);
                        await fs.promises.writeFile(mdFilePath, mdContent, 'utf8');
                        logSuccess(`SAVED: ${mdFileName}`);
                        markdownCount++;
                    }
                    continue;
                }

                // 2. Info table mode (--info / --table)
                if (isInfoMode) {
                    let sizeStr = 'Unknown';
                    const { size } = await getRemoteSizeAndRanges(bestSourceUrl, lectureUrl);
                    if (size) { totalSizeApproxInfo += size; sizeStr = formatBytes(size); }
                    tableData.push({ Chapter: chapter.title.slice(0, 30), Lesson: unit.title.slice(0, 45), Type: 'Video', Size: sizeStr });
                    process.stdout.write(`Fetching info... ${tableData.length} items parsed.\r`);
                    continue;
                }

                // 3. Download high-resolution video file
                const baseFileName = `${unitOrder} - ${sanitizedTitle}.mp4`;
                const finalFileName = sampleBytesToDownload > 0 ? baseFileName.replace(/\.mp4$/i, '.sample.mp4') : baseFileName;
                const outputFilePath = path.join(chapterFolder, finalFileName);
                const videoBaseNoExt = finalFileName.replace(/\.sample\.mp4$/i, '').replace(/\.mp4$/i, '');

                console.log(`📥 Downloading: ${finalFileName}`);
                const status = await downloadToFile(bestSourceUrl, outputFilePath, lectureUrl, 3, sampleBytesToDownload, '');
                if (status === 'exists') {
                    console.log(paintYellow(`🟡 SKIP exists: ${finalFileName}`));
                    skippedCount++;
                } else {
                    logSuccess(`DOWNLOADED: ${finalFileName}`);
                    downloadedCount++;
                }

                // 4. Download WebVTT subtitles if available
                try {
                    if (detailData?.has_caption && detailData?.caption_file) {
                        const subName = `${videoBaseNoExt}.vtt`;
                        const subPath = path.join(chapterFolder, subName);
                        if (!fs.existsSync(subPath)) {
                            console.log(`📝 Subtitle: ${subName}`);
                            await downloadToFile(detailData.caption_file, subPath, lectureUrl, 2, 0, '');
                            logSuccess(`SUBTITLE: ${subName}`);
                        }
                    }
                } catch { }

                // 5. Download course lecture attachments
                try {
                    if (detailData?.description) {
                        const attLinks = extractAttachmentLinks(detailData.description);
                        for (const attUrl of attLinks) {
                            let filePart = attUrl.split('?')[0].split('/').pop() || 'attachment.bin';
                            const finalAttachmentName = `${videoBaseNoExt} - ${sanitizeName(filePart)}`;
                            const attachmentPath = path.join(chapterFolder, finalAttachmentName);
                            if (!fs.existsSync(attachmentPath)) {
                                console.log(`📎 Attachment: ${finalAttachmentName}`);
                                await downloadToFile(attUrl, attachmentPath, lectureUrl, 3, 0, '');
                                logSuccess(`ATTACHMENT: ${finalAttachmentName}`);
                            }
                        }
                    }
                } catch { }

                await sleep(250);
            } catch (err) {
                logError(`FAIL ${sanitizedTitle}: ${err.message}`);
                failedCount++;
            }
        }
    }

    // Render final summary output
    if (isInfoMode) {
        console.log('\n\n' + '═'.repeat(95));
        console.table(tableData);
        console.log('═'.repeat(95));
        console.log(`📊 Total Lessons: ${paintBold(tableData.length.toString())}`);
        console.log(`💾 Estimated Video Size: ${paintCyan(formatBytes(totalSizeApproxInfo))}\n`);
    } else {
        console.log('—'.repeat(40));
        console.log(`📊 Total units processed: ${paintBold(String(totalUnits))}`);
        console.log(`🎬 Videos Downloaded: ${paintGreen(String(downloadedCount))}`);
        console.log(`📝 Markdowns Extracted: ${paintGreen(String(markdownCount))}`);
        console.log(`🟡 Skipped: ${paintYellow(String(skippedCount))}`);
        console.log(`❌ Failed: ${paintRed(String(failedCount))}`);
    }
}

// Global unhandled error guard
main().catch(err => { logError('Fatal:', err); process.exit(1); });