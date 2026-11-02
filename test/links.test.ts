// The phone app is where the words come from, so every way in sends a person there, and to one place.

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { APP_HINT, APP_LINK } from "../src/names.ts";

const read = (file: string): string => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("the phone app's link is the TestFlight beta until the App Store page is live", () => {
  assert.equal(APP_LINK, "https://testflight.apple.com/join/nUxAwCM6");
});

test("the page, the README and the installer send a person to the same place for the phone app", () => {
  for (const file of ["site/index.html", "README.md", "install.sh"]) {
    assert.ok(read(file).includes(APP_LINK), `${file} does not link ${APP_LINK}`);
  }
});

test("setup and doctor name the phone app's link when there is nothing to follow", () => {
  const cli = read("src/cli.ts");
  assert.match(cli, /\$\{APP_LINK\}/);
});

// The phone app's install page says this too: a person looking for Vakyume on the Home Screen finds nothing yet.
test("wherever the phone app's link goes, one line says what the app is called on the Home Screen", () => {
  assert.equal(APP_HINT, "On your Home Screen it is called Scribe for now.");
  for (const file of ["site/index.html", "README.md", "install.sh", "src/help.ts"]) {
    assert.ok(read(file).includes(file === "src/help.ts" ? "APP_HINT" : APP_HINT), `${file} does not say ${APP_HINT}`);
  }
  assert.match(read("src/cli.ts"), /\$\{APP_HINT\}/);
});
