import ExcelJS from "exceljs";
import QRCode from "qrcode";

/**
 * HANDING OUT THE LINKS (§24).
 *
 * A respondent list is only useful once each person's link is out of the
 * database and in front of them, which in practice means one of three
 * things, in this order of how often it actually happens:
 *
 *   a SPREADSHEET the team mail-merges from, or sends to the client to send
 *   a CSV a mailing tool imports
 *   a QR CODE, for a link that has to be printed, shown on a screen, or put
 *     on a receipt — the one case where a URL cannot be clicked
 *
 * All three are built here rather than in the browser for the reason the
 * response importer gives for parsing spreadsheets on the server: the
 * libraries already live in this package because it writes every export, and
 * shipping a second copy into the Studio bundle to produce a file that is
 * about to be downloaded anyway is paying twice.
 *
 * Nothing here sends anything. This platform has no mail transport, and a
 * distribution screen that pretends otherwise is worse than one that is
 * honest about handing you the links.
 */

export interface Invitation {
  /** the person's own link, tokenised */
  url: string;
  token: string;
  name?: string | null;
  email?: string | null;
  externalId?: string | null;
  listName?: string | null;
  status?: string | null;
  sentAt?: string | null;
  invitedAt?: string | null;
}

/**
 * Column order chosen for a mail merge, not for the database: the address
 * first, then the link, because that is the pair a merge needs and a human
 * checking the file reads across.
 */
export const INVITATION_COLUMNS = [
  "NAME",
  "EMAIL",
  "EXTERNAL_ID",
  "SURVEY_LINK",
  "TOKEN",
  "LIST",
  "STATUS",
  "INVITED_AT",
  "SENT_AT",
] as const;

function cells(i: Invitation): (string | null)[] {
  return [
    i.name ?? "",
    i.email ?? "",
    i.externalId ?? "",
    i.url,
    i.token,
    i.listName ?? "",
    i.status ?? "",
    i.invitedAt ?? "",
    i.sentAt ?? "",
  ];
}

/** RFC-4180 quoting, and one thing more — see below. */
function csvCell(value: string): string {
  /*
   * A leading =, +, - or @ is quoted AND prefixed, because Excel and Sheets
   * evaluate such a cell as a formula. A respondent list is user-supplied
   * data going into a file a client will open, so a name like "-Ann" or an
   * external id starting with "=" is a formula-injection vector, not a
   * curiosity. The tab keeps the value readable while stopping evaluation.
   */
  const s = /^[=+\-@\t\r]/.test(value) ? `\t${value}` : value;
  return /[",\n\r\t]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function invitationsToCSV(rows: Invitation[]): string {
  const lines = [INVITATION_COLUMNS.join(",")];
  for (const r of rows) lines.push(cells(r).map((c) => csvCell(String(c ?? ""))).join(","));
  return lines.join("\n") + "\n";
}

export async function invitationsToXlsx(
  rows: Invitation[],
  opts: { surveyTitle?: string; environment?: string } = {},
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "rescript";
  wb.created = new Date(0);

  const ws = wb.addWorksheet("Invitations");
  ws.columns = INVITATION_COLUMNS.map((h) => ({
    header: h,
    key: h,
    width: h === "SURVEY_LINK" ? 62 : h === "EMAIL" ? 30 : Math.min(40, Math.max(12, h.length + 4)),
  }));
  for (const r of rows) {
    const row = ws.addRow(cells(r));
    /*
     * The link is written as TEXT, not as a hyperlink. A mail merge reads the
     * cell value; a hyperlink-formatted cell in Excel can carry a display
     * string that differs from its target, and a survey link whose visible
     * text is not where it goes is the shape of a phishing mail.
     */
    row.getCell(4).alignment = { vertical: "middle" };
  }
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: INVITATION_COLUMNS.length } };

  /*
   * A second sheet saying what this file is. A spreadsheet of live survey
   * links leaves the platform and is forwarded, and six months later nobody
   * can tell which study or which environment it belongs to — which is how a
   * test list gets mailed to a client's customers.
   */
  const about = wb.addWorksheet("About");
  about.columns = [{ header: "", key: "k", width: 22 }, { header: "", key: "v", width: 70 }];
  about.addRows([
    ["Survey", opts.surveyTitle ?? ""],
    ["Environment", opts.environment ?? ""],
    ["Invitations", String(rows.length)],
    ["Generated", new Date().toISOString()],
    ["", ""],
    ["Each link is personal", "One link, one respondent. Forwarding a link gives that person's interview away."],
    ["Keep this file private", "A link is a credential: anyone holding it can answer as that respondent."],
  ]);
  about.getColumn(1).font = { bold: true };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * A survey link as a QR code, in SVG.
 *
 * SVG rather than PNG because the thing a printed QR code most often fails
 * at is resolution: a raster code sized for a screen is unscannable on a
 * poster, and nobody notices until the posters are printed. Vector has no
 * such size.
 *
 * Error correction is fixed at M (~15% recoverable). A survey link is short
 * enough that M costs nothing in module count, and QR codes are read off
 * crumpled paper, phone screens at an angle, and stickers with a thumb over
 * one corner.
 */
export async function surveyQrSvg(
  url: string,
  opts: { margin?: number; scale?: number } = {},
): Promise<string> {
  return QRCode.toString(url, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: opts.margin ?? 2,
    scale: opts.scale ?? 8,
    color: { dark: "#000000", light: "#ffffff" },
  });
}

/** The same code as PNG bytes, for a document or a slide that cannot take SVG. */
export async function surveyQrPng(
  url: string,
  opts: { width?: number } = {},
): Promise<Buffer> {
  return QRCode.toBuffer(url, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 2,
    width: opts.width ?? 512,
  });
}
