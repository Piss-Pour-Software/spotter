# The page

This folder is the page at https://spotter.pisspoursoftware.xyz and its `/install` redirect. A Cloudflare Worker serves
them with no secret and no binding: [worker.mjs](worker.mjs) and [index.html](index.html). `/install` leads to the latest
release's [install.sh](../install.sh) at its tag, and `/download/` holds that release's two archives, which Cloudflare
serves as static files.

Where it lives: github.com/Piss-Pour-Software/spotter/tree/main/site
