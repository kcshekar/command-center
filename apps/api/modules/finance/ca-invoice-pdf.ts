import puppeteer from "puppeteer-core";
import { amountInWords } from "./number-to-words";

const TEMPLATE = await Bun.file(new URL("./ca-invoice-template.html", import.meta.url)).text();

// ponytail: hardcoded to the one company/client this app invoices today —
// revisit if a second client or issuing entity is ever needed.
const SERVICE_DESCRIPTION_PREFIX = "UI /UX design, website design , platform UI/UX design (for services rendered in ";

const MONTH_ABBR = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const MONTH_NAME = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export function invoiceNumberFor(date: Date, sequenceForDay: number): string {
  const yyyy = date.getUTCFullYear();
  const mmm = MONTH_ABBR[date.getUTCMonth()];
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const seq = String(sequenceForDay).padStart(2, "0");
  return `PMT${yyyy}${mmm}${dd}${seq}`;
}

function formatAmount(amountCents: number): string {
  const value = (amountCents / 100).toFixed(2);
  const [whole, decimals] = value.split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${decimals}`;
}

function formatInvoiceDate(date: Date): string {
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${date.getUTCFullYear()}`;
}

// The service-period month is the month before the invoice date, matching
// how the sample template read "(for services rendered in dec 2025)" for a
// January-dated invoice.
function serviceMonthLabel(invoiceDate: Date): string {
  const d = new Date(Date.UTC(invoiceDate.getUTCFullYear(), invoiceDate.getUTCMonth() - 1, 1));
  return `${MONTH_NAME[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export interface InvoiceFields {
  invoiceNumber: string;
  invoiceDate: Date;
  amountCents: number;
  currency: string;
}

export async function renderInvoicePdf(fields: InvoiceFields): Promise<Buffer> {
  const amount = formatAmount(fields.amountCents);
  const html = TEMPLATE.replaceAll("{{INVOICE_NUMBER}}", fields.invoiceNumber)
    .replaceAll("{{INVOICE_DATE}}", formatInvoiceDate(fields.invoiceDate))
    .replaceAll("{{CURRENCY}}", fields.currency)
    .replaceAll("{{SERVICE_DESCRIPTION}}", `${SERVICE_DESCRIPTION_PREFIX}${serviceMonthLabel(fields.invoiceDate)})`)
    .replaceAll("{{AMOUNT_WORDS}}", amountInWords(fields.amountCents, fields.currency))
    .replaceAll("{{AMOUNT}}", amount);

  const executablePath = process.env.CHROME_PATH;
  if (!executablePath) throw new Error("CHROME_PATH not configured");
  // --no-sandbox is required when this runs as root in a container (Chromium
  // refuses the sandbox otherwise) — safe here since the page content is
  // always our own generated HTML, never third-party/untrusted input.
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const pdf = await page.pdf({ format: "A4", printBackground: true, landscape: true, scale: 0.85 });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
