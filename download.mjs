/**
 * Maktabkhooneh Course Downloader PLUS
 * High-performance, robust downloader supporting both Legacy and Nuxt 3 LMS architectures.
 * 
 * Features:
 * - Unit-by-Unit dynamic structure detection (Legacy vs LMS vs API)
 * - Multi-quality video extraction (1080p, 720p, 480p, HQ)
 * - Zero-byte & unknown size streaming support
 * - HTTP Range-based download resumption (.part files)
 * - Automated WebVTT subtitle and course attachment downloading
 * - Quiz and reading unit extraction to Markdown (.md)
 * - Netscape cookies.txt, multi-user session.json, and credential login
 * - Curriculum inspection table mode (--info)
 * 
 * Repository: https://github.com/NabiKAZ/maktabkhooneh-downloader
 * License: GPL-3.0
 */

import fs from 'fs';
import path from 'path';
import { Transform, Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { setTimeout as sleep } from 'timers/promises';
import https from 'https';

// ===============
// ANSI Console Styling
// ===============
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

let LOG_WRITER = null;

function formatLogMessage(parts) {
    return parts.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join(' ');
}

function initLogger(logFilePath) {
    const resolvedPath = path.resolve(logFilePath || 'downloader.log');
    try { fs.mkdirSync(path.dirname(resolvedPath), { recursive: true }); } catch {}
    LOG_WRITER = {
        path: resolvedPath,
        write(level, message) {
            try {
                const stamp = new Date().toISOString();
                fs.appendFileSync(this.path, `[${stamp}] [${level}] ${message}\n`, 'utf8');
            } catch {}
        }
    };
    return LOG_WRITER;
}

function writeLog(level, ...parts) {
    if (!LOG_WRITER) return;
    LOG_WRITER.write(level, formatLogMessage(parts));
}

const logInfo = (...a) => { console.log('ℹ️', ...a); writeLog('INFO', ...a); };
const logStep = (...a) => { console.log('▶️', ...a); writeLog('STEP', ...a); };
const logSuccess = (...a) => { console.log('✅', ...a); writeLog('SUCCESS', ...a); };
const logWarn = (...a) => { console.warn('⚠️', ...a); writeLog('WARN', ...a); };
const logError = (...a) => { console.error('❌', ...a); writeLog('ERROR', ...a); };

// ===============
// Configuration & State
// ===============
const COOKIE = (() => {
    if (process.env.MK_COOKIE && process.env.MK_COOKIE.trim()) return process.env.MK_COOKIE.trim();
    if (process.env.MK_COOKIE_FILE) {
        try { return fs.readFileSync(process.env.MK_COOKIE_FILE, 'utf8').trim(); } catch {}
    }
    return 'PUT_YOUR_COOKIE_HERE';
})();

let ACTIVE_COOKIE = null;
const ORIGIN = 'https://maktabkhooneh.org';

function getCsrfToken() {
    const ck = ACTIVE_COOKIE || COOKIE || '';
    const m = ck.match(/csrftoken=([^;]+)/);
    return m ? m[1] : '';
}

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

function formatBytes(bytes) {
    if (bytes == null || isNaN(bytes) || bytes === 0) return '-';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let n = Number(bytes);
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`;
}

function formatSpeed(bytesPerSec) {
    if (!bytesPerSec || !isFinite(bytesPerSec)) return '-';
    return `${formatBytes(bytesPerSec)}/s`;
}

function buildProgressBar(ratio, width = 24) {
    const r = Math.max(0, Math.min(1, ratio || 0));
    const filled = Math.round(r * width);
    const left = width - filled;
    return `${'█'.repeat(filled)}${'░'.repeat(left)}`;
}

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
        .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function sanitizeName(name) {
    return (name || '')
        .replace(/[\/:*?"<>|]/g, ' ')
        .replace(/[\s\u200c\u200f\u202a\u202b]+/g, ' ')
        .trim()
        .slice(0, 150);
}

function ensureTrailingSlash(u) {
    return u.endsWith('/') ? u : u + '/';
}

function isVideoUrl(url) {
    if (!url) return false;
    const value = String(url).toLowerCase();
    return (
        value.includes('/videos/') ||
        /\.mp4(?:$|[?#])/i.test(value) ||
        /\.m3u8(?:$|[?#])/i.test(value)
    );
}

// ===============
// CLI Parsing & Usage Guide
// ===============

function printUsage() {
    console.log(`${paintBoldCyan('Maktabkhooneh Downloader PLUS')} - ${paintYellow('version 2.0.0')} ${paint(COLOR.dim, '© 2026')}`);
    console.log(paint(COLOR.magenta, 'ویژگی‌ها: ') + 'پشتیبانی ترکیبی از ساختار قدیمی و جدید LMS، کیفیت 1080p، زیرنویس، ضمائم و آزمون‌ها');
    console.log(paint(COLOR.dim, '=============================================================\n'));
    console.log(paintBold('Usage:'));
    console.log(`  ${paintYellow('node download.mjs "https://maktabkhooneh.org/course/..."')}`);
    console.log(`  ${paintYellow('node download.mjs --user you@example.com --pass "password"')}`);
    console.log(`  ${paintYellow('node download.mjs --cookie-file cookies.txt')}`);
    console.log(`  ${paintYellow('node download.mjs --info')} ${paint(COLOR.dim, '(بررسی سرفصل‌ها بدون شروع دانلود)')}`);
    console.log(`  ${paintYellow('node download.mjs --sample-bytes=1048576 --verbose')}`);
    console.log(paintBold('\nOptions:'));
    console.log(`  ${paintYellow('--help, -h')}              نمایش راهنما`);
    console.log(`  ${paintYellow('--info, --table')}          فقط نمایش فهرست دروس و حجم‌ها بدون دانلود`);
    console.log(`  ${paintYellow('--user, --email')}         ایمیل ورود به سایت`);
    console.log(`  ${paintYellow('--pass, --password')}      رمز عبور`);
    console.log(`  ${paintYellow('--cookie-file')}          مسیر فایل Netscape cookies.txt`);
    console.log(`  ${paintYellow('--session-file')}          مسیر ذخیره نشست (پیش‌فرض session.json)`);
    console.log(`  ${paintYellow('--log-file')}              مسیر لاگ فایل (پیش‌فرض downloader.log)`);
    console.log(`  ${paintYellow('--sample-bytes')}          دانلود فقط N بایت اول برای تست`);
    console.log(`  ${paintYellow('--verbose, -v')}           نمایش جزییات لاگ‌ها`);
    console.log(`  ${paintYellow('--force-login')}           اجبار به لاگین مجدد و نادیده گرفتن نشست قبلی`);
    console.log(paintBold('\nFiles:'));
    console.log(`  ${paintYellow('link.txt')}                لیست لینک دوره‌ها (در صورت عدم وارد کردن لینک در خط فرمان)`);
    console.log(`  ${paintYellow('user.txt')}                ایمیل در خط اول و پسورد در خط دوم`);
}

function parseCLI() {
    const args = process.argv.slice(2);
    let positionalUrl = null;
    let sampleBytesToDownload = 0;
    let isVerboseLoggingEnabled = false;
    let userEmail = null;
    let userPassword = null;
    let sessionFile = 'session.json';
    let logFile = 'downloader.log';
    let cookieFile = null;
    let forceLogin = false;
    let showHelp = false;
    let isInfoMode = false;

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--user' || a === '--email') { userEmail = args[++i]; }
        else if (a.startsWith('--user=')) userEmail = a.split('=')[1];
        else if (a === '--pass' || a === '--password') { userPassword = args[++i]; }
        else if (a.startsWith('--pass=')) userPassword = a.split('=')[1];
        else if (a === '--session-file') { sessionFile = args[++i]; }
        else if (a.startsWith('--session-file=')) sessionFile = a.split('=')[1];
        else if (a === '--cookie-file') { cookieFile = args[++i]; }
        else if (a.startsWith('--cookie-file=')) cookieFile = a.split('=')[1];
        else if (a === '--log-file') { logFile = args[++i]; }
        else if (a.startsWith('--log-file=')) logFile = a.split('=')[1];
        else if (a.startsWith('--sample-bytes=')) sampleBytesToDownload = parseInt(a.split('=')[1], 10) || 0;
        else if (a === '--sample-bytes') { sampleBytesToDownload = parseInt(args[++i], 10) || 0; }
        else if (a === '--verbose' || a === '-v') isVerboseLoggingEnabled = true;
        else if (a === '--force-login') forceLogin = true;
        else if (a === '--info' || a === '--table' || a === '--no-download') isInfoMode = true;
        else if (a === '--help' || a === '-h') showHelp = true;
        else if (!positionalUrl && !a.startsWith('--')) positionalUrl = a;
    }

    if (!sampleBytesToDownload && process.env.MK_SAMPLE_BYTES) {
        sampleBytesToDownload = parseInt(process.env.MK_SAMPLE_BYTES, 10) || 0;
    }

    return { positionalUrl, sampleBytesToDownload, isVerboseLoggingEnabled, userEmail, userPassword, sessionFile, logFile, cookieFile, forceLogin, showHelp, isInfoMode };
}

function createVerboseLogger(isVerbose) {
    return { verbose: (...a) => { if (isVerbose) console.log(...a); } };
}

function extractCourseSlug(courseUrl) {
    try {
        const parsed = new URL(courseUrl);
        const parts = parsed.pathname.split('/').filter(Boolean);
        const idx = parts.indexOf('course');
        if (idx === -1 || !parts[idx + 1]) throw new Error('Cannot parse course slug');
        return parts[idx + 1];
    } catch (e) { throw new Error('Invalid course URL: ' + e.message); }
}

function extractCourseSlugId(courseSlug) {
    const match = courseSlug.match(/mk(\d+)/i) || courseSlug.match(/(\d+)$/);
    return match ? match[1] : courseSlug;
}

function extractRequestedUnitId(courseUrl) {
    try {
        const parsed = new URL(courseUrl);
        const parts = parsed.pathname.split('/').filter(Boolean);
        const idx = parts.indexOf('unit');
        if (idx !== -1 && parts[idx + 1] && /^\d+$/.test(parts[idx + 1])) {
            return Number(parts[idx + 1]);
        }
    } catch {}
    return null;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
        options.signal = controller.signal;
        return await fetch(url, options);
    } finally {
        clearTimeout(t);
    }
}

// ===============
// Authentication & Multi-Session
// ===============

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
    } catch {}
    return null;
}

async function readSessionFile(file) {
    try {
        const txt = await fs.promises.readFile(file, 'utf8');
        const data = JSON.parse(txt);
        if (data && data.users) return data;
        if (data && typeof data.cookie === 'string') {
            return {
                users: { 'default': { cookie: data.cookie, updated: data.updated || new Date().toISOString() } },
                lastUsed: 'default'
            };
        }
    } catch {}
    return null;
}

async function writeSessionFileMulti(file, email, cookie, existing) {
    const key = (email || 'default').trim().toLowerCase();
    let data = existing && existing.users ? existing : { users: {}, lastUsed: key };
    data.users[key] = { cookie, updated: new Date().toISOString() };
    data.lastUsed = key;
    try { await fs.promises.writeFile(file, JSON.stringify(data, null, 2), 'utf8'); } catch {}
}

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

function rawRequest(urlStr, { method = 'GET', headers = {}, body = null } = {}) {
    const u = new URL(urlStr);
    return new Promise((resolve, reject) => {
        const opts = { method, hostname: u.hostname, path: u.pathname + (u.search || ''), protocol: u.protocol, headers };
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

async function loginWithCredentialsInline(email, password, verbose = () => {}) {
    if (!email || !password) throw new Error('Email & password required for login');
    const store = new SimpleCookieStore();
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';

    let r = await rawRequest(`${ORIGIN}/accounts/login/`, {
        method: 'GET', headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
    });
    store.applySetCookie(r.headers['set-cookie']);
    let csrf = store.get('csrftoken') || null;
    if (!csrf) {
        const r2 = await rawRequest(`${ORIGIN}/api/v1/general/core-data/?profile=1`, {
            method: 'GET', headers: { 'User-Agent': UA, 'Accept': 'application/json' }
        });
        store.applySetCookie(r2.headers['set-cookie']);
        try { const j2 = JSON.parse(r2.body); csrf = csrf || j2?.auth?.csrf || null; } catch {}
        if (!csrf) csrf = store.get('csrftoken') || null;
    }
    if (!csrf) throw new Error('Cannot obtain CSRF token');

    const cookieHeader = () => store.headerString();
    const baseHeaders = () => ({ 'User-Agent': UA, 'Accept': 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' });
    const addCsrfHeaders = (h = {}) => ({ ...h, 'X-CSRFToken': csrf, 'Origin': ORIGIN, 'Referer': `${ORIGIN}/accounts/login/` });

    const formCheck = new URLSearchParams();
    formCheck.append('csrfmiddlewaretoken', csrf);
    formCheck.append('tessera', email);
    formCheck.append('g-recaptcha-response', '');
    r = await rawRequest(`${ORIGIN}/api/v1/auth/check-active-user`, {
        method: 'POST',
        headers: addCsrfHeaders({ ...baseHeaders(), 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Cookie': cookieHeader() }),
        body: formCheck.toString()
    });
    store.applySetCookie(r.headers['set-cookie']);
    let jCheck = null; try { jCheck = JSON.parse(r.body); } catch {}
    if (!jCheck || jCheck.status !== 'success' || jCheck.message !== 'get-pass') {
        throw new Error('Login flow step 1 failed: ' + (jCheck?.message || 'Unknown error'));
    }

    const formLogin = new URLSearchParams();
    formLogin.append('csrfmiddlewaretoken', csrf);
    formLogin.append('tessera', email);
    formLogin.append('hidden_username', email);
    formLogin.append('password', password);
    formLogin.append('g-recaptcha-response', '');
    r = await rawRequest(`${ORIGIN}/api/v1/auth/login-authentication`, {
        method: 'POST',
        headers: addCsrfHeaders({ ...baseHeaders(), 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Cookie': cookieHeader() }),
        body: formLogin.toString()
    });
    store.applySetCookie(r.headers['set-cookie']);
    let jLogin = null; try { jLogin = JSON.parse(r.body); } catch {}
    if (!jLogin || jLogin.status !== 'success') throw new Error('Login failed: ' + (jLogin?.message || 'Invalid credentials'));

    const sessionid = store.get('sessionid');
    const csrftoken2 = store.get('csrftoken') || csrf;
    if (!sessionid) throw new Error('Session cookie missing after login');
    ACTIVE_COOKIE = `csrftoken=${csrftoken2}; sessionid=${sessionid}`;
    return true;
}

async function prepareSession({ userEmail, userPassword, sessionFile, cookieFile, verbose, forceLogin }) {
    const verify = async () => {
        try {
            if (!ACTIVE_COOKIE) return null;
            verbose('Verifying session cookie...');
            const core = await fetchCoreData(ORIGIN);
            const ok = !!core?.auth?.details?.is_authenticated;
            if (ok) {
                logInfo('Session valid' + (userEmail ? ` (user: ${userEmail})` : ''));
                return core;
            }
            logWarn('Session not authenticated');
            return null;
        } catch (e) {
            verbose('Verify failed: ' + e.message);
            return null;
        }
    };

    const txtCookie = cookieFile || (fs.existsSync('cookies.txt') ? 'cookies.txt' : null) || (fs.existsSync('maktabkhooneh.org_cookies.txt') ? 'maktabkhooneh.org_cookies.txt' : null);
    if (txtCookie) {
        const parsed = parseNetscapeCookieFile(txtCookie);
        if (parsed) {
            ACTIVE_COOKIE = parsed;
            verbose(`Checking cookie from: ${txtCookie}`);
            const core = await verify();
            if (core) {
                logSuccess(`Loaded active session from: ${txtCookie}`);
                return { core, source: 'cookie-file' };
            }
            ACTIVE_COOKIE = null;
        }
    }

    if (COOKIE && COOKIE !== 'PUT_YOUR_COOKIE_HERE') {
        ACTIVE_COOKIE = COOKIE;
        verbose('Using cookie from env / file override');
        const core = await verify();
        if (core) return { core, source: 'env' };
    }

    let sessionData = null;
    if (sessionFile) sessionData = await readSessionFile(sessionFile);
    const desiredUserKey = userEmail ? userEmail.trim().toLowerCase() : null;
    if (sessionData && desiredUserKey && !forceLogin) {
        const entry = sessionData.users[desiredUserKey];
        if (entry && entry.cookie) {
            ACTIVE_COOKIE = entry.cookie;
            logStep(`Loaded stored session for user ${desiredUserKey}`);
            const core = await verify();
            if (core) return { core, source: 'stored-user' };
            ACTIVE_COOKIE = null;
        }
    }
    if (!desiredUserKey && sessionData && sessionData.lastUsed && !forceLogin) {
        const storedKey = sessionData.lastUsed;
        const entry = sessionData.users[storedKey];
        if (entry && entry.cookie) {
            ACTIVE_COOKIE = entry.cookie;
            logStep(`Loaded last-used stored session for ${storedKey}`);
            const core = await verify();
            if (core) return { core, source: 'stored-last-used' };
            ACTIVE_COOKIE = null;
        }
    }

    if (desiredUserKey && userPassword && (!ACTIVE_COOKIE || forceLogin)) {
        try {
            logStep('Attempting login for ' + desiredUserKey);
            await loginWithCredentialsInline(userEmail, userPassword, verbose);
            if (ACTIVE_COOKIE && sessionFile) {
                await writeSessionFileMulti(sessionFile, userEmail, ACTIVE_COOKIE, sessionData);
                logSuccess('Login success; session stored for user ' + desiredUserKey);
            }
            const core = await verify();
            if (core) return { core, source: 'fresh-login' };
        } catch (e) {
            logWarn('Login failed: ' + e.message + '. Proceeding with public/guest access.');
        }
    }

    if (!ACTIVE_COOKIE) {
        logWarn('No usable session found. Provide credentials in user.txt or cookies in cookies.txt.');
    }
    return { core: null, source: 'none' };
}

// ===============
// LMS API & Candidate URL Resolvers
// ===============

async function fetchChapters(courseSlug, referer) {
    const slugId = extractCourseSlugId(courseSlug);
    const apiEndpoints = [
        `${ORIGIN}/api/v1/lms/courses/${slugId}/outline/`,
        `${ORIGIN}/api/v1/courses/${courseSlug}/chapters/`
    ];

    for (const apiUrl of apiEndpoints) {
        try {
            const res = await fetchWithTimeout(apiUrl, { method: 'GET', headers: { ...commonHeaders(referer), accept: 'application/json' } });
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data.chapters) && data.chapters.length > 0) return data;
            }
        } catch {}
    }
    throw new Error(`Failed to fetch chapters for: ${courseSlug}`);
}

async function fetchCoreData(referer) {
    const url = `${ORIGIN}/api/v1/general/core-data/?profile=1`;
    const res = await fetchWithTimeout(url, { method: 'GET', headers: { ...commonHeaders(referer || ORIGIN), accept: 'application/json' } }, 30000);
    if (!res.ok) throw new Error(`Core-data request failed: ${res.status}`);
    return res.json();
}

function printProfileSummary(core) {
    const isAuthenticated = !!core?.auth?.details?.is_authenticated;
    const email = core?.auth?.details?.email || core?.profile?.details?.email || '-';
    const userId = core?.auth?.details?.user_id ?? '-';
    const studentId = core?.auth?.details?.student_id ?? '-';
    const hasSubscription = !!core?.auth?.conditions?.has_subscription || !!core?.auth?.conditions?.business_student;
    const hasCoursePurchase = !!core?.auth?.conditions?.has_course_purchase;
    const statusText = isAuthenticated ? paintGreen('Authenticated') : paintRed('NOT authenticated');
    console.log(`🔐 Auth check: ${statusText}`);
    console.log(`👤 User: ${paintCyan(email)}  | user_id: ${paintCyan(userId)}  | student_id: ${paintCyan(studentId)}`);
    console.log(`💳 Subscription: ${hasSubscription ? paintGreen('yes') : paintYellow('no')}  | Has course purchase: ${hasCoursePurchase ? paintGreen('yes') : paintYellow('no')}`);
    return isAuthenticated;
}

/**
 * Builds candidate URLs for a given unit:
 * 1. Explicit API URL (if present)
 * 2. LMS URL (/lms/course/{slug}/unit/{id}/)
 * 3. Legacy URL (/course/{slug}/{chapter-slug-chID}/{unit-slug}/)
 */
function getUnitUrlCandidates(courseSlug, chapter, unit) {
    const candidates = [];
    const explicitUrls = [unit?.url, unit?.absolute_url, unit?.link, unit?.href].filter(Boolean);

    for (const u of explicitUrls) {
        try {
            candidates.push({ type: 'explicit', url: new URL(u, ORIGIN).toString() });
        } catch {}
    }

    if (unit?.id) {
        candidates.push({
            type: 'lms',
            url: `${ORIGIN}/lms/course/${encodeURIComponent(courseSlug)}/unit/${unit.id}/`
        });
    }

    if (chapter?.slug && chapter?.id && unit?.slug) {
        const chapterSegment = `${encodeURIComponent(chapter.slug)}-ch${chapter.id}`;
        candidates.push({
            type: 'legacy',
            url: `${ORIGIN}/course/${encodeURIComponent(courseSlug)}/${chapterSegment}/${encodeURIComponent(unit.slug)}/`
        });
    }

    const seen = new Set();
    return candidates.filter(c => {
        if (seen.has(c.url)) return false;
        seen.add(c.url);
        return true;
    });
}

async function fetchLmsUnitDetails(unitId, referer) {
    if (!unitId) return { videoData: null, detailData: null };
    const videoUrlApi = `${ORIGIN}/api/v1/lms/units/${unitId}/video_url/`;
    const unitDetailApi = `${ORIGIN}/api/v1/lms/units/${unitId}/`;

    let videoData = null;
    let detailData = null;

    try {
        const res = await fetchWithTimeout(videoUrlApi, { method: 'GET', headers: { ...commonHeaders(referer), accept: 'application/json' } }, 15000);
        if (res.ok) videoData = await res.json();
    } catch {}

    try {
        const res = await fetchWithTimeout(unitDetailApi, { method: 'GET', headers: { ...commonHeaders(referer), accept: 'application/json' } }, 15000);
        if (res.ok) detailData = await res.json();
    } catch {}

    return { videoData, detailData };
}

function extractLmsVideoUrls(videoData, detailData) {
    const items = [];
    const add = (url, quality = 'HQ') => {
        if (!url) return;
        const clean = decodeHtmlEntities(String(url).trim()).replace(/\\\//g, '/');
        items.push({ url: clean, quality: String(quality) });
    };

    if (Array.isArray(videoData?.qualities)) {
        for (const q of videoData.qualities) {
            if (q.download_url) add(q.download_url, q.quality || q.label || 'HQ');
        }
    }
    if (videoData?.video_urls) {
        if (videoData.video_urls.hq) add(videoData.video_urls.hq, 'HQ');
        if (videoData.video_urls.lq) add(videoData.video_urls.lq, 'LQ');
    }
    if (videoData?.hls?.master_url) add(videoData.hls.master_url, 'HLS Master');
    if (Array.isArray(videoData?.hls?.qualities)) {
        for (const q of videoData.hls.qualities) if (q.url) add(q.url, q.quality || 'HLS');
    }

    if (Array.isArray(detailData?.resources)) {
        for (const r of detailData.resources) {
            if (r.download_url) add(r.download_url, r.quality || r.title || 'HQ');
        }
    }

    return items;
}

function extractVideoSourcesFromHtml(html) {
    const urls = [];
    const addCandidate = (raw) => {
        if (!raw) return;
        let url = decodeHtmlEntities(String(raw).trim())
            .replace(/\\u002f/gi, '/')
            .replace(/\\u0026/gi, '&')
            .replace(/\\u003d/gi, '=')
            .replace(/\\\//g, '/');
        if (url.startsWith('//')) url = 'https:' + url;
        try { url = new URL(url, ORIGIN).toString(); } catch {}

        if (isVideoUrl(url)) urls.push(url);
    };

    const attrRe = /\b(?:src|href|data-src|data-url|data-video|data-file|poster)=["']([^"']+)["']/gim;
    let m; while ((m = attrRe.exec(html)) !== null) addCandidate(m[1]);

    const jsonValueRe = /["'](?:src|url|file|video|video_url|videoUrl|source|download_url)["']\s*:\s*["']([^"']+)["']/gim;
    while ((m = jsonValueRe.exec(html)) !== null) addCandidate(m[1]);

    const directUrlRe = /https?:\/\/[^\s"'<>\\]+(?:\.mp4|\.m3u8)(?:[^\s"'<>\\]*)?/gim;
    while ((m = directUrlRe.exec(html)) !== null) addCandidate(m[0]);

    return Array.from(new Set(urls));
}

function pickBestSource(videoItems) {
    if (!videoItems || videoItems.length === 0) return null;
    const mp4Items = videoItems.filter(v => /\.mp4(?:$|[?#])/i.test(v.url));
    const pool = mp4Items.length > 0 ? mp4Items : videoItems;

    const p1080 = pool.find(v => /1080/i.test(v.quality) || /1080p/i.test(v.url));
    if (p1080) return p1080;
    const p720 = pool.find(v => /720/i.test(v.quality) || /720p/i.test(v.url) || /hq\d+/i.test(v.url));
    if (p720) return p720;
    const hq = pool.find(v => /hq/i.test(v.quality) || /hq/i.test(v.url));
    if (hq) return hq;
    const p480 = pool.find(v => /480/i.test(v.quality) || /480p/i.test(v.url));
    if (p480) return p480;

    return pool[0];
}

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

function convertHtmlToMarkdown(html, title) {
    if (!html) return '';
    let content = html;

    content = content
        .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
        .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
        .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<button[^>]*>[\s\S]*?<\/button>/gi, '')
        .replace(/<(?:div|ol|ul)[^>]*class=["'][^"']*(?:breadcrumb|unit-breadcrumbs|course-breadcrumbs|unit-header|unit-content__header)[^"']*["'][^>]*>[\s\S]*?<\/(?:div|ol|ul)>/gi, '')
        .replace(/<div[^>]*class=["'][^"']*(?:unit-navigation|unit-nav|next-prev)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '');

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

    content = content.replace(/<(?:div|li|label)[^>]*class=["'][^"']*(?:answer|choice|option|quiz-item|choice-item)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|li|label)>/gi, (m, inner) => {
        const clean = inner.replace(/<[^>]+>/g, ' ').trim();
        return clean ? `\n- [ ] ${clean}\n` : '';
    });
    content = content.replace(/<input[^>]*type=["'](?:radio|checkbox)["'][^>]*>\s*(?:<label[^>]*>)?(.*?)(?:<\/label>)?/gi, '\n- [ ] $1\n');

    content = content.replace(/<h([1-6])[^>]*>(.*?)<\/h\1>/gi, (_, level, text) => `\n\n${'#'.repeat(Number(level))} ${text.trim()}\n\n`);
    content = content.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n\n');
    content = content.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n\n');
    content = content.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');
    content = content.replace(/<img[^>]*src=["']([^"'>]+)["'][^>]*alt=["']([^"'>]*)["'][^>]*>/gi, '![$2]($1)');
    content = content.replace(/<img[^>]*src=["']([^"'>]+)["'][^>]*>/gi, '![]($1)');
    content = content.replace(/<a[^>]*href=["']([^"'>]+)["'][^>]*>(.*?)<\/a>/gi, '[$2]($1)');
    content = content.replace(/<p[^>]*>/gi, '\n\n').replace(/<\/p>/gi, '')
        .replace(/<br\s*[\/]?>/gi, '\n')
        .replace(/<li[^>]*>/gi, '\n- ').replace(/<\/li>/gi, '');
    content = content.replace(/<(?:b|strong)[^>]*>(.*?)<\/(?:b|strong)>/gi, '**$1**')
        .replace(/<(?:i|em)[^>]*>(.*?)<\/(?:i|em)>/gi, '*$1*');
    content = content.replace(/<[^>]+>/g, ' ');
    content = decodeHtmlEntities(content);

    content = content.replace(/(?:^|\n)\s*(\d+)\s*\n+/g, '\n\n---\n\n### سوال $1\n\n');

    const unwantedLines = new Set(['-', '- [ ]', 'نمایش', 'نمایش محتوای دوره', 'محتوای دوره', 'جلسه بعد', 'جلسه قبل']);
    content = content
        .split('\n')
        .map(line => line.trim())
        .filter(line => !unwantedLines.has(line))
        .filter(line => !line.startsWith('نمره‌ی شما:') && !line.startsWith('%'))
        .join('\n');

    const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    content = content.replace(new RegExp(`^(?:#+\\s*)?${escapedTitle}\\s*`, 'i'), '').trim();

    content = content
        .replace(/[ \t\u200c]+/g, (match) => match.includes('\u200c') ? '\u200c' : ' ')
        .replace(/\n\s*\n\s*\n+/g, '\n\n')
        .trim();

    return `# ${title}\n\n${content}\n\n---\n*Extracted by Maktabkhooneh Downloader PLUS*`;
}

/**
 * Resolves a unit dynamically across:
 * 1. LMS REST API
 * 2. Candidate URLs (Explicit, LMS, Legacy)
 */
async function resolveUnit(courseSlug, chapter, unit, referer, verbose) {
    const candidates = getUnitUrlCandidates(courseSlug, chapter, unit);
    let resolved = {
        structure: 'UNKNOWN',
        url: candidates[0]?.url || `${ORIGIN}/lms/course/${courseSlug}/unit/${unit.id}/`,
        video: null,
        subtitles: [],
        attachments: [],
        rawContent: '',
        html: ''
    };

    // Step 1: Query LMS REST API if unit has an ID
    if (unit?.id) {
        verbose(`[resolve] Unit ID: ${unit.id} | Querying LMS REST API...`);
        const { videoData, detailData } = await fetchLmsUnitDetails(unit.id, resolved.url);
        const lmsVideos = extractLmsVideoUrls(videoData, detailData);
        if (lmsVideos.length > 0) {
            const best = pickBestSource(lmsVideos);
            resolved.structure = 'LMS_API';
            resolved.video = best;
            verbose(`[resolve] Video found via LMS API (${lmsVideos.length} sources, quality: ${best?.quality})`);
        }

        if (detailData?.has_caption && detailData?.caption_file) {
            resolved.subtitles.push(detailData.caption_file);
        }
        if (detailData?.description) {
            resolved.rawContent = detailData.description;
            for (const a of extractAttachmentLinks(detailData.description)) resolved.attachments.push(a);
        }
    }

    // Step 2: If no video yet, iterate through Candidate URLs
    if (!resolved.video) {
        for (const candidate of candidates) {
            verbose(`[resolve] Trying candidate URL (${candidate.type}): ${candidate.url}`);
            try {
                const res = await fetchWithTimeout(candidate.url, { headers: { ...commonHeaders(referer), accept: 'text/html' } }, 20000);
                if (!res.ok) {
                    verbose(`[resolve] Candidate HTTP ${res.status}`);
                    continue;
                }
                const html = await res.text();
                resolved.html = html;
                resolved.url = candidate.url;

                const htmlVideos = extractVideoSourcesFromHtml(html);
                if (htmlVideos.length > 0) {
                    const pool = htmlVideos.map(u => ({ url: u, quality: 'HQ' }));
                    resolved.video = pickBestSource(pool);
                    resolved.structure = candidate.type.toUpperCase() + '_HTML';
                    verbose(`[resolve] Video found via ${candidate.type} HTML (${htmlVideos.length} source(s))`);
                }

                for (const s of extractSubtitleLinks(html)) resolved.subtitles.push(s);
                for (const a of extractAttachmentLinks(html)) resolved.attachments.push(a);

                if (resolved.video) break;
            } catch (err) {
                verbose(`[resolve] Candidate error: ${err.message}`);
            }
        }
    }

    return resolved;
}

// ===============
// Streaming & Resumption Engine
// ===============

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
            if (typeof this._onLimit === 'function') try { this._onLimit(); } catch {}
        }
        cb();
    }
}

