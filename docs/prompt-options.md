# H3 prompt options

The default is the accepted A template with FAL balanced expansion. It uses the
composition and visible character references, retains DSS room placement, and
states that stationary characters stay in place.

To opt into image-aware expansion, use this private renderer configuration:

```json
{"model":"fal-max-ref2v","promptMode":"llm","continuity":"none"}
```

Set `ANTHROPIC_API_KEY` on the renderer server. `H3_PROMPT_MODEL` optionally overrides
`claude-opus-5`. Credentials stay on the server and are not renderer-config fields.
This option adds one paid Anthropic image-aware prompt request per shot, followed
by FAL video generation with expansion explicitly disabled. Other renderer modes
reject the LLM option. Omit `promptMode`, or set it to `template`, for A + balanced.
The live bridge and offline replay share this selection in `ShotGenerator`.

The LLM receives the current shot's DSS authoring and final ordered image bytes,
including a continuity anchor when used. It preserves exact dialogue, supplied
emotion, placement, torso orientation and gaze. Hidden target names are replaced
with anonymous directional evidence internally, then expressed as the visible
performer's gaze and torso direction in the output. Stationary instructions use
“Name stays in place throughout the shot.” Reference poses are not new choreography.

The output must pass six-section, dialogue, visible-cast, gaze and reference checks
before video submission. In a run, an LLM error, timeout or validation failure logs
a warning and uses A + balanced for that shot. Cancellation or run fencing still
stops the run. A missing Anthropic key is a configuration error, rejected before
scheduling. The prompt-only preview CLI remains strict and retains failures for
inspection. Paid prompt calls are not automatically retried.
These checks do not certify visual fidelity; review rendered output.

## Latency and data boundary

Opting in sends the selected composition and portraits plus the shot's dialogue
and anonymized authoring brief to Anthropic, in addition to the existing FAL video
submission. This is a third-party processing choice for the run; keys remain on
the renderer server. Preview artifacts can contain the original private inputs.

The LLM receives JPEG copies downscaled to a 1568-pixel longest edge, with a 1.5 MB
per-image byte cap and at most 12 images. FAL keeps its verified original images.
Oversized or undecodable copies fail expansion and use the per-shot run fallback.
The request uses a 16000-token output ceiling and low effort, plus an ephemeral
cache breakpoint on the fixed instructions; actual cache eligibility/hits depend
on the provider's minimum prefix length and cache state.

Image preparation and expansion share a 60-second deadline inside the scheduler
slot. This can still starve live playback, especially with the default 45-second
buffer. Fallback limits the delay but does not guarantee uninterrupted playout.
A + balanced remains the default low-latency option.

## CLI selection

The story CLI preserves `rendererConfig.promptMode` from the handoff or
`STORY_RENDERER_CONFIG_JSON`. Replay accepts `--prompt-mode llm` or the same handoff
field. Set `ANTHROPIC_API_KEY` in the worker/replay environment. For example:

```sh
npm run replay -- --dss recording.jsonl --prompt-mode llm --resolution 480P --render
```

This renders paid clips. Omitting `--render` only plans the run; it does not call
the LLM and its preview prompt is the A template.

## Preview from recorded DSS

```sh
npm run prompt:trial -- --dss recording.json --group GROUP_ID --out /tmp/new-preview
npm run prompt:trial -- --dss recording.json --group GROUP_ID --out /tmp/new-llm-preview --expand --env-file /path/to/private.env
```

The first command compiles A without an LLM call. The second makes one prompt call;
neither submits video. Existing output directories are rejected. `--asset-map`
optionally maps recorded image URLs to local image files. Prompts, source and
anonymized briefs, reference order/hashes, raw LLM response, and prepared 480P FAL
payloads are saved privately for review. Prompt artifacts may contain private asset
URLs or inline images and must not be committed. `--baseline` can include an exact
archived prompt for comparison. `--model` controls the preview's LLM model.
