import type { HttpTransport, HttpResponse } from './transport';
import { ChatOptions, ProviderError, TranslationProvider, fromTransportError } from './provider';

interface OpenAIChatResponse {
	choices?: { message?: { content?: string }; finish_reason?: string }[];
	error?: { message?: string; type?: string };
	model?: string;
}

/** Accepts `http://host:port`, `.../v1` or `.../v1/chat/completions`. */
export function normalizeOpenAIBase(baseUrl: string): string {
	let url = (baseUrl || 'https://api.openai.com').trim().replace(/\/+$/, '');
	url = url.replace(/\/chat\/completions$/, '');
	url = url.replace(/\/v1$/, '');
	return url;
}

export class OpenAIProvider implements TranslationProvider {
	readonly id = 'openai';
	readonly label = 'OpenAI-compatible';
	private readonly baseUrl: string;

	constructor(
		private readonly transport: HttpTransport,
		baseUrl: string,
		private readonly apiKey?: string,
	) {
		this.baseUrl = normalizeOpenAIBase(baseUrl);
	}

	private headers(): Record<string, string> {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
		return headers;
	}

	async chat(options: ChatOptions): Promise<string> {
		let response: HttpResponse;
		try {
			response = await this.transport.request({
				url: `${this.baseUrl}/v1/chat/completions`,
				method: 'POST',
				headers: this.headers(),
				body: {
					model: options.model,
					messages: options.messages,
					temperature: options.temperature,
					max_tokens: options.maxTokens,
					stream: false,
				},
				timeoutMs: options.timeoutMs,
			});
		} catch (error) {
			throw fromTransportError(error, this.baseUrl);
		}

		let payload: OpenAIChatResponse = {};
		try {
			payload = JSON.parse(response.text) as OpenAIChatResponse;
		} catch {
			payload = {};
		}

		if (response.status >= 400) {
			const detail = payload.error?.message || response.text.slice(0, 300);
			if (response.status === 401 || response.status === 403) {
				throw new ProviderError(`鉴权失败（${response.status}）：请检查 API Key。${detail}`, 'http', detail, false);
			}
			if (response.status === 404) {
				throw new ProviderError(`模型或路径不存在：${options.model}。${detail}`, 'model', detail, false);
			}
			throw new ProviderError(`服务返回 ${response.status}：${detail}`, 'http', detail, response.status >= 500);
		}

		const content = payload.choices?.[0]?.message?.content ?? '';
		if (!content.trim()) {
			throw new ProviderError('服务返回了空内容', 'parse', response.text.slice(0, 300), true);
		}
		return content;
	}

	async listModels(): Promise<string[]> {
		try {
			const response = await this.transport.request({
				url: `${this.baseUrl}/v1/models`,
				method: 'GET',
				headers: this.headers(),
				timeoutMs: 15000,
			});
			if (response.status >= 400) {
				throw new ProviderError(`服务返回 ${response.status}`, 'http', response.text.slice(0, 200));
			}
			const payload = JSON.parse(response.text) as { data?: { id?: string }[] };
			return (payload.data ?? []).map((model) => model.id ?? '').filter(Boolean);
		} catch (error) {
			throw fromTransportError(error, this.baseUrl);
		}
	}
}
