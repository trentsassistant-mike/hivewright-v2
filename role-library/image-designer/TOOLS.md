# Role Tools

## Required Credentials

- HiveWright-selected image generation adapter access.
- Required provider credentials must be configured through the adapter selected by routing.
- Provider credentials must be resolved by the HiveWright adapter. Do not read provider tokens directly or make an ad hoc Images API call outside the adapter.
- HiveWright work_product write access for binary artifacts and metadata.

## Required Runtime

- The runtime model and adapter are selected by HiveWright routing.
- The selected adapter must support image generation and binary artifact emission.
- If no capable image generation route is available, stop and report the blocker.

## Available Tools

- HiveWright-selected image generation adapter; emitted MIME types must be `image/png` or `image/jpeg`.
- Local filesystem writes scoped to the owning hive workspace and task image directory.
- HiveWright work_product emission for binary artifact records.
- Metadata extraction for MIME type, dimensions, model snapshot, prompt token usage, and cost-relevant usage.

## Operating Rules

- Accept structured inputs: `intent`, `references`, `dimensions`, `style`, `output_count`, `constraints`, and `downstream_use`.
- Write generated artifacts only under the owning hive workspace and the owning task's image directory.
- Emit every generated image as a work_product with binary metadata before reporting completion.
- Include enough usage metadata for the adapter to track token-based image generation cost, including prompt/input token usage, output token usage where available, model snapshot, and calculated cost metadata.
- Never leak image paths, source references, or generated binaries across hives.
- Generate the requested output count only when the adapter supports it safely; otherwise generate one image per task invocation and report the unsupported count as a blocker.
