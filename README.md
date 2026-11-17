# Lecture Companion

<!--
TODO (Tony): add a short demo here — a 20–40 s GIF or video of: pick a course → record →
transcript appears live → stop → summary with clickable [mm:ss] → click one, the recording plays.
Record with ScreenToGif (Windows) or Kap (macOS), keep it under ~8 MB, save it as
docs/demo.gif, and replace this comment with:
![Recording a lecture with Lecture Companion](docs/demo.gif)
-->

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
  My notes sections; the course note `Courses/<course>/<course>.md`, in the same folder, lists them under *Lectures* with a
  heading per date, each link followed by a one-sentence summary of that day, and keeps a
  *TODO* list. Or keep everything under date headings inside one note per course. For lectures
  summarized before 0.1.12, run **Rebuild course note links** to add the sentences (taken from
  each note's first key point; re-summarize a note for a proper one-sentence summary).
  Course notes made before 0.1.19 sat next to the course folder (`Courses/<course>.md`); they
  are moved into it once, on the first start of 0.1.19, and links to them keep working, so the
  course folder holds one folder per course and nothing else.
- **Rename a course** without touching files yourself: the command renames the course folder and
  its course note (`ADVANCED SOFTWARE ENGINEERING-…` → `Advanced Software Engineering`), sets
  `course:` in its notes, keeps links working, and remembers the new name for the Canvas course,
  so new lectures and slide pulls use it.
- **Summaries that cite timestamps.** Key points, definitions, formulas, announcements and
  review questions, each pointing back to `[mm:ss]` in the transcript.
- **Flashcards (opt-in).** Turn on **Flashcards for Spaced Repetition** under Settings →
  Summaries and each summary is followed by one more model call that answers its review
  questions from the transcript. The answers are written to a `## Flashcards` section as
  `Question::Answer` lines under a `#flashcards` tag, the single-line format of the
  [Spaced Repetition](https://github.com/st3v3nmw/obsidian-spaced-repetition) plugin, so the
  note reviews itself. Re-summarizing replaces the section; questions the transcript does not
  answer get no card.
- **Course vocabulary for Whisper.** Before each chunk, Whisper is told the words of the course:
  the course name and code, its teachers (from Canvas), distinctive terms from this lecture's
  slides (or the last lecture's), terms defined in recent summaries, and any words you add in
  settings. Names and jargon ("Kullback-Leibler", your professor's name) come out spelled right
  far more often.
- **Clickable timestamps.** In a lecture note, click a transcript marker `**[12:34]**` or a
  summary citation `[12:34]` and the recording plays from that moment (reading view and live
  preview; Alt-click to put the cursor there instead). The embedded player is used when it is on
  screen, otherwise a small player opens in the corner. The note text is not changed.
- **Mark moments while recording.** ⭐ *Important* and ❓ *Confusing* buttons in the panel (and
  commands you can give hotkeys) drop a line like `**[23:10]** ⭐ Important` into the transcript.
  The summary gives important parts priority and explains confusing parts more thoroughly, with
  a review question about them.
- **Catch me up.** Drifted off for a moment? The panel's *Catch me up* button summarizes the
  last 5 minutes (configurable) of the live transcript in a few bullets and says what the
  lecturer is on right now. It stays in the panel unless you click *Add to My notes*.
- **Transcript linked to slides.** After a deck is matched, each transcript paragraph is compared
  with every slide page, and where the slide changes the paragraph gets a link such as
  `[[Lecture 5.pdf#page=12|slide 12]]`, so you can jump from what was said to what was shown.
- **Questions from class.** Short turns that end in a question mark after a pause are marked
  `**Q:**` in the transcript, and the summary lists them under *Questions from class* with the
  answer. This is a heuristic, not speaker recognition (see [Limits](#limits-of-the-question-detection)).
- **Exam review notes.** *Make a review note* gathers a course's lectures in a date range into
  `Courses/<course>/Review <from>–<to>.md`: each lecture's one-sentence summary and key points,
  every term and definition, the review questions and the questions from class, each linked back
  to its lecture, with an overview from the model on top if you want one.
- **Reminders at class time.** Type your weekly schedule (`Machine Learning = Mon Wed Fri
  10:00-10:50`) or let the plugin read the Canvas calendar, and two minutes before class it asks
  "Machine Learning starts in 2 min. Record?". Record fills in the course and date and starts;
  nothing is recorded without that click.
- **Works with Local Vault Agent.** *Ask about this lecture* (panel button and command) opens
  Local Vault Agent's chat about the lecture note, and Lecture Companion exposes an
  [API](#api-for-other-plugins) that Local Vault Agent uses to list lectures, read transcripts and
  transcribe voice input with the same whisper-server. Settings → Summaries can copy Local Vault
  Agent's Ollama URL and model.
- **Canvas or Moodle, or neither.** Slides come from Canvas (personal access token) or Moodle
  (web service token); without a course site everything else works and nothing asks for one.
  Brightspace (D2L), Blackboard Learn and Google Classroom are not supported: their APIs only accept
  apps registered by the school (or Google), not personal tokens, and a plugin cannot ship those.
- **Ollama or any OpenAI-compatible server.** Summaries, flashcards, catch-ups, review notes and
  translations run on Ollama (default) or on LM Studio, llama.cpp's `llama-server`, Jan, vLLM or
  LocalAI through `/v1/chat/completions`, streamed.
- **Languages.** Summaries in the lecture's language or one you choose (*Summary language*), and
  **Translate the transcript of this note** adds a translated copy with the same timestamps
  under its own heading, to read side by side. The interface follows Obsidian's language; only
  English is translated so far (see `src/i18n-en.ts` to contribute one).
- **Transcribe from a link.** Paste a direct link to an audio or video file (a lecture-capture
  download, an `.mp4` on a course page) and it is downloaded and transcribed like a file. Streaming
  sites (YouTube, most lecture-capture players) do not give such a link; download the recording
  there, or record the computer's audio while it plays.
- **Report a problem.** Command, button in Settings → Help, and a *Report* link on every error
  notice. It opens a report you read and edit first (versions, platform, status of whisper.cpp and
  the chat model, settings with tokens removed, the last 50 log lines, with your vault and home
  paths replaced by `<vault>` and `~`), then **Copy** or **Open on GitHub**. Nothing is sent
  automatically.
- **Backups before bulk changes.** Moving course notes into their folders and renaming a course
  first copy every affected note to `.obsidian/plugins/lecture-companion/backups/<date time>
  <what>/` (the newest 10 are kept); the command **Open the backups folder** shows them.
- **Local Vault Agent bridge.** When `AGENT.md` exists in the vault root, a short block
  describing the lecture note shape (folders, sections, `[mm:ss]` citations, `**[m:ss]**`
  transcript paragraphs) is appended once, between markers, so the agent can answer "what did
  the professor say about isolation forests, and when?" by quoting the transcript paragraph
  with its timestamp and linking the note. On by default; nothing happens without an `AGENT.md`.

### First run

Open the panel (microphone in the ribbon). The **setup checklist** opens once and shows, live,
what is installed and what is missing, each with a button that fixes it: whisper.cpp (Install /
Detect), the Whisper model (Download), the chat model server (Ollama or an OpenAI-compatible one)
and the chat model (Download through Ollama, with progress), and the optional course site. It
recommends models for your computer (NVIDIA GPU and its memory, Apple silicon, CPU cores, RAM).
Want to see what you get before installing anything? **Try a sample** writes a sample lecture
(transcript with marks and a question from class, a small slide deck, links from the transcript
to the slides, and a summary) under `Courses/Sample course`. Reopen the checklist any time with
the command **Setup checklist** or from Settings → Help.

### What makes it different

- **Fully local.** Audio is transcribed on your computer by whisper.cpp, which the plugin starts
  and stops itself; summaries come from a model on your computer or your own network (Ollama, LM
  Studio, llama.cpp, Jan, vLLM). No account, no cloud service, no telemetry. The only network
  requests are the ones listed under [Privacy](#privacy-and-network-use).
- **Built around how lectures work.** Live transcript while you listen, the day's slides from
  Canvas or Moodle matched to what was said, transcript paragraphs linked to the slide on screen,
  timestamps that play the recording, marks for important and confusing moments, review notes
  for exams.
- **You stay in control of your vault.** The plugin writes only the lecture notes, course notes
  and attachments it creates. Bulk changes (moving course notes, renaming a course) copy the
  affected notes into a backup folder first; nothing is ever sent anywhere without a click
  (problem reports, the survey and the issue page are all opened by you).
- **Published numbers.** `npm run check-summaries` measures how faithful summaries are (does
  every `[mm:ss]` a summary cites point at a transcript paragraph that says it?) and fails below
  90%; the unit tests gate every release, and end-to-end tests in a real Obsidian run in GitHub Actions on every push.

**Compared with other transcription plugins** (as far as their own documentation describes them;
check their pages for the current state): plugins such as *Whisper*, *Scribe* and *Obsidian
Transcription* record or take an audio file and send it to a speech-to-text service (OpenAI,
AssemblyAI, Swiftink) or a self-hosted server, then insert the text, sometimes with an AI summary.
They are simpler to set up when you are fine with a cloud API. Lecture Companion is the choice when
the audio must not leave your computer, when you want the text *during* the lecture rather than
after it, and when you want the lecture structure around it (slides, course notes, review notes).
It needs more setup (whisper.cpp and a model, which the setup checklist walks through) and a
desktop computer.

Lecture Companion is part of the Companion suite of local-first Obsidian plugins by Tony Peonio for
students and researchers: your machine does the work, every change is a diff you approve, and the
numbers are published. The others are Local Vault Agent (local Ollama agent that searches, compiles,
edits notes), Canvas Companion (Canvas LMS assignments, grades and announcements as notes), Exam
Companion (day-by-day study plan, daily quizzes and flashcards), Paper Companion (Zotero search by
meaning, page-cited reading notes), Research Log Companion (append-only lab notebook with git,
parameters, data hashes), Job Hunt Companion (job applications as notes, resume tailoring, interview
questions), Fellowship Companion (grants and fellowships: deadlines, materials, letters,
eligibility), Code Companion (commits in the daily note, weekly report, TODOs), Teaching Companion
(local-model rubric grading with verbatim evidence) and Branching Table of Contents (parent/child
properties as a rooted family tree). All at [github.com/TonyPeonio](https://github.com/TonyPeonio).

## Requirements

Desktop Obsidian (Windows, macOS or Linux). The plugin uses the microphone (or the computer's own
audio output, see *Remote and recorded lectures*), starts a local process and reads files, which
mobile Obsidian does not allow.

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
repository, then run it from a **PowerShell** window (the default when you open Terminal or
press Win+X):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\Downloads\install-whisper-windows.ps1"
```

In a **Command Prompt** (`cmd.exe`) window, write the path as
`"%USERPROFILE%\Downloads\install-whisper-windows.ps1"` instead. The two shells expand
variables differently; if you see *"The argument … does not exist"*, you used the other shell's
form. The script downloads the official `whisper-bin-x64.zip` from the whisper.cpp releases page,
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

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\Downloads\install-whisper-windows.ps1" -Cuda
```

(`"%USERPROFILE%\Downloads\install-whisper-windows.ps1"` in a Command Prompt window.)

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

### Remote and recorded lectures

A lecture that plays on the computer (Zoom, Teams, a YouTube video, a recording in the browser)
needs no microphone: set **Settings → Recording → Audio source** to *This computer's audio*. The
plugin records what the computer plays through Chromium's desktop capture, so headphones are fine
and nothing in the room is picked up. *Both* mixes the microphone in for a hybrid class. Mute
notification sounds while recording, since everything the computer plays is transcribed.

This works on Windows and Linux. macOS does not let an app record its own output, so there you
install a free virtual audio device such as [BlackHole](https://existential.audio/blackhole/),
route the output through it (a Multi-Output Device keeps your speakers working) and pick it under
*Microphone*. The same trick (Windows *Stereo Mix* or VB-Cable, a PulseAudio monitor on Linux)
works anywhere the desktop capture is not available, and the plugin names the fix when it is not.

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
   callout, so the summary can use them. Press **Attach and stop asking** in the picker (or set
   *Match slides to the lecture* to *Automatic*) to skip the picker from then on whenever one
   deck clearly wins; it still appears when the match is unclear. **Always take the best match**
   (setting *Always*) never asks and attaches the top-ranked deck even when the ranking is close,
   which is handy when splitting an old note into many lectures. *Off* never matches.
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
  `Meetings/<name>/<name>.md` that lists them under *Meetings* and keeps the *TODO* list;
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
| Rename a course | Renames the course folder and course note, updates `course:` in its notes, renames recordings named after the course (`<course> <date> <time>.webm`) and repoints their embeds, keeps links working, and saves the new name for the Canvas course |
| Mark this moment as important / as confusing | While recording: adds `**[m:ss]** ⭐ Important` or `❓ Confusing` to the transcript (give them hotkeys in Settings → Hotkeys) |
| Catch me up | While recording: summarizes the last few minutes in the panel |
| Link transcript paragraphs to slides in this note | Adds `[[deck.pdf#page=N\|slide N]]` links to the open note's transcript where the slide changes (replaces earlier links) |
| Make a review note | Pick a course and a date range; writes `Review <from>–<to>.md` in the course folder |
| Ask about this lecture (Local Vault Agent) | Opens Local Vault Agent's chat about the open lecture note (needs that plugin) |
| Setup checklist | What is installed and what is missing, with fixes and model recommendations |
| Try a sample lecture | Writes a sample lecture note (no setup needed) |
| Report a problem | A report you review, then copy or open as a GitHub issue |
| Transcribe audio from a link (URL) | Downloads a direct link to an audio/video file and transcribes it |
| Translate the transcript of this note | Adds `## Transcript (<language>)` with the same timestamps |
| Open the backups folder | Shows the copies made before moves and renames |
| Summarize this lecture note | Re-runs the summary on the open note (Transcript, or My notes when there is no transcript, plus Slides) |
| Start / Stop whisper-server | Manual control of the local transcription server |
| Add lecture conventions to AGENT.md | Writes the Local Vault Agent block now (it also happens on startup when the setting is on) |

### How transcription works

The audio source (microphone, the computer's output through Chromium's desktop capture, or the
two mixed in a GainNode) is captured at 16 kHz mono by an AudioWorklet. A chunker cuts the stream at
pauses of about 0.7 s (never before 4 s, never after 20 s by default) and sends each chunk as
a WAV file to `whisper-server`'s `/inference` endpoint, passing a prompt: the course vocabulary
(`Glossary: …`, at most 80 words) followed by the last 200 characters of the transcript so far,
so terms are spelled right and sentences stay coherent across chunks. Whisper reads at most 224
prompt tokens and drops the start of a longer prompt, which is why the vocabulary is capped and
comes first. Segments come back with
timestamps and are stitched onto the recording's timeline. Whisper's non-speech markers
(`[BLANK_AUDIO]`, `(music)`) are dropped. The transcript is written to the note every minute
while recording, so a crash loses at most a minute.

`whisper-server` is started as `whisper-server -m <model> -t <threads> --host 127.0.0.1
--port <free port> -l <language>` and stopped after ten idle minutes (configurable). If you set
a **remote whisper-server URL**, no process is started and that server is used instead.

### Limits of the question detection

There is no speaker recognition. A paragraph is marked `**Q:**` when it is short (3 to 45 words),
ends with "?", starts after a pause of more than 2.5 s, is not a stock check-in ("Any
questions?", "Does that make sense?", "Is that clear?") and is followed by another paragraph.
So a question the lecturer puts to the room can be marked too, a student's question that Whisper
merges with the answer (no pause between them) is missed, and so is a question the microphone
barely picked up. The summary is told the marks are a guess and keeps only real questions under
*Questions from class*. Turn it off under Settings → Recording → *Mark questions from class*.

### API for other plugins

`app.plugins.plugins["lecture-companion"].api` (Local Vault Agent uses it):

```ts
interface LectureCompanionApi {
  version: 1;
  /** Course and meeting-series names (Canvas courses under their vault names, typed courses, folders). */
  courses(): string[];
  /** Per-lecture notes `<folder>/<course>/YYYY-MM-DD.md`, oldest first. `sentence` is the
   *  one-line summary from the Summary section (null until summarized, or while the index is
   *  still reading the note right after startup). */
  lectures(course?: string): { path: string; course: string; date: string; kind: "lecture" | "meeting"; sentence: string | null }[];
  /** Transcript paragraphs, `start` in seconds (from `**[m:ss]**`); marks are left out,
   *  `**Q:**` prefixes and slide links are stripped from `text`. */
  transcript(path: string): Promise<{ start: number; text: string }[]>;
  /** Transcribes a 16 kHz mono WAV file with the plugin's whisper-server (started if needed). */
  transcribe(wav16kMono: ArrayBuffer): Promise<string>;
  /** The Ollama URL and model from this plugin's settings. */
  ollama(): { url: string; model: string };
}
```

The "Sections in the course note" layout is not listed by `lectures()`. In the other
direction, *Ask about this lecture* calls Local Vault Agent's `api.openChatAbout(path)`, and
*Use Local Vault Agent's Ollama settings* reads its `api.ollama()`; without Local Vault Agent
the button is hidden and the command says the plugin is needed.

## Settings worth knowing

- **Course files (optional)** — choose *None*, *Canvas LMS* or *Moodle*. Moodle needs your site
  address and a token: Moodle → your profile → Preferences → **Security keys** → the key of
  *Moodle mobile web service* (present when your school allows the Moodle app); otherwise ask
  the Moodle administrator for a web service token. Only read-only functions are used (site info,
  your courses, course contents), and the token is added to file downloads, never written to a note.
- **Chat model server** — *Ollama* (default) or *OpenAI-compatible*. For the latter set the server
  URL (LM Studio `http://localhost:1234`, llama-server `http://localhost:8080`, Jan
  `http://localhost:1337`, vLLM `http://localhost:8000`), the model name as the server lists it
  (**Test** shows them) and, only if the server needs one, an API key. Set the context length when
  you load the model in that server; *Context window* applies to Ollama only.
- **Summary language / Translate transcripts to** — empty summary language keeps the lecture's.

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
     the pairing is saved for you, also when what you typed is the course code), or
  2. go to Settings → Lecture Companion → *Course names in the vault* → **Load courses**, and type
     the name you want next to each Canvas course (leave blank to keep the Canvas title).

  The course box then lists each Canvas course under its vault name, so a renamed course appears
  once, not as both the Canvas title and the short name.
- **Hiding courses** — enrolled in something you will never record (a department shell, a
  section you were added to by mistake)? Under *Course names in the vault*, press the eye
  button next to it. The course leaves the course list, is never matched to a typed name, and
  is skipped by the daily pull; press the eye again to bring it back.

  Change a name later and new notes follow it; existing folders are not renamed (rename them in
  Obsidian's file explorer, which updates the links). The raw list underneath holds the same
  mapping as `canvas id = name` lines, for copying between machines.
- **Course vocabulary** (Whisper section) — on by default. *Extra vocabulary* takes lines like
  `Machine Learning = Prof. Nguyen, Kullback-Leibler`; a line without `=` applies to every course.
- **Class reminders** — *Weekly class schedule* takes one class per line, `Course = days
  start-end`: `Machine Learning = Mon Wed Fri 10:00-10:50`, `Algorithms = TTh 2pm-3:15pm`
  (`MWF`, `TR`, `Tue/Thu` work too). *Use the Canvas calendar* adds timed events of 20 minutes to
  4 hours from your courses' Canvas calendars (many courses do not put class meetings there).
  The prompt shows a couple of minutes before the start (*Ask this many minutes before*), once per
  class, and not while something is recording.
- **Link the transcript to the slides** (Canvas section) — on by default; runs after slides are
  matched or chosen. A paragraph too unlike every slide gets no link, and going back to an
  earlier slide is allowed but costs more than moving on, so one passing mention does not
  produce a link to an old slide.
- **Tell Local Vault Agent about lecture notes** — on by default; only does anything when
  `AGENT.md` exists in the vault root, and never writes outside its
  `<!-- lecture-companion:start -->` … `<!-- lecture-companion:end -->` markers. The block
  follows the *Course folder*, *Layout*, *Date heading* and *Meeting folder* settings; press
  **Update now** (or run *Add lecture conventions to AGENT.md*) after changing them.

## Troubleshooting

| Symptom | What to check |
|---|---|
| **Detect** says *Not found* | whisper.cpp is not installed, or is somewhere the plugin does not look. Paste the full path of `whisper-server.exe` (or `whisper-server`) into *whisper-server binary*. |
| **Start** fails with *"The Whisper model is not downloaded yet"* | Click **Download model** and wait until the status says *Installed*. Each model id has its own file; switching the dropdown to a model you have not downloaded needs another download. |
| **Start** fails with *"whisper-server exited (code …)"* | Settings → Server → **Show log**. Common causes: a corrupt model file (delete it from `.obsidian/plugins/lecture-companion/models` and download again), or antivirus blocking the executable. |
| Server stays on *Loading model…* for a long time | Large models take 10–60 s to load from a slow disk the first time; the plugin waits up to two minutes. A smaller model (`large-v3-turbo-q8_0`, `small`) loads faster. |
| Record button does nothing / *"Could not start: Permission denied"* | Obsidian was refused microphone access. Windows: Settings → Privacy & security → Microphone → allow desktop apps. macOS: System Settings → Privacy & Security → Microphone → Obsidian. |
| Transcript falls further and further behind | The CPU cannot keep up with the model. Use `large-v3-turbo-q8_0` or `small`, make sure *Threads* is 0 (all cores), and close other heavy programs. The bar turns orange when the lag passes a minute. |
| Transcript is empty while the audio level moves | Wrong microphone selected (Settings → Recording → Microphone), or the language setting does not match the lecture (`auto` detects it). |
| *"This computer's audio"* fails with *"macOS does not let apps record…"* | Chromium cannot capture system audio on macOS. Install [BlackHole](https://existential.audio/blackhole/) (free), make a Multi-Output Device with it and your speakers, pick BlackHole under *Microphone* and set the source back to *Microphone*. |
| *"This computer's audio"* fails with *"…does not expose the desktop capturer"* or *"no audio track"* | Pick a loopback device under *Microphone* instead: Windows *Stereo Mix* (enable it under Sound → Recording devices) or VB-Cable; Linux the PulseAudio/PipeWire *Monitor of …* device. |
| Zoom or Teams audio is transcribed but your own voice is not | The source is *This computer's audio*, which hears only what the computer plays. Choose *Both* to add the microphone. |
| Summary fails with *"Cannot reach Ollama"* | Ollama is not running (`ollama serve`), or the URL points to another machine that is not reachable. Click **Test** next to the Ollama URL. |
| Summary fails with *"Model … is not installed"* | The model in Settings → Summaries is not pulled on that Ollama. Run the command in the message, e.g. `ollama pull qwen3.5:9b`, or pick one of the models **Test** lists. |
| Pull says *unauthorized* / *no permission* for a course | The course hides its Files tab from students. The plugin then falls back to files attached to Modules and files linked from the course's Pages (e.g. a "slides" link on a weekly page), which are readable when published. Slides posted only in Announcements are not collected yet. |
| Pull finds nothing although slides were posted | The file was uploaded on another day than you pulled for. Raise *Look back (days)* in the Canvas settings, or use *Pull Canvas slides for a date…*. |
| Summary says the transcript is empty | The Transcript section holds only placeholders or an audio embed. Record first; a very short test recording with no speech produces no transcript. |
| Canvas **Test** says *rejected the access token (401)* | The token was pasted incompletely or has expired. Generate a new one in Canvas and paste it again. |
| Canvas **Test** says *not found (404)* | The Canvas URL is wrong. It must be the address you log in at, e.g. `https://school.instructure.com`, with no path after it. |

## Privacy and network use

This plugin makes network requests only to:

- the **Canvas URL** you configure, with your access token, to list courses (with their
  teachers' names, for the Whisper vocabulary) and files, download the files you asked for, and,
  when class reminders use the Canvas calendar, read today's calendar events;
- **huggingface.co**, only when you click *Download model*, to fetch the Whisper model you chose;
- the **Ollama URL** or **OpenAI-compatible server URL** you configure, sending the transcript and
  slide text for summarizing (and the last few minutes of the live transcript when you press
  *Catch me up*, and the transcript when you translate it); *Download* in the setup checklist asks
  Ollama to pull the model;
- the **Moodle URL** you configure (instead of Canvas), with your token, to list your courses and
  their files and download the ones you asked for;
- a **link you paste** into *Transcribe audio from a link*, to download that file;
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

## Mac (Apple silicon)

Install whisper.cpp with Homebrew (`brew install whisper-cpp`): on M1 and later its build uses the
GPU through Metal, so even `large-v3-turbo` runs several times faster than real time and keeps up
live. The plugin finds it in `/opt/homebrew/bin` on its own. The setup checklist counts unified
memory when it suggests a chat model (about 60% of it is usable by the model). On an Intel Mac the
Homebrew build runs on the CPU; choose a quantized model (`large-v3-turbo-q5_0`) if it falls behind.

## Mobile

Lecture Companion is desktop-only (`isDesktopOnly`). It starts a local program (whisper-server),
reads models and runs converters through Node.js, none of which exists in Obsidian mobile, and the
plugin's code imports those Node modules when it loads. Notes it wrote work on mobile like any
other notes; clicking a timestamp to play the recording needs the desktop app.

## Beta versions (BRAT)

Betas are GitHub pre-releases tagged like `0.3.1-beta.1`, built by the same workflow as releases.
To test one, install [BRAT](https://github.com/TfTHacker/obsidian42-brat), choose *Add beta plugin*
and enter `TonyPeonio/obsidian-lecture-companion`. To publish one (maintainer): set the version in
`manifest-beta.json` (create it as a copy of `manifest.json`; `manifest.json` keeps the stable
version, so the community store never offers a beta), commit, then
`git tag -a 0.3.1-beta.1 -m "Lecture Companion 0.3.1-beta.1"` and push the tag. The workflow checks
the tag against `manifest-beta.json`, marks the release as a pre-release and attaches
`manifest-beta.json` as its `manifest.json`.

## Development

```bash
npm install
npm run dev     # watch build → main.js
npm test        # unit tests (vitest): chunker, pipeline, whisper client/server manager, Canvas, extractors, notes
npm run build   # type-check + Obsidian review lint + production bundle
npm run e2e:obsidian   # end-to-end tests in a real Obsidian (downloaded into .obsidian-cache): course rename, course-note migration, clickable timestamps, sample, import
npm run check-summaries -- <vault folder>   # faithfulness: does every [mm:ss] a summary cites point at a transcript paragraph within 20 s that shares a content word? Prints precision per note; fails below 90%
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
