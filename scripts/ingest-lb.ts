/**
 * Lietuvos bankas (Bank of Lithuania) Ingestion Crawler
 *
 * Scrapes the Bank of Lithuania website (lb.lt) and populates the SQLite
 * database with:
 *   1. Nutarimai — Board resolutions on licensing, capital requirements,
 *      AML/CFT, payment services, fintech, and crypto-asset regulation
 *   2. Gaires — supervisory guidelines on IT risk, ESG, governance,
 *      cyber security, and operational resilience
 *   3. Rekomendacijos — non-binding best-practice recommendations on
 *      consumer protection, AI governance, outsourcing, and reporting
 *   4. Enforcement actions (poveikio priemones) — fines, licence
 *      revocations, warnings, and other supervisory sanctions
 *
 * The lb.lt website serves paginated HTML listings under:
 *   - /lt/teisesaktai/lietuvos-banko-valdybos-nutarimai  (nutarimai)
 *   - /lt/teisesaktai/lietuvos-banko-pozicijos-ir-gaires (gaires)
 *   - /lt/rekomendacijos                                  (rekomendacijos)
 *   - /lt/poveikio-priemones-2                            (enforcement)
 *
 * Pagination uses `?page=N` query parameters. Individual documents link
 * to detail pages or PDF downloads under /uploads/documents/.
 *
 * Because lb.lt returns HTTP 403 for bot-like User-Agents, the crawler
 * sends a browser-like UA header. All content is in Lithuanian, as
 * issued by Lietuvos bankas.
 *
 * Usage:
 *   npx tsx scripts/ingest-lb.ts                   # full crawl
 *   npx tsx scripts/ingest-lb.ts --resume           # resume from last checkpoint
 *   npx tsx scripts/ingest-lb.ts --dry-run          # log what would be inserted
 *   npx tsx scripts/ingest-lb.ts --force            # drop and recreate DB first
 *   npx tsx scripts/ingest-lb.ts --enforcement-only # only crawl enforcement actions
 *   npx tsx scripts/ingest-lb.ts --docs-only        # only crawl provisions
 */

import Database from "better-sqlite3";
import * as cheerio from "cheerio";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_PATH = process.env["LB_DB_PATH"] ?? "data/lb.db";
const PROGRESS_FILE = resolve(dirname(DB_PATH), "ingest-progress.json");
const BASE_URL = "https://www.lb.lt";

const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 2000;
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Browser-like UA — lb.lt returns 403 for bot-like agents.
 * Accept-Language set to Lithuanian to receive lt content.
 */
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";

// CLI flags
const args = process.argv.slice(2);
const force = args.includes("--force");
const dryRun = args.includes("--dry-run");
const resume = args.includes("--resume");
const enforcementOnly = args.includes("--enforcement-only");
const docsOnly = args.includes("--docs-only");

// ---------------------------------------------------------------------------
// Listing-page URLs
// ---------------------------------------------------------------------------

/** LB document listing pages — one per sourcebook category. */
const DOC_LISTING_PAGES: Array<{
  sourcebookId: string;
  basePath: string;
  label: string;
  maxPages: number;
}> = [
  {
    sourcebookId: "LB_NUTARIMAI",
    basePath: "/lt/teisesaktai/lietuvos-banko-valdybos-nutarimai",
    label: "Nutarimai (valdybos nutarimai)",
    maxPages: 100,
  },
  {
    sourcebookId: "LB_GAIRES",
    basePath: "/lt/teisesaktai/lietuvos-banko-pozicijos-ir-gaires",
    label: "Gaires (pozicijos ir gaires)",
    maxPages: 30,
  },
  {
    sourcebookId: "LB_REKOMENDACIJOS",
    basePath: "/lt/rekomendacijos",
    label: "Rekomendacijos",
    maxPages: 15,
  },
];

/** Enforcement listing — paginated list of supervisory sanctions. */
const ENFORCEMENT_BASE_PATH = "/lt/poveikio-priemones-2";
const ENFORCEMENT_MAX_PAGES = 30;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProvisionRow {
  sourcebook_id: string;
  reference: string;
  title: string;
  text: string;
  type: string;
  status: string;
  effective_date: string | null;
  chapter: string | null;
  section: string | null;
}

interface EnforcementRow {
  firm_name: string;
  reference_number: string | null;
  action_type: string;
  amount: number | null;
  date: string | null;
  summary: string;
  sourcebook_references: string | null;
}

interface DiscoveredDoc {
  sourcebookId: string;
  title: string;
  url: string;
  docId: string;
  type: string;
  date: string | null;
}

interface Progress {
  completed_doc_urls: string[];
  completed_enforcement_urls: string[];
  enforcement_last_page: number;
  doc_pages_completed: Record<string, number>;
  last_updated: string;
}

