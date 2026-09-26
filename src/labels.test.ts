import { test } from "node:test";
import assert from "node:assert/strict";
import { closestLabelNames, findLabel, labelDisplay, LabelInfo } from "./labels.js";

const labels: LabelInfo[] = [
  { id: "INBOX", name: "INBOX", type: "system" },
  { id: "CATEGORY_PERSONAL", name: "CATEGORY_PERSONAL", type: "system" },
  { id: "Label_98", name: "Accounts", type: "user" },
  { id: "Label_99", name: "Accounts/Invoices", type: "user" },
  { id: "Label_7", name: "Horses/Fjords", type: "user" },
];
const byId = new Map(labels.map((l) => [l.id, l]));

test("user labels show their name, system labels their id", () => {
  assert.equal(labelDisplay("Label_98", byId), "Label_98 (Accounts)");
  assert.equal(labelDisplay("Label_99", byId), "Label_99 (Accounts/Invoices)");
  assert.equal(labelDisplay("INBOX", byId), "INBOX");
  assert.equal(labelDisplay("Label_404", byId), "Label_404");
});

test("finds a label by id or by name ignoring case", () => {
  assert.equal(findLabel("Label_7", labels)?.name, "Horses/Fjords");
  assert.equal(findLabel("accounts/invoices", labels)?.id, "Label_99");
  assert.equal(findLabel("Invoices", labels), undefined);
});

test("closest names put the near misses first", () => {
  assert.deepEqual(closestLabelNames("Acounts/Invoice", labels).slice(0, 2), ["Accounts/Invoices", "Accounts"]);
  assert.equal(closestLabelNames("Invoices", labels)[0], "Accounts/Invoices");
  assert.equal(closestLabelNames("fjord", labels)[0], "Horses/Fjords");
});

test("closest names leave out unrelated labels", () => {
  assert.deepEqual(closestLabelNames("Enquries", [...labels, { id: "L1", name: "ENquiries", type: "user" }]), ["ENquiries"]);
  assert.deepEqual(closestLabelNames("Zebra crossing", labels), []);
});
