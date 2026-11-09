#!/bin/bash
# Run the real Gemini CLI against mock-gemini.mjs. SPIKE = scratch dir with node_modules/, home/.gemini/settings.json and wk/.
# The API key is a dummy; the mock never checks it.
SPIKE=${SPIKE:-$(pwd)}
cd "$SPIKE/wk" && exec env -i PATH="$SPIKE/node_modules/.bin:$PATH" HOME="$SPIKE/home" GEMINI_API_KEY=dummy-not-a-key GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:8796 gemini "$@"
