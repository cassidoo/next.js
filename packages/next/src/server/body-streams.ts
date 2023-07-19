import type { IncomingMessage, Server, ServerResponse } from 'http'
import { PassThrough, Readable } from 'stream'

export function requestToBodyStream(
  context: { ReadableStream: typeof ReadableStream },
  KUint8Array: typeof Uint8Array,
  stream: Readable
) {
  return new context.ReadableStream({
    start(controller) {
      stream.on('data', (chunk) =>
        controller.enqueue(new KUint8Array([...new Uint8Array(chunk)]))
      )
      stream.on('end', () => controller.close())
      stream.on('error', (err) => controller.error(err))
    },
  })
}

function replaceRequestBody<T extends IncomingMessage>(
  base: T,
  stream: Readable
): T {
  for (const key in stream) {
    let v = stream[key as keyof Readable] as any
    if (typeof v === 'function') {
      v = v.bind(base)
    }
    base[key as keyof T] = v
  }

  return base
}

export interface CloneableBody {
  finalize(): Promise<void>
  cloneBodyStream(): Readable
}

export function getCloneableBody<T extends IncomingMessage>(
  readable: T
): CloneableBody {
  let buffered: Readable | null = null

  const endPromise = new Promise<void | { error?: unknown }>(
    (resolve, reject) => {
      readable.on('end', resolve)
      readable.on('error', reject)
    }
  ).catch((error) => {
    return { error }
  })

  return {
    /**
     * Replaces the original request body if necessary.
     * This is done because once we read the body from the original request,
     * we can't read it again.
     */
    async finalize(): Promise<void> {
      if (buffered) {
        const res = await endPromise

        if (res && typeof res === 'object' && res.error) {
          throw res.error
        }
        replaceRequestBody(readable, buffered)
        buffered = readable
      }
    },
    /**
     * Clones the body stream
     * to pass into a middleware
     */
    cloneBodyStream() {
      const input = buffered ?? readable
      const p1 = new PassThrough()
      const p2 = new PassThrough()
      input.on('data', (chunk) => {
        p1.push(chunk)
        p2.push(chunk)
      })
      input.on('end', () => {
        p1.push(null)
        p2.push(null)
      })
      buffered = p2
      return p1
    },
  }
}

async function streamReadableToResponse(
  stream: Readable,
  response: ServerResponse,
  onWrite: () => void
) {
  let responseOpen = true
  let streamDone = false

  function onData(chunk: Uint8Array) {
    response.write(chunk)
    onWrite()
  }
  function onEnd() {
    streamDone = true
  }
  function onClose() {
    if (responseOpen) {
      response.end()
    }

    stream.off('data', onData)
    stream.off('end', onEnd)
    stream.off('error', onClose)
    stream.off('close', onClose)
  }
  stream.on('data', onData)
  stream.on('end', onEnd)
  stream.on('error', onClose)
  stream.on('close', onClose)

  response.on('close', () => {
    responseOpen = false
    if (!streamDone) {
      streamDone = true
      stream.destroy()
    }
  })
}

async function streamReadableStreamToResponse(
  stream: ReadableStream<Uint8Array>,
  response: ServerResponse,
  onWrite: () => void
) {
  const reader = stream.getReader()
  let responseOpen = true
  let streamDone = false

  response.on('close', () => {
    responseOpen = false
    if (!streamDone) {
      streamDone = true
      reader.cancel().catch(() => {})
    }
  })

  try {
    while (responseOpen) {
      const { done, value } = await reader.read()
      if (done) {
        streamDone = true
        break
      }

      response.write(value)
      onWrite()
    }
  } catch (e) {
    // The reader threw an error
    streamDone = true
    throw e
  } finally {
    // The reader is guaranteed to be closed by this point because either we
    // fully drained the reader (`done = true`), the reader threw an error, or
    // the client disconnected and we called `reader.cancel()` already.

    if (responseOpen) {
      response.end()
    }
  }
}

export function streamToNodeResponse(
  stream: Readable | ReadableStream<Uint8Array> | null,
  response: ServerResponse,
  onWrite?: () => void
) {
  if (stream == null) {
    return
  }
  onWrite ??= () => {}

  if ('getReader' in stream) {
    streamReadableStreamToResponse(stream, response, onWrite)
  } else {
    streamReadableToResponse(stream, response, onWrite)
  }
}
