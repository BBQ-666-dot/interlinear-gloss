import type { GlossSettings } from '../types';
import type { HttpTransport } from './transport';
import { TransportError } from './transport';
import { OllamaProvider } from './ollama';
import { OpenAIProvider } from './openai';

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface ChatOptions {
	model: string;
	messages: ChatMessage[];
	temperature: number;
	maxTokens: number;
	numCtx?: number;
	timeoutMs: number;
}

export interface TranslationProvider {
	readonly id: string;
	readonly label: string;
	chat(options: ChatOptions): Promise<string>;
	listModels(): Promise<string[]>;
}

export type ProviderErrorKind = 'network' | 'timeout' | 'model' | 'http' | 'parse';

export class ProviderError extends Error {
	constructor(
		message: string,
		public readonly kind: ProviderErrorKind,
		public readonly detail?: string,
		public readonly retryable = false,
	) {
		super(message);
		this.name = 'ProviderError';
	}
}

export function fromTransportError(error: unknown, baseUrl: string): ProviderError {
	if (error instanceof TransportError) {
		if (error.kind === 'timeout') return new ProviderError(error.message, 'timeout', undefined, true);
		return new ProviderError(
			`连不上模型服务 ${baseUrl}。请确认服务已启动（本地 Ollama：在终端运行 ollama serve）。原始错误：${error.message}`,
			'network',
			error.message,
			true,
		);
	}
	if (error instanceof ProviderError) return error;
	const message = error instanceof Error ? error.message : String(error);
	return new ProviderError(`请求失败：${message}`, 'http', message, false);
}

/** One retry for transient failures, so a cold model load does not lose the paragraph. */
export async function withRetry<T>(
	run: () => Promise<T>,
	attempts = 2,
	onRetry?: (error: unknown, attempt: number) => void,
): Promise<T> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await run();
		} catch (error) {
			lastError = error;
			const retryable =
				error instanceof ProviderError ? error.retryable : error instanceof TransportError ? true : false;
			if (!retryable || attempt === attempts) break;
			onRetry?.(error, attempt);
		}
	}
	throw lastError;
}

export function createProvider(
	settings: GlossSettings,
	transport: HttpTransport,
	apiKey = '',
): TranslationProvider {
	if (settings.provider === 'openai') {
		return new OpenAIProvider(transport, settings.baseUrl, apiKey || undefined);
	}
	return new OllamaProvider(transport, settings.baseUrl);
}
