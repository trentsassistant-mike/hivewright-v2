# Role Tools

## Required Runtime

- The runtime model and adapter are selected by HiveWright routing.
- The selected adapter must support repository context, filesystem inspection, and image-read references when present.

## Available Tools

- File system access to inspect project code and design artifacts.
- Image-read capability for authorized image work_product paths in session context, including structured references with `imageRead`, `path`, `metadata`, and `originalImageBrief`.
- Repository-aware design-spec drafting through the selected HiveWright adapter.
- External design plugin skill IDs: `frontend-design:frontend-design` and `figma:figma-implement-design` when available. These are namespaced plugin references, not `skills-library/<slug>/SKILL.md` entries.

## Operating Rules

- Use `frontend-design:frontend-design` when the task requires frontend design judgement, visual system definition, UX layout decisions, responsive behaviour, or accessibility review.
- Use `figma:figma-implement-design` when Figma context exists or when the output should be Figma-shaped for later implementation.
- Inspect image work_product references through image-read before describing visual details.
- Emit design specs as HiveWright work_products with Tailwind, JSX, shadcn-oriented, or Figma-shaped implementation detail as appropriate.
