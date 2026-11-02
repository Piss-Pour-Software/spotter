// The phone app is where the words come from, so every way in sends a person there, and to one place.

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { APP_LINK } from "../src/names.ts";

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
