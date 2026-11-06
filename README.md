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
  My notes sections; the course note links to each lecture. Or keep everything under date
  headings inside one note per course.
- **Summaries that cite timestamps.** Key points, definitions, formulas, announcements and
  review questions, each pointing back to `[mm:ss]` in the transcript.

Pairs well with [Local Vault Agent](https://github.com/TonyPeonio/obsidian-local-vault-agent),
which can search and compile across the notes this plugin writes.

## Requirements

Desktop Obsidian (Windows, macOS or Linux). The plugin uses the microphone, starts a local
process and reads files, which mobile Obsidian does not allow.

1. **whisper.cpp** — the `whisper-server` binary. The plugin does not download it (Obsidian's
   developer policy forbids plugins installing their own dependencies); it finds it on your
   PATH or in the usual places once you install it:
   - Windows: `scoop install whisper-cpp` ([Scoop](https://scoop.sh)), or unzip
     `whisper-bin-x64.zip` from the [releases page](https://github.com/ggml-org/whisper.cpp/releases)
     anywhere and set the binary path in settings.
   - macOS: `brew install whisper-cpp`
   - Linux: `whisper-bin-ubuntu-x64.tar.gz` from the releases page, or build from source.
2. **A Whisper model** — downloaded with one click in settings from the official
   `ggerganov/whisper.cpp` repository on Hugging Face and verified by SHA-256. The default,
   `large-v3-turbo` (1.5 GB), keeps up with live speech on a modern 8-core laptop CPU and is
   the most accurate option; `large-v3-turbo-q8_0` (830 MB) is noticeably faster with almost
   the same accuracy; `small` is for older machines.
3. **Ollama** with a chat model, for summaries (optional). `ollama pull qwen3.5:9b` is the
   default. Ollama can run on another machine: set its URL in settings.
4. **A Canvas access token**, for slides (optional). In Canvas: Account → Settings → Approved
   Integrations → *New Access Token*. Paste it into the plugin settings.

## Usage

Click the microphone in the ribbon or run **Lecture Companion: Open panel**.

1. Type or pick the course, check the date, press **record**. The first start loads the model
   (10–30 s for large models); the status pill turns green when Whisper is ready.
2. Watch the transcript grow. The bar underneath shows *transcribed 12:34 of 12:50* and how
   many seconds behind it is. Pause and resume as needed.
3. Press **stop**. The plugin finishes the last chunk, saves the audio (Opus, about 20 MB per
   hour) and the transcript into the lecture note, then streams a summary from Ollama into the
   Summary section.
4. Press **download** to pull the day's slides from Canvas for that course, or run **Pull
   today's Canvas slides** for all courses. Each file is embedded under *Slides* with its text in
   a folded callout. Turn on *Pull slides automatically once a day* to do this at startup.

### Commands

| Command | What it does |
|---|---|
| Open panel | Opens the sidebar panel |
| Start recording | Opens the panel with the course picker focused |
| Pause or resume recording | |
| Stop recording and write the note | |
| Pull today's Canvas slides | Fetches today's new PDF/PPTX files from every active course |
| Pull Canvas slides for a date… | Same, for a date you choose |
| Summarize this lecture note | Re-runs the summary on the open note (uses its Slides and Transcript sections) |
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

- **Threads** — 0 uses every logical CPU. Whisper scales well; on an 8-core/16-thread laptop
  `large-v3-turbo` runs faster than real time.
- **Maximum chunk length** — shorter chunks show text sooner but give Whisper less context.
  20 s is a good default; 10–12 s if you want it snappier.
- **Layout** — *One note per lecture* (recommended; transcripts are long) or *Sections in the
  course note* with a `## YYYY-MM-DD` heading per day.
- **Context window** — summaries read the whole transcript; an hour of speech is roughly
  10–12k tokens. 32768 is the default. If the transcript does not fit it is truncated and the
  summary says so.
- **Extra summary instructions** — e.g. "Always list formulas" or "Write in German".

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

The plugin **runs a local program**: `whisper-server` from whisper.cpp, at a path you install
or choose. It is started with the arguments above and nothing else; it listens on localhost
only. The plugin never downloads or updates executables.

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
