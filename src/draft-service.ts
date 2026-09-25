import { google, gmail_v1 } from "googleapis";
import {
  Address,
  buildRawMessage,
  parseAddress,
  parseAddressList,
  replyReferences,
  replySubject,
  splitAddressHeader,
} from "./mime.js";

// ---------------------------------------------------------------------------
// Drafts. Creating, reading, updating and deleting a draft never touches a
// label, the inbox, or read state. Sending lives in ONE method, sendDraft,
// which only the approval-gated send_draft tool calls.
// ---------------------------------------------------------------------------

export interface DraftSummary {
  draftId: string;
  messageId: string;
  threadId: string;
  to: string;
  subject: string;
  updated: string;
}

export interface DraftDetail extends DraftSummary {
  from: string;
  cc: string;
  inReplyTo: string;
  references: string;
  bodyText: string;
  bodyHtml: string | null;
  hasAttachments: boolean;
  gmailLink: string;
}

export interface CreateDraftInput {
  to?: string | string[];
  cc?: string | string[];
  subject?: string;
  bodyText: string;
  bodyHtml?: string;
  replyToMessageId?: string;
}

export interface UpdateDraftInput {
  subject?: string;
  bodyText?: string;
  bodyHtml?: string;
}

type Headers = gmail_v1.Schema$MessagePartHeader[];

function header(headers: Headers | undefined, name: string): string {
  return (
    headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? ""
  );
}

