# The Video Interview: a researcher asks, on camera

*On top of `08d6581`. Engine 972 tests (+17 new), schema 6, billing 31; new `scripts/video-interview-test.mjs`.*

A qualitative question type. The researcher records themselves asking; the respondent must watch it through, answers out loud, and the recording is transcribed. One answer holds all three parts.

## The one thing it promises

> **The respondent heard the question before they answered it.**

Everything structural follows from defending that sentence, because it is the easy thing to fake. `video.currentTime >= duration - tolerance` — the condition the brief suggests — is satisfied by dragging the scrubber, and `ended` fires just as honestly after a drag as after watching. Either on its own is a lie.

So **seconds are summed from playback**. A tick larger than a second and a half is a seek, not watching: it adds nothing and is counted (`watch.seeks`), so a researcher can see who tried. `completed` requires the end *and* the seconds — at least 90% of the clip, because browsers drop final frames and a gate nobody can pass is worse than one that is a fraction generous. `foldWatchTick` in the engine owns that arithmetic so the renderer, the validator and the tests cannot each derive it differently.

The player is hand-built for the same reason. `controlsList` is advisory, Chrome-only and ignored in picture-in-picture; snapping a seek back works but reads as a broken page. So the native controls are off and the transport is drawn: play, pause, a progress **bar with no handle**, and replay once it has finished. There is nothing to grab, which is the point.

## Why it is a type and not a preset of `upload`

The taxonomy refused a "Speech-to-Text Response" type on the grounds that a transcript is a text answer and a second type means a second place for the same data to live. That reasoning is right and does not apply here. This answer is not a file and not a string:

```
{ watch: { watchedSeconds, completed, seeks, replays, … },
  audio: { url, path, durationSeconds, retakes, … },
  transcript: { text, source, model, … } }
```

The parts do not survive separation — a transcript with no clip cannot be re-listened to, a clip with no watch record cannot be trusted as an answer to the question that was asked, and a watch record alone is telemetry. An `upload` carrying three transcript fields would have been exactly the second place the audit was clearing up.

New response model `interview`, new base type `video_interview`, one row in the `SHAPES` table.

## The gate survives a refresh, in both directions

The watch record lives in the **answer**, not in component state. A respondent who refreshes mid-interview does not rewatch a two-minute clip, and equally cannot unlock the answer area by refreshing — the same record decides both. (The video-rating variant keeps its gate in `useState` and loses it on remount; that is a bug this type cannot afford.)

## Nothing blocks on the network

`/api/session/transcribe` stores the clip and transcribes it in **one** call. Two calls over the same bytes means the respondent waits twice and, worse, has a failure mode with no good answer: if the second never arrives, the clip is in the bucket and nothing knows it needs transcribing.

The order is deliberate. **Store first** — a transcript can always be generated again from a stored clip; a clip that was never uploaded is gone. So the upload is fatal to the request and every transcription failure (no provider, empty wallet, timeout, empty reply) returns 200 with `transcript.source: "none"`, and the respondent moves on with their recording safely kept. `interviewAnswered` deliberately does not require a transcript.

That is the contract `/api/session/ai` states and the geocoder follows: **a paid external service is never the reason an interview stops.**

## Speech-to-text, and the bill it was not sending

`transcribe()` in `packages/ai` — the first **multipart** provider call in a package where everything else is JSON, which is why it is its own function rather than a flag. `AI_STT_MODEL`, default `whisper-1`, 30-second timeout (the TTS one; 8 seconds would abort legitimate work on a minute of speech). A deterministic fake whose transcript carries an id derived from the audio bytes, so a test can prove a transcript belongs to the clip that produced it.

The metering gap was real and pre-existing: `SPEECH_TO_TEXT_MINUTE` and the `ai.stt.*` rate row both already existed, but **neither `usageToSpec` had an `stt` branch**, so an stt report fell through to the chat branch and was priced as tokens it does not have — quantity zero, a transcription costing nothing. Both layers now branch, and `meteredSessionStt` reserves against the clip's length before sending and corrects on settle.

