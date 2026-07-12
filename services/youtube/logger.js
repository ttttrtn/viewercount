// Small logging helper. `info`/`warn`/`error` always log (these are the
// user-facing status lines shown in the required log format). `debug` only
// logs when DEBUG_YOUTUBE=true, for verbose request/response tracing.

const { config } = require('./config');

const PREFIX = '[YouTube]';

function info(...args) {
  console.log(PREFIX, ...args);
}

function warn(...args) {
  console.warn(PREFIX, ...args);
}

function error(...args) {
  console.error(PREFIX, ...args);
}

function debug(...args) {
  if (config.DEBUG_YOUTUBE) {
    console.log(PREFIX, '[debug]', ...args);
  }
}

module.exports = { info, warn, error, debug };
