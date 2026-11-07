/**
 * Transport abstraction so the providers can be exercised from plain Node
 * (tests, CLI probes) without importing Obsidian.
 */

export interface HttpRequestOptions {
	url: string;
	method?: 'GET' | 'POST';
	headers?: Record<string, string>;
	body?: unknown;
	timeoutMs: number;
}

export interface HttpResponse {
	status: number;
	text: string;
}

export interface HttpTransport {
	request(options: HttpRequestOptions): Promise<HttpResponse>;
}

export type TransportErrorKind = 'network' | 'timeout' | 'aborted';

export class TransportError extends Error {
	constructor(
		message: string,
		public readonly kind: TransportErrorKind,
		public readonly detail?: unknown,
	) {
		super(message);
		this.name = 'TransportError';
	}
}

export function isAbortError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		('name' in error ? (error as { name?: string }).name === 'AbortError' : false)
	);
}

export class FetchTransport implements HttpTransport {
	async request(options: HttpRequestOptions): Promise<HttpResponse> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), options.timeoutMs);
		try {
			const init: RequestInit = {
				method: options.method ?? 'POST',
				headers: {
					...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
					...(options.headers ?? {}),
				},
				signal: controller.signal,
			};
			if (options.body !== undefined) init.body = JSON.stringify(options.body);
			const response = await fetch(options.url, init);
			const text = await response.text();
			return { status: response.status, text };
		} catch (error) {
			if (isAbortError(error)) {
				throw new TransportError(`请求超时（${Math.round(options.timeoutMs / 1000)}s）`, 'timeout', error);
			}
			const detail = error instanceof Error ? error.message : String(error);
			throw new TransportError(`网络请求失败：${detail}`, 'network', error);
		} finally {
			clearTimeout(timer);
		}
	}
}