// ---------------------------------------------------------------------------
// Utility: rate-limited fetch with retry
// ---------------------------------------------------------------------------

let lastRequestTime = 0;

async function rateLimitedFetch(
  url: string,
  opts?: RequestInit,
): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      lastRequestTime = Date.now();
      const resp = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8",
          "Accept-Language": "lt-LT,lt;q=0.9,en;q=0.5",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        ...opts,
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${url}`);
      }
      return resp;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `  [bandymas ${attempt}/${MAX_RETRIES}] ${url}: ${lastError.message}`,
      );
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BACKOFF_MS * attempt);
      }
    }
  }
  throw lastError!;
}

async function fetchHtml(url: string): Promise<string> {
  const resp = await rateLimitedFetch(url);
  return resp.text();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Progress tracking
// ---------------------------------------------------------------------------

function loadProgress(): Progress {
  if (resume && existsSync(PROGRESS_FILE)) {
    try {
      const raw = readFileSync(PROGRESS_FILE, "utf-8");
      const p = JSON.parse(raw) as Progress;
      console.log(
        `Progreso failas ikeltas (${p.last_updated}): ` +
          `${p.completed_doc_urls.length} dokumentai, ` +
          `${p.completed_enforcement_urls.length} poveikio priemones`,
      );
      return p;
    } catch {
      console.warn(
        "Nepavyko perskaityti progreso failo, pradedama is naujo",
      );
    }
  }
  return {
    completed_doc_urls: [],
    completed_enforcement_urls: [],
    enforcement_last_page: 0,
    doc_pages_completed: {},
    last_updated: new Date().toISOString(),
  };
}

function saveProgress(progress: Progress): void {
  progress.last_updated = new Date().toISOString();
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

function initDatabase(): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`Esama duomenu baze istrinta: ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  console.log(`Duomenu baze inicializuota: ${DB_PATH}`);
  return db;
}

// ---------------------------------------------------------------------------
// Sourcebook definitions
// ---------------------------------------------------------------------------

interface SourcebookDef {
  id: string;
  name: string;
  description: string;
}

const SOURCEBOOKS: SourcebookDef[] = [
  {
    id: "LB_NUTARIMAI",
    name: "LB Nutarimai",
    description:
      "Lietuvos banko valdybos nutarimai — fintech licencijavimas, kapitalo reikalavimai, AML/CFT, mokejimo paslaugu ir kriptovaliutu reguliavimas.",
  },
  {
    id: "LB_GAIRES",
    name: "LB Gaires",
    description:
      "Lietuvos banko pozicijos ir gaires — prieziuros lukesciai, IT sauga, rizikos valdymas, ESG, valdysenos standartai ir operacinis atsparumas.",
  },
  {
    id: "LB_REKOMENDACIJOS",
    name: "LB Rekomendacijos",
    description:
      "Lietuvos banko rekomendacijos — gerosios prakties standartai, vartotoju apsauga, DI valdysena ir savanoriski atitikties vadovai.",
  },
];

// ---------------------------------------------------------------------------
// HTML parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extract a Lithuanian date string (e.g. "2023 m. kovo 15 d." or
 * "2023-03-15") and normalise to ISO YYYY-MM-DD.
 */
function parseLithuanianDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();

  // ISO format already
  const isoMatch = trimmed.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  // "YYYY m. <month> DD d." format
  const ltMonths: Record<string, string> = {
    sausio: "01",
    vasario: "02",
    kovo: "03",
    balandzio: "04",
    geguzes: "05",
    birzelio: "06",
    liepos: "07",
    rugpjucio: "08",
    rugsejo: "09",
    spalio: "10",
    lapkricio: "11",
    gruodzio: "12",
  };

  const ltMatch = trimmed.match(
    /(\d{4})\s*m\.\s*(\S+)\s*(\d{1,2})\s*d\./i,
  );
  if (ltMatch) {
    const year = ltMatch[1];
    const monthName = ltMatch[2].toLowerCase().replace(/ž/g, "z").replace(/ė/g, "e").replace(/ū/g, "u").replace(/į/g, "i");
    const day = ltMatch[3].padStart(2, "0");
    const month = ltMonths[monthName] ?? null;
    if (month) return `${year}-${month}-${day}`;
  }

  // "YYYY.MM.DD" or "DD.MM.YYYY" format
  const dotMatch = trimmed.match(/(\d{4})\.(\d{2})\.(\d{2})/);
  if (dotMatch) return `${dotMatch[1]}-${dotMatch[2]}-${dotMatch[3]}`;

  const dotMatchReverse = trimmed.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (dotMatchReverse)
    return `${dotMatchReverse[3]}-${dotMatchReverse[2]}-${dotMatchReverse[1]}`;

  // "YYYY-MM-DD" embedded somewhere
  const embedded = trimmed.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (embedded) {
    return `${embedded[1]}-${embedded[2].padStart(2, "0")}-${embedded[3].padStart(2, "0")}`;
  }

  return null;
}