function findPart(
  part: gmail_v1.Schema$MessagePart | undefined,
  mimeType: string
): string | null {
  if (!part) return null;
  if (part.mimeType === mimeType && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf-8");
  }
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Parse an address header Gmail handed back. Never drops a recipient quietly:
 * an entry that won't parse is an error, not a shorter list.
 */
function addressesFromHeader(value: string, field: string): Address[] {
  return splitAddressHeader(value).map((p) => {
    try {
      return parseAddress(p);
    } catch {
      throw new Error(`Couldn't read the ${field} address "${p}" on this message, so it can't be carried over safely.`);
    }
  });
}

function hasAttachment(part: gmail_v1.Schema$MessagePart | undefined): boolean {
  if (!part) return false;
  if (part.filename || part.body?.attachmentId) return true;
  return (part.parts ?? []).some(hasAttachment);
}

function gmailError(err: any, what: string): Error {
  const status = err?.code ?? err?.response?.status;
  if (status === 404) return new Error(`${what} was not found in this account.`);
  if (status === 403) {
    return new Error(
      `Gmail refused (${err?.message ?? "403"}). The account may not have granted the permission this needs; re-authorise it via /setup.`
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * SENDER_NAMES: JSON of account address -> From name, e.g.
 * {"harrie@tarcombe.farm":"Tarcombe Farm, Little River"}. A malformed value
 * is an error, not a silent fallback to the bare address.
 */
function senderNames(): Record<string, string> {
  const raw = process.env.SENDER_NAMES;
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("The SENDER_NAMES setting is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The SENDER_NAMES setting must be a JSON object of address to name.");
  }
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>)
      .filter(([, v]) => typeof v === "string" && v.trim())
      .map(([k, v]) => [k.toLowerCase(), (v as string).trim()])
  );
}

export class DraftService {
  private gmail: gmail_v1.Gmail;

  constructor(accessToken: string, private account: string) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    this.gmail = google.gmail({ version: "v1", auth });
  }

  draftLink(messageId: string): string {
    return `https://mail.google.com/mail/u/${encodeURIComponent(this.account)}/#drafts?compose=${messageId}`;
  }

  /**
   * The account's own address, with the name its mail should go out under:
   * the SENDER_NAMES setting first (the owner's choice per account), then the
   * Gmail send-as display name, else the bare address.
   */
  private async fromAddress(): Promise<Address> {
    const configured = senderNames()[this.account.toLowerCase()];
    if (configured) return { name: configured, email: this.account };
    try {
      const res = await this.gmail.users.settings.sendAs.list({ userId: "me" });
      const own = res.data.sendAs?.find(
        (s) => s.sendAsEmail?.toLowerCase() === this.account.toLowerCase()
      );
      if (own?.displayName) return { name: own.displayName, email: this.account };
    } catch {
      // The display name is cosmetic; the address alone is still correct.
    }
    return { email: this.account };
  }

  // -----------------------------------------------------------------------
  // create_draft
  // -----------------------------------------------------------------------

  async createDraft(input: CreateDraftInput): Promise<DraftDetail> {
    let to = parseAddressList(input.to, "to");
    const cc = parseAddressList(input.cc, "cc");
    let subject = input.subject?.trim() ?? "";
    let threadId: string | undefined;
    let inReplyTo: string | undefined;
    let references: string | undefined;

    if (input.replyToMessageId) {
      let original: gmail_v1.Schema$Message;
      try {
        const res = await this.gmail.users.messages.get({
          userId: "me",
          id: input.replyToMessageId,
          format: "metadata",
          metadataHeaders: ["Subject", "From", "Reply-To", "To", "Message-ID", "References"],
        });
        original = res.data;
      } catch (err) {
        throw gmailError(err, `Message ${input.replyToMessageId}`);
      }
      const h = original.payload?.headers;
      const messageId = header(h, "Message-ID");
      if (!messageId) {
        throw new Error(
          `Message ${input.replyToMessageId} has no Message-ID header, so a reply can't be threaded to it.`
        );
      }
      threadId = original.threadId ?? undefined;
      inReplyTo = messageId;
      references = replyReferences(header(h, "References"), messageId);
      subject = replySubject(subject || header(h, "Subject"));

      if (to.length === 0) {
        // Reply to whoever the sender asked replies to go to, else the sender.
        // If the account itself sent the original, reply to its recipients.
        const fromAddrs = addressesFromHeader(header(h, "From"), "From");
        const sentByMe = fromAddrs.some(
          (a) => a.email.toLowerCase() === this.account.toLowerCase()
        );
        to = sentByMe
          ? addressesFromHeader(header(h, "To"), "To")
          : addressesFromHeader(header(h, "Reply-To") || header(h, "From"), "Reply-To/From");
        if (to.length === 0) {
          throw new Error(
            `Couldn't work out who to reply to from message ${input.replyToMessageId}. Pass "to" explicitly.`
          );
        }
      }
    } else {
      if (to.length === 0) throw new Error('"to" is required unless reply_to_message_id is given.');
      if (!subject) throw new Error('"subject" is required unless reply_to_message_id is given.');
    }

    const raw = buildRawMessage({
      from: await this.fromAddress(),
      to,
      cc,
      subject,
      bodyText: input.bodyText,
      bodyHtml: input.bodyHtml,
      inReplyTo,
      references,
    });

    const res = await this.gmail.users.drafts.create({
      userId: "me",
      requestBody: { message: { raw, threadId } },
    });
    return this.getDraft(res.data.id!);
  }

  // -----------------------------------------------------------------------
  // list_drafts / get_draft
  // -----------------------------------------------------------------------

  async listDrafts(maxResults: number): Promise<DraftSummary[]> {
    const res = await this.gmail.users.drafts.list({ userId: "me", maxResults });
    const drafts = res.data.drafts ?? [];
    const summaries = await Promise.all(
      drafts.map(async (d) => {
        const full = await this.gmail.users.drafts.get({
          userId: "me",
          id: d.id!,
          format: "metadata",
        });
        const m = full.data.message ?? {};
        return {
          draftId: d.id!,
          messageId: m.id ?? "",
          threadId: m.threadId ?? "",
          to: header(m.payload?.headers, "To"),
          subject: header(m.payload?.headers, "Subject"),
          updated: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : "",
        };
      })
    );
    // ISO strings sort chronologically; newest first.
    return summaries.sort((a, b) => b.updated.localeCompare(a.updated));
  }

  async getDraft(draftId: string): Promise<DraftDetail> {
    let draft: gmail_v1.Schema$Draft;
    try {
      const res = await this.gmail.users.drafts.get({ userId: "me", id: draftId, format: "full" });
      draft = res.data;
    } catch (err) {
      throw gmailError(err, `Draft ${draftId}`);
    }
    const m = draft.message ?? {};
    const h = m.payload?.headers;
    return {
      draftId: draft.id!,
      messageId: m.id ?? "",
      threadId: m.threadId ?? "",
      from: header(h, "From"),
      to: header(h, "To"),
      cc: header(h, "Cc"),
      subject: header(h, "Subject"),
      inReplyTo: header(h, "In-Reply-To"),
      references: header(h, "References"),
      updated: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : "",
      bodyText: findPart(m.payload, "text/plain") ?? "",
      bodyHtml: findPart(m.payload, "text/html"),
      hasAttachments: hasAttachment(m.payload),
      gmailLink: this.draftLink(m.id ?? ""),
    };
  }

  // -----------------------------------------------------------------------
  // update_draft — replaces subject and/or body; recipients and threading stay
  // -----------------------------------------------------------------------

  async updateDraft(draftId: string, input: UpdateDraftInput): Promise<DraftDetail> {
    if (input.subject === undefined && input.bodyText === undefined && input.bodyHtml === undefined) {
      throw new Error("Nothing to update: pass subject, body_text or body_html.");
    }
    if (input.bodyHtml !== undefined && input.bodyText === undefined) {
      throw new Error("body_html needs body_text alongside it, so the plain-text part matches.");
    }

    const current = await this.getDraft(draftId);
    if (current.hasAttachments) {
      throw new Error(
        `Draft ${draftId} has an attachment, which rebuilding it would drop. Edit it in Gmail instead: ${current.gmailLink}`
      );
    }
    const bodyText = input.bodyText ?? current.bodyText;
    // A new plain body without HTML makes the draft plain text; otherwise keep
    // the HTML part that was already there.
    const bodyHtml =
      input.bodyText !== undefined ? input.bodyHtml : current.bodyHtml ?? undefined;

    const raw = buildRawMessage({
      from: await this.fromAddress(),
      to: addressesFromHeader(current.to, "To"),
      cc: addressesFromHeader(current.cc, "Cc"),
      subject: input.subject ?? current.subject,
      bodyText,
      bodyHtml,
      inReplyTo: current.inReplyTo || undefined,
      references: current.references || undefined,
    });

    try {
      await this.gmail.users.drafts.update({
        userId: "me",
        id: draftId,
        requestBody: { id: draftId, message: { raw, threadId: current.threadId || undefined } },
      });
    } catch (err) {
      throw gmailError(err, `Draft ${draftId}`);
    }
    return this.getDraft(draftId);
  }

  // -----------------------------------------------------------------------
  // delete_draft — the drafts endpoint can only ever delete a draft
  // -----------------------------------------------------------------------

  async deleteDraft(draftId: string): Promise<{ deleted: string; subject: string }> {
    const current = await this.getDraft(draftId);
    try {
      await this.gmail.users.drafts.delete({ userId: "me", id: draftId });
    } catch (err) {
      throw gmailError(err, `Draft ${draftId}`);
    }
    return { deleted: draftId, subject: current.subject };
  }

  // -----------------------------------------------------------------------
  // send_draft — the ONLY place a draft is sent. Called solely by the
  // send_draft tool, which the user approves call by call.
  // -----------------------------------------------------------------------

  async sendDraft(draftId: string): Promise<{ messageId: string; threadId: string; to: string; subject: string }> {
    const current = await this.getDraft(draftId);
    try {
      const res = await this.gmail.users.drafts.send({
        userId: "me",
        requestBody: { id: draftId },
      });
      return {
        messageId: res.data.id ?? "",
        threadId: res.data.threadId ?? "",
        to: current.to,
        subject: current.subject,
      };
    } catch (err) {
      throw gmailError(err, `Draft ${draftId}`);
    }
  }
}