## Configuration

Three groups, because a researcher configures three separable things.

| | default | |
|---|---|---|
| Must watch the whole clip | **on** | the reason the type exists |
| Allow skipping forward | off | off hides the handle rather than fighting for it |
| Allow replay / show progress | on | |
| Auto-play | off | browsers refuse unmuted autoplay; a preference, never a guarantee |
| Spoken answer required | **on** | |
| Min / max length, re-records | —, 300s, 3 | |
| Allow pause, play back before submitting | on | |
| Automatic transcription | **on** | |
| Keep audio / keep transcript | **on** | both off is refused — the question would store nothing |

`saveTranscript: false` turns transcription off rather than paying a provider for something immediately discarded.

**Two doors, one type.** `qualitative.video_interview` carries the defaults above. `media.video_prompt_voice` is a preset with the discipline relaxed — gate off, seeking allowed, nothing transcribed — for ad-reaction work, listed in Video / Audio where somebody who thinks "show a clip, get a reaction" will look. The registry refuses an identical cross-listing (correctly: it would be a duplicate, not a preset), so the second door has to earn its place by being a genuinely different starting point.

## The researcher's recorder

Camera and microphone are previewed **before** recording, with device pickers — the commonest way to waste a take is to discover afterwards that the wrong microphone was live. Record, pause where the browser supports it (hidden where it does not, rather than shown and failing), stop, review the take, keep or re-record. Upload and external URL are equal paths.

Storage is a new `rescript-video` bucket behind a new `/api/surveys/[id]/media` route at **200 MB** — separate from the 20 MB audio route because a minute of 720p is 8–15 MB against a few hundred kilobytes of speech. Sharing the audio ceiling would refuse ordinary two-minute questions; raising it would let a runaway TTS job write 200 MB objects. Two limits, two buckets. Duration and frame size are read from the blob in the browser before upload, so the metadata is measured rather than guessed from a byte count.

## The data file

The base column is the **transcript**, because that is what an analyst reads, codes and searches — a URL in the first column makes a data file useless to the person it is for.

```
Q1                       the transcript
Q1_AUDIO_URL             the recording
Q1_DURATION_S            how long they spoke
Q1_RETAKES               re-records before settling
Q1_TRANSCRIPT_SOURCE     provider | browser | manual | none
Q1_VIDEO_COMPLETED       1 / 0 — blank when unknown
Q1_WATCHED_S             seconds of the question that actually played
Q1_WATCHED_PCT
Q1_REPLAYS
```

Blank is *"we do not know"*; `0` is *"they did not watch"*. A half-finished interview keeps that distinction.

Piping `{{Q5}}` gives the transcript, never a signed URL. Logic gets the **text** operator family for the same reason — `contains`, `matches`, `is empty` against what was said.

## Everything else is unchanged

Display logic, skip logic, branching, randomization, loops, piping, quotas, validation and completion all work without a line of change, because the answer lands in `state.answers` like every other answer and `interviewAnswered` is consulted through the ordinary `required` path. The three validation messages are separate sentences on purpose: *"please answer this question"* tells a respondent staring at a locked microphone nothing at all.

## Tests

| where | what |
|---|---|
| `packages/engine/src/interview.test.ts` | the gate under attack — watching through opens it, **dragging to the end does not**, a dropped final frame is not a skip, an unmeasurable clip falls back to `ended`; the nine states in order; a missing transcript not blocking; length limits; dictionary and export columns proved equal |
| `scripts/video-interview-test.mjs` | the whole path in a browser with a real `MediaRecorder` against Chromium's fake devices: the picker in both families, the editor flagging a question with no video, the answer locked and **staying locked after a jump to the end**, no scrub handle to grab, watch → record → store → review, the transcript proved to belong to its own clip, transcription off calling nobody, the gate surviving a reload, and the relaxed preset not gating |
