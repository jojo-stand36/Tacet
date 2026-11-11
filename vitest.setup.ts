import { setDefaultHostClaudeTokenFile } from './packages/core/src/testing/index.js';

// Claude Code's host token file exists in its own cloud containers (#291). Unless a test names a
// path, check one that never exists, so suites behave the same there as on CI. Tests of the check
// itself pass their own path.
setDefaultHostClaudeTokenFile('/nonexistent/tacet-test/host-claude-token');
