import { gmail_v1 } from "googleapis";
import type { TrashTarget } from "./trash-service.js";

// ---------------------------------------------------------------------------
// Labels. Nothing here creates a label unless the caller explicitly asks
// (apply_label with create_if_missing), so a typo can't quietly start a new
// filing folder.
// ---------------------------------------------------------------------------

export interface LabelInfo {
  id: string;
  name: string;
  type: "system" | "user";
}

export interface LabelWithCounts extends LabelInfo {
  messagesTotal: number;
  messagesUnread: number;
  threadsTotal: number;
}

/** "Label_98 (Accounts)" for a user label; a system label's id is its name. */
export function labelDisplay(id: string, byId: Map<string, LabelInfo>): string {
  const label = byId.get(id);
  if (!label || label.name === id) return id;
  return `${id} (${label.name})`;
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/**
 * The existing label names nearest to what was asked for, best first. Scored
 * on the whole name, the last segment ("Invoices" in "Accounts/Invoices") and
 * the first segment (so a misspelt child still ranks its parent), with a name
 * that contains the other winning outright. User labels win ties.
 */
export function closestLabelNames(wanted: string, labels: LabelInfo[], limit = 5): string[] {
  const w = wanted.trim().toLowerCase();
  const first = (n: string) => n.split("/")[0];
  const last = (n: string) => n.split("/").pop() ?? n;
  return labels
    .map((l) => {
      const n = l.name.toLowerCase();
      const contains = n.includes(w) || w.includes(n) || n.includes(last(w));
      const score =
        Math.min(
          levenshtein(w, n),
          levenshtein(last(w), last(n)) + 2,
          levenshtein(first(w), n) + 2
        ) - (contains ? 100 : 0);
      return { name: l.name, score, user: l.type === "user" };
    })
    .sort((a, b) => a.score - b.score || Number(b.user) - Number(a.user) || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((x) => x.name);
}

/** Find a label by exact ID, else by name ignoring case (Gmail names are case-insensitive). */
export function findLabel(ref: string, labels: LabelInfo[]): LabelInfo | undefined {
  const r = ref.trim();
  return labels.find((l) => l.id === r) ?? labels.find((l) => l.name.toLowerCase() === r.toLowerCase());
}

export class LabelService {
  // The promise is cached, not the result, so a list of 20 emails looked up
  // in parallel makes one labels.list call, not 20. A failed load is dropped
  // so the next call retries.
  private cache?: Promise<LabelInfo[]>;

  constructor(private gmail: gmail_v1.Gmail, private account: string) {}

  async all(): Promise<LabelInfo[]> {
    if (!this.cache) {
      this.cache = this.gmail.users.labels.list({ userId: "me" }).then((res) =>
        (res.data.labels ?? []).map((l) => ({
          id: l.id!,
          name: l.name ?? l.id!,
          type: (l.type === "system" ? "system" : "user") as LabelInfo["type"],
        }))
      );
      this.cache.catch(() => (this.cache = undefined));
    }
    return this.cache;
  }

  async byId(): Promise<Map<string, LabelInfo>> {
    return new Map((await this.all()).map((l) => [l.id, l]));
  }

  /** Label ids as "Label_98 (Accounts)". Never throws: names are a courtesy. */
  async display(ids: string[]): Promise<string[]> {
    try {
      const map = await this.byId();
      return ids.map((id) => labelDisplay(id, map));
    } catch {
      return ids;
    }
  }

  async listWithCounts(): Promise<LabelWithCounts[]> {
    const labels = await this.all();
    const out: LabelWithCounts[] = [];
    // A few at a time: one labels.get per label is how Gmail gives counts.
    for (let i = 0; i < labels.length; i += 10) {
      const batch = await Promise.all(
        labels.slice(i, i + 10).map(async (l) => {
          const res = await this.gmail.users.labels.get({ userId: "me", id: l.id });
          return {
            ...l,
            messagesTotal: res.data.messagesTotal ?? 0,
            messagesUnread: res.data.messagesUnread ?? 0,
            threadsTotal: res.data.threadsTotal ?? 0,
          };
        })
      );
      out.push(...batch);
    }
    return out.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "user" ? -1 : 1
    );
  }

  /**
   * Resolve a label name or ID. Missing + create=false is an error naming the
   * closest existing labels; create=true makes it (nested names like
   * "Accounts/Invoices" nest in Gmail).
   */
  async resolve(ref: string, create = false): Promise<LabelInfo & { created: boolean }> {
    const wanted = ref.trim();
    if (!wanted) throw new Error("A label name or ID is required.");
    const labels = await this.all();
    const found = findLabel(wanted, labels);
    if (found) return { ...found, created: false };

    if (!create) {
      const near = closestLabelNames(wanted, labels);
      throw new Error(
        `No label "${wanted}" in ${this.account}. Closest existing: ${near.map((n) => `"${n}"`).join(", ") || "none"}. ` +
          `Use one of those, or pass create_if_missing=true on apply_label to create it. Nothing was changed.`
      );
    }
    const created = await this.gmail.users.labels.create({
      userId: "me",
      requestBody: { name: wanted, labelListVisibility: "labelShow", messageListVisibility: "show" },
    });
    const info: LabelInfo = { id: created.data.id!, name: created.data.name ?? wanted, type: "user" };
    this.cache = Promise.resolve([...labels, info]);
    return { ...info, created: true };
  }

  /** Add/remove label ids on a message or thread in ONE call; returns the labels after. */
  async modify(
    target: TrashTarget,
    add: string[],
    remove: string[]
  ): Promise<{ kind: "message" | "thread"; id: string; labels: string[] }> {
    const requestBody = { addLabelIds: add, removeLabelIds: remove };
    if ("messageId" in target) {
      const res = await this.gmail.users.messages.modify({ userId: "me", id: target.messageId, requestBody });
      return { kind: "message", id: target.messageId, labels: await this.display(res.data.labelIds ?? []) };
    }
    await this.gmail.users.threads.modify({ userId: "me", id: target.threadId, requestBody });
    const after = await this.gmail.users.threads.get({ userId: "me", id: target.threadId, format: "minimal" });
    const ids = [...new Set((after.data.messages ?? []).flatMap((m) => m.labelIds ?? []))];
    return { kind: "thread", id: target.threadId, labels: await this.display(ids) };
  }
}
