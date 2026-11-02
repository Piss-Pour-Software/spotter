// The one file that touches the macOS Keychain. The sign-in is written through `security -i`, by standard input, because
// a value on a command line can be read by any process listing commands.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { KEYCHAIN_SERVICE, setting } from "./names.ts";

const run = promisify(execFile);
const SAFE_VALUE = /^[A-Za-z0-9._@+-]+$/;

export interface Credential {
  userID: string;
  refreshToken: string;
  email: string | null;
}

/** Tests use their own keychain file, never the login keychain. */
const keychainArguments = (): string[] => {
  const keychain = setting("KEYCHAIN");
  return keychain ? [keychain] : [];
};

async function readItem(account: string): Promise<string | null> {
  try {
    const { stdout } = await run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", ...keychainArguments()], { timeout: 5_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function readCredential(): Promise<Credential | null> {
  const envToken = setting("REFRESH_TOKEN");
  const envUser = setting("USER_ID");
  if (envToken && envUser) return { userID: envUser, refreshToken: envToken, email: null };
  const [refreshToken, userID, email] = await Promise.all([readItem("refresh-token"), readItem("user-id"), readItem("email")]);
  return refreshToken && userID ? { userID, refreshToken, email } : null;
}

function writeThroughStandardInput(commands: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("security", ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
    let errors = "";
    child.stderr.on("data", (chunk: Buffer) => (errors += chunk.toString()));
    const timer = setTimeout(() => child.kill(), 5_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && errors.trim() === "") resolve();
      else reject(new Error(`the Keychain refused the sign-in: ${errors.trim() || `exit ${code}`}`));
    });
    child.stdin.end(`${commands.join("\n")}\n`);
  });
}

export async function writeCredential(credential: Credential): Promise<void> {
  const items: Array<[string, string]> = [["refresh-token", credential.refreshToken], ["user-id", credential.userID]];
  if (credential.email) items.push(["email", credential.email]);
  for (const [account, value] of items) {
    if (!SAFE_VALUE.test(value)) throw new Error(`the ${account} has characters the Keychain command cannot carry`);
  }
  const target = keychainArguments().join(" ");
  await writeThroughStandardInput(
    items.map(([account, value]) => `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${account} -T /usr/bin/security -w ${value} ${target}`.trim()),
  );
}

export async function deleteCredential(): Promise<void> {
  for (const account of ["refresh-token", "user-id", "email"]) {
    await run("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, ...keychainArguments()], { timeout: 5_000 }).catch(() => undefined);
  }
}
