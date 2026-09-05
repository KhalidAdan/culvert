# @culvert/csv

Streaming CSV parser and stringifier. Bounded memory. RFC 4180 plus
the real-world dialects. Works in Node, Deno, Bun, Cloudflare Workers,
and browsers.

## Install

```sh
npm install @culvert/csv
```

## Parsing

`csvParse` is a `Transform<Uint8Array, Row>` — a peer of `filter` and
`map`, not a special parsing stage:

```ts
import { pipe, filter, writeTo } from "@culvert/stream";
import { csvParse } from "@culvert/csv";

await pipe(
  response.body,                       // Source<Uint8Array>
  csvParse({ headers: true }),         // Transform<Uint8Array, Record<string, string>>
  filter(row => row.status === "active"),
  writeTo(database),
);
```

Memory is bounded by the longest single row. Quoted fields may contain
newlines and escaped quotes (`""`) — the tokenizer is character-driven,
so the row count is right even when line-driven parsers get it wrong.

### Headers

- `headers: false` (default) — rows are `string[]`, positional.
- `headers: true` — the first row becomes the keys; rows are
  `Record<string, string>`.
- `headers: string[]` — you supply the keys; no row is consumed.

### Every value is a string

CSV has no type system. `dynamicTyping`-style coercion silently turns
`"01234"` zip codes into `1234`, so we don't ship it. The generic
parameter types the row's *keys*; coercion belongs in a `map` operator
where it's visible:

```ts
interface UserRow { id: string; age: string }

pipe(
  source,
  csvParse<UserRow>({ headers: ["id", "age"] }),
  map(row => ({ ...row, age: parseInt(row.age, 10) })),
  sink,
);
```

### Malformed input

Strict default + named modes + function escape hatch — the same recipe
as tar's `pathPolicy`:

```ts
csvParse({ onMalformed: "strict" });      // throw CsvSyntaxError (default)
csvParse({ onMalformed: "permissive" });  // emit a best-effort row
csvParse({
  onMalformed: (err, rawLine) => {
    log(err, rawLine);
    return null;                          // skip; or return a substitute row
  },
});
```

Covers unbalanced quotes, data after a closing quote, and row-length
mismatches against the header set.

### Dialect options

```ts
csvParse({
  delimiter: ";",        // default ","
  quote: "'",            // default '"'
  newline: "auto",       // default; accepts \r\n, \n, and \r anywhere
  comment: "#",          // skip lines starting with this; off by default
  trim: true,            // trim unquoted fields; default false
  skipEmptyLines: true,  // default false
});
```

With `newline: "auto"` the parser accepts all three terminators mixed
in one file. An explicit terminator is exact — other newline characters
become field data.

## Stringifying

```ts
import { pipe, writeTo } from "@culvert/stream";
import { csvStringify } from "@culvert/csv";

await pipe(
  database.query("SELECT id, name FROM users"),  // Source<Record<string, string>>
  csvStringify({ headers: true }),               // Transform<Row, Uint8Array>
  writeTo(httpResponse),
);
```

Output starts with the first row; the full result set is never held in
memory. Defaults are conservative where the parser is liberal: `\r\n`
terminators (RFC 4180) and minimal quoting — a field is quoted only
when it contains the delimiter, the quote character, or a newline.
`quoting: "all"` quotes everything.

With `headers: true` the header row is the first record's keys; later
records are projected onto that key set (missing keys emit empty
strings, extra keys are dropped). `headers: string[]` supplies the key
set up front.

## Errors

- `CsvSyntaxError` — malformed input: unbalanced quotes, invalid
  UTF-8, header/row length mismatch.
- `CsvWriteError` — the stringifier got a row whose shape doesn't
  match its header mode.
- `CsvAbortError` — an `AbortSignal` fired.

Same names, same semantics as `@culvert/zip`, `@culvert/tar`, and
`@culvert/gzip`.

## What's not included

- **Type coercion.** Values are strings; coerce in a `map` operator.
- **Encoding detection.** UTF-8 only (a leading BOM is stripped).
  Invalid UTF-8 throws `CsvSyntaxError`.
- **Dialect sniffing.** You know your input; say what it is.
- **Header renaming.** `headers: string[]` overrides keys; renaming is
  a `map` on your side.
- **`quoting: "none"`.** It would have to corrupt data or throw at
  runtime — both worse than understanding quoting.

## Related packages

- [`@culvert/stream`](../stream) — the streaming contract this
  package is built on
- [`@culvert/gzip`](../gzip) — decompress `.csv.gz` on the way in

## License

MIT
