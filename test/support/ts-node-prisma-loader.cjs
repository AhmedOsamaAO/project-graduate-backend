'use strict';

const Module = require('node:module');
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function resolveWithTsFallback(
  request,
  parent,
  isMain,
  options,
) {
  if (
    typeof request === 'string' &&
    request.endsWith('.js') &&
    (request.startsWith('./') || request.startsWith('../'))
  ) {
    try {
      return originalResolveFilename.call(
        this,
        request,
        parent,
        isMain,
        options,
      );
    } catch {
      return originalResolveFilename.call(
        this,
        `${request.slice(0, -3)}.ts`,
        parent,
        isMain,
        options,
      );
    }
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

require('ts-node').register({ transpileOnly: true });
