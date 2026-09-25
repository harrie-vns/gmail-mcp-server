import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Pure helpers for building draft messages. No Gmail calls live here, so the
// whole file can be tested without an account.
// ---------------------------------------------------------------------------

// Deliberately conservative: one @, no spaces, a dotted domain. Gmail does its
// own checks too; this catches typos and header injection before a draft exists.
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export interface Address {
  name?: string;
  email: string;
}

/** Parse one address: "person@example.com" or "Name <person@example.com>". */
export function parseAddress(input: string): Address {
  const raw = input.trim();
  if (/[\r\n]/.test(raw)) {
    throw new Error(`Invalid email address "${input}": it contains a line break.`);
  }
  const angled = raw.match(/^(.*)<([^<>]+)>$/);
  const name = angled ? angled[1].trim().replace(/^"(.*)"$/, "$1").trim() : undefined;
  const email = (angled ? angled[2] : raw).trim();
  if (!EMAIL_RE.test(email)) {
    throw new Error(
      `Invalid email address "${input}". Use person@example.com or Name <person@example.com>.`
    );
  }
  return name ? { name, email } : { email };
}

/** Parse a list given as an array, or as one comma-separated string. */
export function parseAddressList(input: string | string[] | undefined, field: string): Address[] {
  if (input === undefined) return [];
  const parts = (Array.isArray(input) ? input : splitAddressHeader(input))
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.map((p) => {
    try {
      return parseAddress(p);
    } catch (err: any) {
      throw new Error(`${field}: ${err.message}`);
    }
  });
}

/** Split an address header on commas that are not inside quotes or <>. */
export function splitAddressHeader(header: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let angled = false;
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<" && !quoted) angled = true;
    else if (ch === ">" && !quoted) angled = false;
    if (ch === "," && !quoted && !angled) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** RFC 2047 encode a header value when it is not plain ASCII. */
export function encodeHeaderValue(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error("Header values cannot contain line breaks.");
  }
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export function formatAddress(a: Address): string {
  if (!a.name) return a.email;
  const name = /^[\x20-\x7e]*$/.test(a.name)
    ? `"${a.name.replace(/(["\\])/g, "\\$1")}"`
    : encodeHeaderValue(a.name);
  return `${name} <${a.email}>`;
}

/** "Re: " once, however many the original already had. */
export function replySubject(original: string): string {
  const trimmed = original.trim();
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

/** The References header for a reply: the original's chain plus its own id. */
export function replyReferences(originalReferences: string, originalMessageId: string): string {
  return [originalReferences.trim(), originalMessageId.trim()].filter(Boolean).join(" ");
}

export interface DraftContent {
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  inReplyTo?: string;
  references?: string;
}

function base64Lines(s: string): string {
  return (Buffer.from(s, "utf8").toString("base64").match(/.{1,76}/g) ?? [""]).join("\r\n");
}

/**
 * Build the raw RFC 5322 message Gmail wants, base64url encoded. Bodies are
 * base64 transfer-encoded, so they arrive byte-for-byte as given.
 */
export function buildRawMessage(d: DraftContent): string {
  if (d.to.length === 0) throw new Error("A draft needs at least one To address.");

  const headers = [
    `From: ${formatAddress(d.from)}`,
    `To: ${d.to.map(formatAddress).join(", ")}`,
    ...(d.cc.length ? [`Cc: ${d.cc.map(formatAddress).join(", ")}`] : []),
    `Subject: ${encodeHeaderValue(d.subject)}`,
    ...(d.inReplyTo ? [`In-Reply-To: ${d.inReplyTo}`] : []),
    ...(d.references ? [`References: ${d.references}`] : []),
    "MIME-Version: 1.0",
  ];

  let body: string[];
  if (d.bodyHtml !== undefined) {
    const boundary = `b_${randomBytes(12).toString("hex")}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(d.bodyText),
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(d.bodyHtml),
      `--${boundary}--`,
    ];
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64");
    body = [base64Lines(d.bodyText)];
  }

  return Buffer.from([...headers, "", ...body].join("\r\n"), "utf8").toString("base64url");
}
