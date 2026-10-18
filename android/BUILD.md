# Value Wallet pilot APK (Android)

A Trusted Web Activity over the live wallet https://aeilus.institute/tools/vledger/ (decision: Grok Heavy + Codex,
`docs/VLEDGER/ux-review/codex_android.md`). The app opens the wallet in the phone's Chrome: the same application,
the same storage, sign-in and biometrics as in Chrome. Without Digital Asset Links on the site Chrome shows a thin
URL bar; that is expected for the pilot. To hide it later, publish `/.well-known/assetlinks.json` with the SHA-256 of
the signing certificate (printed by the build) for package `institute.aeilus.vledger.pilot`.

Build (JDK 17, Android SDK with platform 35 and build-tools 35, Gradle 8.9+):

    set VW_KEYSTORE_PASSWORD=<from secrets/keystore-password>
    gradle :app:assembleRelease          (or ./gradlew with a wrapper)

The keystore `secrets/pilot.p12` (alias `vledger-pilot`) and its password are kept outside git
(`R:\02_PROJECTS\01_Governance_Value_Systems\Aeilus\private\android-pilot\`). Updates need the same key and a higher
versionCode.

Owner's morning steps (RU): see `docs/VLEDGER/ANDROID_PILOT_README_RU.md`.

## Build 0.1.0-pilot (2026-10-18)

- APK: `android/dist/Value-Wallet-Pilot-0.1.0.apk` (408 883 bytes, APK Signature Scheme v2), a copy in
  `C:\Users\archi\Downloads\`; SHA-256 of the file in `dist/*.sha256`.
- Package `institute.aeilus.vledger.pilot`, versionCode 1, minSdk 26 (Android 8), targetSdk 35.
- Signing certificate SHA-256: `6D:57:42:4B:68:11:E4:0E:A8:5E:B6:CB:DF:58:BE:C9:F1:7D:41:3F:0D:F0:AB:C6:03:09:C6:18:D7:E1:66:6F`.
- Built with the toolchain set up by the 2dBrain session: JDK 17 `C:\Users\archi\Android\jdk-17`, SDK
  `C:\Users\archi\Android\Sdk`, Gradle `C:\Users\archi\Android\gradle-8.10.2`.
- Not published yet (waits for the owner): `aeilus.institute/docroot/.well-known/assetlinks.json` with this
  fingerprint; it removes the URL bar and makes wallet links open in the app.
