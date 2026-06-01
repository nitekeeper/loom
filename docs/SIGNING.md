# Code signing & notarization

Loom's installer pipelines (Windows NSIS + portable, macOS `.dmg` + `.zip`) are
built unsigned by default and **sign themselves automatically the moment you add
the certificate secrets to the GitHub repository** — no code or workflow change
is required to flip signing on (with one optional macOS exception, noted below).

This document lists every required secret and how to obtain the certificates.

---

## TL;DR — current state

| Platform | Today (no secrets) | After you add the secrets |
|----------|--------------------|---------------------------|
| **Windows** | Unsigned `.exe` — SmartScreen warns ("Windows protected your PC") | Authenticode-signed `.exe` — no SmartScreen warning (EV) / reduced warning (OV) |
| **macOS** | Unsigned `.dmg`/`.zip` (`mac.identity: null`) — Gatekeeper blocks ("can't be opened" / "is damaged") | Developer ID–signed **and notarized** — opens with no Gatekeeper friction |

The unsigned builds are fully functional installers; the only difference is the
OS trust prompt. **You do not need certificates to ship — they only remove the
warnings.** Until the secrets exist, every CI build stays unsigned and green.

---

## How the conditional signing works (why no-secret builds stay green)

Signing is made **truly conditional** by two cooperating pieces: a config file
that branches on the environment, and a workflow step that exports the signing
env **only when a real cert secret exists**.

### 1. The build config lives in `electron-builder.config.cjs`

The electron-builder configuration is a CommonJS file at the repo root
(`electron-builder.config.cjs`), **not** the old `build` key in `package.json`
(that key was removed). Being executable JS, it computes the macOS signing fields
from the environment at build time:

```js
const signed = Boolean(process.env.CSC_LINK);     // see step 2 — set only when a cert exists
mac.identity        = signed ? undefined : null;  // null = PROVEN UNSIGNED (no ad-hoc); undefined = auto-discover Developer ID
mac.hardenedRuntime = signed;                      // hardened runtime ONLY when signing
mac.entitlements        = signed ? 'build/entitlements.mac.plist' : undefined;
mac.entitlementsInherit = signed ? 'build/entitlements.mac.plist' : undefined;
// mac.notarize is left UNSET -> electron-builder notarizes only when APPLE_* + a signature are present.
```

So with **no** `CSC_LINK` the config yields `mac.identity: null` — the *proven
unsigned* build (no hardened runtime, no entitlements), identical in effect to
the build that ships today. With `CSC_LINK` present it flips to auto-discovering
the Developer ID identity, with the hardened runtime + entitlements required for
notarization.

> Because the file is named `electron-builder.config.cjs` (not the bare
> `electron-builder.cjs` that electron-builder auto-detects), every invocation
> passes it explicitly with `--config electron-builder.config.cjs` — the npm
> `dist:win` / `dist:mac` scripts and both CI workflows. Without that flag
> electron-builder would silently fall back to its built-in defaults and fail.

### 2. The workflow exports the signing env ONLY when the cert secret is non-empty

The critical fix: an unset GitHub secret renders as an **empty string**, and
electron-builder 26 treats a *defined-but-empty* `CSC_LINK` as a **certificate
path**, tries to load it from the working directory, and fails with
`… not a file` → exit 1. (This is exactly what broke the macOS tag build.) An
empty `CSC_LINK` must therefore never reach electron-builder.

Each workflow has a **`Configure code signing`** step (`shell: bash`) that runs
*before* the build. It receives the secrets in its own `env:` block and appends
the signing variables to `$GITHUB_ENV` **only when the cert secret is non-empty**:

- **Windows** — if `WIN_CSC_LINK` is non-empty, it exports `CSC_LINK` +
  `CSC_KEY_PASSWORD`; otherwise it exports **nothing**, so `CSC_LINK` stays
  genuinely **unset** and the unsigned installer is produced (no error).
- **macOS** — if `MAC_CSC_LINK` is non-empty, it exports `CSC_LINK`,
  `CSC_KEY_PASSWORD`, and `CSC_IDENTITY_AUTO_DISCOVERY=true` (plus the `APPLE_*`
  trio *only if* `APPLE_ID` is also set, enabling notarization). If
  `MAC_CSC_LINK` is empty, it exports **only** `CSC_IDENTITY_AUTO_DISCOVERY=false`
  (no `CSC_LINK` at all), so electron-builder does the proven unsigned build and
  skips notarization silently.

