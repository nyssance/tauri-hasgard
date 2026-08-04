# Releasing

## One-time setup

1. Make `nyssance/tauri-hasgard` public.
2. Create public repositories `nyssance/homebrew-tap` and `nyssance/scoop-bucket` with a `main` branch.
3. Publish the first npm package and both crates manually, then configure trusted publishers for
   `.github/workflows/release.yml` on npmjs.com and crates.io. Later releases use GitHub OIDC and do
   not store npm or crates.io publish tokens.
4. Create a GitHub App installed only on `nyssance/homebrew-tap` and
   `nyssance/scoop-bucket`, with repository Contents read/write permission. Add its client ID as the
   repository variable `DISTRIBUTION_APP_CLIENT_ID` and its private key as the repository secret
   `DISTRIBUTION_APP_PRIVATE_KEY`.
5. Confirm the `nyssance` npm organization exists and the publishing account can publish public packages.

## Release

Keep these three versions identical:

- `[workspace.package].version` in `Cargo.toml`.
- `version` in `packages/playwright/package.json`.
- Git tag without its `v` prefix.

The root `package.json` is `private: true` and is not published, so its version
is deliberately not part of this set.

Add the release's entry to `CHANGELOG.md` before tagging.

After CI passes, create and push the tag:

```bash
git tag -s v0.2.0 -m "tauri-hasgard v0.2.0"
git push origin v0.2.0
```

The release workflow validates the version, tests the workspace, publishes both Rust crates and the
npm package, builds six CLI archives, creates checksums and GitHub provenance attestations, creates
the GitHub Release, then updates the Homebrew Tap and Scoop Bucket with a short-lived GitHub App
installation token. Every CLI archive and the npm package include `LICENSE` and `NOTICE.md`.

## User installation

```bash
# macOS
brew install nyssance/tap/tauri-hasgard

# Windows
scoop bucket add nyssance https://github.com/nyssance/scoop-bucket
scoop install nyssance/tauri-hasgard

# Any Rust toolchain
cargo install tauri-hasgard-cli

# Tauri application
cargo add tauri-plugin-hasgard

# Playwright Test fixture
bun add --dev @nyssance/tauri-hasgard
```
