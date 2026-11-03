# Changes

What each release lets you do, newest first. Releases before 0.2.0 are on GitHub.

## 0.2.2

See: on a Mac with Scribe for Mac, `spotter models remove` now takes spotter's own helper and its compiled copies, and
leaves the models Scribe for Mac uses. Before, it removed nothing there.
Try: `spotter models remove` on a Mac with Scribe for Mac. You should see that spotter's files went and the models stayed.

## 0.2.1

See: `spotter models remove` now also takes the Neural Engine's compiled copies of the models (about 40 MB, in
`~/Library/Caches`).
See: from this release on, an update that brings the same speech helper keeps the models' compiled copies, so the first
file after it starts at once; an update with a changed helper prepares the models again, once.
See: when the Mac's voice cannot make the spoken sample in time, the download says the test was skipped.
Try: `spotter models remove`, then `du -sh ~/Library/Caches/spotter-speech*`. You should see nothing left.

## 0.2.0

See: `spotter setup` now offers Scribe's own speech models for this Mac: 832 MB, downloaded once, with one line that
shows the download moving and says so when it waits.
See: `spotter transcribe FILE` writes down an audio file's words, with times and speakers, on this Mac. Nothing you
transcribe leaves it.
See: a Mac that has Scribe for Mac downloads nothing: the two share one copy of the models.
Try: `spotter models download`, then `spotter transcribe` a voice memo. You should see its lines, each with its time.