The `Build …` step carries **no** inline `CSC_*` / `APPLE_*` env — it inherits
whatever `Configure code signing` chose to export. This guarantees `CSC_LINK` is
**unset (not empty)** for unsigned builds, so the config's `signed` branch is
`false` and electron-builder never tries to load a non-existent cert.

No certificate, password, or Apple credential is ever echoed, written to a file,
committed, or printed in the run log — secrets are referenced solely via
`${{ secrets.NAME }}`, passed into the step's `env:`, and guarded by a `[ -n … ]`
test before being appended to `$GITHUB_ENV`. The step prints only a
`Signing: ON` / `Signing: OFF` status line, never a value.

---

## Windows code signing

### Secrets to add

In the GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**.

| Secret name | Value |
|-------------|-------|
| `WIN_CSC_LINK` | The **base64** of your code-signing certificate as a `.pfx` |
| `WIN_CSC_KEY_PASSWORD` | The password that protects the `.pfx` |

### How to get the certificate

1. **Buy a code-signing certificate** from a recognized CA — e.g. **Sectigo**,
   **DigiCert**, **SSL.com**, or **GlobalSign**. Typical cost is **~$100–400/yr**.
   - **OV (Organization Validation)** — cheaper; reduces SmartScreen warnings,
     reputation builds over time. Exportable to a `.pfx`, so it works in headless
     CI.
   - **EV (Extended Validation)** — instant SmartScreen trust, but the private
     key is locked to a **hardware token (FIPS HSM)**. An EV cert on a physical
     USB token **cannot be exported to a `.pfx`** and therefore **does not work
     in headless GitHub-hosted CI** unless you use the CA's **cloud-signing /
     HSM service** (e.g. SSL.com eSigner, DigiCert KeyLocker, Azure Trusted
     Signing). Those require a different electron-builder integration than the
     `CSC_LINK` `.pfx` flow documented here — see *EV / cloud signing* below.

