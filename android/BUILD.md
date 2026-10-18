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
