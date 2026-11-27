'use strict';

// Node checks incomplete requests periodically; this is not a precise deadline.
// These settings cover receiving HTTP headers and bodies, not upgraded WebSockets.
const HTTP_TIMEOUT_OPTIONS = Object.freeze({
  headersTimeout: 30_000,
  requestTimeout: 120_000,
  connectionsCheckingInterval: 5_000,
});

module.exports = { HTTP_TIMEOUT_OPTIONS };