2. **Export the cert + private key to a `.pfx`** (also called PKCS#12). From the
   Windows certificate store: `certmgr.msc` → your cert → **All Tasks → Export →
   Yes, export the private key → .PFX**, set a password. (Or, if the CA gave you a
   `.cer` + `.key`: `openssl pkcs12 -export -out cert.pfx -inkey key.pem -in cert.cer`.)

3. **Base64-encode the `.pfx`** (this is the `WIN_CSC_LINK` value):
   ```bash
   base64 -w0 cert.pfx > cert.pfx.b64      # Linux
   base64 -i cert.pfx | tr -d '\n' > cert.pfx.b64   # macOS
   ```
   Paste the contents of `cert.pfx.b64` as the `WIN_CSC_LINK` secret, and the
   `.pfx` password as `WIN_CSC_KEY_PASSWORD`.

> Delete the local `.pfx` / `.b64` afterward. `*.pfx`, `*.cer`, `*.key` are
> git-ignored so they can never be committed, but do not leave key material lying
> around.

### EV / cloud signing (advanced)

EV certs and HSM-backed cloud signing (SSL.com eSigner, DigiCert KeyLocker,
**Azure Trusted Signing**) are not covered by the `CSC_LINK` `.pfx` path. Azure
Trusted Signing is electron-builder–native via `AZURE_TENANT_ID`,
`AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` env vars; the others need the CA's
signing tool invoked from a custom step. If you go EV, start with an OV cert for
the standard flow here, or open an issue to wire up Azure Trusted Signing.

---

## macOS code signing + notarization

### Secrets to add

| Secret name | Value |
|-------------|-------|
| `MAC_CSC_LINK` | The **base64** of your **Developer ID Application** certificate as a `.p12` |
| `MAC_CSC_KEY_PASSWORD` | The password that protects the `.p12` |
| `APPLE_ID` | Your Apple ID email (the developer account) |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password for that Apple ID (for notarization) |
| `APPLE_TEAM_ID` | Your 10-character Apple Developer **Team ID** |

### How to get the certificate

1. **Enroll in the Apple Developer Program** — <https://developer.apple.com/programs/>,
   **$99/yr**.

2. **Create a "Developer ID Application" certificate.** In **Xcode → Settings →
   Accounts → Manage Certificates → + → Developer ID Application**, or at
   **developer.apple.com → Certificates, IDs & Profiles → Certificates → + →
   Developer ID Application**. (Developer ID Application is the cert type for apps
   distributed **outside** the Mac App Store, which is what a `.dmg` is.)

3. **Export it as a `.p12`** from **Keychain Access**: find the
   *"Developer ID Application: Your Name (TEAMID)"* identity (expand it so the
   private key is included) → right-click → **Export → Personal Information
   Exchange (.p12)** → set a password.

4. **Base64-encode the `.p12`** (this is the `MAC_CSC_LINK` value):
   ```bash
   base64 -i developer-id.p12 | tr -d '\n' > developer-id.p12.b64   # macOS
   base64 -w0 developer-id.p12 > developer-id.p12.b64               # Linux
   ```
   Paste its contents as `MAC_CSC_LINK`, and the `.p12` password as
   `MAC_CSC_KEY_PASSWORD`.

5. **Create an app-specific password for notarization** at
   <https://appleid.apple.com> → **Sign-In and Security → App-Specific Passwords →
   +**. Use it as `APPLE_APP_SPECIFIC_PASSWORD`. (An App Store Connect **API key**
   — `APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` — is a more secure
   alternative supported by electron-builder; if you prefer it, set those three
   env vars instead of the `APPLE_ID` trio.)

6. **Find your Team ID** at <https://developer.apple.com/account> → **Membership
   details** (10 characters, e.g. `A1B2C3D4E5`). Use it as `APPLE_TEAM_ID`.

### Notarization toggle — important

`mac.notarize` is **left unset** in `electron-builder.config.cjs` on purpose. In
electron-builder 26, notarization runs **only when the Apple credentials are
present in the environment**:

- **No `APPLE_*` secrets** → the `Configure code signing` step does not export
  them → electron-builder generates no notarize options and **skips notarization
  silently** (no error). This is what keeps the unsigned CI build green.
- **`APPLE_*` secrets present** (plus a real Developer ID cert via `MAC_CSC_LINK`)
  → electron-builder notarizes the signed app automatically.

So **adding the five macOS secrets is the only action needed** — you do **not**
have to edit any config. (If you ever want notarization explicitly forced on or
off regardless of env, set `mac.notarize: true` / `false` in
`electron-builder.config.cjs` — but the default env-driven behavior is the
recommended setup and needs no change.)

> **Caveat — don't set the `APPLE_*` secrets without `MAC_CSC_LINK`.** Notarizing
> an unsigned app fails. Always add the Developer ID cert secret together
> with the notarization credentials, never the Apple creds alone.

The hardened runtime and entitlements (`build/entitlements.mac.plist`, tracked in
git) are computed by the config's `signed` branch: they are enabled **only when
the build is actually signed** (a cert secret is present), and are omitted from
the unsigned build entirely (`hardenedRuntime: false`, no entitlements). They are
required for notarization and engage automatically together with signing.

---

## Flipping signing on — summary

1. Add the secrets above (Windows: 2 secrets; macOS: 5 secrets).
2. Push a tag (`git tag vX.Y.Z && git push origin vX.Y.Z`) or run the workflow
   manually. **No code change is needed.**
3. The next build produces a **signed** Windows installer and a **signed +
   notarized** macOS `.dmg`/`.zip`.

---

## How to verify a signed build

### Windows

- **GUI:** right-click `Loom-Setup-<version>.exe` → **Properties → Digital
  Signatures** tab. A valid signature lists your certificate's subject; open it →
  **Details → View Certificate** to confirm the issuer and validity.
- **CLI (PowerShell):**
  ```powershell
  Get-AuthenticodeSignature .\Loom-Setup-0.5.0.exe | Format-List
  ```
  `Status` should be `Valid`.

### macOS

- **Confirm the code signature** (run on the extracted `Loom.app`):
  ```bash
  codesign -dv --verbose=4 /Applications/Loom.app
  ```
  Look for `Authority=Developer ID Application: Your Name (TEAMID)` and
  `Authority=Developer ID Certification Authority`.

- **Confirm Gatekeeper acceptance + notarization:**
  ```bash
  spctl -a -vvv /Applications/Loom.app
  ```
  A notarized app reports `accepted` and `source=Notarized Developer ID`. You can
  also check the notarization ticket is stapled with:
  ```bash
  xcrun stapler validate /Applications/Loom.app
  ```

If `spctl` reports `rejected` or `codesign` shows `Signature=adhoc`, the build was
**not** signed — confirm the secrets are set on the repository and that the build
ran after they were added.

---

## Security notes

- Certificate material is referenced **only** via `${{ secrets.NAME }}` and is
  never echoed, logged, or committed.
- `*.p12`, `*.pfx`, `*.cer`, `*.key`, `*.keychain`, `*.mobileprovision` are
  git-ignored — cert files cannot be accidentally committed.
- Rotate the app-specific password / certificates per your security policy;
  updating a secret takes effect on the next build with no code change.
