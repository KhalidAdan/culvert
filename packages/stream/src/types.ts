/**
 * A Source produces chunks of type T.
 *
 * Any AsyncIterable qualifies — async generators, ReadableStreams (in most
 * runtimes), or any object with [Symbol.asyncIterator]. This is the only
 * requirement for producing data in a Culvert pipeline.
 */
export type Source<T> = AsyncIterable<T>;

/**
 * A Transform consumes a Source and produces a new Source.
 *
 * The most natural implementation is an async generator function that
 * iterates its input and yields transformed output:
 *
 * ```ts
 * const double: Transform<number, number> = async function* (source) {
 *   for await (const n of source) {
 *     yield n * 2;
 *   }
 * };
 * ```
 *
 * Transforms compose by nesting: t2(t1(source)) is a valid Source.
 * Backpressure flows naturally — the downstream consumer controls
 * the pace by when it calls next().
 */
export type Transform<I, O> = (source: Source<I>) => Source<O>;

/**
 * A Sink consumes a Source and produces a final result.
 *
 * The sink is the driver of the pipeline — it pulls data by iterating
 * the source. The returned promise resolves when consumption is complete
 * or rejects if an error occurs.
 *
 * A Sink<T, void> consumes without producing a result (e.g., writing
 * to a file). A Sink<T, R> collects or reduces to a value (e.g.,
 * concatenating all chunks into a single Uint8Array).
 *
 * ```ts
 * const log: Sink<string> = async (source) => {
 *   for await (const line of source) {
 *     console.log(line);
 *   }
 * };
 * ```
 */
export type Sink<T, R = void> = (source: Source<T>) => Promise<R>;
