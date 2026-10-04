'use strict';

// FLAG: Deliberately idle test child, never malformed input or a production decoder.
require('node:fs').writeFileSync('/tmp/maxim-photo-ci-child.pid', String(process.pid));
process.stdin.resume();
setInterval(() => {}, 1000);
