import { requestUrl } from 'obsidian';
import {
	HttpRequestOptions,
	HttpResponse,
	HttpTransport,
	TransportError,
	isAbortError,
} from './transport';

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new TransportError(`请求超时（${Math.round(timeoutMs / 1000)}s）`, 'timeout'));
		}, timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/**
 * Obsidian's requestUrl bypasses CORS, which is required for a localhost
 * Ollama endpoint served to an `app://` origin.
 */
export class ObsidianTransport implements HttpTransport {
	async request(options: HttpRequestOptions): Promise<HttpResponse> {
		try {
			const response = await withTimeout(
				requestUrl({
					url: options.url,
					method: options.method ?? 'POST',
					headers: options.headers ?? {},
					contentType: options.body !== undefined ? 'application/json' : undefined,
					body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
					throw: false,
				}),
				options.timeoutMs,
			);
			return { status: response.status, text: response.text };
		} catch (error) {
			if (error instanceof TransportError) throw error;
			if (isAbortError(error)) {
				throw new TransportError(`请求超时（${Math.round(options.timeoutMs / 1000)}s）`, 'timeout', error);
			}
			const detail = error instanceof Error ? error.message : String(error);
			throw new TransportError(`网络请求失败：${detail}`, 'network', error);
		}
	}
}