/**
 * Determine document type from sourcebook ID.
 */
function typeForSourcebook(sourcebookId: string): string {
  switch (sourcebookId) {
    case "LB_NUTARIMAI":
      return "nutarimas";
    case "LB_GAIRES":
      return "gaires";
    case "LB_REKOMENDACIJOS":
      return "rekomendacija";
    default:
      return "dokumentas";
  }
}

/**
 * Extract a stable reference ID from a document title or URL.
 * LB documents often contain reference numbers like "Nr. 03-41",
 * "No. 2021/1", or dated identifiers.
 */
function extractReference(
  title: string,
  url: string,
  sourcebookId: string,
): string {
  // "Nr. XX-YYY" or "Nr. XXXX/YY" pattern
  const nrMatch = title.match(/Nr\.\s*(\S+)/i);
  if (nrMatch) return `LB ${nrMatch[1]}`;

  // Extract from URL slug
  const slug = url
    .replace(/\/$/, "")
    .split("/")
    .pop()
    ?.replace(/^(del-|apie-|lietuvos-banko-)/, "")
    ?? "";

  // Date-based reference for gaires/rekomendacijos
  const dateMatch = title.match(/(\d{4})/);
  if (dateMatch) {
    const prefix =
      sourcebookId === "LB_GAIRES"
        ? "LB gaires"
        : sourcebookId === "LB_REKOMENDACIJOS"
          ? "LB rekomendacija"
          : "LB nutarimas";
    // Use slug hash to avoid collisions
    const shortSlug = slug.slice(0, 30);
    return `${prefix} ${dateMatch[1]}/${shortSlug}`;
  }

  // Fallback: use slug
  const prefix =
    sourcebookId === "LB_NUTARIMAI"
      ? "LB nutarimas"
      : sourcebookId === "LB_GAIRES"
        ? "LB gaires"
        : "LB rekomendacija";
  return `${prefix} ${slug}`.slice(0, 120);
}

/**
 * Parse the main body text from an lb.lt detail page.
 * The site wraps article content in various container divs.
 */
function extractDetailText($: cheerio.CheerioAPI): string {
  // Remove non-content elements
  $(
    "nav, header, footer, .breadcrumb, .sidebar, .menu, script, style, " +
      ".social-share, .related-links, .cookie-banner, .header-container, " +
      ".footer-container, .page-header, noscript, iframe",
  ).remove();

  // Try specific content containers first (lb.lt patterns)
  const contentSelectors = [
    ".field--name-body",
    ".node__content",
    ".text-content",
    ".content-body",
    ".article-body",
    ".page-content .field",
    "article .content",
    ".main-content article",
    "main article",
    ".node--full .field--type-text-long",
    "#content .field",
  ];

  for (const selector of contentSelectors) {
    const el = $(selector);
    if (el.length > 0) {
      const text = el.text().replace(/\s+/g, " ").trim();
      if (text.length > 100) return text;
    }
  }

  // Fallback: main content area
  const mainEl = $("main").length > 0 ? $("main") : $(".main-content");
  if (mainEl.length > 0) {
    const text = mainEl.text().replace(/\s+/g, " ").trim();
    if (text.length > 100) return text;
  }

  // Last resort: entire body
  const body = $("body").text().replace(/\s+/g, " ").trim();
  return body;
}

/**
 * Extract chapter/section metadata from text or breadcrumbs.
 */
function extractChapterSection(
  text: string,
  $?: cheerio.CheerioAPI,
): { chapter: string | null; section: string | null } {
  let chapter: string | null = null;
  let section: string | null = null;

  // Look for Roman numeral chapters: "I skyrius", "II dalis"
  const chapterMatch = text.match(
    /\b(I{1,3}|IV|V|VI{0,3}|IX|X{0,3})\s+(skyrius|dalis|skirsnis)/i,
  );
  if (chapterMatch) chapter = chapterMatch[1];

  // Look for numbered sections: "1 straipsnis", "2.3 punktas"
  const sectionMatch = text.match(/(\d+(?:\.\d+)?)\s+(straipsnis|punktas)/i);
  if (sectionMatch) section = sectionMatch[1];

  // Try breadcrumb
  if ($ && !chapter) {
    const breadcrumb = $(".breadcrumb, .breadcrumbs, nav[aria-label='breadcrumb']")
      .text()
      .trim();
    const bcChapter = breadcrumb.match(
      /\b(I{1,3}|IV|V|VI{0,3}|IX|X{0,3})\s+(skyrius|dalis)/i,
    );
    if (bcChapter) chapter = bcChapter[1];
  }

  return { chapter, section };
}

// ---------------------------------------------------------------------------
// 1. Discover documents from paginated listing pages
// ---------------------------------------------------------------------------

