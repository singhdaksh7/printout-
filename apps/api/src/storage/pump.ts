import type { Writable } from 'node:stream';
import { AppError } from '../errors.js';

/**
 * Copies `body` into `sink` with back-pressure, counting bytes and aborting past `maxBytes`.
 *
 * Unlike stream.pipeline this NEVER destroys the source on failure. For an HTTP request body, destroying the source
 * would tear down the socket before the 413 response could be written. The source is only paused/detached;
 * the HTTP layer then replies and closes the connection. Resolves with the byte count after `sink.end()` has flushed.
 */
export function pumpLimited(body: NodeJS.ReadableStream, sink: Writable, maxBytes: number, onChunk: (chunk: Buffer) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    let ended = false;
    const cleanup = () => {
      body.removeListener('data', onData);
      body.removeListener('end', onEnd);
      body.removeListener('error', onSourceError);
      body.removeListener('close', onClose);
      sink.removeListener('error', onSinkError);
      sink.removeListener('drain', onDrain);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      body.pause();
      reject(err);
    };
    const onDrain = () => body.resume();
    function onData(chunk: Buffer | string) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > maxBytes) return fail(new AppError(413, 'FILE_TOO_LARGE', 'File exceeds the maximum allowed size'));
      onChunk(buf);
      if (!sink.write(buf)) body.pause();
    }
    function onEnd() {
      ended = true;
      if (settled) return;
      sink.end(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(size);
      });
    }
    const onSourceError = (e: Error) => fail(e);
    const onSinkError = (e: Error) => fail(e);
    const onClose = () => {
      if (!ended) fail(new Error('Upload stream closed before completion'));
    };
    sink.on('drain', onDrain);
    sink.once('error', onSinkError);
    body.on('data', onData);
    body.once('end', onEnd);
    body.once('error', onSourceError);
    body.once('close', onClose);
  });
}