async function getRemoteSizeAndRanges(url, referer) {
    try {
        const res = await fetchWithTimeout(url, { method: 'HEAD', headers: { ...commonHeaders(referer), accept: '*/*' } }, 15000);
        if (res.ok) {
            const len = res.headers.get('content-length');
            const size = len ? parseInt(len, 10) : undefined;
            const acceptRanges = (res.headers.get('accept-ranges') || '').toLowerCase().includes('bytes');
            return { size, acceptRanges };
        }
    } catch {}
    try {
        const res = await fetchWithTimeout(url, { method: 'GET', headers: { ...commonHeaders(referer), range: 'bytes=0-0', accept: '*/*' } }, 15000);
        if (res.status === 206) {
            const cr = res.headers.get('content-range');
            const m = cr && cr.match(/\/(\d+)$/);
            const size = m ? parseInt(m[1], 10) : undefined;
            try { if (res.body) { const rb = typeof res.body.pipe === 'function' ? res.body : Readable.fromWeb(res.body); rb.resume(); } } catch {}
            return { size, acceptRanges: true };
        }
    } catch {}
    return { size: undefined, acceptRanges: false };
}

async function downloadToFile(url, filePath, referer, maxRetries = 3, sampleBytes = 0, label = '') {
    let existingFinalSize = 0;
    try { existingFinalSize = fs.statSync(filePath).size; if (existingFinalSize > 0 && sampleBytes > 0) return 'exists'; } catch {}
    const tmpPath = filePath + '.part';
    let existingTmpSize = 0;
    try { existingTmpSize = fs.statSync(tmpPath).size; } catch {}
    
    let remoteInfo;
    if (sampleBytes === 0 && existingFinalSize > 0) {
        remoteInfo = await getRemoteSizeAndRanges(url, referer);
        if (remoteInfo.size && existingFinalSize >= remoteInfo.size) return 'exists';
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            let resumeOffset = 0;
            if (sampleBytes <= 0) {
                if (existingTmpSize > 0) resumeOffset = existingTmpSize;
                else if (existingFinalSize > 0) {
                    if (!remoteInfo) remoteInfo = await getRemoteSizeAndRanges(url, referer);
                    if (remoteInfo.acceptRanges) {
                        try { await fs.promises.rename(filePath, tmpPath); existingTmpSize = existingFinalSize; resumeOffset = existingFinalSize; existingFinalSize = 0; } catch {}
                    }
                }
            }
            
            const requestInit = { method: 'GET', headers: { ...commonHeaders(referer), accept: 'video/mp4,application/octet-stream,*/*' } };
            if (sampleBytes > 0) requestInit.headers['range'] = `bytes=0-${Math.max(0, sampleBytes - 1)}`;
            else if (resumeOffset > 0) requestInit.headers['range'] = `bytes=${resumeOffset}-`;

            const controller = new AbortController();
            const to = setTimeout(() => controller.abort(), 1800000);
            const res = await fetch(url, { ...requestInit, signal: controller.signal });
            if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
            
            if (resumeOffset > 0 && res.status !== 206) {
                try { await fs.promises.unlink(tmpPath); } catch {}
                existingTmpSize = 0; resumeOffset = 0;
                clearTimeout(to);
                throw new Error('Server rejected range request');
            }

            await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
            const write = fs.createWriteStream(tmpPath, { flags: (sampleBytes > 0 || resumeOffset === 0) ? 'w' : 'a' });
            const readable = typeof res.body.pipe === 'function' ? res.body : Readable.fromWeb(res.body);
            
            const contentLengthHeader = res.headers.get('content-length');
            const fullLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : undefined;
            let expectedTotal;
            const contentRange = res.headers.get('content-range');
            const crMatch = contentRange && contentRange.match(/\/(\d+)$/);
            if (sampleBytes > 0) expectedTotal = sampleBytes;
            else if (crMatch) expectedTotal = parseInt(crMatch[1], 10);
            else if (fullLength && resumeOffset > 0) expectedTotal = resumeOffset + fullLength;
            else expectedTotal = fullLength;
            
            let downloadedBytes = resumeOffset;
            const startedAt = Date.now();

            const render = (final = false) => {
                const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);
                const speed = (downloadedBytes - resumeOffset) / elapsedSec;
                let shownDownloaded = downloadedBytes;
                if (expectedTotal && (final || downloadedBytes > expectedTotal)) {
                    if (downloadedBytes - expectedTotal <= 65536) shownDownloaded = expectedTotal;
                }
                const ratio = final ? 1 : (expectedTotal ? (shownDownloaded / expectedTotal) : 0);
                const pct = final ? '100.0%' : (expectedTotal ? `${(Math.min(1, ratio) * 100).toFixed(1)}%` : '--%');
                const name = label ? ` - ${label.slice(0, 50)}` : '';
                process.stdout.write(`\r  ⬇️  [${buildProgressBar(final ? 1 : ratio)}] ${pct}  ${formatBytes(shownDownloaded)}${expectedTotal ? ' / ' + formatBytes(expectedTotal) : ''}  ${formatSpeed(speed)}${name}`);
            };

            const counter = new Transform({
                transform(chunk, _, cb) {
                    downloadedBytes += chunk.length;
                    if (downloadedBytes === resumeOffset + chunk.length || downloadedBytes % 65536 < 8192) render();
                    cb(null, chunk);
                }
            });

            let limitReached = false;
            try {
                if (sampleBytes > 0) {
                    const limiter = new ByteLimit(sampleBytes, () => {
                        limitReached = true;
                        try { readable.destroy(new Error('byte-limit')); } catch {}
                        try { controller.abort(); } catch {}
                    });
                    await pipeline(readable, counter, limiter, write);
                } else {
                    await pipeline(readable, counter, write);
                }
            } catch (pipeErr) {
                if (sampleBytes > 0 && limitReached) {
                    try { clearTimeout(to); } catch {}
                    try { render(true); process.stdout.write('\n'); } catch {}
                    try { await fs.promises.rename(tmpPath, filePath); } catch {}
                    return 'downloaded';
                }
                throw pipeErr;
            } finally {
                clearTimeout(to);
            }

            render(true);
            process.stdout.write('\n');
            await fs.promises.rename(tmpPath, filePath);
            return 'downloaded';
            
        } catch (err) {
            process.stdout.write('\n');
            if (attempt === maxRetries) {
                try { await fs.promises.unlink(tmpPath); } catch {}
                throw err;
            }
            logWarn(`Retry ${attempt}/${maxRetries} for ${path.basename(filePath)} | ${err.message}`);
            await sleep(1500 * attempt);
        }
    }
}