/**
 * Detect whether a listing page has a next page.
 * lb.lt uses standard pagination with ?page=N params and
 * "Kitas" (Next) / "Paskutinis" (Last) links, or numbered page links.
 */
function hasNextPage($: cheerio.CheerioAPI, currentPage: number): boolean {
  // Check for "next" pagination link
  const nextLink = $('a[rel="next"], .pager__item--next a, .pagination .next a, a:contains("Kitas"), a:contains("›"), a:contains("»")');
  if (nextLink.length > 0) return true;

  // Check for numbered page links greater than current page
  const pageLinks = $(".pager a, .pagination a, .page-link");
  let hasHigher = false;
  pageLinks.each((_i, el) => {
    const href = $(el).attr("href") ?? "";
    const pageMatch = href.match(/[?&]page=(\d+)/);
    if (pageMatch && parseInt(pageMatch[1], 10) > currentPage) {
      hasHigher = true;
    }
  });

  return hasHigher;
}

/**
 * Scrape a single listing page and return discovered document links.
 */
function parseListingPage(
  $: cheerio.CheerioAPI,
  sourcebookId: string,
): DiscoveredDoc[] {
  const docs: DiscoveredDoc[] = [];
  const seen = new Set<string>();

  // lb.lt listing pages typically use <div> or <li> elements with links
  // Pattern 1: Document links in content area tables or lists
  const contentArea = $("main, .main-content, .view-content, .content, #content, .region-content");
  const linkContainer = contentArea.length > 0 ? contentArea : $("body");

  linkContainer.find("a[href]").each((_i, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    const fullUrl = href.startsWith("http")
      ? href
      : `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;

    // Skip non-lb.lt links, pagination, anchors, and static assets
    if (!fullUrl.startsWith(BASE_URL)) return;
    if (/[?&]page=/.test(fullUrl)) return;
    if (fullUrl.match(/\.(css|js|png|jpg|gif|svg|ico)$/i)) return;

    // Skip navigation, footer, breadcrumb, social links
    const parent = $(el).closest(
      "nav, footer, .breadcrumb, .menu, header, .social, .footer-container, .header-container",
    );
    if (parent.length > 0) return;

    const linkText = $(el).text().trim();
    if (linkText.length < 5) return;

    // Skip obvious non-document links
    if (
      /^(Pradzia|Kontaktai|Paieska|Privatumo|Slapukai|English|RSS|Ziniasklaidai|Naujienos$)/i.test(
        linkText,
      )
    )
      return;

    // Accept PDF downloads
    const isPdf = /\.pdf($|\?)/.test(fullUrl) || /uploads\/documents/.test(fullUrl);

    // Accept detail pages under /lt/ that look like regulation content
    const isDetailPage =
      fullUrl.includes("/lt/") &&
      (fullUrl.includes("del-") ||
        fullUrl.includes("apie-") ||
        fullUrl.includes("gaires") ||
        fullUrl.includes("rekomendacij") ||
        fullUrl.includes("nutarim") ||
        fullUrl.includes("reglament") ||
        fullUrl.includes("tvark") ||
        fullUrl.includes("taisykl"));

    // Accept links from structured document list containers
    const isInDocList =
      $(el).closest(".views-row, .item-list, table, .document-list, .teisesaktai-list, .field--name-field").length > 0;

    if (!isPdf && !isDetailPage && !isInDocList) return;

    // Deduplicate by URL
    const normalised = fullUrl.replace(/\/$/, "").replace(/\?.*$/, "");
    if (seen.has(normalised)) return;
    seen.add(normalised);

    // Extract date from surrounding context
    const parentText = $(el).parent().text();
    const date = parseLithuanianDate(parentText);

    // Build document ID from URL slug
    const slug = normalised.split("/").pop() ?? normalised;

    docs.push({
      sourcebookId,
      title: linkText,
      url: fullUrl,
      docId: slug,
      type: typeForSourcebook(sourcebookId),
      date,
    });
  });

  return docs;
}

/**
 * Crawl all pages of a document listing and return discovered documents.
 */
async function discoverDocuments(
  sourcebookId: string,
  basePath: string,
  label: string,
  maxPages: number,
  startPage: number,
): Promise<{ docs: DiscoveredDoc[]; pagesCompleted: number }> {
  console.log(`\n--- ${label}: dokumentu paieska ---`);
  const allDocs: DiscoveredDoc[] = [];
  let page = startPage;

  while (page <= maxPages) {
    const url =
      page === 1
        ? `${BASE_URL}${basePath}`
        : `${BASE_URL}${basePath}?page=${page}`;

    console.log(`  Puslapis ${page}: ${url}`);

    let html: string;
    try {
      html = await fetchHtml(url);
    } catch (err) {
      console.warn(
        `  Nepavyko gauti puslapio ${page}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // If page 1 fails, abort. Otherwise assume end of pagination.
      if (page === 1) throw err;
      break;
    }

    const $ = cheerio.load(html);
    const pageDocs = parseListingPage($, sourcebookId);
    console.log(`    Rasta dokumentu: ${pageDocs.length}`);
    allDocs.push(...pageDocs);

    // Check for next page
    if (pageDocs.length === 0 || !hasNextPage($, page)) {
      console.log(`  Paskutinis puslapis: ${page}`);
      break;
    }

    page++;
  }

  return { docs: allDocs, pagesCompleted: page };
}

