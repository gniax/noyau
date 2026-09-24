# Contributing to Noyau

Thanks for helping improve Noyau. Contributions should stay focused, keep the local-first model intact, and avoid exposing personal workspace data.

## Before starting

- Search existing issues and pull requests before opening a duplicate.
- Open an issue first for broad architectural changes or new external services.
- Never commit `.data/`, access tokens, certificates, private keys, logs, local caches, or real task and finance data.

## Development workflow

1. Fork the repository and create a branch from `main`.
2. Install dependencies with `npm install --include=dev`.
3. Make one coherent change and add or update targeted tests.
4. Run the required checks:

   ```bash
   npm test
   npm run build
   ```

5. Update the SemVer version in both `package.json` and `package-lock.json`:
   - patch for fixes, documentation, styles, and tooling;
   - minor for backward-compatible features;
   - major for breaking API, behavior, or data changes.
6. Use a Conventional Commit message, then open a pull request explaining the change and how it was verified.

## Pull requests

Keep pull requests small enough to review. Include screenshots for visible UI changes, describe migrations or configuration changes, and call out any security impact. Generated build output must not be committed.

By contributing, you agree that your contribution is provided under the repository's MIT license.
