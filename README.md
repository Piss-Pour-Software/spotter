# spotter

Follow your own live recording from the terminal, and answer in it.

Vakyume on your iPhone writes down what is said. `spotter` hands those lines to a coding agent on your Mac as they
arrive, and the agent's answers show up in the recording, at the line they belong to.

You need Vakyume on your iPhone first: [join the free beta on TestFlight](https://testflight.apple.com/join/nUxAwCM6).
On your Home Screen it is called Scribe for now.

    curl -fsSL https://spotter.pisspoursoftware.xyz/install | sh

or

    brew install piss-pour-software/tap/spotter

Read [install.sh](install.sh) first if you like: it asks for no password, writes only under your home folder, and checks
the download against a checksum in the script, whichever of its two places the download comes from. The line above always
runs the install.sh of the latest release. To remove the command, its PATH line and your sign-in:

    curl -fsSL https://spotter.pisspoursoftware.xyz/install | sh -s -- --uninstall

## Using it

    spotter setup       sign in with your phone's email, then check everything
    spotter doctor      what works, what does not, and the fix
    spotter guide       what to tell your coding agent
    spotter watch       the lines of your live recording, as they arrive
    spotter reply --segment 42 "Done."

`spotter COMMAND --help` says more about any of them. `spotter doctor` is the place to start when something is wrong: each
check says what it found and what to do. Until you open a new terminal, the one that ran the installer does not know the
command yet, so spotter prints its commands with the whole path, `~/.local/bin/spotter guide`, and they work there too.

## What it reads and where it goes

- Only your own recordings, with your own sign-in, kept in the macOS Keychain. It holds no shared key, and the server
  shows it nothing else. `spotter logout` removes the sign-in.
- It keeps no copy of your words on disk. The one file it may write is a cursor you ask for with `--cursor-file`.
- It sends no analytics and starts no model. Words reach a model only if you give them to your agent, and then they
  leave this Mac for that model's provider. People near you did not choose that, so tell them it is on.
- A line sealed on your phone stays sealed: it arrives as `[sealed]`, with no words.

## How it stays cheap

A live query restates its result each time a row in it changes, so `watch` follows a window of about 24 lines that moves
forward, and a refresh costs the same at line 30 and at line 30,000: about 2 KB a line, after about 1.6 MB when it
connects. If the connection dies without closing, a read every 30 seconds hands over what was missed and says so.

## Developing

    bun install
    node --test test/*.test.ts      # Node 24 or later
    bun build --compile --minify src/cli.ts --outfile spotter

MIT licensed.
