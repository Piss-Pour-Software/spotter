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
runs the install.sh of the latest release. To remove the command, its PATH line, your sign-in and the speech models it
downloaded:

    curl -fsSL https://spotter.pisspoursoftware.xyz/install | sh -s -- --uninstall

## Using it

    spotter setup       sign in with your phone's email, check everything, and offer the speech models
    spotter doctor      what works, what does not, and the fix
    spotter guide       what to tell your coding agent
    spotter watch       the lines of your live recording, as they arrive
    spotter reply --segment 42 "Done."
    spotter models      Scribe's speech models on this Mac: status, download, remove
    spotter transcribe meeting.m4a      an audio file's words, with times and speakers, on this Mac

`spotter COMMAND --help` says more about any of them. `spotter doctor` is the place to start when something is wrong: each
check says what it found and what to do. Until you open a new terminal, the one that ran the installer does not know the
command yet, so spotter prints its commands with the whole path, `~/.local/bin/spotter guide`, and they work there too.

## Transcribing on this Mac

`spotter setup` offers Scribe's own speech models, the ones the phone app transcribes with on the device: Parakeet Ultra
for the words, Silero for where speech is, and Nemotron 3 for who speaks. They are 832 MB, downloaded once from
[FluidInference on Hugging Face](https://huggingface.co/FluidInference), and they need an Apple silicon Mac with macOS 15
or later. A download that is cut continues where it stopped. The first time, they are prepared for the Neural Engine
(a minute or two), and then tried on a spoken sample, so the first file you give `spotter transcribe` starts at once.

They live where Scribe for Mac keeps the same models, `~/Library/Application Support/OnDeviceTranscription/models`, so a
Mac that has Scribe for Mac downloads nothing, and the two share one copy. `spotter models remove` takes them off again,
unless Scribe for Mac uses them.

The program that runs them, `spotter-speech`, is built from Scribe's speech engine and
[FluidAudio](https://github.com/FluidInference/FluidAudio) (Apache License 2.0). spotter fetches it from its release the
first time it is needed and checks it against a checksum spotter carries; its licenses come with it, in
`~/Library/Application Support/spotter/licenses`.

## What it reads and where it goes

- Only your own recordings, with your own sign-in, kept in the macOS Keychain. It holds no shared key, and the server
  shows it nothing else. `spotter logout` removes the sign-in.
- It keeps no copy of your words on disk. Besides a cursor you ask for with `--cursor-file`, it writes only the speech
  models and their helper when you download them, and the helper's log of counts and timings, never words, in
  `~/Library/Logs/spotter`.
- It sends no analytics. It starts a speech model only to transcribe on this Mac (a file you give it, or the spoken
  sample that tries the models once they download), and that model runs here: the words stay on this Mac. Words reach another model only if you give them to your agent, and then they leave this Mac for that
  model's provider. People near you did not choose that, so tell them it is on.
- A line sealed on your phone stays sealed: it arrives as `[sealed]`, with no words.

## How it stays cheap

A live query restates its result each time a row in it changes, so `watch` follows a window of about 24 lines that moves
forward, and a refresh costs the same at line 30 and at line 30,000: about 2 KB a line, after about 1.6 MB when it
connects. If the connection dies without closing, a read every 30 seconds hands over what was missed and says so.

## Developing

    bun install
    node --test test/*.test.ts      # Node 24 or later
    bun build --compile --minify src/cli.ts --outfile spotter

A copy built from the source has no speech helper to fetch: point `SPOTTER_SPEECH` at a `spotter-speech` you built.

MIT licensed.
