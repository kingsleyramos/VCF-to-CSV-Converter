# VCF to CSV Converter

Convert `.vcf` (vCard) files into `.csv` format using Node.js.
Supports common vCard fields (name, phone, email, address, organization, etc.), including multiple values and labels. Handles quoted-printable, base64, and different charsets.

## Features

* Converts **all major vCard fields** into CSV columns.
* Handles **multiple phones, emails, addresses** (separate columns by label).
* Automatically **decodes encodings** (quoted-printable, base64, charset).
* Saves the CSV file **next to the input `.vcf`** by default.
* Prevents overwriting: appends `(1)`, `(2)`, etc. if the file already exists.
* Works as both a **CLI tool** and an **importable module**.

## Requirements

* Node.js 14+
* Dependencies:

  ```bash
  npm install iconv-lite quoted-printable
  ```

## Usage

### CLI

```bash
# Default: saves CSV in the same folder as input
node vcf-to-csv.mjs contacts.vcf

# Explicit output path
node vcf-to-csv.mjs contacts.vcf output.csv
```

Result:

```
✅ 245 contact(s) written to:
./contacts.csv
```

If `contacts.csv` already exists, it will create `contacts (1).csv`, `contacts (2).csv`, etc.

### As a Module

```js
import { parseVCF, toCSV, convertVCFtoCSV } from "./vcf-to-csv.mjs";

const vcfContent = fs.readFileSync("contacts.vcf", "utf8");
const contacts = parseVCF(vcfContent);
console.log(contacts); // JSON array of contact objects

const csv = toCSV(contacts);
fs.writeFileSync("contacts.csv", csv);
```

## Output

* Each row = one contact.
* Multiple values (e.g. work + home phone) appear in separate columns like:

  * `TEL_cell`, `TEL_work`, `EMAIL_home`, etc.
* Unknown or custom fields (`X-...`) are included as their own columns.

## Notes

* Binary fields (like photos) are ignored by default.
  You can toggle this inside the script (`INCLUDE_BINARY = true`).
* Dates (`BDAY`, `ANNIVERSARY`) are normalized to `YYYY-MM-DD` when possible.