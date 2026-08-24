const crypto = require('crypto');

/** Short, stable content hash used as the dataset "version" the client compares against. */
function hashContent(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

module.exports = { hashContent };
