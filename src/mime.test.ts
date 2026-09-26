import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  buildRawMessage,
  parseAddress,
  parseAddressList,
  replyReferences,
  replySubject,
  splitAddressHeader,
} from "./mime.js";

const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");

test("parses bare and named addresses", () => {
  assert.deepEqual(parseAddress("a@b.com"), { email: "a@b.com" });
  assert.deepEqual(parseAddress('"Jo Bloggs" <jo@x.com.au>'), { name: "Jo Bloggs", email: "jo@x.com.au" });
});

test("rejects bad addresses with a clear error", () => {
  for (const bad of ["nope", "a@b", "a b@c.com", "a@b.com\r\nBcc: x@y.com"]) {
    assert.throws(() => parseAddress(bad), /Invalid email address/);
  }
  assert.throws(() => parseAddressList(["ok@x.com", "bad"], "cc"), /^Error: cc: Invalid/);
});

test("splits address headers without breaking quoted commas", () => {
  assert.deepEqual(splitAddressHeader('"Smith, Jo" <jo@x.com>, a@b.com'), ['"Smith, Jo" <jo@x.com>', "a@b.com"]);
});

test("reply subject gets exactly one Re:", () => {
  assert.equal(replySubject("Hay order"), "Re: Hay order");
  assert.equal(replySubject("RE: Hay order"), "RE: Hay order");
});

test("references append the original's id", () => {
  assert.equal(replyReferences("<a@x> <b@x>", "<c@x>"), "<a@x> <b@x> <c@x>");
  assert.equal(replyReferences("", "<c@x>"), "<c@x>");
});

test("builds a plain draft with the body byte-for-byte", () => {
  const body = "Hi Jo,\n\nThanks — see you Tuesday.\n\nHarrie\n";
  const raw = decode(buildRawMessage({
    from: { name: "Harrie", email: "h@x.com" },
    to: [{ email: "jo@y.com" }],
    cc: [],
    subject: "Re: Hay ✓",
    bodyText: body,
    inReplyTo: "<m1@y>",
    references: "<m1@y>",
  }));
  assert.match(raw, /^From: "Harrie" <h@x\.com>\r\n/);
  assert.match(raw, /\r\nSubject: =\?UTF-8\?B\?/);
  assert.match(raw, /\r\nIn-Reply-To: <m1@y>\r\n/);
  const encoded = raw.split("\r\n\r\n")[1].replace(/\r\n/g, "");
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), body);
});

test("builds multipart when HTML is given", () => {
  const raw = decode(buildRawMessage({
    from: { email: "h@x.com" }, to: [{ email: "jo@y.com" }], cc: [],
    subject: "s", bodyText: "t", bodyHtml: "<p>t</p>",
  }));
  assert.match(raw, /multipart\/alternative/);
  assert.match(raw, /text\/html/);
});

test("refuses a draft with no recipient", () => {
  assert.throws(() => buildRawMessage({ from: { email: "h@x.com" }, to: [], cc: [], subject: "s", bodyText: "t" }));
});

// Sending is allowed in exactly two places: send_draft (which the user
// approves call by call) and the email-based unsubscribe fallback. Anything
// else that sends fails this test.
test("mail is sent only from the two approved places", () => {
  const dir = new URL(".", import.meta.url);
  const hits: string[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
    readFileSync(new URL(f, dir), "utf8").split("\n").forEach((line, i) => {
      if (/\b(messages|drafts)\.send\s*\(/.test(line)) hits.push(`${f}:${line.trim()}`);
    });
  }
  assert.deepEqual(hits.sort(), [
    "draft-service.ts:const res = await this.gmail.users.drafts.send({",
    "gmail-service.ts:await this.gmail.users.messages.send({",
  ]);
});

// Trash is Gmail's recoverable Trash only. Nothing may delete permanently.
test("nothing deletes mail permanently", () => {
  const dir = new URL(".", import.meta.url);
  const hits: string[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
    readFileSync(new URL(f, dir), "utf8").split("\n").forEach((line) => {
      if (/\b(messages|threads)\.(delete|batchDelete)\s*\(/.test(line)) hits.push(`${f}:${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});

test("trash needs exactly one target", async () => {
  const { trashTarget } = await import("./trash-service.js");
  assert.deepEqual(trashTarget("m1", undefined), { messageId: "m1" });
  assert.deepEqual(trashTarget(undefined, "t1"), { threadId: "t1" });
  assert.throws(() => trashTarget("m1", "t1"), /not both/);
  assert.throws(() => trashTarget(undefined, " "), /Pass message_id/);
});
