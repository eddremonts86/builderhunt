/**
 * `StorageProvider` against the S3 API, backed by self-hosted MinIO
 * (`docs/operations/interview-provider-register.md` §1). Every vendor error is
 * normalised to `StorageProviderError` so no domain code ever sees an AWS SDK
 * exception class.
 *
 * ## `maxBytes` is advisory on the URL and authoritative afterwards
 *
 * A presigned **PUT** cannot cap the body size. Only a presigned **POST** can,
 * through its policy conditions, and S3-style POST is not what the upload path
 * uses. Signing an exact `Content-Length` is not a substitute either: the
 * signature would then demand a byte count the caller has to predict exactly,
 * turning "the file is 1 byte smaller than announced" into an opaque signature
 * failure.
 *
 * So the limit is carried two ways, and the second is the one that counts:
 *
 *   1. Nothing at all on the request. Carrying the limit as
 *      `x-amz-meta-max-bytes` was tried and removed: a presigned URL cannot
 *      sign it, and MinIO rejects any unsigned header outright, so it broke
 *      every upload while enforcing nothing.
 *   2. `headObject` reports the real size. The upload-completion path must read
 *      it and reject anything over the limit **before** marking the document
 *      usable — the object is already written by then, so rejecting means
 *      deleting it, not refusing it.
 *
 * Writing this down because the interface's shape invites the opposite
 * assumption: `createSignedUploadUrl({ maxBytes })` reads like an enforced
 * limit, and treating it as one would leave the only real check unwritten.
 */
import {
  DeleteObjectCommand,
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import {
  StorageProviderError,
  type SignedDownloadUrl,
  type SignedUploadUrl,
  type StorageObjectMetadata,
  type StorageProvider,
} from './types'

export interface S3StorageConfig {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** Only ever `'eu'` today; `env.ts` pins it and rejects anything else. */
  region?: string
}

/**
 * Object keys are generated server-side, never supplied by a candidate. This
 * rejects the shapes that would still be dangerous if that ever stopped being
 * true — traversal, absolute paths, and the empty key — rather than trusting
 * the generator to stay correct.
 */
function assertValidKey(key: string): void {
  if (key.length === 0 || key.length > 1024) {
    throw new StorageProviderError(`object key must be 1..1024 characters, got ${key.length}`, 'invalid_key')
  }
  if (key.startsWith('/') || key.includes('//')) {
    throw new StorageProviderError('object key must be relative and must not contain an empty segment', 'invalid_key')
  }
  if (key.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new StorageProviderError('object key must not contain a traversal segment', 'invalid_key')
  }
  // Control characters survive some S3 implementations and are stripped by
  // others, so the same key can address two different objects depending on who
  // reads it.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(key)) {
    throw new StorageProviderError('object key must not contain control characters', 'invalid_key')
  }
}

function normalise(error: unknown, fallback: string): StorageProviderError {
  if (error instanceof StorageProviderError) return error
  const name = (error as { name?: string } | null)?.name ?? ''
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode
  if (name === 'NotFound' || name === 'NoSuchKey' || status === 404) {
    return new StorageProviderError('object not found', 'not_found')
  }
  if (name === 'AccessDenied' || status === 403) {
    return new StorageProviderError('access denied by the object store', 'access_denied')
  }
  return new StorageProviderError(
    `${fallback}: ${error instanceof Error ? error.message : String(error)}`,
    'provider_unavailable',
  )
}

export class S3StorageProvider implements StorageProvider {
  private readonly client: S3Client
  private readonly bucket: string

  constructor(config: S3StorageConfig, client?: S3Client) {
    this.bucket = config.bucket
    const options: S3ClientConfig = {
      endpoint: config.endpoint,
      // MinIO serves path-style. Virtual-host style would resolve the bucket as
      // a subdomain of an internal hostname that has no DNS record.
      forcePathStyle: true,
      region: config.region ?? 'auto',
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    }
    this.client = client ?? new S3Client(options)
  }

