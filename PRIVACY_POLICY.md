# Privacy Policy — TriBus (Nature Coast to Tampa Bay Transit)

**Last updated:** [fill in date of first publish]

TriBus is an offline-first transit companion app covering Hernando and
Pasco County, FL public transportation, plus Tampa's HART system —
Citrus County is a planned addition, not yet live (see the project's own
README for why). This policy describes exactly what data the app
collects, uses, and sends off your device — nothing more, nothing less
than what the app's code actually does.

## What this app does NOT do

- No account, sign-in, name, email address, or any other personal
  identifier is ever collected or required.
- No advertising, no ad SDKs, no ad identifiers.
- No general-purpose analytics SDK is included in the app.
- Your search history is stored only on your device and never
  transmitted to us or anyone else. The text of the question you're
  actively asking right now is different: when your device is online,
  it (and the app's own already-correct answer to it) may be sent to a
  third-party AI service to be rephrased in friendlier language — see
  "AI-assisted answer rephrasing" below for exactly what that does and
  doesn't include.

## Location data

If you grant location permission, the app uses your device's GPS
position to answer questions like "nearest stop to me" or "when's the
next bus" without you having to type a place name.

**Your GPS coordinates are used entirely on your device** to calculate
the straight-line distance to the nearest bus stop, using transit
schedule data already stored on your phone. Your coordinates are never
sent to our server or to any third party. Location permission is
optional — the app works fully without it if you type a stop or place
name instead. You can revoke this permission at any time in your
device's app settings.

## Place-name search ("nearest stop to a business/school/landmark")

When you ask for the nearest stop to a place that isn't already a known
bus stop (e.g., "nearest stop to Springstead High School"), the text you
typed is sent to our backend server, which forwards it to OpenStreetMap's
Nominatim geocoding service (operated by the OpenStreetMap Foundation,
not by us) to look up that place's coordinates. Only the place-name text
you typed is sent — not your location, not any other information about
you or your device. This request is subject to Nominatim's own privacy
practices: https://osmfoundation.org/wiki/Privacy_Policy

Results are cached, both on our server and on your device, so the exact
same search doesn't need to be looked up again.

## AI-assisted answer rephrasing (online only)

The app answers every question using its own offline schedule-lookup
engine first — that engine's answer is always completely correct and is
always computed entirely on your device, with or without a network
connection. When your device IS online, the app additionally sends the
text you typed and that engine's own already-correct answer to our
server, which forwards both to xAI's Grok AI service, asking it only to
rewrite the wording in a friendlier, more natural style — never to add,
change, or invent any stop name, route, time, or other transit fact.

**What is sent:** the text of your question, and the app's own factual
answer to it (which never contains your GPS coordinates, since your
location itself is never included in what's asked). **What is never
sent:** your GPS location, your search history, any other question you
haven't just asked, or anything about your device.

If this rewrite succeeds, the app shows it instead of the plain
engine text, clearly marked with an "[AI]" label so you can always tell
the AI-rephrased version from the app's own offline-computed answer. If
you're offline, if this feature isn't available, or if the rewrite
fails or times out for any reason, the app simply shows its own
already-correct offline answer unchanged — this step never blocks or
changes the accuracy of any answer, only (optionally) its wording. This
request is subject to xAI's own privacy practices:
https://x.ai/legal/privacy-policy

## Map images in answers

When a question you ask has a specific bus stop location attached to the
answer (e.g., "where is [stop]" or "nearest stop to [place]"), the app
may show a small map image of that stop alongside the text. To generate
this image, that stop's coordinates (never your own location) are sent
to our server, which requests the rendered image from Geoapify's Static
Maps API (built on OpenStreetMap data) and passes it back to your
device. This only happens when you're online, and only for the specific
stop the answer is about — never your GPS position. See Geoapify's
privacy policy: https://www.geoapify.com/privacy-policy/

## Real-time bus positions

The "Live Map" view fetches current bus positions from our server (which
in turn gets them from Hernando County Transit's real-time tracking
vendor) so you can see buses moving on the map. This requires a network
connection and does not involve sending any information about you — it's
a one-way read of public vehicle-location data.

## Schedule data sync

On first launch and periodically afterward, the app checks our server for
updated bus schedule data and downloads it if newer. This is a standard
anonymous file download — no personal information is sent as part of it.

## Data retention

Everything the app remembers about your usage (search history, learned
place lookups, your location-permission choice) is stored only on your
own device, using Android's standard app storage. Uninstalling the app
deletes all of it. We have no way to access it, because it's never sent
to us.

## Crash and error reporting

If the app encounters an unexpected error, a report containing only the
error message, a technical stack trace, which screen it happened on
(terminal or map), and your device's platform (e.g. "android") is sent
to our own server and logged there so we can find and fix the problem.
This report never includes anything you typed, your location, or any
other personally identifying information — the same boundary this
policy describes everywhere else. This data is not sent to any
third-party crash-reporting service; it stays on infrastructure we
operate directly.

## Children's privacy

This app is a general-audience public transit tool and is not directed
at children. It does not knowingly collect personal information from
anyone, including children.

## Changes to this policy

If what the app collects or sends ever changes, this policy will be
updated to match before that change ships, and the "Last updated" date
above will be revised.

## Contact

[Your contact email or method, for Play Console's privacy policy
requirements and for anyone with a question about this policy.]

---

*This document must be reachable at a public URL (e.g., hosted via
GitHub Pages from this repo, or on your own site) before it can be
entered into Google Play Console's Data Safety / privacy policy fields.
A file sitting in the repo alone is not enough — Play Console checks
that the URL is live and publicly viewable.*
