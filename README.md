# Lecture Companion

An [Obsidian](https://obsidian.md) plugin for students: **record a lecture and watch the
transcript appear as it is spoken**, pull the day's **slides from Canvas LMS** into the same
note, and get a **summary from a local model** when the lecture ends. Everything runs on your
own machine: transcription through [whisper.cpp](https://github.com/ggml-org/whisper.cpp),
summaries through [Ollama](https://ollama.com).

- **Live transcription with progress.** Audio is sent to Whisper in short chunks at natural
  pauses, so text shows up seconds after it is said. A progress bar shows how far the
  transcript is behind the recording, and the mic level, so you know it is working.
- **Multithreaded, no Docker.** The plugin starts `whisper-server` from whisper.cpp itself,
  using every CPU core, and stops it again when idle. Or point it at a whisper server you
  already run elsewhere.
- **Slides from Canvas.** One command fetches today's new PDF/PPTX files from every active
  course, saves them next to the note, embeds them, and extracts their text so the summary
  can use it.
- **One note per lecture.** `Courses/<course>/<date>.md` with Slides, Summary, Transcript and
  My notes sections; the course note `Courses/<course>.md` lists them under *Lectures* with a
  heading per date, each link followed by a one-sentence summary of that day, and keeps a
  *TODO* list. Or keep everything under date headings inside one note per course. For lectures
  summarized before 0.1.12, run **Rebuild course note links** to add the sentences (taken from
  each note's first key point; re-summarize a note for a proper one-sentence summary).
- **Summaries that cite timestamps.** Key points, definitions, formulas, announcements and
  review questions, each pointing back to `[mm:ss]` in the transcript.

Pairs well with [Local Vault Agent](https://github.com/TonyPeonio/obsidian-local-vault-agent),
which can search and compile across the notes this plugin writes.

## Requirements

Desktop Obsidian (Windows, macOS or Linux). The plugin uses the microphone, starts a local
process and reads files, which mobile Obsidian does not allow.

1. **whisper.cpp** — the `whisper-server` binary. The plugin does not download it (Obsidian's
   developer policy forbids plugins installing their own dependencies); it finds it on your
   PATH or in the usual places once you install it. See [Installing whisper.cpp](#installing-whispercpp)
   below.
2. **A Whisper model** — downloaded with one click in settings from the official
   `ggerganov/whisper.cpp` repository on Hugging Face and verified by SHA-256. The default,
   `large-v3-turbo` (1.5 GB), keeps up with live speech on a modern 8-core laptop CPU and is
   the most accurate option; `large-v3-turbo-q8_0` (830 MB) is noticeably faster with almost
   the same accuracy; `small` is for older machines.
3. **Ollama** with a chat model, for summaries (optional). `ollama pull qwen3.5:9b` is the
   default. Ollama can run on another machine: set its URL in settings.
4. **A Canvas access token**, for slides (optional). In Canvas: Account → Settings → Approved
   Integrations → *New Access Token*. Paste it into the plugin settings.

## Installing whisper.cpp

The plugin looks for `whisper-server` (`whisper-server.exe` on Windows) on your PATH and in
these folders: `%LOCALAPPDATA%\whisper.cpp`, `~\whisper.cpp`, `C:\whisper.cpp` and the Scoop
app folder on Windows; `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin` and
`~/whisper.cpp/build/bin` elsewhere. Put it anywhere else and paste the full path into
*Settings → Lecture Companion → whisper-server binary*.

### Windows

**Option A — from inside Obsidian.** Settings → Lecture Companion → *Install whisper.cpp*.
The plugin checks for an NVIDIA GPU and offers **Install GPU build** (CUDA, 10× faster) or
**Install CPU build**. Clicking one opens a PowerShell window that runs the same script as
option B, where you can watch it download the official release, verify the checksum and
unpack it to `%LOCALAPPDATA%\whisper.cpp`. When it prints *Installed*, click **Detect**. The
GPU option also adds `-fa` (flash attention) to the server arguments for you.

**Option B — the install script by hand (no package manager needed).** Download
[`scripts/install-whisper-windows.ps1`](scripts/install-whisper-windows.ps1) from this
repository, then run it from a **Command Prompt or PowerShell** window:

```
powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\Downloads\install-whisper-windows.ps1"
```

(In PowerShell, write the path as `"$env:USERPROFILE\Downloads\install-whisper-windows.ps1"`.)
The script downloads the official `whisper-bin-x64.zip` from the whisper.cpp releases page,
checks its SHA-256, and unpacks it to `%LOCALAPPDATA%\whisper.cpp`. The last lines print
`Installed: …\whisper-server.exe` and the program's usage text. Read the script first if you
like: it is 30 lines.

**Option C — by hand.** Download `whisper-bin-x64.zip` from the
[whisper.cpp releases page](https://github.com/ggml-org/whisper.cpp/releases) (pick a release
that lists Windows zip files; the plain `vX.Y.Z` tags have no files, the `bNNNN` build tags do).
Unzip it, and either move the contents of its `Release` folder to
`C:\Users\<you>\AppData\Local\whisper.cpp`, or paste the full path of `whisper-server.exe` into
the plugin's *whisper-server binary* setting.

**Option D — Scoop.** If you already use [Scoop](https://scoop.sh): `scoop install whisper-cpp`.
If Windows says *"'scoop' is not recognized"*, Scoop is not installed; use option A instead.

**Have an NVIDIA card?** Use the CUDA build; it transcribes 10× faster than the CPU build and
`large-v3-turbo` runs many times faster than real time. Option A offers it automatically when
it detects the GPU; with the script, pass `-Cuda` (it downloads the 650 MB
`whisper-bin-win-cuda-12.4.0-x64.zip`, which bundles the CUDA runtime; any NVIDIA driver from
2024 or later works):

```
powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\Downloads\install-whisper-windows.ps1" -Cuda
```

Then add `-fa` under *Extra whisper-server arguments* in the plugin settings (flash attention,
faster on GPUs). If you had the CPU build installed through Scoop, also clear the *whisper-server
binary* path or set it to `%LOCALAPPDATA%\whisper.cpp\whisper-server.exe`, because the Scoop
copy is found first.

Things that trip people up:

- **Command Prompt vs PowerShell.** Commands starting with `$` or `Set-ExecutionPolicy` are
  PowerShell; they fail in Command Prompt with *"is not recognized as an internal or external
  command"*. The `powershell -File …` line above works in both.
- **No NVIDIA GPU needed.** The CPU build is the right one for laptops; it uses every core.
  The `cuda` zips are only for machines with an NVIDIA card and the matching CUDA runtime.
- **SmartScreen / antivirus** may ask about `whisper-server.exe` the first time it runs. It is
  the unmodified official build; the script verified its checksum.

### macOS

```
brew install whisper-cpp
```

### Linux

Download `whisper-bin-ubuntu-x64.tar.gz` from the releases page, extract it, and copy
`whisper-server` to `~/.local/bin`; or build from source
(`cmake -B build && cmake --build build -j`, then the binary is `build/bin/whisper-server`).

### After installing

Settings → Lecture Companion → **Detect** should say `Found: <path>`. Then **Download model**
(wait for *Installed*) and **Start**; the status line should read `ready · http://127.0.0.1:<port>`.

## Usage

Click the microphone in the ribbon or run **Lecture Companion: Open panel**.

1. Type or pick the course, check the date, press **record**. The first start loads the model
   (10–30 s for large models); the status pill turns green when Whisper is ready.
2. Watch the transcript grow. The bar underneath shows *transcribed 12:34 of 12:50* and how
   many seconds behind it is. Pause and resume as needed.
3. Press **stop**. The plugin finishes the last chunk, saves the audio (Opus, about 20 MB per
   hour) and the transcript into the lecture note, then streams a summary from Ollama into the
   Summary section. For the next class, press **new recording** (or just type the other
   course and press record): the panel clears and the previous lecture stays in its note.
4. Before the summary, the plugin **matches slides to the lecture**: it ranks every deck in the
   Canvas course (from the Files area, Modules, and links on the course's Pages, such as a
   "slides" link on a weekly overview page) by how much its text overlaps the transcript and by
   whether it looks like a deck rather than a worksheet, syllabus or paper (file type, words in
   the name or in the page link, page structure); upload dates are ignored. It shows a picker with the best match
   checked. Confirm, and the deck is embedded under *Slides* with its text in a folded
   callout, so the summary can use them. Set *Match slides to the lecture* to *Automatic* to
   skip the picker when one deck clearly wins, or *Off*.
   - **Choose slides for this lecture note** re-runs the picker on any lecture note and
     replaces its Slides section (then run *Summarize this lecture note*).
   - **Pull today's Canvas slides** / the **download** button fetch files changed in the
     look-back window without a transcript; the picker then ranks by deck-likeness only.
     *Pull slides automatically once a day* does this at startup.
   - **PowerPoint decks become PDFs** when PowerPoint (Windows) or LibreOffice is installed,
     because Obsidian renders PDFs inline but only links a `.pptx`. Text is still extracted from
     the original. Turn it off, or keep the `.pptx` too, under *Canvas* settings; **Convert
     PowerPoint decks in this note to PDF** converts decks attached earlier.
   - Decks are downloaded once for matching and their text is cached in the plugin folder
     (`slide-cache.json`), so later matches are instant.

### Already have a recording?

Press the **audio file** button in the panel (or run **Transcribe an audio file**), pick the
recording, and it is transcribed in chunks with the same progress bar, then matched to slides and
summarized exactly like a live session. The file is copied into the attachment folder and embedded
in the transcript. Anything Chromium can decode works: webm, m4a, mp3, wav, ogg, flac, mp4.

### Already have notes from class?

You don't need to re-record anything. In the panel, the **paste** button takes text from
anywhere (another app, a chat export) and the **import note** button takes the note that is open;
the same two actions exist as commands. **Import this note as a lecture** takes the open note
(or just the selected text), asks for the course and date (pre-filled from the file name when it
contains one), and creates `Courses/<course>/<date>.md` in the lecture layout with your text
under *My notes*. It then matches the deck against your notes instead of a transcript and
writes the summary from notes + slide text. If the open note already sits at the lecture path,
it is upgraded in place; otherwise your original is left untouched.

**Tasks move to the course TODO list.** Lines like `- [ ] read chapter 3` or bullets with
Tasks-plugin markers (`* Homework 2 📅 2026-09-06 ✅ 2026-09-04`) are taken out of the imported
notes and appended, as checkboxes, under `## TODO` in the course note (done ones checked, dates
kept), so one list tracks the whole course. **Move tasks from this note to the course TODO list**
does the same for a lecture note later.

**One file with the whole semester in it?** If the note holds several dated entries (headers
like `Lecture 2 - 8.26.26`, `Meeting with Caleb - 9/11/2026`, `## Week 3: trees`), *Import this
note* opens a split preview instead: one row per entry with its detected date, an include box
and an editable date. Entries on the same day merge into one lecture note; headers without a
date assume the previous entry's date (marked, so you can correct them); text before the first
header is skipped unless you give it a date. *Split this note into lectures* opens the same
preview on demand.

**Import all notes in this folder as lectures** does the same for every note in the active
note's folder: one course, dates from the file names (`2026-11-05`, `11-05-2026`, `Nov 5 2026`
all work; otherwise the file's creation date), slide matching set to automatic. Notes that are
already lectures are skipped, so it is safe to run twice.

### Meetings (work, clubs, 1:1s)

Not everything you record is a class. Type any name in the course box (`Robotics Club`,
`1:1 with Sam`), tick **Meeting** next to it, and record as usual. A meeting:

- is filed under its own folder: `Meetings/<name>/<date>.md`, with a series note
  `Meetings/<name>.md` that lists them under *Meetings* and keeps the *TODO* list;
- is **never looked up in Canvas**: no slide matching, no "No Canvas course matches" notice, and
  the name is never saved as an alias for a course;
- has no Slides section, and its summary is written for meetings: *Overview*, *Discussion*,
  *Decisions*, *Action items* (as checkboxes, with owners when the transcript makes them clear)
  and *Open questions*. The action items are also added to the series TODO list.

Ticking the box adds the name to *Settings → Meetings → Meeting series*; after that the box ticks
itself whenever you type that name. You can also list names there by hand, and any folder already
inside the meeting folder counts as a meeting series. The import dialogs (*paste*, *import note*,
*split*, *import folder*) have the same checkbox.

### Commands

| Command | What it does |
|---|---|
| Open panel | Opens the sidebar panel |
| Start recording | Opens the panel with the course picker focused |
| Transcribe an audio file | Pick a recording you already have (webm, m4a, mp3, wav, ogg, mp4…); it goes through the same transcript → slides → summary steps |
| Pause or resume recording | |
| Stop recording and write the note | |
| Pull today's Canvas slides | Fetches today's new PDF/PPTX files from every active course |
| Pull Canvas slides for a date… | Same, for a date you choose |
| Summarize this lecture note | Re-runs the summary on the open note (Transcript, or My notes when there is no transcript, plus Slides) |
| Start / Stop whisper-server | Manual control of the local transcription server |

### How transcription works

The microphone is captured at 16 kHz mono by an AudioWorklet. A chunker cuts the stream at
pauses of about 0.7 s (never before 4 s, never after 20 s by default) and sends each chunk as
a WAV file to `whisper-server`'s `/inference` endpoint, passing the tail of the transcript so
far as the prompt so sentences stay coherent across chunks. Segments come back with
timestamps and are stitched onto the recording's timeline. Whisper's non-speech markers
(`[BLANK_AUDIO]`, `(music)`) are dropped. The transcript is written to the note every minute
while recording, so a crash loses at most a minute.

`whisper-server` is started as `whisper-server -m <model> -t <threads> --host 127.0.0.1
--port <free port> -l <language>` and stopped after ten idle minutes (configurable). If you set
a **remote whisper-server URL**, no process is started and that server is used instead.

## Settings worth knowing

- **Threads** — 0 uses one thread per physical core, which is what whisper.cpp runs fastest
  with; adding hyper-threads makes it slower. If the transcript keeps falling behind on a CPU
  build, switch to `large-v3-turbo-q8_0` (about 1.5× faster, nearly the same accuracy) or
  `large-v3-turbo-q5_0`, or use the CUDA build on a PC with an NVIDIA card.
- **Stop automatically** — two safety nets for forgotten recordings. *Stop after* (default
  180 min) is a hard limit; *Stop after silence* (default 15 min) stops when nobody has
  spoken for that long, so set it longer than the quiet stretches in your classes. Closing the
  laptop lid also ends the recording: when the machine wakes, the plugin notices the clock
  jump, stops, finishes the transcript and writes the note. A microphone being unplugged does
  the same.
- **Recording the same lecture twice** appends to the Transcript section rather than
  replacing it, so a quick test recording before class does not wipe the real one.
- **Attachment folder** — recordings and downloaded decks go to `Courses/<course>/attachments`
  by default (`{{notefolder}}/attachments`). Set any vault path, or leave it empty to follow
  Obsidian's "Default location for new attachments". Obsidian cannot embed files from hidden
  (dot) folders, so the folder is a normal one; collapse it in the file explorer.
- **Course names** — notes are filed under `Courses/<name>/…`. By default `<name>` is the
  course's full Canvas title ("Fall 2026 BIOINFORMATICS (CSCI-578-A, …)"). To use a short name
  instead, either:
  1. type it in the panel's course box when you record or import (if it matches a Canvas course,
     the pairing is saved for you), or
  2. go to Settings → Lecture Companion → *Course names in the vault* → **Load courses**, and type
     the name you want next to each Canvas course (leave blank to keep the Canvas title).

  Change a name later and new notes follow it; existing folders are not renamed (rename them in
  Obsidian's file explorer, which updates the links). The raw list underneath holds the same
  mapping as `canvas id = name` lines, for copying between machines.

## Troubleshooting

| Symptom | What to check |
|---|---|
| **Detect** says *Not found* | whisper.cpp is not installed, or is somewhere the plugin does not look. Paste the full path of `whisper-server.exe` (or `whisper-server`) into *whisper-server binary*. |
| **Start** fails with *"The Whisper model is not downloaded yet"* | Click **Download model** and wait until the status says *Installed*. Each model id has its own file; switching the dropdown to a model you have not downloaded needs another download. |
| **Start** fails with *"whisper-server exited (code …)"* | Settings → Server → **Show log**. Common causes: a corrupt model file (delete it from `.obsidian/plugins/lecture-companion/models` and download again), or antivirus blocking the executable. |
| Server stays on *Loading model…* for a long time | Large models take 10–60 s to load from a slow disk the first time; the plugin waits up to two minutes. A smaller model (`large-v3-turbo-q8_0`, `small`) loads faster. |
| Record button does nothing / *"Could not start: Permission denied"* | Obsidian was refused microphone access. Windows: Settings → Privacy & security → Microphone → allow desktop apps. macOS: System Settings → Privacy & Security → Microphone → Obsidian. |
| Transcript falls further and further behind | The CPU cannot keep up with the model. Use `large-v3-turbo-q8_0` or `small`, make sure *Threads* is 0 (all cores), and close other heavy programs. The bar turns orange when the lag passes a minute. |
| Transcript is empty while the mic level moves | Wrong microphone selected (Settings → Recording → Microphone), or the language setting does not match the lecture (`auto` detects it). |
| Summary fails with *"Cannot reach Ollama"* | Ollama is not running, or the URL points to another machine that is not reachable. Click **Test** next to the Ollama URL. |
| Pull says *unauthorized* / *no permission* for a course | The course hides its Files tab from students. The plugin then falls back to files attached to Modules and files linked from the course's Pages (e.g. a "slides" link on a weekly page), which are readable when published. Slides posted only in Announcements are not collected yet. |
| Pull finds nothing although slides were posted | The file was uploaded on another day than you pulled for. Raise *Look back (days)* in the Canvas settings, or use *Pull Canvas slides for a date…*. |
| Summary says the transcript is empty | The Transcript section holds only placeholders or an audio embed. Record first; a very short test recording with no speech produces no transcript. |
| Canvas **Test** says *rejected the access token (401)* | The token was pasted incompletely or has expired. Generate a new one in Canvas and paste it again. |
| Canvas **Test** says *not found (404)* | The Canvas URL is wrong. It must be the address you log in at, e.g. `https://school.instructure.com`, with no path after it. |

## Privacy and network use

This plugin makes network requests only to:

- the **Canvas URL** you configure, with your access token, to list courses and files and
  download the files you asked for;
- **huggingface.co**, only when you click *Download model*, to fetch the Whisper model you chose;
- the **Ollama URL** you configure, sending the transcript and slide text for summarizing;
- **`127.0.0.1`** (the local `whisper-server` it started) or the **remote whisper-server URL**
  you configure, sending recorded audio for transcription.

It never contacts any other host and collects no telemetry. Audio is captured only while you
record and is stored only in your vault (if *Keep the audio* is on). The Canvas token is saved
in this plugin's `data.json` inside your vault's configuration folder, like other plugin
settings; do not sync that folder to places you do not trust.

The plugin **runs local programs**: `whisper-server` from whisper.cpp, at a path you install
or choose, and, to turn PowerPoint decks into PDFs, PowerPoint (through PowerShell COM
automation, hidden) or LibreOffice (`soffice --headless`) when either is installed. It is started with the arguments above and nothing else; it listens on localhost
only. The plugin never downloads or updates executables itself. On Windows it can open a
PowerShell window running the bundled installer script (`scripts/install-whisper-windows.ps1`)
when you click *Install*; the script fetches the pinned official whisper.cpp release from
GitHub, checks its SHA-256 and unpacks it under your user profile. You start it, you can read
it, and you can close it.

Releases are built by GitHub Actions from the committed lockfile and carry
[artifact attestations](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds).

## Development

```bash
npm install
npm run dev     # watch build → main.js
npm test        # unit tests (vitest): chunker, pipeline, whisper client/server manager, Canvas, extractors, notes
npm run build   # type-check + Obsidian review lint + production bundle
```

`src/core/` has no Obsidian or Node imports; process control, HTTP, file system and pdf.js are
injected (`src/node/deps.ts`, `src/main.ts`) and faked in tests. `src/recorder.ts`,
`src/session.ts`, `src/view.ts`, `src/settings-tab.ts` and `src/main.ts` are the Obsidian layer.

To release: bump `version` in `manifest.json` and `package.json`, add the version to
`versions.json`, write `release-notes/<version>.md`, commit, then push a tag named exactly
`<version>`.

## Acknowledgements

- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT) by Georgi Gerganov and contributors.
- [fflate](https://github.com/101arrowz/fflate) (MIT) for reading .pptx files.

## License

MIT
