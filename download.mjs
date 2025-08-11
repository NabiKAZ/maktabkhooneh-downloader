/**
 * CLI tool to download all lecture videos of a maktabkhooneh course
 * 
 * Usage examples:
 *   node download.mjs "https://maktabkhooneh.org/course/<slug>/"
 *   node download.mjs "https://maktabkhooneh.org/course/<slug>/" --sample-bytes 65536 --verbose
 * 
 * Notes:
 * - Set MK_COOKIE or MK_COOKIE_FILE for authentication.
 * - Only download content you have legal rights to access.
 * 
 * @repository https://github.com/NabiKAZ/maktabkhooneh-downloader
 * @author NabiKAZ <https://x.com/NabiKAZ>
 * @license GPL-3.0
 * @created 2025
 * 
 * Copyright(C) 2025 NabiKAZ
 */

import fs from 'fs';
import path from 'path';
import { Transform, Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { setTimeout as sleep } from 'timers/promises';

// ===============
// Console styling (ANSI colors) and emojis
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
// Combined style helpers
const paintBoldCyan = s => `${COLOR.bold}${COLOR.cyan}${s}${COLOR.reset}`; // bold + cyan
const paintBlue = s => paint(COLOR.blue, s);
const paintLightBlue = s => paint(COLOR.lightBlue, s);

const logInfo = (...a) => console.log('ℹ️', ...a);
const logStep = (...a) => console.log('▶️', ...a);
const logSuccess = (...a) => console.log('✅', ...a);
const logWarn = (...a) => console.warn('⚠️', ...a);
const logError = (...a) => console.error('❌', ...a);

// ===============
// Configuration
// ===============
// Cookie: read from env MK_COOKIE or file path in MK_COOKIE_FILE; fallback to placeholder.
const COOKIE = (() => {
    if (process.env.MK_COOKIE && process.env.MK_COOKIE.trim()) return process.env.MK_COOKIE.trim();
    if (process.env.MK_COOKIE_FILE) {
        try { return fs.readFileSync(process.env.MK_COOKIE_FILE, 'utf8').trim(); } catch { }
    }
    return 'PUT_YOUR_COOKIE_HERE';
})();
// Sample mode default (0 means full download)
const DEFAULT_SAMPLE_BYTES = 0;

// Ensure Node 18+ for global fetch
if (typeof fetch !== 'function') {
    logError('This script requires Node.js v18+ with global fetch.');
    process.exit(1);
}

const ORIGIN = 'https://maktabkhooneh.org';

// Build common headers for authenticated requests.
function commonHeaders(referer) {
    /** @type {Record<string,string>} */
    const headers = {
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9,fa;q=0.8',
        'cache-control': 'no-cache',
        'pragma': 'no-cache',
        'x-requested-with': 'XMLHttpRequest',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
    };
    if (COOKIE && COOKIE !== 'PUT_YOUR_COOKIE_HERE') headers['cookie'] = COOKIE;
    if (referer) headers['referer'] = referer;
    return headers;
}

// Human-friendly byte formatter
function formatBytes(bytes) {
    if (bytes == null || isNaN(bytes)) return '-';
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
    const bar = `${'█'.repeat(filled)}${'░'.repeat(left)}`;
    return bar;
}

function ensureCookiePresent() {
    if (!COOKIE || COOKIE === 'PUT_YOUR_COOKIE_HERE') {
        logError('Cookie is not set. Set', paintBold('MK_COOKIE'), 'or', paintBold('MK_COOKIE_FILE'), 'or edit the COOKIE placeholder.');
        process.exit(1);
    }
}

// CLI usage
function printUsage() {
    // Header section
    console.log(`${paintBoldCyan('Maktabkhooneh Downloader')} - ${paintYellow('version 0.1.0')} ${paint(COLOR.dim, '© 2025')}`);
    console.log(paint(COLOR.magenta, 'By ') + paint(COLOR.magenta, '@NabiKAZ') + ' ' + paintLightBlue('<www.nabi.ir>') + ' ' + paintGreen('<nabikaz@gmail.com>') + ' ' + paintLightBlue('<x.com/NabiKAZ>'));
    console.log(paint(COLOR.dim, 'Signup: ') + paintLightBlue('https://maktabkhooneh.org/'));
    console.log(paint(COLOR.dim, 'Project: ') + paintLightBlue('https://github.com/NabiKAZ/maktabkhooneh-downloader'));
    console.log(paint(COLOR.dim, '=============================================================\n'));

    // Usage
    console.log(paintBold('Usage:'));
    console.log(`  ${paintCyan('node download.mjs')} ${paintYellow('<course_url>')} [${paintGreen('--sample-bytes')} ${paintYellow('<N>')}] [${paintGreen('--verbose')}]`);

    // Options
    console.log('\n' + paintBold('Options:'));
    console.log(`  ${paintYellow('<course_url>')}       The maktabkhooneh course URL (e.g., https://maktabkhooneh.org/course/<slug>/)`);
    console.log(`  ${paintGreen('--sample-bytes')} ${paintYellow('N')}   Download only the first N bytes of each video (also supports env MK_SAMPLE_BYTES)`);
    console.log(`  ${paintGreen('--verbose')}          Print detailed progress logs`);

    // Examples
    console.log('\n' + paintBold('Examples:'));
    console.log('  ' + paintCyan('node download.mjs "https://maktabkhooneh.org/course/…/"'));
    console.log('  ' + paintCyan('node download.mjs "https://maktabkhooneh.org/course/…/" --sample-bytes 65536 --verbose'));
}

function parseCLI() {
    const args = process.argv.slice(2);
    let inputCourseUrl = null;
    let sampleBytesToDownload = DEFAULT_SAMPLE_BYTES;
    let isVerboseLoggingEnabled = false;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--help' || a === '-h') {
            printUsage();
            process.exit(0);
        } else if (a.startsWith('--sample-bytes=')) {
            const v = a.split('=')[1];
            sampleBytesToDownload = parseInt(v, 10) || 0;
        } else if (a === '--sample-bytes') {
            const v = args[i + 1];
            if (v) { sampleBytesToDownload = parseInt(v, 10) || 0; i++; }
        } else if (a === '--verbose' || a === '-v') {
            isVerboseLoggingEnabled = true;
        } else if (!inputCourseUrl) {
            inputCourseUrl = a;
        }
    }
    if (!sampleBytesToDownload && process.env.MK_SAMPLE_BYTES) {
        sampleBytesToDownload = parseInt(process.env.MK_SAMPLE_BYTES, 10) || 0;
    }
    return { inputCourseUrl, sampleBytesToDownload, isVerboseLoggingEnabled };
}

