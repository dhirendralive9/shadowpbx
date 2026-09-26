# Dialer: leave-message on answering machines

Previously, a campaign set to `amdAction: leave-message` logged
"not yet implemented" and hung up — the mode was selectable but did nothing.
It now leaves a pre-recorded message.

## How it works

1. AMD detects a machine on an outbound campaign call.
2. If the campaign is `leave-message` **and** has an `amdMessageAudio` file, the
   dialer redirects the carrier call to play that message, then hang up:
   - Twilio / SignalWire — redirected to
     `/webhook/dialer/:campaignId/leave-message`, which returns
     `<Play>…</Play><Hangup/>` TwiML.
   - Telnyx — the audio URL is played on the call directly (`playback_start`).
3. The lead is recorded as `machine-message` (a completed outcome, not retried).
4. If `leave-message` is selected but no audio is set, or the redirect fails, it
   falls back to hanging up (the old behaviour) and warns in the log.

## Setup

- Upload the message audio in **Settings → Audio library** (wav or mp3).
- On the campaign, enable **AMD**, set **On machine → Leave message**, and pick
  the **Message to leave** file (the new dropdown).
- `WEBHOOK_BASE_URL` must be set so the carrier can fetch the audio and TwiML.

The audio is served at `/webhook/dialer/audio/:filename`, constrained to the
audio directory (no path traversal), so the carrier can fetch it.

## Compliance note

Leaving automated messages on answering machines is regulated (TCPA in the US,
similar rules elsewhere) and generally requires prior consent for the numbers
you dial. This implements the capability; using it lawfully — consent, opt-out,
calling-hours — remains your responsibility.
