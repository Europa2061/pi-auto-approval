# pi-auto-review

AI classifier based automatic approval extension for Pi coding agent.

The extension is disabled by default. Use `/auto-review fallback` for the recommended interactive mode, `/auto-review auto` for unattended fail-closed mode, or `/auto-review off` to disable it.

Slash commands:

- `/auto-review status`
- `/auto-review off`
- `/auto-review fallback`
- `/auto-review auto`
- `/auto-review model`

Approval classifier model:

- `/auto-review model` opens a model selector for the approval classifier model.
- `/auto-review model current` uses the active Pi session model.
- `/auto-review model <model-id>` or `/auto-review model <provider>/<model-id>` uses a dedicated approval classifier model.
