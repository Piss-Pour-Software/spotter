// Every name the tool goes by, in one file, so a new name is a one-line change.

export const TOOL = "spotter";
export const KEYCHAIN_SERVICE = `xyz.pisspoursoftware.${TOOL}`;

/** Answers' ids are derived under this, and it never follows a rename: posting the same answer again must find the same
 *  rows, whatever the tool is called by then. */
export const ID_NAMESPACE = "spotter";

/** The tool's own environment variables, SPOTTER_<NAME>: tests point it at their own keychain or app. */
export const setting = (name: string): string | undefined => process.env[`${TOOL.toUpperCase()}_${name}`]?.trim() || undefined;

/** The app the phone writes to. An app id is not a secret: it ships inside every copy of the phone app, and only each
 *  account's own rows are readable with it. */
export const APP_ID = setting("INSTANT_APP_ID") || "e7c49961-d702-46a1-82c1-fca9a61f6a4d";
export const INSTANT_API = "https://api.instantdb.com";

/** Where a person gets the phone app the words come from: the TestFlight beta until the App Store page is live, then
 *  that page. The page, the README and the installer carry the same link, and a test holds them together. */
export const APP_LINK = "https://testflight.apple.com/join/nUxAwCM6";
/** The install page's sentence (scripts/install-page): the phone app's name on the Home Screen until it changes. */
export const APP_HINT = "On your Home Screen it is called Scribe for now.";
