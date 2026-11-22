/** Limits cover the complete response, including streaming body reads. */
export interface RequestLimits {
  timeoutMs?: number;
  maxBytes?: number;
}

export async function fetchBoundedText(
  url: string,
  options: RequestLimits & { signal?: AbortSignal; label?: string } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('Request timeout and byte limit must be positive finite values.');
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs} ms.`)), timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let body: ReadableStream<Uint8Array> | null | undefined;
  let complete = false;
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener('abort', abort, { once: true });
  // Attach a handler even if the signal was already aborted before the first fetch.
  void aborted.catch(() => {});
  if (controller.signal.aborted) abort();
  const wait = <T>(promise: Promise<T>) => Promise.race([promise, aborted]);
  try {
    controller.signal.throwIfAborted();
    const response = await wait(fetch(url, { signal: controller.signal }));
    body = response.body;
    if (!response.ok) throw new Error(`Could not fetch ${options.label ?? 'resource'} (${response.status}) from ${url}`);
    const length = Number(response.headers.get('content-length'));
    if (length > maxBytes) throw new Error(`Response exceeds ${maxBytes} bytes.`);
    if (!body) { complete = true; return ''; }
    reader = body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = '';
    while (true) {
      const chunk = await wait(reader.read());
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error(`Response exceeds ${maxBytes} bytes.`);
      text += decoder.decode(chunk.value, { stream: true });
    }
    complete = true;
    return text + decoder.decode();
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    controller.signal.removeEventListener('abort', abort);
    if (!complete) {
      controller.abort();
      void (reader ? reader.cancel() : body?.cancel())?.catch(() => {});
    }
    reader?.releaseLock();
  }
}