// ---------------------------------------------------------------------------
// 2. Fetch and parse individual document detail pages
// ---------------------------------------------------------------------------

/**
 * Fetch a document detail page and extract provision data.
 */
async function fetchDocumentDetail(
  doc: DiscoveredDoc,
): Promise<ProvisionRow | null> {
  try {
    const html = await fetchHtml(doc.url);
    const $ = cheerio.load(html);

    // Extract title — prefer page <h1>, fall back to discovered title
    const pageTitle =
      $("h1").first().text().trim() ||
      $("title").text().replace(/\s*\|.*$/, "").trim() ||
      doc.title;

    // Extract main body text
    const text = extractDetailText($);
    if (text.length < 50) {
      console.warn(`    Per trumpas tekstas (${text.length} simb.): ${doc.url}`);
      return null;
    }

    // Extract chapter/section
    const { chapter, section } = extractChapterSection(text, $);

    // Extract or refine date
    let effectiveDate = doc.date;
    if (!effectiveDate) {
      // Look for date in meta tags
      const metaDate =
        $('meta[property="article:published_time"]').attr("content") ??
        $('meta[name="dcterms.date"]').attr("content") ??
        $('meta[name="date"]').attr("content") ??
        null;
      effectiveDate = parseLithuanianDate(metaDate);
    }
    if (!effectiveDate) {
      // Look for date pattern in visible text near the top
      const headerText = $("h1, .field--name-field-date, .date, .meta, .document-date")
        .text()
        .trim();
      effectiveDate = parseLithuanianDate(headerText);
    }

    // Build reference
    const reference = extractReference(pageTitle, doc.url, doc.sourcebookId);

    // Determine status — default in_force unless text suggests otherwise
    let status = "in_force";
    if (/netekus\w*\s+galios|negalioja|panaikint|atšaukt/i.test(text)) {
      status = "repealed";
    } else if (/pakeist|nauja\s+redakcij/i.test(text)) {
      status = "amended";
    }

    return {
      sourcebook_id: doc.sourcebookId,
      reference,
      title: pageTitle.slice(0, 500),
      text: text.slice(0, 50_000), // cap at 50K characters
      type: doc.type,
      status,
      effective_date: effectiveDate,
      chapter,
      section,
    };
  } catch (err) {
    console.warn(
      `    Nepavyko gauti dokumento: ${doc.url}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// 3. Crawl enforcement actions
// ---------------------------------------------------------------------------

/**
 * Parse the enforcement measures listing page.
 * lb.lt/lt/poveikio-priemones-2 lists enforcement actions as a table
 * or structured list with firm name, action type, date, and summary.
 */
function parseEnforcementListing(
  $: cheerio.CheerioAPI,
): Array<{ url: string; firmName: string; date: string | null }> {
  const entries: Array<{ url: string; firmName: string; date: string | null }> =
    [];
  const seen = new Set<string>();

  // Pattern 1: table rows
  $("table tbody tr, .views-table tbody tr").each((_i, el) => {
    const cells = $(el).find("td");
    if (cells.length < 2) return;

    const link = $(el).find("a[href]").first();
    const href = link.attr("href");
    if (!href) return;

    const fullUrl = href.startsWith("http")
      ? href
      : `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;
    if (seen.has(fullUrl)) return;
    seen.add(fullUrl);

    const firmName = link.text().trim() || cells.first().text().trim();
    const dateText = cells.last().text().trim();
    const date = parseLithuanianDate(dateText);

    if (firmName.length > 2) {
      entries.push({ url: fullUrl, firmName, date });
    }
  });

  // Pattern 2: list items with links (if not table layout)
  if (entries.length === 0) {
    const contentArea = $("main, .main-content, .view-content, #content");
    const container = contentArea.length > 0 ? contentArea : $("body");

    container.find(".views-row, .item-list li, .node--teaser, article").each(
      (_i, el) => {
        const link = $(el).find("a[href]").first();
        const href = link.attr("href");
        if (!href) return;

        const fullUrl = href.startsWith("http")
          ? href
          : `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;

        // Skip non-content links
        if (!fullUrl.startsWith(BASE_URL)) return;
        if (/[?&]page=/.test(fullUrl)) return;

        const parent = $(link).closest("nav, footer, .breadcrumb, .menu, header");
        if (parent.length > 0) return;

        if (seen.has(fullUrl)) return;
        seen.add(fullUrl);

        const firmName = link.text().trim();
        const parentText = $(el).text();
        const date = parseLithuanianDate(parentText);

        if (firmName.length > 3) {
          entries.push({ url: fullUrl, firmName, date });
        }
      },
    );
  }

  return entries;
}

/**
 * Fetch an individual enforcement action detail page and extract data.
 */
async function fetchEnforcementDetail(entry: {
  url: string;
  firmName: string;
  date: string | null;
}): Promise<EnforcementRow | null> {
  try {
    const html = await fetchHtml(entry.url);
    const $ = cheerio.load(html);

    // Extract title
    const title =
      $("h1").first().text().trim() ||
      $("title").text().replace(/\s*\|.*$/, "").trim();

    // Extract body text
    const text = extractDetailText($);
    if (text.length < 30) return null;

    // Determine action type from text/title
    let actionType = "kita"; // default: other
    const combinedText = `${title} ${text}`.toLowerCase();
    if (/baud|nuobaud|pinigin/i.test(combinedText)) {
      actionType = "bauda"; // fine
    } else if (/licencij\w+\s*(panaikin|atsaukt|atemt)/i.test(combinedText)) {
      actionType = "licencijos_panaikinimas"; // licence revocation
    } else if (/ispejim|perspejim/i.test(combinedText)) {
      actionType = "ispejimas"; // warning
    } else if (/ipareigojim|nurody/i.test(combinedText)) {
      actionType = "ipareigojimas"; // obligation/order
    } else if (/draudim|apribojim|sustabdy/i.test(combinedText)) {
      actionType = "draudimas"; // prohibition/restriction
    }

    // Extract fine amount
    let amount: number | null = null;
    // "XXX XXX EUR", "XXX,XXX EUR", "€XXX"
    const amountMatch = combinedText.match(
      /(\d[\d\s,.]*)\s*(?:eur|euru|\u20ac)/i,
    );
    if (amountMatch) {
      const cleaned = amountMatch[1].replace(/\s/g, "").replace(",", ".");
      const parsed = parseFloat(cleaned);
      if (!isNaN(parsed) && parsed > 0) {
        amount = parsed;
      }
    }

    // Extract reference number from text
    let referenceNumber: string | null = null;
    const refMatch = combinedText.match(
      /(?:sprendim\w*|nutarim\w*)\s*(?:Nr\.?\s*)?(\S+-\d{4}-\d+|\d{4}\/\d+|\S+-\d+)/i,
    );
    if (refMatch) {
      referenceNumber = refMatch[1].toUpperCase();
    }

    // Build reference number from URL if not found in text
    if (!referenceNumber) {
      const slug = entry.url.replace(/\/$/, "").split("/").pop() ?? "";
      referenceNumber = `LB-ENF-${slug}`.slice(0, 60);
    }

    // Extract date (prefer page metadata over listing date)
    let date = entry.date;
    if (!date) {
      const metaDate =
        $('meta[property="article:published_time"]').attr("content") ??
        $('meta[name="date"]').attr("content") ??
        null;
      date = parseLithuanianDate(metaDate);
    }
    if (!date) {
      const dateInText = text.match(
        /(\d{4})\s*m\.\s*\S+\s*(\d{1,2})\s*d\./,
      );
      if (dateInText) date = parseLithuanianDate(dateInText[0]);
    }

    // Extract sourcebook references mentioned in the text
    const lbRefs: string[] = [];
    const nutarimoRefs = text.matchAll(/LB\s+nutarim\w*\s+(\S+)/gi);
    for (const m of nutarimoRefs) lbRefs.push(`LB nutarimas ${m[1]}`);
    const gairesRefs = text.matchAll(/LB\s+gair\w*\s+(\S+)/gi);
    for (const m of gairesRefs) lbRefs.push(`LB gaires ${m[1]}`);

    const summary = text.slice(0, 2000);

    return {
      firm_name: entry.firmName || title,
      reference_number: referenceNumber,
      action_type: actionType,
      amount,
      date,
      summary,
      sourcebook_references: lbRefs.length > 0 ? lbRefs.join(", ") : null,
    };
  } catch (err) {
    console.warn(
      `    Nepavyko gauti poveikio priemones: ${entry.url}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// 4. Database insertion
// ---------------------------------------------------------------------------

function insertSourcebooks(db: Database.Database): void {
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO sourcebooks (id, name, description) VALUES (?, ?, ?)",
  );
  const insertAll = db.transaction(() => {
    for (const sb of SOURCEBOOKS) {
      stmt.run(sb.id, sb.name, sb.description);
    }
  });
  insertAll();
  console.log(`Saltiniai irasyti: ${SOURCEBOOKS.length}`);
}

function insertProvision(db: Database.Database, p: ProvisionRow): void {
  db.prepare(
    `INSERT INTO provisions
       (sourcebook_id, reference, title, text, type, status, effective_date, chapter, section)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    p.sourcebook_id,
    p.reference,
    p.title,
    p.text,
    p.type,
    p.status,
    p.effective_date,
    p.chapter,
    p.section,
  );
}

function insertEnforcement(db: Database.Database, e: EnforcementRow): void {
  db.prepare(
    `INSERT INTO enforcement_actions
       (firm_name, reference_number, action_type, amount, date, summary, sourcebook_references)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.firm_name,
    e.reference_number,
    e.action_type,
    e.amount,
    e.date,
    e.summary,
    e.sourcebook_references,
  );
}

/**
 * Check whether a provision reference already exists (for resume support).
 */
function provisionExists(db: Database.Database, reference: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM provisions WHERE reference = ? LIMIT 1")
    .get(reference);
  return row !== undefined;
}

/**
 * Check whether an enforcement reference already exists.
 */
function enforcementExists(
  db: Database.Database,
  referenceNumber: string,
): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM enforcement_actions WHERE reference_number = ? LIMIT 1",
    )
    .get(referenceNumber);
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// 5. Main crawl orchestration
// ---------------------------------------------------------------------------

async function crawlDocuments(
  db: Database.Database,
  progress: Progress,
): Promise<{ provisionsInserted: number; errors: number }> {
  let provisionsInserted = 0;
  let errors = 0;

  for (const listing of DOC_LISTING_PAGES) {
    const startPage =
      resume && progress.doc_pages_completed[listing.sourcebookId]
        ? progress.doc_pages_completed[listing.sourcebookId] + 1
        : 1;

    // If resuming and already completed all pages, skip
    if (resume && startPage > listing.maxPages) {
      console.log(`  ${listing.label}: jau apdorota, praleidziama`);
      continue;
    }

    const { docs, pagesCompleted } = await discoverDocuments(
      listing.sourcebookId,
      listing.basePath,
      listing.label,
      listing.maxPages,
      startPage,
    );

    progress.doc_pages_completed[listing.sourcebookId] = pagesCompleted;

    console.log(`  Rasta is viso: ${docs.length} dokumentai`);

    for (const doc of docs) {
      // Skip if already processed
      if (resume && progress.completed_doc_urls.includes(doc.url)) {
        continue;
      }

      console.log(`  Gaunamas: ${doc.title.slice(0, 80)}...`);
      const provision = await fetchDocumentDetail(doc);

      if (provision) {
        // Skip duplicates in DB
        if (provisionExists(db, provision.reference)) {
          console.log(`    Jau yra DB, praleidziama: ${provision.reference}`);
          progress.completed_doc_urls.push(doc.url);
          continue;
        }

        if (dryRun) {
          console.log(
            `    [dry-run] Butu irasytas: ${provision.reference} — ${provision.title?.slice(0, 60)}`,
          );
        } else {
          try {
            insertProvision(db, provision);
            provisionsInserted++;
            console.log(
              `    Irasytas: ${provision.reference} (${provision.text.length} simb.)`,
            );
          } catch (err) {
            errors++;
            console.warn(
              `    Irasymo klaida: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      } else {
        errors++;
      }

      progress.completed_doc_urls.push(doc.url);

      // Save progress periodically
      if (progress.completed_doc_urls.length % 10 === 0) {
        saveProgress(progress);
      }
    }

    saveProgress(progress);
  }

  return { provisionsInserted, errors };
}

async function crawlEnforcement(
  db: Database.Database,
  progress: Progress,
): Promise<{ enforcementInserted: number; errors: number }> {
  console.log("\n--- Poveikio priemones: paieska ---");

  let enforcementInserted = 0;
  let errors = 0;
  const startPage =
    resume && progress.enforcement_last_page > 0
      ? progress.enforcement_last_page + 1
      : 1;

  let page = startPage;

  while (page <= ENFORCEMENT_MAX_PAGES) {
    const url =
      page === 1
        ? `${BASE_URL}${ENFORCEMENT_BASE_PATH}`
        : `${BASE_URL}${ENFORCEMENT_BASE_PATH}?page=${page}`;

    console.log(`  Puslapis ${page}: ${url}`);

    let html: string;
    try {
      html = await fetchHtml(url);
    } catch (err) {
      console.warn(
        `  Nepavyko gauti puslapio ${page}: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (page === 1) throw err;
      break;
    }

    const $ = cheerio.load(html);
    const entries = parseEnforcementListing($);

    console.log(`    Rasta irasu: ${entries.length}`);

    if (entries.length === 0) {
      console.log(`  Paskutinis puslapis: ${page}`);
      break;
    }

    for (const entry of entries) {
      // Skip if already processed
      if (resume && progress.completed_enforcement_urls.includes(entry.url)) {
        continue;
      }

      console.log(`  Gaunamas: ${entry.firmName.slice(0, 60)}...`);
      const enforcement = await fetchEnforcementDetail(entry);

      if (enforcement) {
        // Skip duplicates
        if (
          enforcement.reference_number &&
          enforcementExists(db, enforcement.reference_number)
        ) {
          console.log(
            `    Jau yra DB, praleidziama: ${enforcement.reference_number}`,
          );
          progress.completed_enforcement_urls.push(entry.url);
          continue;
        }

        if (dryRun) {
          console.log(
            `    [dry-run] Butu irasytas: ${enforcement.firm_name} — ${enforcement.action_type} — ${enforcement.amount ?? "n/a"} EUR`,
          );
        } else {
          try {
            insertEnforcement(db, enforcement);
            enforcementInserted++;
            console.log(
              `    Irasytas: ${enforcement.firm_name} (${enforcement.action_type}, ${enforcement.amount ?? "n/a"} EUR)`,
            );
          } catch (err) {
            errors++;
            console.warn(
              `    Irasymo klaida: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      } else {
        errors++;
      }

      progress.completed_enforcement_urls.push(entry.url);
    }

    progress.enforcement_last_page = page;
    saveProgress(progress);

    // Check for next page
    if (!hasNextPage($, page)) {
      console.log(`  Paskutinis puslapis: ${page}`);
      break;
    }

    page++;
  }

  return { enforcementInserted, errors };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== Lietuvos banko duomenu nuskaitymo programa ===");
  console.log(`  Duomenu baze: ${DB_PATH}`);
  console.log(`  Rezimai: ${[
    force && "--force",
    dryRun && "--dry-run",
    resume && "--resume",
    enforcementOnly && "--enforcement-only",
    docsOnly && "--docs-only",
  ]
    .filter(Boolean)
    .join(" ") || "(pilnas nuskaitymas)"}`);
  console.log(`  Greicio limitas: ${RATE_LIMIT_MS} ms tarp uzklausu`);
  console.log();

  const db = dryRun ? null : initDatabase();
  if (db && !dryRun) {
    insertSourcebooks(db);
  }

  const progress = loadProgress();
  let totalProvisions = 0;
  let totalEnforcement = 0;
  let totalErrors = 0;

  // Crawl provisions (nutarimai, gaires, rekomendacijos)
  if (!enforcementOnly) {
    const dummyDb = db ?? initDatabase(); // dry-run still needs a DB for exists checks
    const { provisionsInserted, errors } = await crawlDocuments(
      dummyDb,
      progress,
    );
    totalProvisions = provisionsInserted;
    totalErrors += errors;
    if (dryRun && dummyDb !== db) dummyDb.close();
  }

  // Crawl enforcement actions
  if (!docsOnly) {
    const dummyDb = db ?? initDatabase();
    const { enforcementInserted, errors } = await crawlEnforcement(
      dummyDb,
      progress,
    );
    totalEnforcement = enforcementInserted;
    totalErrors += errors;
    if (dryRun && dummyDb !== db) dummyDb.close();
  }

  // Save final progress
  saveProgress(progress);

  // Print summary
  if (db && !dryRun) {
    const provisionCount = (
      db.prepare("SELECT count(*) as cnt FROM provisions").get() as {
        cnt: number;
      }
    ).cnt;
    const sourcebookCount = (
      db.prepare("SELECT count(*) as cnt FROM sourcebooks").get() as {
        cnt: number;
      }
    ).cnt;
    const enforcementCount = (
      db.prepare("SELECT count(*) as cnt FROM enforcement_actions").get() as {
        cnt: number;
      }
    ).cnt;
    const ftsCount = (
      db.prepare("SELECT count(*) as cnt FROM provisions_fts").get() as {
        cnt: number;
      }
    ).cnt;

    console.log("\n=== Duomenu bazes suvestine ===");
    console.log(`  Saltiniai:             ${sourcebookCount}`);
    console.log(`  Nuostatos:             ${provisionCount} (+${totalProvisions} naujos)`);
    console.log(`  Poveikio priemones:    ${enforcementCount} (+${totalEnforcement} naujos)`);
    console.log(`  FTS irasu:             ${ftsCount}`);
    console.log(`  Klaidos:               ${totalErrors}`);

    db.close();
  } else {
    console.log("\n=== Dry-run suvestine ===");
    console.log(`  Butu irasytu nuostatu:          ${totalProvisions}`);
    console.log(`  Butu irasytu poveikio priemoniu: ${totalEnforcement}`);
    console.log(`  Klaidos:                         ${totalErrors}`);
  }

  console.log(`\nProgreso failas: ${PROGRESS_FILE}`);
  console.log("Baigta.");
}

main().catch((err) => {
  console.error("Fatali klaida:", err);
  process.exit(1);
});
