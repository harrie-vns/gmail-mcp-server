import { google, gmail_v1 } from "googleapis";

// ---------------------------------------------------------------------------
// Trash and untrash. Gmail's Trash keeps mail for 30 days and can be undone,
// so nothing here deletes permanently: there is no call to messages.delete,
// threads.delete or batchDelete, and the account's gmail.modify scope could
// not make one anyway.
// ---------------------------------------------------------------------------

export interface TrashedMessage {
  messageId: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  labelIds: string[];
}

export interface TrashResult {
  kind: "message" | "thread";
  id: string;
  messages: TrashedMessage[];
}

export type TrashTarget = { messageId: string } | { threadId: string };

function header(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function summarise(m: gmail_v1.Schema$Message): TrashedMessage {
  const h = m.payload?.headers;
  return {
    messageId: m.id ?? "",
    threadId: m.threadId ?? "",
    from: header(h, "From"),
    subject: header(h, "Subject"),
    date: header(h, "Date"),
    labelIds: m.labelIds ?? [],
  };
}

function notFound(err: any, what: string): Error {
  const status = err?.code ?? err?.response?.status;
  if (status === 404 || status === 400) return new Error(`${what} was not found in this account.`);
  return err instanceof Error ? err : new Error(String(err));
}

/** Exactly one of message_id / thread_id, or a clear error. */
export function trashTarget(messageId?: string, threadId?: string): TrashTarget {
  const m = messageId?.trim();
  const t = threadId?.trim();
  if (m && t) throw new Error("Pass message_id or thread_id, not both.");
  if (m) return { messageId: m };
  if (t) return { threadId: t };
  throw new Error("Pass message_id (one message) or thread_id (the whole thread).");
}

export class TrashService {
  private gmail: gmail_v1.Gmail;

  constructor(accessToken: string) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    this.gmail = google.gmail({ version: "v1", auth });
  }

  async trash(target: TrashTarget): Promise<TrashResult> {
    return this.move(target, "trash");
  }

  async untrash(target: TrashTarget): Promise<TrashResult> {
    return this.move(target, "untrash");
  }

  private async move(target: TrashTarget, action: "trash" | "untrash"): Promise<TrashResult> {
    const metadataHeaders = ["From", "Subject", "Date"];

    if ("messageId" in target) {
      const what = `Message ${target.messageId}`;
      try {
        await this.gmail.users.messages.get({ userId: "me", id: target.messageId, format: "minimal" });
      } catch (err) {
        throw notFound(err, what);
      }
      const res =
        action === "trash"
          ? await this.gmail.users.messages.trash({ userId: "me", id: target.messageId })
          : await this.gmail.users.messages.untrash({ userId: "me", id: target.messageId });
      const after = await this.gmail.users.messages.get({
        userId: "me",
        id: res.data.id ?? target.messageId,
        format: "metadata",
        metadataHeaders,
      });
      return { kind: "message", id: target.messageId, messages: [summarise(after.data)] };
    }

    const what = `Thread ${target.threadId}`;
    try {
      await this.gmail.users.threads.get({ userId: "me", id: target.threadId, format: "minimal" });
    } catch (err) {
      throw notFound(err, what);
    }
    if (action === "trash") {
      await this.gmail.users.threads.trash({ userId: "me", id: target.threadId });
    } else {
      await this.gmail.users.threads.untrash({ userId: "me", id: target.threadId });
    }
    const after = await this.gmail.users.threads.get({
      userId: "me",
      id: target.threadId,
      format: "metadata",
      metadataHeaders,
    });
    return {
      kind: "thread",
      id: target.threadId,
      messages: (after.data.messages ?? []).map(summarise),
    };
  }
}