// ===============
// Main Execution Orchestrator
// ===============

async function main() {
    try {
        const cliArgs = parseCLI();
        const { positionalUrl, sampleBytesToDownload, userEmail, userPassword, sessionFile, logFile, cookieFile, forceLogin, isVerboseLoggingEnabled, showHelp, isInfoMode } = cliArgs;
        const { verbose } = createVerboseLogger(isVerboseLoggingEnabled);
        const baseDir = process.cwd();
        const resolvedLogFile = path.resolve(baseDir, logFile || 'downloader.log');
        initLogger(resolvedLogFile);

        writeLog('INFO', 'Maktabkhooneh Downloader PLUS v2.0 started');
        writeLog('INFO', `Working directory: ${baseDir}`);
        writeLog('INFO', `Log file: ${resolvedLogFile}`);

        if (showHelp) {
            printUsage();
            writeLog('INFO', 'Help requested');
            process.exit(0);
        }

        let email = userEmail;
        let password = userPassword;
        if (!email || !password) {
            try {
                const userTxt = fs.readFileSync(path.join(baseDir, 'user.txt'), 'utf8');
                const lines = userTxt.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
                if (!email && lines[0]) email = lines[0];
                if (!password && lines[1]) password = lines[1];
                writeLog('INFO', `Loaded credentials from user.txt for email: ${email || 'unknown'}`);
            } catch {}
        }

        const sessionFilePath = path.resolve(baseDir, sessionFile || 'session.json');
        const cookieFilePath = cookieFile ? path.resolve(baseDir, cookieFile) : null;

    // Iterate chapters and units
    let totalUnits = 0, downloadedCount = 0, skippedCount = 0, failedCount = 0;
    try {
        for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex++) {
            const chapter = chapters[chapterIndex];
            const chapterOrder = String(chapterIndex + 1).padStart(2, '0');
            const chapterFolder = path.join(outputRootFolder, `${chapterOrder} - ${sanitizeName(chapter.title || chapter.slug || 'chapter')}`);
            console.log(`📖 Chapter ${chapterIndex + 1}/${chapters.length}: ${paintBold(chapter.title || chapter.slug)}`);

            // Support both old API (unit_set) and new API (units)
            const units = Array.isArray(chapter.units) ? chapter.units : (Array.isArray(chapter.unit_set) ? chapter.unit_set : []);
            for (let unitIndex = 0; unitIndex < units.length; unitIndex++) {
                const unit = units[unitIndex];
                // Old API: skip if status is explicitly falsy; new API has no status field so skip this check
                if ('status' in unit && !unit.status) continue; // inactive (old API)
                if (unit?.type !== 'lecture') continue; // skip non-video units
                totalUnits++;
                const unitOrder = String(unitIndex + 1).padStart(2, '0');
                const baseFileName = `${unitOrder} - ${sanitizeName(unit.title || unit.slug || 'lecture')}.mp4`;
                const finalFileName = (sampleBytesToDownload && sampleBytesToDownload > 0)
                    ? baseFileName.replace(/\.mp4$/i, '.sample.mp4')
                    : baseFileName;
                const outputFilePath = path.join(chapterFolder, finalFileName);
                verbose(`  🎬 Unit ${unitIndex + 1}/${units.length}: ${unit.title || unit.slug}`);

                // Skip locked content or content requiring purchase
                // Old API: unit.locked (boolean); New API: unit.view_access (10=free, 20=enrolled, 30=purchased, 40=subscription)
                const isLocked = unit.locked === true;
                if (isLocked) {
                    logWarn(`🔒 Locked/No access: ${finalFileName}`);
                    skippedCount++;
                    continue;
                }

        let courseUrls = [];
        if (positionalUrl) {
            courseUrls = [positionalUrl.trim()];
        } else {
            try {
                const linkContent = fs.readFileSync(path.join(baseDir, 'link.txt'), 'utf8');
                courseUrls = linkContent.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
                writeLog('INFO', `Loaded ${courseUrls.length} course URL(s) from link.txt`);
                if (!courseUrls.length) throw new Error('Empty');
            } catch {
                logError("Failed to read valid links. Specify course URL as argument or create 'link.txt'.");
                printUsage();
                process.exit(1);
            }
        }

        for (const courseUrl of courseUrls) {
            console.log('\n' + '═'.repeat(60));
            writeLog('INFO', `Processing course URL: ${courseUrl}`);
            const normalizedCourseUrl = ensureTrailingSlash(courseUrl.trim());
            const courseSlug = extractCourseSlug(normalizedCourseUrl);
            const requestedUnitId = extractRequestedUnitId(normalizedCourseUrl);
            const courseDisplayName = sanitizeName(decodeURIComponent(courseSlug));
            const outputRoot = path.resolve(baseDir, 'download', courseDisplayName);
            
            if (isInfoMode) {
                console.log(`\n🔍 ${paintBoldCyan('INFO MODE ACTIVATED:')} Fetching curriculum for ${paintBold(courseDisplayName)}...\n`);
            } else {
                logStep(`Processing: ${paintBold(courseDisplayName)}`);
                try { await fs.promises.mkdir(outputRoot, { recursive: true }); } catch {}
                if (sampleBytesToDownload > 0) {
                    console.log(`🎯 Sample mode: downloading first ${paintBold(String(sampleBytesToDownload))} bytes`);
                }
            }

            let chaptersData;
            try {
                chaptersData = await fetchChapters(courseSlug, normalizedCourseUrl);
            } catch (e) {
                logError(`Failed to fetch chapters for ${courseSlug}: ${e.message}`);
                writeLog('ERROR', `Failed to fetch chapters for ${courseSlug}: ${e.message}`);
                continue;
            }

            const chapters = Array.isArray(chaptersData?.chapters) ? chaptersData.chapters : [];
            let stats = { total: 0, resolvedVideos: 0, downloaded: 0, skipped: 0, failed: 0, markdown: 0, subtitles: 0, attachments: 0 };
            let tableData = [];
            let totalEstimatedSize = 0;

            for (let cIdx = 0; cIdx < chapters.length; cIdx++) {
                const chapter = chapters[cIdx];
                const chapterFolder = path.join(outputRoot, `${String(cIdx + 1).padStart(2, '0')} - ${sanitizeName(chapter.title || chapter.slug || 'chapter')}`);
                
                if (!isInfoMode) {
                    console.log(`\n📖 Chapter ${cIdx + 1}/${chapters.length}: ${paintBold(chapter.title || chapter.slug)}`);
                }
                writeLog('INFO', `Chapter ${cIdx + 1}/${chapters.length}: ${chapter.title || chapter.slug || 'chapter'}`);

                const units = Array.isArray(chapter.units) ? chapter.units : (Array.isArray(chapter.unit_set) ? chapter.unit_set : []);
                for (let uIdx = 0; uIdx < units.length; uIdx++) {
                    const unit = units[uIdx];
                    if ('status' in unit && !unit.status) continue;
                    if (requestedUnitId != null && Number(unit?.id) !== requestedUnitId) continue;

                    stats.total++;
                    const unitOrder = String(uIdx + 1).padStart(2, '0');
                    const sanitizedTitle = sanitizeName(unit.title || unit.slug || 'lecture');
                    const baseFileName = `${unitOrder} - ${sanitizedTitle}.mp4`;
                    const finalFileName = sampleBytesToDownload > 0 ? baseFileName.replace(/\.mp4$/i, '.sample.mp4') : baseFileName;
                    const videoBaseNoExt = finalFileName.replace(/\.sample\.mp4$/i, '').replace(/\.mp4$/i, '');
                    const outputFilePath = path.join(chapterFolder, finalFileName);

                    const isLocked = unit.locked === true || (unit.view_access === 2 && !coreData?.auth?.conditions?.has_subscription && !coreData?.auth?.conditions?.business_student && !coreData?.auth?.conditions?.has_course_purchase);

                    if (isLocked) {
                        logWarn(`🔒 Locked/No access: ${finalFileName}`);
                        writeLog('WARN', `Locked lecture skipped: ${finalFileName}`);
                        stats.skipped++;
                        if (isInfoMode) {
                            tableData.push({ Chapter: (chapter.title || '').slice(0, 30), Lesson: (unit.title || '').slice(0, 45), Type: unit.type_display || 'Lesson', Size: 'Locked 🔒' });
                        }
                        continue;
                    }

                    try {
                        // Dynamically resolve Unit structure and media
                        const resolved = await resolveUnit(courseSlug, chapter, unit, normalizedCourseUrl, verbose);
                        const isVideo = !!resolved.video?.url;

                        if (isVideo) {
                            stats.resolvedVideos++;
                            if (!isInfoMode) console.log(`🔎 Structure: ${paintCyan(resolved.structure)} [Quality: ${paintGreen(resolved.video.quality || 'HQ')}]`);
                        }

                        // Non-video units (quizzes / text readings / exercises)
                        if (!isVideo) {
                            if (isInfoMode) {
                                tableData.push({ Chapter: (chapter.title || '').slice(0, 30), Lesson: (unit.title || '').slice(0, 45), Type: unit.type_display || 'Text/Quiz', Size: 'N/A' });
                                continue;
                            }

                            const mdFileName = `${unitOrder} - ${sanitizedTitle}.md`;
                            const mdFilePath = path.join(chapterFolder, mdFileName);
                            if (fs.existsSync(mdFilePath) && fs.statSync(mdFilePath).size > 0) {
                                console.log(paintYellow(`🟡 SKIP exists: ${mdFileName}`));
                                writeLog('INFO', `Skipped existing Markdown: ${mdFileName}`);
                                stats.skipped++;
                            } else {
                                console.log(`📝 Extracting Markdown: ${mdFileName}`);
                                writeLog('INFO', `Extracting Markdown: ${mdFileName}`);
                                await fs.promises.mkdir(chapterFolder, { recursive: true });
                                const rawText = resolved.rawContent || unit.description || resolved.html || '';
                                const mdContent = convertHtmlToMarkdown(rawText, unit.title || sanitizedTitle);
                                await fs.promises.writeFile(mdFilePath, mdContent, 'utf8');
                                logSuccess(`SAVED: ${mdFileName}`);
                                writeLog('SUCCESS', `Saved Markdown: ${mdFileName}`);
                                stats.markdown++;
                            }
                            continue;
                        }

                        // Info table mode
                        if (isInfoMode) {
                            let sizeStr = 'Unknown';
                            const { size } = await getRemoteSizeAndRanges(resolved.video.url, resolved.url);
                            if (size) { totalEstimatedSize += size; sizeStr = formatBytes(size); }
                            tableData.push({ Chapter: (chapter.title || '').slice(0, 30), Lesson: (unit.title || '').slice(0, 45), Type: `Video (${resolved.video.quality || 'HQ'})`, Size: sizeStr });
                            process.stdout.write(`Fetching info... ${tableData.length} items parsed.\r`);
                            continue;
                        }

                        // Download video
                        console.log(`📥 Downloading: ${finalFileName}`);
                        writeLog('INFO', `Downloading: ${finalFileName} (URL: ${resolved.video.url})`);
                        const status = await downloadToFile(resolved.video.url, outputFilePath, resolved.url, 3, sampleBytesToDownload, finalFileName);
                        if (status === 'exists') {
                            console.log(paintYellow(`🟡 SKIP exists: ${finalFileName}`));
                            writeLog('INFO', `Skipped existing file: ${finalFileName}`);
                            stats.skipped++;
                        } else {
                            logSuccess(`DOWNLOADED: ${finalFileName}`);
                            writeLog('SUCCESS', `Downloaded: ${finalFileName}`);
                            stats.downloaded++;
                        }

                        // Download Subtitles (.vtt)
                        try {
                            for (const subUrl of resolved.subtitles) {
                                const absSubUrl = (() => { try { return new URL(subUrl, ORIGIN).toString(); } catch { return subUrl; } })();
                                let ext = '.vtt';
                                try { const up = new URL(absSubUrl); ext = path.extname(up.pathname) || '.vtt'; } catch {}
                                const subtitleName = `${videoBaseNoExt}${ext}`;
                                const subtitlePath = path.join(chapterFolder, subtitleName);
                                if (!fs.existsSync(subtitlePath) || fs.statSync(subtitlePath).size === 0) {
                                    console.log(`📝 Subtitle: ${subtitleName}`);
                                    await downloadToFile(absSubUrl, subtitlePath, resolved.url, 2, 0, subtitleName);
                                    logSuccess(`SUBTITLE: ${subtitleName}`);
                                    writeLog('SUCCESS', `Downloaded subtitle: ${subtitleName}`);
                                    stats.subtitles++;
                                }
                            }
                        } catch (subErr) {
                            verbose(`Subtitle fail: ${subErr.message}`);
                        }

                        // Download Attachments
                        try {
                            for (const attUrl of resolved.attachments) {
                                let filePart;
                                try {
                                    const u = new URL(attUrl, ORIGIN);
                                    filePart = u.pathname.split('/').pop() || 'attachment.bin';
                                } catch {
                                    filePart = attUrl.split('?')[0].split('/').pop() || 'attachment.bin';
                                }
                                const finalAttachmentName = `${videoBaseNoExt} - ${sanitizeName(filePart)}`;
                                const attachmentPath = path.join(chapterFolder, finalAttachmentName);
                                if (!fs.existsSync(attachmentPath) || fs.statSync(attachmentPath).size === 0) {
                                    console.log(`📎 Attachment: ${finalAttachmentName}`);
                                    await downloadToFile(attUrl, attachmentPath, resolved.url, 3, 0, finalAttachmentName);
                                    logSuccess(`ATTACHMENT: ${finalAttachmentName}`);
                                    writeLog('SUCCESS', `Downloaded attachment: ${finalAttachmentName}`);
                                    stats.attachments++;
                                }
                            }
                        } catch (attErr) {
                            verbose(`Attachment fail: ${attErr.message}`);
                        }

                        await sleep(250);

                    } catch (err) {
                        logError(`FAIL ${finalFileName}: ${err.message}`);
                        writeLog('ERROR', `Failed file: ${finalFileName} | ${err.message}`);
                        stats.failed++;
                    }
                }
            }
            
            if (isInfoMode) {
                console.log('\n\n' + '═'.repeat(95));
                console.table(tableData);
                console.log('═'.repeat(95));
                console.log(`📊 Total Lessons: ${paintBold(tableData.length.toString())}`);
                console.log(`💾 Estimated Video Size: ${paintCyan(formatBytes(totalEstimatedSize))}\n`);
            } else {
                console.log('—'.repeat(40));
                console.log(`📊 Statistics for ${courseDisplayName}:`);
                console.log(`   Total Units Discovered: ${paintBold(String(stats.total))}`);
                console.log(`   🎬 Video Units Resolved: ${paintBold(String(stats.resolvedVideos))}`);
                console.log(`   ✅ Downloaded Videos:    ${paintGreen(String(stats.downloaded))}`);
                console.log(`   📝 Markdown Extracted:   ${paintGreen(String(stats.markdown))}`);
                console.log(`   📝 Subtitles Downloaded: ${paintGreen(String(stats.subtitles))}`);
                console.log(`   📎 Attachments Saved:    ${paintGreen(String(stats.attachments))}`);
                console.log(`   🟡 Skipped / Exists:     ${paintYellow(String(stats.skipped))}`);
                console.log(`   ❌ Failed:               ${paintRed(String(stats.failed))}`);
            }
        }
        
        console.log('\n' + '═'.repeat(60));
        logSuccess('Process Terminated Successfully.');
        writeLog('INFO', 'Process completed successfully');
    } catch (err) {
        logError('FATAL PROCESS ERROR:', err.message);
        writeLog('ERROR', `Fatal process error: ${err.message}`);
        process.exit(1);
    }
}

main();
