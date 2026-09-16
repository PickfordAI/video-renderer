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
before video submission. An LLM error or validation failure stops that shot; it
neither silently falls back to another prompt nor retries the paid prompt call.
These checks do not certify visual fidelity; review rendered output.

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
