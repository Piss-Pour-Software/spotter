import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

// @ts-expect-error a plain module with no types
import worker, { respond } from "../site/worker.mjs";

const page = fs.readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const source = fs.readFileSync(new URL("../site/worker.mjs", import.meta.url), "utf8");
const INSTALL = "https://raw.githubusercontent.com/Piss-Pour-Software/spotter/v1.2.3/install.sh";
const site = { page, styles: ["sha256-abc="], install: INSTALL };

test("the root is the page", async () => {
  const response = respond("/", "GET", site);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(await response.text(), /curl -fsSL https:\/\/spotter\.pisspoursoftware\.xyz\/install \| sh/);
});

test("the page may use only its own styles: no script, no frame, no form, nothing from elsewhere", () => {
  const policy = respond("/", "GET", site).headers.get("content-security-policy") ?? "";
  assert.match(policy, /^default-src 'none';/);
  assert.match(policy, /style-src 'sha256-abc=';/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.equal(respond("/", "GET", site).headers.get("x-content-type-options"), "nosniff");
});

test("/install points at the release's script in the public repository, so what runs is what anyone can read", () => {
  const response = respond("/install", "GET", site);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), INSTALL);
});

test("HEAD answers as GET does", () => {
  assert.equal(respond("/", "HEAD", site).status, 200);
  assert.equal(respond("/install", "HEAD", site).status, 302);
});

test("nothing else is served: other paths and other methods are a bare 404", () => {
  for (const [path, method] of [["/.env", "GET"], ["/install/", "GET"], ["/install.sh", "GET"], ["/", "POST"], ["/install", "PUT"], ["/", "DELETE"]]) {
    assert.equal(respond(path, method, site).status, 404, `${method} ${path}`);
  }
});

test("a Worker built without a release answers /install with nothing rather than a redirect to nowhere", async () => {
  const response = await worker.fetch(new Request("https://spotter.pisspoursoftware.xyz/install"));
  assert.equal(response.status, 404);
});

test("the Worker never sees a download: Cloudflare answers those from the release's files, and anything else is a 404", () => {
  assert.equal(respond("/download/v1.2.3/spotter-1.2.3-darwin-arm64.tar.xz", "GET", site).status, 404);
});

test("the Worker calls nothing and reads no binding: it reaches none of our machines", () => {
  assert.doesNotMatch(source, /\bfetch\(/);
  assert.doesNotMatch(source, /\benv\b/);
  assert.doesNotMatch(source, /\bimport\b/);
  assert.equal(source.match(/^const SITE = .*;$/gm)?.length, 1, "one line for the build to fill");
});

test("the page loads nothing from another site", () => {
  assert.doesNotMatch(page, /<(script|img|link|iframe)\b/);
});
