# Modern Desktop App Template

Last Updated: 2024-12-19

Tauri and React boilerplate for a modern desktop application. Not a project nor a substitute tutorial for my video tutorials. I didn't use yew (wasm) since its component libraries are not to the calibre of existing React component libraries.

## Template Instructions

1. Have [`git`](https://git-scm.com/downloads) installed
2. Download this repository and rename the folder to YOUR_APP or click "use this template" and clone your new repo that is referred to henceforth as YOUR_APP
3. Open YOUR_APP in an IDE
4. Follow environment instructions in [`SAMPLE_README.md`](./SAMPLE_README.md)
5. While you run `pnpm install` to install dependencies,
    - Modify `productName, identifier, title` found in [`src-tauri/tauri.conf.json`](./src-tauri/tauri.conf.json)
    - Modify `authors` in [`src-tauri/Cargo.toml`](./src-tauri/Cargo.toml)
    - You can modify the header and the deafult footer by using Find feature in your IDE (`const FOOTER = 'footerI18nKey';`, `HEADER_TITLE`)
    - If you didn't click "use this template", remove the `.git` folder and reinitialize your own git repo
    - Delete or replace `LICENSE.md` since this template is public domain
    - Edit `SAMPLE_README.md` and replace `README.md`
6. Run `pnpm dev` to start developing
7. Read [Tips and Trouble Shooting](#tips) section of the new `README.md`
8. If any problems arise, open an issue or contact me

[Ground-up Instructions](https://v2.tauri.app/start/)

## RSS of Commit History

Add <https://github.com/elibroftw/modern-desktop-app-template/commits.atom> to your RSS reader to stay up to date!
I do not recommend pulling from my repo because you will need to edit the same files I reorganize

## [Tips](/SAMPLE_README.md#tips-and-trouble-shooting)

- [Upgrading to Tauri v2](https://v2.tauri.app/start/migrate/from-tauri-1/)

## Environments (dev / staging / prod)

The template ships a reproducible three-mode build pipeline. The two key design
decisions are documented inline next to the code that implements them:

- **Frontend = build-time static injection.** `vite.config.ts` only exposes the
  `VITE_APP_` prefix (`envPrefix`), and `src/config/runtime.ts` is the single
  place allowed to read `import.meta.env`. Values become literals at build time,
  so environment branches are tree-shakeable and prod bundles stay small — at
  the cost of rebuilding to switch env. Components must never read
  `import.meta.env` directly; import `runtimeConfig` instead.
- **Rust = runtime config reads.** `src-tauri/src/lib.rs` reads the merged
  Tauri config (and an optional `APP_UPDATE_ENDPOINT` env var) at startup so the
  same binary can hot-swap host-side settings. On conflict the **build-time
  value wins** for anything the UI / updater check relies on.
- **One base file + thin overrides.** Frontend: `.env` + `.env.<mode>`.
  Tauri: `src-tauri/tauri.conf.json` + `tauri.<env>.conf.json` (merged by
  `scripts/tauri-env.mjs`, windows are merged by `label`). Capabilities are
  generated from a single whitelist in that script — prod drops the devtools
  permission and every `fs` wildcard, keeping only scoped `$APP/$DOCUMENT/
  $DOWNLOAD` access.

Commands:

```bash
pnpm verify:env             # builds all three modes, asserts injected vars /
                            # identifier / capability sets; non-zero on over-privilege
pnpm dev                    # tauri dev  (dev config + capabilities)
pnpm dev:staging            # tauri dev  against staging override
pnpm build:dev              # tauri build with dev  bundle identifier/endpoint
pnpm build:staging          # pre-release bundle
pnpm build:prod             # release bundle (no devtools / fs wildcards)
```

CI (`.github/workflows/build.yml`) runs a 3 envs × 3 OS matrix sharing the same
env vars and verification steps, uploading one installer artifact per cell.

## Screenshots

- The four views not found in boilerplate were added by yours truly. My About is the ViewExample provided in `src`
- `Home view` is purposely not translated since it's a filler

![App screenshot with dark colorscheme](https://user-images.githubusercontent.com/21298211/209476561-5813ef56-21e6-4e64-91b5-53499ced1296.png "dark colorscheme")

![App screenshot with light colorscheme](https://user-images.githubusercontent.com/21298211/209476610-5599245b-59b1-4dcf-8dfa-a77fab0013b3.png "light colorscheme")

## Future Resources

### URL Schema (used with Single Instance)

The single instance plugin is already included in this template. Combine this plugin with the reading from below to get a Windows
app URL protocol. This can be used for say Music Players, PDF Readers, etc.

- [URL schema](https://gitlab.com/ioneyed/tauri-example-singleinstance)