  async createSignedUploadUrl(params: { key: string; contentType: string; maxBytes: number }): Promise<SignedUploadUrl> {
    assertValidKey(params.key)
    if (!Number.isSafeInteger(params.maxBytes) || params.maxBytes <= 0) {
      throw new StorageProviderError(`maxBytes must be a positive integer, got ${params.maxBytes}`, 'invalid_key')
    }
    // Five minutes: long enough for a slow mobile upload of a CV, short enough
    // that a URL leaked from a browser history or a proxy log is stale.
    const expiresInSeconds = 300
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: params.key,
      ContentType: params.contentType,
    })
    try {
      // `signableHeaders` is not optional here. Without it the SDK signs only
      // `host`, and MinIO rejects the upload outright — "there were headers
      // present in the request which were not signed" — the moment the client
      // sends the content type back. Naming them also makes the enforcement
      // real: an unsigned header is one the client can change freely.
      const url = await getSignedUrl(this.client, command, {
        expiresIn: expiresInSeconds,
        signableHeaders: new Set(['content-type']),
      })
      return {
        url,
        method: 'PUT',
        headers: {
          // The only header returned, and deliberately so: MinIO rejects any
          // header the signature does not cover, so every extra one is a
          // failure mode rather than a control. This one IS covered, so the
          // upload fails if the client announces a different type.
          //
          // `maxBytes` used to travel here as `x-amz-meta-max-bytes`. It could
          // not be signed on a presigned URL, so it broke every upload while
          // enforcing nothing — the limit was always going to be checked by the
          // caller against `headObject`, which is where it still is.
          'content-type': params.contentType,
        },
        expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      }
    } catch (error) {
      throw normalise(error, 'could not sign an upload url')
    }
  }

  async createSignedDownloadUrl(params: { key: string; expiresInSeconds: number }): Promise<SignedDownloadUrl> {
    assertValidKey(params.key)
    if (!Number.isSafeInteger(params.expiresInSeconds) || params.expiresInSeconds <= 0 || params.expiresInSeconds > 3600) {
      throw new StorageProviderError(
        `expiresInSeconds must be 1..3600, got ${params.expiresInSeconds}`,
        'invalid_key',
      )
    }
    try {
      const url = await getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: params.key }),
        { expiresIn: params.expiresInSeconds },
      )
      return {
        url,
        method: 'GET',
        expiresAt: new Date(Date.now() + params.expiresInSeconds * 1000).toISOString(),
      }
    } catch (error) {
      throw normalise(error, 'could not sign a download url')
    }
  }

  async headObject(params: { key: string }): Promise<StorageObjectMetadata | null> {
    assertValidKey(params.key)
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: params.key }))
      return {
        bytes: head.ContentLength ?? 0,
        contentType: head.ContentType ?? 'application/octet-stream',
        // MinIO returns this only when the object was written with a checksum;
        // the caller hashes the bytes itself when it is absent rather than
        // treating "no checksum" as "checksum matched".
        sha256: head.ChecksumSHA256 ?? null,
      }
    } catch (error) {
      const normalised = normalise(error, 'could not read object metadata')
      // Absence is an answer here, not a failure — the contract returns null.
      if (normalised.code === 'not_found') return null
      throw normalised
    }
  }

  async readObject(params: { key: string }): Promise<{ bytes: number; stream: AsyncIterable<Uint8Array> }> {
    assertValidKey(params.key)
    try {
      const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: params.key }))
      const body: unknown = object.Body
      // The SDK types `Body` as a union that includes browser streams. On Node
      // it is always a Readable, but an empty or unexpected body must not reach
      // the scanner as a zero-byte stream — clamd would call that clean.
      if (!body || typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== 'function') {
        throw new StorageProviderError('object body was not readable as a stream', 'provider_unavailable')
      }
      return { bytes: object.ContentLength ?? 0, stream: body as AsyncIterable<Uint8Array> }
    } catch (error) {
      throw normalise(error, 'could not read object')
    }
  }

  async deleteObject(params: { key: string }): Promise<void> {
    assertValidKey(params.key)
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: params.key }))
    } catch (error) {
      // S3 delete is idempotent and answers 204 for a key that never existed,
      // so anything thrown here is a real failure and must not be swallowed:
      // the retention worker relies on this to know a document is gone.
      throw normalise(error, 'could not delete object')
    }
  }

  async moveObject(params: { fromKey: string; toKey: string }): Promise<void> {
    assertValidKey(params.fromKey)
    assertValidKey(params.toKey)
    if (params.fromKey === params.toKey) return
    try {
      await this.client.send(new CopyObjectCommand({
        Bucket: this.bucket,
        Key: params.toKey,
        CopySource: `${this.bucket}/${params.fromKey}`,
      }))
    } catch (error) {
      throw normalise(error, 'could not copy object to its destination')
    }
    // Deliberately after the copy succeeded, and deliberately not rolled back if
    // it fails: a leftover source object is a retention-worker problem, while a
    // deleted source with no destination is a lost CV.
    await this.deleteObject({ key: params.fromKey })
  }
}
