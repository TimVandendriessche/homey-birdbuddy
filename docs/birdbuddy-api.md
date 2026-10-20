# Bird Buddy API sources

This is an unofficial API. The identification request and selected fields in
`lib/birdbuddy.js` were cross-checked against the public **pybirdbuddy** client at
commit `35e701afc16cfa2c111a34b80c3fe061eaa994e2`. Pinned references:

- [POSTCARD_REANALYZE](https://github.com/jhansche/pybirdbuddy/blob/35e701afc16cfa2c111a34b80c3fe061eaa994e2/birdbuddy/queries/birds.py#L3-L63)
  contains `inferenceExternalPostcardReanalyze(feedItemId: $feedItemId)`,
  `updatedFeedItem`, `inferenceExecutionMode`, `reanalyzeAvailability`, feeder IDs,
  media URLs, and the recognized/unlocked sighting types with species IDs and names.
- [identify_postcard](https://github.com/jhansche/pybirdbuddy/blob/35e701afc16cfa2c111a34b80c3fe061eaa994e2/birdbuddy/client.py#L647-L682)
  documents the manual identification operation, including free accounts, and
  passes only the postcard ID as a variable. Collecting a postcard is a separate operation.
- [GraphQL introspection snapshot](https://github.com/jhansche/pybirdbuddy/blob/35e701afc16cfa2c111a34b80c3fe061eaa994e2/tests/fixtures/schema.json)
  defines the field and argument types used to validate the feed, single-postcard,
  and identification queries.

## Video URL argument

In that schema, `MediaVideo.contentUrl` has this signature:

```graphql
contentUrl(size: MediaVideoSize!): String!
```

`ORIGINAL` is a member of `MediaVideoSize`. The argument is required and has no
default, so removing it would fail validation against this snapshot. The public
[video selection](https://github.com/jhansche/pybirdbuddy/blob/35e701afc16cfa2c111a34b80c3fe061eaa994e2/birdbuddy/queries/birds.py#L31-L34)
also uses `contentUrl(size: ORIGINAL)`. Images have a separate `MediaImageSize` enum.

These sources support the query shape; they do not guarantee that the service's
current schema or account permissions will stay the same. Live verification on a
Homey Pro with a free Bird Buddy account remains necessary.

## Flow tokens

The identification Flow exposes `species` (names joined with commas) and `time`.
Opaque postcard and species IDs are retained internally for API calls and
deduplication, but are not exposed as Flow tokens. Flows created with the earlier
development version's `species_id` or `postcard_id` tokens must be updated.
