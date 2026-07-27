import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchJson } from '../../src/lib/ipfs';
import { IpfsError } from '../../src/lib/errors';

const KNOWN_CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

/** Minimal Response-shaped stubs for the global fetch mock. */
const okJson = (obj: any) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  text: async () => JSON.stringify(obj),
});
const httpError = (status: number) => ({
  ok: false,
  status,
  statusText: 'ERR',
});

describe('ipfs gateway cascade', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    delete process.env.POP_IPFS_GATEWAY_URL;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete process.env.POP_IPFS_GATEWAY_URL;
  });

  it('cascades to the next gateway when the first returns HTTP 500', async () => {
    fetchMock
      .mockResolvedValueOnce(httpError(500))
      .mockResolvedValueOnce(okJson({ hello: 'world' }));

    const result = await fetchJson(KNOWN_CID);
    expect(result).toEqual({ hello: 'world' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://ipfs.io/ipfs/${KNOWN_CID}`);
    expect(fetchMock.mock.calls[1][0]).toBe(`https://cloudflare-ipfs.com/ipfs/${KNOWN_CID}`);
  });

  it('tries POP_IPFS_GATEWAY_URL first when set', async () => {
    process.env.POP_IPFS_GATEWAY_URL = 'https://my-gateway.example/ipfs/';
    fetchMock.mockResolvedValueOnce(okJson({ from: 'env' }));

    const result = await fetchJson(KNOWN_CID);
    expect(result).toEqual({ from: 'env' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://my-gateway.example/ipfs/${KNOWN_CID}`);
  });

  it('aborts a hung gateway after the timeout and cascades to the next', async () => {
    vi.useFakeTimers();

    // Gateway 1 hangs until its abort signal fires
    fetchMock.mockImplementationOnce((_url: string, opts: any) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })
    );
    fetchMock.mockResolvedValueOnce(okJson({ after: 'timeout' }));

    const promise = fetchJson(KNOWN_CID);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(promise).resolves.toEqual({ after: 'timeout' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws IpfsError after retrying the full cascade once when every gateway fails', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(httpError(502));

    const promise = fetchJson(KNOWN_CID);
    // Attach the rejection expectation before advancing timers so the
    // rejection is never unhandled.
    const assertion = expect(promise).rejects.toBeInstanceOf(IpfsError);
    // Flush the withRetry backoff delay between cascade attempts
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;

    // 4 public gateways x 2 cascade passes (1 retry)
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it('cascades on invalid JSON bodies', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '<html>gateway error page</html>',
      })
      .mockResolvedValueOnce(okJson({ parsed: true }));

    const result = await fetchJson(KNOWN_CID);
    expect(result).toEqual({ parsed: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null for empty and zero-hash inputs without fetching', async () => {
    expect(await fetchJson('')).toBeNull();
    expect(await fetchJson('0x' + '0'.repeat(64))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
