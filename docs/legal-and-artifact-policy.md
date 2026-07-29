# Legal And Artifact Policy

This repository contains wrapper code, Linux compatibility glue, build tools,
tests, and documentation only.

Do not commit or publish through git:

- Factory DMGs, extracted `.app` directories, `app.asar`, or proprietary icons;
- Factory-derived JavaScript bundles or screenshots;
- Droid binaries, installers, or user credentials;
- Generated `.deb`, `.rpm`, `.AppImage`, or update-builder workspaces;
- Real proprietary bundle fixtures.

Regression tests use metadata manifests and local/cache-only fixture paths. A
fixture may be used for a local or private CI run only when it was obtained by
the operator from an authorized upstream source. The fixture must not be added
to git, uploaded as a public CI artifact, or included in a release.

Release automation must make the unofficial status clear and must not imply
endorsement by Factory. The MIT license applies only to this repository's
original wrapper and tooling.
