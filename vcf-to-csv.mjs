// vcf-to-csv.mjs
import fs from "fs";
import path from "path";
import iconv from "iconv-lite";
import qp from "quoted-printable";

const INCLUDE_BINARY = false; // set true to include base64 fields (PHOTO, LOGO) as data URLs (can explode your CSV)

// ---------- helpers ----------
function unfoldLines(text) {
  // Join folded lines (continuations begin with space or tab)
  const raw = text.split(/\r?\n/);
  const lines = [];
  for (const line of raw) {
    if (/^[ \t]/.test(line) && lines.length) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

function decodeValue(value, params = "") {
  let decoded = value ?? "";

  if (/QUOTED-PRINTABLE/i.test(params)) {
    decoded = qp.decode(decoded);
  } else if (/BASE64/i.test(params) || /;ENCODING=B/i.test(params)) {
    // Some vCards put the base64 value on the same line, others break lines. We assume it's already unfolded.
    try {
      decoded = Buffer.from(decoded, "base64").toString("utf8");
    } catch {
      // leave as-is
    }
  }

  const charsetMatch = params.match(/CHARSET=([^;]+)/i);
  if (charsetMatch) {
    const charset = charsetMatch[1].trim();
    if (charset && !/^utf-8$/i.test(charset)) {
      decoded = iconv.decode(Buffer.from(decoded, "binary"), charset);
    }
  }

  // Normalize newlines inside field values and trim
  decoded = String(decoded).replace(/\r?\n|\r/g, " ").trim();
  return decoded;
}

// Parse a content line like "item1.EMAIL;type=HOME;TYPE=internet:foo@bar"
function parseContentLine(line) {
  // Split group.prop;params:value
  // Group (optional) is before the first dot when present.
  const [lhs, ...rhsParts] = line.split(":");
  if (!lhs || rhsParts.length === 0) return null;
  const value = rhsParts.join(":"); // in case colon appears in value

  // Extract group and key (property)
  let group = "";
  let keyAndParams = lhs;
  if (lhs.includes(".")) {
    const idx = lhs.indexOf(".");
    group = lhs.slice(0, idx);
    keyAndParams = lhs.slice(idx + 1);
  }

  // KEY(;param=...;param=...)?
  const m = keyAndParams.match(/^([^;]+)(;.*)?$/);
  if (!m) return null;
  const key = m[1].toUpperCase();
  const paramsStr = m[2] || "";

  // Build params map; TYPE can appear multiple times / comma-separated
  const params = {};
  paramsStr
    .split(";")
    .filter(Boolean)
    .forEach(pair => {
      const [kRaw, vRaw = ""] = pair.split("=");
      const k = kRaw.trim().toUpperCase();
      const v = vRaw.trim();
      if (!k) return;
      if (k === "TYPE") {
        // TYPE may contain comma-separated values
        const vals = v.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
        params.TYPE = (params.TYPE || []).concat(vals);
      } else {
        params[k] = v;
      }
    });

  return { group, key, paramsStr: paramsStr, params, rawValue: value };
}

function normalizeDate(s) {
  // Accept YYYYMMDD, YYYY-MM-DD, YYYYMMDDThhmmssZ, etc. Return 'YYYY-MM-DD' if possible.
  if (!s) return "";
  const m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return s; // fallback
}

function adrToString(value) {
  // ADR is semicolon-separated: PO Box;Extended;Street;City;Region;PostalCode;Country
  // Keep it human-readable single field
  const parts = value.split(";").map(x => x.trim()).filter(x => x);
  return parts.join(", ");
}

function nToParts(value) {
  // N is semicolon-separated: Family;Given;Additional;Prefix;Suffix
  const [family = "", given = "", additional = "", prefix = "", suffix = ""] = value.split(";");
  return { Name_Family: family, Name_Given: given, Name_Additional: additional, Name_Prefix: prefix, Name_Suffix: suffix };
}

function isBinaryKey(key) {
  return ["PHOTO", "LOGO", "SOUND", "KEY"].includes(key);
}

function labelFromParams(key, params) {
  // Build a suffix like "_cell", "_work", "_home"; default to "_default"
  const types = (params.TYPE || []).map(t => t.toLowerCase());
  if (types.length) return `_${types.join("-")}`;
  // Some exports encode kind in other params (e.g., PREF, VOICE); ignore for label
  return "_default";
}

// Merge a value into contact row at named column, joining if already present
function mergeField(row, col, val) {
  if (!val) return;
  if (!row[col]) row[col] = val;
  else if (!String(row[col]).includes(val)) row[col] = `${row[col]}; ${val}`;
}

// ---------- main parsing ----------
export function parseVCF(content) {
  const contacts = [];
  // Split on VCARD boundaries
  const split = content.split(/BEGIN:VCARD/i);
  for (const chunk of split) {
    if (!/END:VCARD/i.test(chunk)) continue;
    const cardText = chunk.split(/END:VCARD/i)[0];
    const lines = unfoldLines(cardText).filter(Boolean);

    const row = {};
    for (const line of lines) {
      const cl = parseContentLine(line);
      if (!cl) continue;

      const { key, paramsStr, params, rawValue } = cl;

      // Decode field value respecting encoding/charset
      let value = decodeValue(rawValue, paramsStr || "");

      // Skip binaries unless enabled
      if (isBinaryKey(key) && !INCLUDE_BINARY) continue;

      switch (key) {
        case "FN":
          mergeField(row, "Full_Name", value);
          break;
        case "N": {
          const parts = nToParts(value);
          Object.entries(parts).forEach(([k, v]) => mergeField(row, k, v));
          // Also provide a single combined "Name" if FN missing
          if (!row.Full_Name) {
            const fallback = [parts.Name_Prefix, parts.Name_Given, parts.Name_Additional, parts.Name_Family, parts.Name_Suffix]
              .filter(Boolean)
              .join(" ")
              .replace(/\s+/g, " ")
              .trim();
            if (fallback) row.Full_Name = fallback;
          }
          break;
        }
        case "NICKNAME":
          mergeField(row, "Nickname", value.replace(/,/g, "; "));
          break;
        case "ORG":
          // ORG may be semicolon-separated hierarchy
          mergeField(row, "Organization", value.replace(/;/g, " / "));
          break;
        case "TITLE":
          mergeField(row, "Title", value);
          break;
        case "ROLE":
          mergeField(row, "Role", value);
          break;
        case "NOTE":
          mergeField(row, "Note", value);
          break;
        case "URL": {
          const label = labelFromParams(key, params);
          mergeField(row, `URL${label}`, value);
          break;
        }
        case "TEL": {
          const label = labelFromParams(key, params);
          mergeField(row, `TEL${label}`, value);
          break;
        }
        case "EMAIL": {
          const label = labelFromParams(key, params);
          mergeField(row, `EMAIL${label}`, value);
          break;
        }
        case "ADR": {
          const label = labelFromParams(key, params);
          mergeField(row, `ADR${label}`, adrToString(value));
          break;
        }
        case "BDAY":
          mergeField(row, "Birthday", normalizeDate(value));
          break;
        case "ANNIVERSARY":
          mergeField(row, "Anniversary", normalizeDate(value));
          break;
        case "CATEGORIES":
          mergeField(row, "Categories", value.replace(/,/g, "; "));
          break;
        case "IMPP":
          // instant messaging URI
          mergeField(row, "IMPP", value);
          break;
        case "GENDER":
          mergeField(row, "Gender", value);
          break;
        case "TZ":
          mergeField(row, "Timezone", value);
          break;
        case "REV":
          mergeField(row, "Last_Updated", value);
          break;
        case "X-ABSHOWAS":
        case "X-ABUID":
        case "X-ABRELATEDNAMES":
        case "X-SOCIALPROFILE":
        case "X-ANDROID-CUSTOM":
        default: {
          // Catch-all: include any unknown or X- extension keys
          // Normalize key to a safe column name
          const base = key.replace(/[^A-Z0-9_-]/gi, "_").toUpperCase();
          const label = labelFromParams(key, params);
          const col = isBinaryKey(key) ? base : `${base}${label}`;
          mergeField(row, col, value);
          break;
        }
      }
    }

    // Only push rows that have at least one value
    if (Object.keys(row).length) contacts.push(row);
  }
  return contacts;
}

export function toCSV(rows) {
  if (!rows.length) return "Full_Name\n"; // empty CSV with header
  // Determine columns: prioritize common ones, then everything else alpha-sorted
  const allCols = new Set();
  rows.forEach(r => Object.keys(r).forEach(k => allCols.add(k)));
  const preferred = [
    "Full_Name",
    "Name_Prefix",
    "Name_Given",
    "Name_Additional",
    "Name_Family",
    "Name_Suffix",
    "Nickname",
    "Title",
    "Role",
    "Organization",
    "Birthday",
    "Anniversary",
    "Categories",
    "Note",
  ];
  const remaining = [...allCols].filter(c => !preferred.includes(c)).sort();
  const headers = [...preferred.filter(c => allCols.has(c)), ...remaining];

  const escape = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [
    headers.join(","),
    ...rows.map(r => headers.map(h => escape(r[h] ?? "")).join(",")),
  ];
  return lines.join("\n");
}

// Ensure output file path is unique: name.csv, name (1).csv, name (2).csv, ...
function uniqueCsvPath(basePath) {
  const dir = path.dirname(basePath);
  const ext = path.extname(basePath) || ".csv";
  const base = path.basename(basePath, ext);
  let candidate = path.join(dir, `${base}${ext}`);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
    i += 1;
  }
  return candidate;
}

export function convertVCFtoCSV(inputFile, outputFile) {
  if (!fs.existsSync(inputFile)) {
    console.error(`❌ Input file not found: ${inputFile}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(inputFile);
  const vcfContent = raw.toString("utf8"); // per-field decoding handles charsets/encodings
  const contacts = parseVCF(vcfContent);
  const csv = toCSV(contacts);

  // Default output: same dir, same basename, .csv
  let outPath = outputFile;
  if (!outPath) {
    const dir = path.dirname(inputFile);
    const base = path.basename(inputFile, path.extname(inputFile));
    outPath = path.join(dir, `${base}.csv`);
  }
  outPath = uniqueCsvPath(outPath);

  fs.writeFileSync(outPath, csv, "utf8");
  console.log(`✅ ${contacts.length} contact(s) written to:\n${outPath}`);
}

// CLI usage:
//   node vcf-to-csv.mjs input.vcf
//   node vcf-to-csv.mjs input.vcf explicit-output.csv
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , inputFile, outputFile] = process.argv;
  if (!inputFile) {
    console.error("Usage: node vcf-to-csv.mjs <input.vcf> [output.csv]");
    process.exit(1);
  }
  convertVCFtoCSV(inputFile, outputFile);
}
