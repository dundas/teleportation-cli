import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { retry, retryFetch, createRetryableApiClient } from './retry.js';

describe('retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should succeed on first attempt', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const result = await retry(fn);
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on failure and eventually succeed', async () => {
    const error = new Error('Network error');
    error.code = 'ECONNREFUSED'; // Make it retryable
    const fn = vi.fn()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValue('success');
    
    const promise = retry(fn, { maxRetries: 2, initialDelay: 100 });
    
    // Fast-forward timers
    await vi.runAllTimersAsync();
    
    const result = await promise;
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should exhaust retries and throw last error', async () => {
    const error = new Error('Network error');
    error.code = 'ECONNREFUSED';
    const fn = vi.fn().mockRejectedValue(error);

    const promise = retry(fn, { maxRetries: 2, initialDelay: 100 });

    // Attach rejection handler BEFORE running timers to avoid unhandled rejection
    const resultPromise = promise.catch(e => e);

    await vi.runAllTimersAsync();

    const caughtError = await resultPromise;
    expect(caughtError.message).toBe('Network error');
    expect(fn).toHaveBeenCalledTimes(3); // Initial + 2 retries
  });

  it('should not retry non-retryable errors', async () => {
    const error = new Error('Validation error');
    error.status = 400; // Client error, not retryable
    const fn = vi.fn().mockRejectedValue(error);

    const shouldRetry = (err) => err.status >= 500;
    const promise = retry(fn, { shouldRetry });

    // Attach rejection handler immediately to avoid unhandled rejection
    const resultPromise = promise.catch(e => e);

    const caughtError = await resultPromise;
    expect(caughtError.message).toBe('Validation error');
    expect(fn).toHaveBeenCalledTimes(1); // No retries
  });

  it('should call onRetry callback before each retry', async () => {
    const onRetry = vi.fn();
    const error = new Error('Network error');
    error.code = 'ECONNREFUSED';
    const fn = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue('success');
    
    const promise = retry(fn, { maxRetries: 1, initialDelay: 100, onRetry });
    
    await vi.runAllTimersAsync();
    
    await promise;
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(error, 1, expect.any(Number));
  });

  it('should use exponential backoff with jitter', async () => {
    const delays = [];
    const onRetry = vi.fn((error, attempt, delay) => {
      delays.push(delay);
    });
    
    const error = new Error('Network error');
    error.code = 'ECONNREFUSED';
    const fn = vi.fn()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValue('success');
    
    const promise = retry(fn, {
      maxRetries: 2,
      initialDelay: 1000,
      factor: 2,
      onRetry
    });
    
    await vi.runAllTimersAsync();
    
    await promise;
    expect(delays.length).toBe(2);
    // First delay should be around 1000ms (with jitter)
    expect(delays[0]).toBeGreaterThanOrEqual(1000);
    expect(delays[0]).toBeLessThan(1300); // 1000 + 30% jitter
    // Second delay should be around 2000ms (with jitter)
    expect(delays[1]).toBeGreaterThanOrEqual(2000);
    expect(delays[1]).toBeLessThan(2600); // 2000 + 30% jitter
  });
});

describe('retryFetch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should retry on network errors', async () => {
    let callCount = 0;
    global.fetch.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        const error = new Error('Network error');
        error.code = 'ECONNREFUSED';
        throw error;
      }
      return { ok: true, status: 200 };
    });
    
    const promise = retryFetch('http://example.com/api', {}, { maxRetries: 1, initialDelay: 100 });
    
    await vi.runAllTimersAsync();
    
    const result = await promise;
    expect(result.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('should retry on 5xx server errors', async () => {
    const error500 = new Error('Server error');
    error500.status = 500;
    
    global.fetch
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    
    // Mock fetch to throw on 5xx
    global.fetch.mockImplementation(async (url, options) => {
      const callCount = global.fetch.mock.calls.length;
      if (callCount === 1) {
        throw error500;
      }
      return { ok: true, status: 200 };
    });
    
    const promise = retryFetch('http://example.com/api', {}, { maxRetries: 1, initialDelay: 100 });
    
    await vi.runAllTimersAsync();
    
    await promise;
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('should not retry on 4xx client errors', async () => {
    const error400 = new Error('Bad request');
    error400.status = 400;

    global.fetch.mockRejectedValue(error400);

    const promise = retryFetch('http://example.com/api', {}, { maxRetries: 2, initialDelay: 100 });

    // Attach rejection handler immediately to avoid unhandled rejection
    const resultPromise = promise.catch(e => e);

    const caughtError = await resultPromise;
    expect(caughtError.message).toBe('Bad request');
    expect(global.fetch).toHaveBeenCalledTimes(1); // No retries
  });

  it('should respect timeout', async () => {
    // Mock fetch to check abort signal and reject when aborted
    global.fetch.mockImplementation((url, options) => {
      return new Promise((resolve, reject) => {
        // Check if signal is already aborted
        if (options?.signal?.aborted) {
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          reject(error);
          return;
        }

        // Listen for abort event - reject immediately when aborted
        if (options?.signal) {
          const abortHandler = () => {
            const error = new Error('The operation was aborted.');
            error.name = 'AbortError';
            reject(error);
          };
          options.signal.addEventListener('abort', abortHandler, { once: true });
        }

        // Otherwise, never resolve (simulating slow network)
      });
    });

    const promise = retryFetch('http://example.com/api', {}, {
      maxRetries: 0,
      timeout: 100
    });

    // Attach rejection handler BEFORE advancing timers to avoid unhandled rejection
    const resultPromise = promise.catch(e => e);

    // Advance timers to trigger the AbortController timeout
    await vi.advanceTimersByTimeAsync(150);

    // The abort signal should cause fetch to reject with AbortError
    const caughtError = await resultPromise;
    expect(caughtError.name).toBe('AbortError');

    // Verify fetch was called
    expect(global.fetch).toHaveBeenCalled();

    // Verify the abort signal was passed
    const fetchCall = global.fetch.mock.calls[0];
    expect(fetchCall[1].signal).toBeDefined();
  });
});

describe('createRetryableApiClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should create API client with base URL', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200 });
    const apiClient = createRetryableApiClient('http://api.example.com');
    
    await apiClient('/users', { method: 'GET' });
    
    expect(global.fetch).toHaveBeenCalledWith(
      'http://api.example.com/users',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('should use default retry options', async () => {
    let callCount = 0;
    global.fetch.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        const error = new Error('Network error');
        error.code = 'ECONNREFUSED'; // Make it retryable
        throw error;
      }
      return { ok: true, status: 200 };
    });
    
    const apiClient = createRetryableApiClient('http://api.example.com', {
      maxRetries: 2,
      initialDelay: 500
    });
    
    const promise = apiClient('/users');
    await vi.runAllTimersAsync();
    
    await promise;
    expect(global.fetch).toHaveBeenCalledTimes(2); // Initial + 1 retry (maxRetries=2 means 1 retry)
  });
});

