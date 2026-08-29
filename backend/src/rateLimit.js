/**
 * A minimal, dependency-free per-IP sliding-window rate limiter. Not
 * meant to protect Nominatim itself -- geocode.js's own request queue
 * already serializes every outbound call at 1.1s regardless of how many
 * clients are asking -- this protects OUR server: without it, nothing
 * stops one misbehaving client (or a script kiddie who found the URL)
 * from opening thousands of concurrent requests and piling them all up
 * behind that queue, or from ballooning the in-memory geocode cache with
 * junk queries (see geocode.js's own cap for that half of the problem).
 *
 * In-memory only, per-process -- fine for a single small-county backend
 * with no horizontal scaling; would need a shared store (Redis, etc.) if
 * this ever ran as more than one instance.
 */
function createRateLimiter({ windowMs, max }) {
  const hits = new Map(); // ip -> array of request timestamps within the current window

  return function rateLimit(req, res, next) {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const windowStart = now - windowMs;

    let timestamps = hits.get(ip);
    if (timestamps) {
      timestamps = timestamps.filter((t) => t > windowStart);
    } else {
      timestamps = [];
    }

    if (timestamps.length >= max) {
      hits.set(ip, timestamps);
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
      return res.status(429).json({ error: 'too many requests, slow down' });
    }

    timestamps.push(now);
    hits.set(ip, timestamps);

    // Sweep stale IPs occasionally so `hits` doesn't grow forever across
    // the life of a long-running (or externally-pinged-awake) process --
    // cheap enough to just do on a random fraction of requests rather
    // than running a separate timer.
    if (Math.random() < 0.01) {
      for (const [key, ts] of hits) {
        if (ts.every((t) => t <= windowStart)) hits.delete(key);
      }
    }

    next();
  };
}

module.exports = { createRateLimiter };
