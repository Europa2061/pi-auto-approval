# Security Policy

## Supported Versions

Security fixes are handled on the latest released version.

## Reporting a Vulnerability

Please do not open a public issue with secrets, private logs, or exploit details.

Report security concerns privately to the repository maintainer. Include:

- affected version or commit;
- reproduction steps;
- expected and actual behavior;
- relevant logs with secrets removed.

## Scope

Security-sensitive areas include:

- automatic tool approval behavior;
- classifier prompt construction;
- handling of local configuration and audit logs;
- paths or commands that could expose private project data.

## Notes

`/auto-approval fallback` is the recommended mode for normal use. `/auto-approval auto` is fail-closed, but it still relies on a model-based classifier and should be used only in trusted unattended contexts.
