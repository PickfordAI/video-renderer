# Third-party software and media

The MIT license in this repository applies to Pickford renderer code and documentation. Dependencies
retain their own licenses and copyright notices. The lockfile pins exact JavaScript versions.

| Component | License | Source |
|---|---|---|
| React / React DOM | MIT | https://github.com/facebook/react |
| hls.js | Apache-2.0 | https://github.com/video-dev/hls.js |
| ws | MIT | https://github.com/websockets/ws |
| dotenv | BSD-2-Clause | https://github.com/motdotla/dotenv |
| MediaMTX | MIT | https://github.com/bluenviron/mediamtx/tree/v1.12.2 |
| FFmpeg | LGPL/GPL depending on build; Alpine's libx264-enabled build includes GPL components | https://ffmpeg.org/legal.html |

Build tools have their own licenses in the installed packages. Distributors must retain the
applicable dependency notices. The Docker image uses Alpine's FFmpeg package; exact package versions can be inspected with `apk info -v`. Corresponding package
build recipes and upstream source references are in https://gitlab.alpinelinux.org/alpine/aports.
Before redistributing a binary image, retain the matching source/build metadata and satisfy the
source-distribution requirements of the FFmpeg build you ship; the repository's MIT license does
not replace those obligations.

No show-specific portraits or voice samples are distributed in the release tree. User-provided
references, Story Kernel, fal/MiniMax services, and generated media are separate from this code
license and subject to their respective rights and terms.