function createVerboseLogger(isVerbose) {
    return { verbose: (...a) => { if (isVerbose) console.log(...a); } };
}

// Parse the course slug from the full course URL.
function extractCourseSlug(courseUrl) {
    try {
        const parsed = new URL(courseUrl);
        if (parsed.origin !== ORIGIN) {
            throw new Error('Unexpected origin: ' + parsed.origin);
        }
        const parts = parsed.pathname.split('/').filter(Boolean);
        const idx = parts.indexOf('course');
        if (idx === -1 || !parts[idx + 1]) throw new Error('Cannot parse course slug');
        return parts[idx + 1];
    } catch (e) {
        throw new Error('Invalid course URL: ' + e.message);
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

function ensureTrailingSlash(u) { return u.endsWith('/') ? u : u + '/'; }

// Try to detect remote file size and whether server supports Range
async function getRemoteSizeAndRanges(url, referer) {
    // HEAD first
    try {
        const res = await fetchWithTimeout(url, { method: 'HEAD', headers: { ...commonHeaders(referer), accept: '*/*' } }, 20_000);
        if (res.ok) {
            const len = res.headers.get('content-length');
            const size = len ? parseInt(len, 10) : undefined;
            const acceptRanges = (res.headers.get('accept-ranges') || '').toLowerCase().includes('bytes');
            return { size, acceptRanges };
        }
    } catch { }
    // Fallback: GET single byte
    try {
        const res = await fetchWithTimeout(url, { method: 'GET', headers: { ...commonHeaders(referer), range: 'bytes=0-0', accept: '*/*' } }, 20_000);
        if (res.status === 206) {
            const cr = res.headers.get('content-range');
            // e.g. bytes 0-0/123456
            const m = cr && cr.match(/\/(\d+)$/);
            const size = m ? parseInt(m[1], 10) : undefined;
            try { if (res.body) { const rb = Readable.fromWeb(res.body); rb.resume(); } } catch { }
            return { size, acceptRanges: true };
        }
    } catch { }
    return { size: undefined, acceptRanges: false };
}

// API: fetch chapters JSON for a course.
async function fetchChapters(courseSlug, referer) {
    const apiUrl = `${ORIGIN}/api/v1/courses/${courseSlug}/chapters/`;
    const res = await fetchWithTimeout(apiUrl, { method: 'GET', headers: { ...commonHeaders(referer), accept: 'application/json' } });
    if (!res.ok) throw new Error(`Failed to fetch chapters: ${res.status} ${res.statusText}`);
    return res.json();
}

// API: core-data to verify authentication and basic profile.
async function fetchCoreData(referer) {
    const url = `${ORIGIN}/api/v1/general/core-data/?profile=1`;
    const res = await fetchWithTimeout(url, { method: 'GET', headers: { ...commonHeaders(referer || ORIGIN), accept: 'application/json' } }, 30_000);
    if (!res.ok) throw new Error(`Core-data request failed: ${res.status} ${res.statusText}`);
    return res.json();
}

function printProfileSummary(core) {
    const isAuthenticated = !!core?.auth?.details?.is_authenticated;
    const email = core?.auth?.details?.email || core?.profile?.details?.email || '-';
    const userId = core?.auth?.details?.user_id ?? '-';
    const studentId = core?.auth?.details?.student_id ?? '-';
    const hasSubscription = !!core?.auth?.conditions?.has_subscription;
    const hasCoursePurchase = !!core?.auth?.conditions?.has_course_purchase;
    const statusText = isAuthenticated ? paintGreen('Authenticated') : paintRed('NOT authenticated');
    console.log(`🔐 Auth check: ${statusText}`);
    console.log(`👤 User: ${paintCyan(email)}  | user_id: ${paintCyan(userId)}  | student_id: ${paintCyan(studentId)}`);
    console.log(`💳 Subscription: ${hasSubscription ? paintGreen('yes') : paintYellow('no')}  | Has course purchase: ${hasCoursePurchase ? paintGreen('yes') : paintYellow('no')}`);
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
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// Extract <source ... src="..."> URLs from lecture page HTML.
function extractVideoSources(html) {
    const urls = [];
    const re = /<source\b[^>]*?src=["']([^"'>]+)["'][^>]*>/gim;
    let m;
    while ((m = re.exec(html)) !== null) {
        const raw = m[1];
        const url = decodeHtmlEntities(raw);
        if (url && url.includes('/videos/')) urls.push(url);
    }
    return Array.from(new Set(urls));
}
// Extract subtitle (.vtt) URLs from lecture page HTML.
function extractSubtitleSources(html) {
    const urls = [];
    const re = /href=["']([^"'>]+\.vtt[^"'>]*)["']/gim;
    let m;
    while ((m = re.exec(html)) !== null) {
        const raw = m[1];
        const url = decodeHtmlEntities(raw);
        if (url && url.endsWith('.vtt')) urls.push(url);
    }
    return Array.from(new Set(urls));
}

// Pick best source, prefer HQ.
function pickBestSource(urls) {
    if (!urls || urls.length === 0) return null;
    const hq = urls.find(u => /\/videos\/hq\d+/.test(u) || u.includes('/videos/hq'));
    return hq || urls[0];
}

// Sanitize a string for safe Windows filenames.
function sanitizeName(name) {
    return name.replace(/[\/:*?"<>|]/g, ' ').replace(/[\s\u200c\u200f\u202a\u202b]+/g, ' ').trim().slice(0, 150);
}

// Transform stream to limit to first N bytes and optionally signal upstream.
class ByteLimit extends Transform {
    // Limits the stream to the first `limit` bytes, then signals upstream to stop.
    constructor(limit, onLimit) { super(); this.limit = limit; this.seen = 0; this._hit = false; this._onLimit = onLimit; }
    _transform(chunk, enc, cb) {
        if (this.limit <= 0) { this.push(chunk); return cb(); }
        const remaining = this.limit - this.seen;
        if (remaining <= 0) { return cb(); }
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

// Download a URL to a file (with retries). If sampleBytes > 0, request a Range and also enforce a local limit.
// label: optional display name to show in the progress line (e.g., final file name)
async function downloadToFile(url, filePath, referer, maxRetries = 3, sampleBytes = 0, label = '') {
    // Skip if already exists with non-zero size
    let existingFinalSize = 0;
    try { const stat = fs.statSync(filePath); existingFinalSize = stat.size; if (existingFinalSize > 0 && sampleBytes > 0) return 'exists'; } catch { }
    const tmpPath = filePath + '.part';
    let existingTmpSize = 0;
    try { const stat = fs.statSync(tmpPath); existingTmpSize = stat.size; } catch { }

    // For full downloads, see if final is already complete
    let remoteInfo;
    if (sampleBytes === 0 && existingFinalSize > 0) {
        remoteInfo = await getRemoteSizeAndRanges(url, referer);
        if (remoteInfo.size && existingFinalSize >= remoteInfo.size) {
            return 'exists';
        }
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // Decide resume offset
            let resumeOffset = 0;
            let writingTo = tmpPath;
            if (sampleBytes > 0) {
                resumeOffset = 0; // do not resume sample downloads
            } else {
                if (existingTmpSize > 0) {
                    resumeOffset = existingTmpSize;
                } else if (existingFinalSize > 0) {
                    // Only resume from final if server supports ranges
                    if (!remoteInfo) remoteInfo = await getRemoteSizeAndRanges(url, referer);
                    if (remoteInfo.acceptRanges) {
                        // Move final to tmp to resume appending
                        try { await fs.promises.rename(filePath, tmpPath); existingTmpSize = existingFinalSize; resumeOffset = existingFinalSize; existingFinalSize = 0; } catch { }
                    } else {
                        // Cannot resume; start from scratch
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
            const to = setTimeout(() => controller.abort(), 120_000);
            const res = await fetch(url, { ...requestInit, signal: controller.signal });
            if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
            if (resumeOffset > 0 && res.status !== 206) {
                // Server didn't honor Range; restart from 0
                try { await fs.promises.unlink(tmpPath); } catch { }
                existingTmpSize = 0; resumeOffset = 0;
                clearTimeout(to);
                throw new Error('Server did not honor range; restarting from 0');
            }

            await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
            const write = fs.createWriteStream(writingTo, { flags: (sampleBytes > 0 || resumeOffset === 0) ? 'w' : 'a' });
            const readable = Readable.fromWeb(res.body);

            // Progress bar state
            const contentLengthHeader = res.headers.get('content-length');
            const fullLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : undefined;
            // Try content-range for total size when resuming
            let expectedTotal;
            const contentRange = res.headers.get('content-range');
            const crMatch = contentRange && contentRange.match(/\/(\d+)$/);
            if (sampleBytes && sampleBytes > 0) expectedTotal = sampleBytes;
            else if (crMatch) expectedTotal = parseInt(crMatch[1], 10);
            else if (fullLength && resumeOffset > 0) expectedTotal = resumeOffset + fullLength;
            else expectedTotal = fullLength;
            let downloadedBytes = resumeOffset;
            const startedAt = Date.now();

            // Progress render helper
            const truncate = (s, max = 70) => {
                if (!s) return '';
                const str = String(s);
                return str.length > max ? str.slice(0, max - 1) + '…' : str;
            };
            const render = (final = false) => {
                const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);
                const speed = downloadedBytes / elapsedSec;
                // clamp bytes to expected total when finalizing or very close (to avoid 99.9% stuck)
                let shownDownloaded = downloadedBytes;
                if (expectedTotal && (final || downloadedBytes > expectedTotal)) {
                    // Tolerate tiny overflow due to headers/rounding
                    const overflow = downloadedBytes - expectedTotal;
                    if (overflow <= 65536) shownDownloaded = expectedTotal;
                }
                let ratio = expectedTotal ? (shownDownloaded / expectedTotal) : 0;
                if (final && expectedTotal) ratio = 1;
                const bar = buildProgressBar(ratio);
                const pct = expectedTotal ? `${(Math.min(1, ratio) * 100).toFixed(1)}%` : '--%';
                const sizeStr = `${formatBytes(shownDownloaded)}${expectedTotal ? ' / ' + formatBytes(expectedTotal) : ''}`;
                const name = label ? `  -  ${truncate(label, 80)}` : '';
                const line = `  ⬇️  [${bar}] ${pct}  ${sizeStr}  ${formatSpeed(speed)}${name}`;
                process.stdout.write(`\r${line}`);
            };

            // Counting transform
            const counter = new Transform({
                transform(chunk, _enc, cb) {
                    downloadedBytes += chunk.length;
                    // throttle render slightly by size steps
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

            // finalize progress bar to 100%
            try { render(true); } catch { }
            process.stdout.write('\n');
            await fs.promises.rename(tmpPath, filePath).catch(async () => {
                // If we were already writing to final (rare), ensure exists
                try { await fs.promises.copyFile(writingTo, filePath); } catch { }
            });
            return 'downloaded';
        } catch (err) {
            try { process.stdout.write('\n'); } catch { }
            // Keep .part file for future resume; do not delete on error
            if (attempt < maxRetries) {
                logWarn(`Retry ${attempt}/${maxRetries} for ${path.basename(filePath)} after error: ${err.message}`);
                await sleep(1000 * attempt);
                continue;
            }
            throw err;
        }
    }
}

async function main() {
    const { inputCourseUrl, sampleBytesToDownload, isVerboseLoggingEnabled } = parseCLI();
    const { verbose } = createVerboseLogger(isVerboseLoggingEnabled);
    if (!inputCourseUrl) { printUsage(); process.exit(1); }
    ensureCookiePresent();

    const normalizedCourseUrl = ensureTrailingSlash(inputCourseUrl.trim());
    const courseSlug = extractCourseSlug(normalizedCourseUrl);
    // Use decoded slug (human-friendly, especially for Persian) for the top-level folder name
    const courseDisplayName = sanitizeName(decodeURIComponent(courseSlug));
    const outputRootFolder = path.resolve(process.cwd(), 'download', courseDisplayName);
    // Ensure base output folder exists
    try { await fs.promises.mkdir(outputRootFolder, { recursive: true }); } catch { }

    // Verify auth profile first
    try {
        const core = await fetchCoreData(normalizedCourseUrl);
        const ok = printProfileSummary(core);
        if (!ok) { logError('Not logged in. Please update your cookie and try again.'); process.exit(1); }
    } catch (e) {
        logError('Failed to verify authentication:', e.message);
        process.exit(1);
    }

    console.log(`📚 Course slug: ${paintBold(decodeURIComponent(courseSlug))}`);
    console.log(`📁 Output folder: ${paintCyan(outputRootFolder)}`);
    if (sampleBytesToDownload && sampleBytesToDownload > 0) {
        console.log(`🎯 Sample mode: downloading first ${paintBold(String(sampleBytesToDownload))} bytes of each video (saved as .sample.mp4)`);
    }

    // Fetch chapters
    verbose(paintCyan('Fetching chapters...'));
    const chaptersData = await fetchChapters(courseSlug, normalizedCourseUrl);
    const chapters = Array.isArray(chaptersData?.chapters) ? chaptersData.chapters : [];
    if (chapters.length === 0) { logError('No chapters found. Make sure the URL and cookie are correct.'); process.exit(2); }

    // Iterate chapters and units
    let totalUnits = 0, downloadedCount = 0, skippedCount = 0, failedCount = 0;
    try {
        for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex++) {
            const chapter = chapters[chapterIndex];
            const chapterOrder = String(chapterIndex + 1).padStart(2, '0');
            const chapterFolder = path.join(outputRootFolder, `${chapterOrder} - ${sanitizeName(chapter.title || chapter.slug || 'chapter')}`);
            console.log(`📖 Chapter ${chapterIndex + 1}/${chapters.length}: ${paintBold(chapter.title || chapter.slug)}`);

            const units = Array.isArray(chapter.unit_set) ? chapter.unit_set : [];
            for (let unitIndex = 0; unitIndex < units.length; unitIndex++) {
                const unit = units[unitIndex];
                if (!unit?.status) continue; // inactive
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
                if (unit.locked) {
                    logWarn(`🔒 Locked/No access: ${finalFileName}`);
                    skippedCount++;
                    continue;
                }

                const lectureUrl = buildLectureUrl(courseSlug, chapter, unit);
                try {
                    // Fetch lecture page HTML
                    const res = await fetchWithTimeout(lectureUrl, { headers: { ...commonHeaders(normalizedCourseUrl), accept: 'text/html' } });
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const html = await res.text();
                    const videoSources = extractVideoSources(html);
                    const bestSourceUrl = pickBestSource(videoSources);
                    if (!bestSourceUrl) { logWarn(`No video source found for: ${finalFileName}`); skippedCount++; continue; }

                    // Print the filename on its own line; progress bar will render on the next line
                    console.log(`📥 Downloading: ${finalFileName}`);
                    const status = await downloadToFile(bestSourceUrl, outputFilePath, lectureUrl, 3, sampleBytesToDownload, '');
                    if (status === 'exists') { console.log(paintYellow(`🟡 SKIP exists: ${finalFileName}`)); skippedCount++; }
                    else { logSuccess(`DOWNLOADED: ${finalFileName}`); downloadedCount++; }

                    // After downloading the video, attempt to download the subtitle
                    const subtitleUrls = extractSubtitleSources(html);
                    if (subtitleUrls.length > 0) {
                        for (const subUrl of subtitleUrls) {
                            try {
                                const subtitleFileName = finalFileName.replace(/\.mp4$/i, '.vtt');
                                const subtitlePath = path.join(chapterFolder, subtitleFileName);
                    
                                console.log(`📝 Downloading subtitle: ${subtitleFileName}`);
                                const statusSub = await downloadToFile(
                                    subUrl.startsWith('http') ? subUrl : `${ORIGIN}${subUrl}`,
                                    subtitlePath,
                                    lectureUrl,
                                    3,
                                    0,
                                    ''
                                );
                                if (statusSub === 'exists') {
                                    console.log(paintYellow(`🟡 SKIP exists: ${subtitleFileName}`));
                                } else {
                                    logSuccess(`DOWNLOADED: ${subtitleFileName}`);
                                }
                            } catch (err) {
                                logWarn(`Subtitle download failed: ${err.message}`);
                            }
                        }
                    } else {
                        logWarn('No subtitle found for this lecture.');
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
        console.log('—'.repeat(40));
        console.log(`📊 Total lecture units: ${paintBold(String(totalUnits))}`);
        console.log(`✅ Downloaded: ${paintGreen(String(downloadedCount))}`);
        console.log(`🟡 Skipped: ${paintYellow(String(skippedCount))}`);
        console.log(`❌ Failed: ${paintRed(String(failedCount))}`);
    }
}

main().catch(err => { logError('Fatal:', err); process.exit(1); });

