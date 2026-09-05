# Contributing

Use Node.js 22 or later and `npm ci`. Run `npm run check` before opening a pull request.
Tests require no credentials and must not submit paid fal jobs or send audience messages.

Keep the repository standalone. Integrate with Story Kernel through its documented HTTP and
WebSocket contracts; do not import private monorepo code or access its database. Preserve DSS
ordering, assignment correlation, playback acknowledgements, and separate operator/media ports.

Describe the problem, resulting behavior, and relevant verification in your pull request. For
protocol changes include an anonymized fixture and regression test. For UI changes include a
screenshot. Avoid credentials, real story content, and unlicensed media in fixtures or assets.

By contributing, you agree to license your contribution under the repository's MIT license.
Be respectful and specific when discussing changes.
