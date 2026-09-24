import { normalizeDomain } from "@/src/domain/suppression";
import type { SizeBand } from "@/src/domain/types";
import type { LeadCandidate, LeadSource } from "@/src/ports/lead-source";

/**
 * CSV adapter: a pasted or uploaded Sales Navigator / Apollo export becomes candidates.
 * This is the manual path section 12 keeps for the free-first plan, so the parser has to
 * tolerate what those exports actually contain: a BOM, CRLF, quoted fields with embedded
 * commas and newlines, and headers that change between vendors.
 *
 * Parsing is code, never a model call: one row in, one candidate out, and nothing here
 * touches the database or the network.
 */

export interface CsvSourceOptions {
  /** Shown as `csv:<label>` in `companies.source` / `contacts.source`, e.g. the list name. */
  label?: string;
}

export const CSV_FIELDS = [
  "fullName",
  "firstName",
  "lastName",
  "title",
  "companyName",
  "companyDomain",
  "linkedinUrl",
  "email",
  "country",
  "employees",
  "industry",
] as const;

export type CsvField = (typeof CSV_FIELDS)[number];

/** Case-insensitive aliases seen in Sales Navigator, Apollo and generic exports. */
const CSV_ALIASES: Record<CsvField, string[]> = {
  fullName: ["full name", "fullname", "name", "person name", "contact name", "lead name"],
  firstName: ["first name", "firstname", "given name"],
  lastName: ["last name", "lastname", "family name", "surname"],
  title: ["title", "job title", "position", "role", "current title"],
  companyName: ["company", "company name", "organization", "organization name", "employer", "account name"],
  companyDomain: [
    "company domain",
    "company domain name",
    "domain",
    "primary domain",
    "company website",
    "website",
    "company url",
  ],
  linkedinUrl: ["linkedin url", "linkedin", "linkedin profile", "linkedin profile url", "person linkedin url", "profile url"],
  email: ["email", "email address", "work email", "e mail", "email 1"],
  country: ["country", "country region", "company country"],
  employees: [
    "employees",
    "employee count",
    "company size",
    "company employee count",
    "headcount",
    "num employees",
    "number of employees",
  ],
  industry: ["industry", "company industry", "sector"],
};

export function createCsvSource(csvText: string, options: CsvSourceOptions = {}): LeadSource {
  const source = options.label ? `csv:${options.label}` : "csv";

  return {
    name: "csv",
    searchesPerCall: 0,
    async search(input) {
      const rows = parseCsv(csvText);
      const [header, ...body] = rows;
      if (!header) return [];
      const columns = mapColumns(header);
      const candidates: LeadCandidate[] = [];

      for (const row of body) {
        if (candidates.length >= input.limit) break;
        const candidate = rowToCandidate(header, columns, row, source);
        if (!candidate) continue;
        if (candidate.companyDomain && input.excludeDomains.includes(candidate.companyDomain)) continue;
        candidates.push(candidate);
      }

      return candidates;
    },
  };
}

/**
 * RFC-4180-ish parser: handles a BOM, CRLF, quoted fields, escaped quotes and
 * newlines inside quotes. Returns rows of raw cell values, dropping empty lines.
 */
export function parseCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source.charAt(i);

    if (inQuotes) {
      if (char === '"') {
        if (source.charAt(i + 1) === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && source.charAt(i + 1) === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += char;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((cells) => cells.some((cell) => cell.trim().length > 0));
}

/** Maps normalised header names to column indexes. First match wins, so no ambiguity. */
export function mapColumns(header: string[]): Partial<Record<CsvField, number>> {
  const columns: Partial<Record<CsvField, number>> = {};

  header.forEach((rawHeader, index) => {
    const normalized = normalizeHeader(rawHeader);
    if (!normalized) return;
    for (const field of CSV_FIELDS) {
      if (columns[field] !== undefined) continue;
      if (CSV_ALIASES[field].includes(normalized)) {
        columns[field] = index;
        return;
      }
    }
  });

  return columns;
}

/**
 * Employees come as "51-200", "1,000+", "250" or "10001+". The band comes from the
 * lower bound, which is what Apollo and Sales Navigator call the company size.
 */
export function sizeBandFromEmployees(value: string | null): SizeBand | null {
  if (!value) return null;
  const compact = value.replace(/[,\s]/g, "");
  const range = /(\d+)[-–](\d+)/.exec(compact);
  const numeric = range ? Number(range[1]) : Number(compact.replace(/[^0-9]/g, ""));
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  if (numeric <= 10) return "1-10";
  if (numeric <= 50) return "11-50";
  if (numeric <= 200) return "51-200";
  if (numeric <= 1000) return "201-1000";
  return "1000+";
}

function rowToCandidate(
  header: string[],
  columns: Partial<Record<CsvField, number>>,
  row: string[],
  source: string,
): LeadCandidate | null {
  const get = (field: CsvField): string => {
    const index = columns[field];
    if (index === undefined) return "";
    return (row[index] ?? "").trim();
  };

  const fullName = get("fullName") || [get("firstName"), get("lastName")].filter((part) => part.length > 0).join(" ");
  if (!fullName) return null;

  const raw: Record<string, unknown> = {};
  header.forEach((name, index) => {
    const value = (row[index] ?? "").trim();
    if (name.trim().length > 0 && value.length > 0) raw[name.trim()] = value;
  });

  return {
    fullName,
    title: get("title") || null,
    companyName: get("companyName") || null,
    companyDomain: domainFromCell(get("companyDomain")),
    companyLinkedinUrl: null,
    companyIndustry: get("industry") || null,
    companySizeBand: sizeBandFromEmployees(get("employees") || null),
    companyCountry: get("country") || null,
    linkedinUrl: linkedinFromCell(get("linkedinUrl")),
    email: emailFromCell(get("email")),
    source,
    raw,
  };
}

function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function domainFromCell(value: string): string | null {
  if (!value) return null;
  const domain = normalizeDomain(value);
  return domain.includes(".") ? domain : null;
}

function linkedinFromCell(value: string): string | null {
  if (!value) return null;
  const match = /linkedin\.com\/(?:in|pub)\/[^/?#\s]+/i.exec(value);
  if (!match) return null;
  return value.startsWith("http") ? value.split(/[?#]/)[0] ?? value : `https://${match[0]}`;
}

function emailFromCell(value: string): string | null {
  if (!value) return null;
  const email = value.toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}
